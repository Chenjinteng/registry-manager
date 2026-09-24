/**
 * 独立镜像仓库管理服务。
 *
 * 一个进程同时做两件事：
 *   1. 托管前端静态产物（生产态）；
 *   2. 代理并归一化 registry 的 HTTP API V2。
 *
 * 第 2 点是必需的而不是设计偏好：registry 不下发任何 CORS 头，浏览器无法跨域
 * 直接读 `/v2/`，删除也必须同源发起。
 *
 * 所有接口统一返回 `{ success, code, message, data }`。外部系统（registry）的
 * "能力性拒绝"（例如未开启删除）走 success:false + 稳定 code，HTTP 仍是 200：
 * 它是页面要内联渲染、且往往需要用户去改配置的领域事实，不是一个接口异常。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import express from 'express';

import { loadConfig, readAppVersion } from './config.mjs';
import { Inventory } from './inventory.mjs';
import { RegistryClient, RegistryError } from './registry-client.mjs';
import { PullQueue } from './puller.mjs';
import { CredentialStore, pickCredentialPublic, assertCredentialUsable } from './credentials.mjs';
import { ProxyStore, pickProxyPublic, testProxyConnectivity, buildProxyUrl } from './proxies.mjs';
import { ActivityStore, verifyNotifyToken, emptySummary } from './events.mjs';
import { Db } from './db.mjs';
import { resolve as resolvePath, join } from 'node:path';

const config = loadConfig();
/** 运行中的版本号，从 package.json 读（见 config.mjs 的 readAppVersion）。 */
const appVersion = readAppVersion();
/**
 * 全局 client：本 registry 的认证来自配置（env 或 registry.config.json），
 * 因此**所有**对本仓库的读写（盘点、删除、拉取时的 mount / blob / manifest PUT）
 * 都自动带上同一份凭据 —— 拉取任务里不再需要单独选目的凭据。
 */
const client = new RegistryClient({
  url: config.url,
  proxy: config.proxy,
  auth: config.username ? { username: config.username, password: config.password } : undefined,
});
const inventory = new Inventory(client, { ttlSeconds: config.cacheTtlSeconds });

/**
 * 凭据库初始化。
 *
 * 两种失败必须区分开，否则会把用户引到错误的方向：
 *   - 没设密钥              → 配置缺失，用户该去补 REGISTRY_CREDENTIAL_KEY；
 *   - 设了密钥但初始化失败  → 目录不可写 / 密钥本身有问题，改密钥没用。
 * 之前这两种都报“未配置 REGISTRY_CREDENTIAL_KEY”，导致明明配了密钥的人
 * 反复去检查 env（容器里 env 确实有），却查不出真正原因。
 */
const credentialKey = String(process.env.REGISTRY_CREDENTIAL_KEY ?? '').trim();
const secretsDir = config.credentialsDir;

/** @type {{code: string, message: string} | null} */
let credentialInitError = null;
let credentialStore = null;
let proxyStore = null;

if (!credentialKey) {
  credentialInitError = {
    code: 'CREDENTIAL_KEY_MISSING',
    message: '未设置环境变量 REGISTRY_CREDENTIAL_KEY，凭据库不可用。',
  };
} else {
  try {
    credentialStore = new CredentialStore({
      filePath: resolvePath(join(secretsDir, 'credentials.json')),
      masterKey: credentialKey,
    });
    // 代理库用同一个密钥、同一个目录、独立文件。
    proxyStore = new ProxyStore({
      filePath: resolvePath(join(secretsDir, 'proxies.json')),
      masterKey: credentialKey,
    });
  } catch (error) {
    credentialInitError = {
      code: 'CREDENTIAL_STORE_INIT_FAILED',
      message:
        `加密存储初始化失败：${error.message}。` +
        `密钥已读到（长度 ${credentialKey.length}），问题出在数据目录 ` +
        `${config.credentialsDir}（需要存在且对运行用户可写）。` +
        `容器里以非 root 的 node 用户运行时，请确保该目录属主是 node（见 Dockerfile / compose 的 volume 配置）。`,
    };
    console.error(`[registry-manager] ${credentialInitError.message}`);
  }
}

/**
 * 持久层（SQLite）：**热度统计与拉取历史共用同一个文件、同一个连接**。
 *
 * 初始化失败**不阻断启动**：两者都是可重建的辅助数据，写不进磁盘不该让整个界面打不开。
 * 与凭据库（缺了它连拉取都用不了）的严重程度不同，所以处理方式也不同。
 *
 * 注意**凭据与代理不在这里** —— 它们仍是整份加密的独立 JSON 文件，
 * 进表会把 name / registry_url / username 变成明文。理由见 docs/design.md。
 */
/** @type {{code: string, message: string} | null} */
let statsInitError = null;
let db = null;
try {
  db = new Db({ filePath: resolvePath(join(config.credentialsDir, 'registry-manager.db')) });
} catch (error) {
  statsInitError = {
    code: 'STATS_STORE_INIT_FAILED',
    message:
      `数据库初始化失败：${error.message}。` +
      `它位于数据目录 ${config.credentialsDir}（需要存在且对运行用户可写）。` +
      `其余功能不受影响；修好目录后重启即可启用热度统计与拉取历史。`,
  };
  console.error(`[registry-manager] ${statsInitError.message}`);
}

// 热度：数据库不可用时整个 store 为 null，查询接口退化成空结构（页面按 /api/config 解释原因）。
const activityStore = db ? new ActivityStore({ db, retentionDays: config.statsRetentionDays }) : null;

/**
 * 清理超期数据（启动时一次 + 每 24 小时一次）。
 *
 * 两类的保留期是**独立配置**，所以分别清理、分别记日志 —— 合并的话迟早会把
 * 其中一个的保留期套到另一个头上。
 */
function cleanupExpired() {
  const result = { activity: 0, dedup: 0, pulls: 0 };
  try {
    if (activityStore) {
      Object.assign(result, activityStore.cleanup());
    }
  } catch (error) {
    console.error('[registry-manager] 热度数据清理失败', error);
  }
  try {
    if (db) {
      Object.assign(result, db.cleanupPullJobs({ retentionDays: config.pullHistoryRetentionDays }));
    }
  } catch (error) {
    console.error('[registry-manager] 拉取历史清理失败', error);
  }
  return result;
}

// 启动时先清一次：保留期被改小时，旧数据不该一直留着。
{
  const removed = cleanupExpired();
  if (removed.pulls > 0) {
    console.log(`[registry-manager] 拉取历史清理：删除 ${removed.pulls} 条超期任务`);
  }
}

const pullQueue = new PullQueue({
  client,
  credentialStore: credentialStore ?? undefined,
  proxyStore: proxyStore ?? undefined,
  historyLimit: config.pullQueueSize,
  // 拉取历史：数据库不可用时退化成原来的"纯内存历史"，不影响拉取本身。
  history: db,
});

const app = express();
app.disable('x-powered-by');
/**
 * 热度事件端点的 body 上限单独放宽（registry 可能把多条事件放进同一个信封）。
 * 该路径在全局解析器里被跳过，改由路由自己解析 —— 这样**密钥校验可以发生在解析之前**，
 * 未授权的请求不消耗解析成本。
 */
const EVENT_PATH = '/api/registry-events';
app.use((req, res, next) => {
  if (req.path === EVENT_PATH) {
    next();
    return;
  }
  express.json({ limit: '32kb' })(req, res, next);
});

function ok(res, payload = {}) {
  res.json({ success: true, code: 'OK', message: '', ...payload });
}

function fail(res, error) {
  const registryError =
    error instanceof RegistryError ? error : new RegistryError(String(error?.message ?? error), 'INTERNAL_ERROR');
  if (registryError.code === 'INTERNAL_ERROR') {
    console.error('[registry-manager] 未预期的错误', error);
  }
  const payload = {
    success: false,
    code: registryError.code,
    message: registryError.message,
  };
  if (registryError.origin) {
    payload.origin = registryError.origin;
  }
  res.json(payload);
}

/** 只暴露连接的目标，不暴露任何可能的凭据（当前实现也没有凭据）。 */
app.get('/api/config', (req, res) => {
  ok(res, {
    data: {
      name: config.name,
      /** 当前运行中的版本，供界面展示；取不到时为空串。 */
      version: appVersion,
      url: config.url,
      host: client.host,
      usingProxy: Boolean(config.proxy),
      /** 是否给本 registry 配了 basic auth（只暴露布尔，密码绝不出接口）。 */
      usingAuth: Boolean(config.username),
      cacheTtlSeconds: config.cacheTtlSeconds,
      allowDelete: config.allowDelete,
      allowPull: config.allowPull,
      pullQueueSize: config.pullQueueSize,
      allowCredentials: Boolean(credentialStore),
      allowProxies: Boolean(proxyStore),
      credentialsDir: config.credentialsDir,
      // 凭据库不可用时把原因一并给出，页面才能显示真正的问题，
      // 而不是一律猜“没配 KEY”。
      credentialError: credentialInitError,
      /** 热度统计是否可用（开关打开 **且** 数据库初始化成功）。 */
      statsEnabled: Boolean(activityStore) && config.allowRegistryEvents,
      /** 是否允许接收 registry 推来的事件（REGISTRY_ALLOW_REGISTRY_EVENTS）。 */
      allowRegistryEvents: config.allowRegistryEvents,
      /** 数据库初始化失败的原因；正常时为 null。 */
      statsError: statsInitError,
      /** 是否配了热度事件的共享密钥。**只暴露布尔，密钥绝不出接口**。 */
      notifyTokenConfigured: Boolean(config.notifyToken),
      /** 热度数据最早的一天，用来在空状态里说明“从什么时候开始有数据”。 */
      statsSince: activityStore ? activityStore.earliestDay() : null,
      statsRetentionDays: config.statsRetentionDays,
      /** 拉取历史的保留天数（与热度分开配置）。 */
      pullHistoryRetentionDays: config.pullHistoryRetentionDays,
    },
  });
});

app.get('/api/inventory', async (req, res) => {
  try {
    const snapshot = await inventory.get();
    ok(res, { data: snapshot });
  } catch (error) {
    fail(res, error);
  }
});

app.post('/api/refresh', async (req, res) => {
  try {
    const snapshot = await inventory.get({ force: true });
    ok(res, { data: snapshot });
  } catch (error) {
    fail(res, error);
  }
});

app.post('/api/probe', async (req, res) => {
  try {
    ok(res, { data: await client.probe() });
  } catch (error) {
    fail(res, error);
  }
});

app.delete('/api/tags', async (req, res) => {
  // 只读模式：给运维一个不依赖 registry 侧配置的"关掉破坏性操作"的开关。
  if (!config.allowDelete) {
    fail(
      res,
      new RegistryError(
        '当前为只读模式（allowDelete=false），已拒绝删除。移除该配置或设为 true 后重启服务即可恢复。',
        'DELETE_FORBIDDEN'
      )
    );
    return;
  }

  const repositoryName = String(req.query.repository ?? '');
  const tag = String(req.query.tag ?? '');
  if (!repositoryName || !tag) {
    fail(res, new RegistryError('缺少 repository 或 tag 参数', 'INVALID_REQUEST'));
    return;
  }
  try {
    const snapshot = await inventory.get();
    const repository = snapshot.repositories.find((item) => item.name === repositoryName);
    const target = repository?.tags.find((item) => item.tag === tag);
    if (!target) {
      throw new RegistryError(
        `${repositoryName}:${tag} 不在当前清单中，请先刷新`,
        'REPOSITORY_NOT_FOUND',
        { name: repositoryName }
      );
    }

    // 一个 digest 可能被多个 tag 指向，删除会一次影响它们，先算清影响面。
    const affectedTags = repository.tags
      .filter((item) => item.digest === target.digest)
      .map((item) => item.tag)
      .sort();

    await client.deleteManifest(repositoryName, target.digest);
    console.log(
      `[registry-manager] 已删除 ${repositoryName}@${target.digest}（影响 ${affectedTags.length} 个 tag）`
    );

    const refreshed = await inventory.refreshRepository(repositoryName);
    ok(res, {
      code: 'DELETED',
      message: `已删除 ${tag}，该仓库剩余 ${refreshed.tagCount} 个 tag。`,
      data: {
        deletedTag: tag,
        digest: target.digest,
        affectedTags,
        repository: refreshed,
      },
    });
  } catch (error) {
    fail(res, error);
  }
});

// ---------------------------------------------------------------------------
// 镜像拉取：单并发 + FIFO 队列。allowPull=false 时整组路由拒绝写入（GET 列表仍可读）。
// ---------------------------------------------------------------------------

function ensurePullAllowed(req, res, next) {
  // 关闭拉取模式后：GET 列表/详情仍可读，便于查看历史任务；POST/DELETE 一律拒绝。
  if (config.allowPull || req.method === 'GET') {
    next();
    return;
  }
  fail(
    res,
    new RegistryError(
      '当前为禁止拉取模式（allowPull=false），已拒绝写入。',
      'PULL_DISABLED'
    )
  );
}

function readPullJobId(req) {
  return String(req.params.id ?? '').trim();
}

app.post('/api/pull/jobs', ensurePullAllowed, async (req, res) => {
  const body = req.body ?? {};
  try {
    const job = pullQueue.enqueue({
      sourceUrl: String(body.sourceUrl ?? ''),
      sourceRef: String(body.sourceRef ?? ''),
      sourceProxy: body.sourceProxy ? String(body.sourceProxy) : '',
      sourceProxyId: body.sourceProxyId ? String(body.sourceProxyId) : '',
      destRepo: String(body.destRepo ?? ''),
      destTag: body.destTag ? String(body.destTag) : '',
      sourceCredentialId: body.sourceCredentialId ? String(body.sourceCredentialId) : '',
      // 临时 inline 凭据：不落库；只在这一次任务的 runner 内使用。
      // 安全前提：网络层 HTTPS / 代理可信，HTTP body 仅在反向代理 / 进程内存中。
      sourceAuthInline: body.sourceAuthInline
        ? {
            username: String(body.sourceAuthInline.username ?? ''),
            password: String(body.sourceAuthInline.password ?? ''),
          }
        : undefined,
    });
    ok(res, { data: job, message: '已加入队列' });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * 创建任务前的预检：一次请求同时回答两件事
 *   1. 源 registry 是否可达、兼容 V2（GET /v2/）；
 *   2. 目标 tag 在本仓库是否已存在、digest 是否与源一致
 *      （两侧各一次 HEAD manifest，都是只读，不写任何东西）。
 *
 * 目的端主机固定来自配置，所以这里只能探测本 registry 内的路径。
 */
app.post('/api/pull/probe', ensurePullAllowed, async (req, res) => {
  const body = req.body ?? {};
  const rawUrl = String(body.sourceUrl ?? '');
  let proxyUrl = body.sourceProxy ? String(body.sourceProxy) : '';
  const credentialId = body.credentialId ? String(body.credentialId) : '';
  const proxyId = body.proxyId ? String(body.proxyId) : '';
  let auth;
  // 用了代理库里的代理，就把它的地址（含 basic auth）取出来用于预检，
  // 与真实拉取走同一条路径。
  if (proxyId) {
    if (!proxyStore) {
      fail(res, new RegistryError('代理库未配置', 'CREDENTIAL_KEY_MISSING'));
      return;
    }
    const proxy = proxyStore.get(proxyId);
    if (!proxy) {
      fail(res, new RegistryError('代理不存在', 'JOB_NOT_FOUND'));
      return;
    }
    proxyUrl = buildProxyUrl(proxy);
  }
  if (credentialId) {
    if (!credentialStore) {
      fail(res, new RegistryError('凭据库未配置', 'PULL_DISABLED'));
      return;
    }
    const c = credentialStore.get(credentialId);
    if (!c) {
      fail(res, new RegistryError('凭据不存在', 'JOB_NOT_FOUND'));
      return;
    }
    try {
      assertCredentialUsable(c, rawUrl);
    } catch (error) {
      fail(res, error);
      return;
    }
    auth = { username: c.username, password: c.password };
  }
  try {
    // 注意命名：下面用的是**源端** client；探测目标 tag 现状必须用模块级的
    // `client`（本仓库，带配置里的凭据），否则会去源 registry 上查目标仓库，
    // 得出完全错误的"是否已存在 / 会不会被替换"结论。
    const sourceClient = new RegistryClient({ url: rawUrl, proxy: proxyUrl, auth });
    const probe = await sourceClient.probe({ origin: 'source' });
    const data = { ...probe, sourceUrl: sourceClient.baseUrl, usingProxy: Boolean(proxyUrl) };

    // 目标 tag 现状：解析入参（destRepo/destTag 都允许缺省，与创建任务同一套默认）。
    const destInfo = resolveDestReference(body);
    if (destInfo) {
      data.dest = destInfo;
      try {
        const sourceManifest = await sourceClient.probeManifest(
          destInfo.sourceRepo,
          destInfo.sourceTag,
          { origin: 'source', dispatcher: sourceClient.dispatcher }
        );
        const destManifest = await client.probeManifest(destInfo.destRepo, destInfo.destTag, {
          origin: 'dest',
        });
        data.dest = {
          ...destInfo,
          exists: destManifest.exists,
          existingDigest: destManifest.digest,
          sourceExists: sourceManifest.exists,
          sourceDigest: sourceManifest.digest,
          // 已存在且 digest 相同 → 重复拉取没有意义；不同 → 会替换现有 tag。
          willReplace: destManifest.exists && destManifest.digest !== sourceManifest.digest,
          identical:
            destManifest.exists &&
            Boolean(destManifest.digest) &&
            destManifest.digest === sourceManifest.digest,
        };
      } catch (error) {
        // 目标探测失败不该让整个预览失败：源可达信息已经拿到了，
        // 把探测失败降级成一条提示即可。
        data.dest = {
          ...destInfo,
          probeError:
            error instanceof RegistryError ? error.message : String(error?.message ?? error),
        };
      }
    }

    ok(res, { data });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * 从预览入参解析出源 / 目标引用。入参不足以解析时返回 null（预览仍然可用）。
 * 复用 puller 的口径：destRepo 缺省 = 源仓库路径，destTag 缺省 = 源 tag。
 */
function resolveDestReference(body) {
  const sourceRef = String(body.sourceRef ?? '').trim();
  if (!sourceRef) {
    return null;
  }
  const colon = sourceRef.lastIndexOf(':');
  if (colon < 0) {
    return null;
  }
  const sourceRepo = sourceRef.slice(0, colon).replace(/^\/+/, '');
  const sourceTag = sourceRef.slice(colon + 1);
  if (!sourceRepo || !sourceTag) {
    return null;
  }
  const destRepo = String(body.destRepo ?? '').trim() || sourceRepo;
  const destTag = String(body.destTag ?? '').trim() || sourceTag;
  return { sourceRepo, sourceTag, destRepo, destTag };
}

/** 任务列表单次最多返回多少条历史（内存里的活任务不计入这个上限）。 */
const PULL_HISTORY_LIMIT = 500;

/**
 * 任务列表：**内存里的活任务 + 数据库里的历史**。
 *
 * 内存只管"这次运行中的"（queued / running 与刚完成的几条），重启后是空的；
 * 历史在库里，所以重启也查得到 —— 这正是把拉取历史落库的目的。
 * 两边按 id 去重（刚完成的任务两边都有），以内存那份为准（它带着完整的 phases）。
 */
function collectPullJobs() {
  const live = pullQueue.list();
  if (!db) {
    return live;
  }
  const seen = new Set(live.map((job) => job.id));
  const history = db.listPullJobs({ limit: PULL_HISTORY_LIMIT });
  return [...live, ...history.filter((job) => !seen.has(job.id))].sort((a, b) =>
    String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
  );
}

app.get('/api/pull/jobs', (req, res) => {
  ok(res, { data: collectPullJobs() });
});

app.get('/api/pull/jobs/:id', (req, res) => {
  const id = readPullJobId(req);
  const job = pullQueue.get(id) ?? db?.getPullJob(id) ?? null;
  if (!job) {
    fail(res, new RegistryError('任务不存在', 'JOB_NOT_FOUND'));
    return;
  }
  ok(res, { data: job });
});

app.post('/api/pull/jobs/:id/cancel', ensurePullAllowed, (req, res) => {
  const id = readPullJobId(req);
  try {
    const job = pullQueue.cancel(id);
    ok(res, {
      code: 'CANCELLED',
      message: '已请求取消，传输中的 chunk 会写完再退出',
      data: job,
    });
  } catch (error) {
    fail(res, error);
  }
});

app.delete('/api/pull/jobs/:id', ensurePullAllowed, (req, res) => {
  const id = readPullJobId(req);
  try {
    // 顺序要紧：内存里的先删（运行中的任务会在这里抛错，不该被删），再删库里的历史。
    // 只删内存不删库的话，重启后这条任务会"复活"。
    const inMemory = pullQueue.remove(id);
    const inHistory = db ? db.removePullJob(id) : false;
    if (!inMemory && !inHistory) {
      fail(res, new RegistryError('任务不存在', 'JOB_NOT_FOUND'));
      return;
    }
    ok(res, { data: { id } });
  } catch (error) {
    fail(res, error);
  }
});

// ---------------------------------------------------------------------------
// 凭据库（加密 JSON 文件 + AES-256-GCM）
// ---------------------------------------------------------------------------

function ensureCredentialsAvailable(req, res, next) {
  ensureSecretsAvailable(res, next, credentialStore, '凭据库');
}

/** 凭据库与代理库共用同一个密钥与数据目录，不可用的原因是同一个。 */
function ensureSecretsAvailable(res, next, store, label) {
  if (!store) {
    fail(
      res,
      new RegistryError(
        `${label}未配置：服务启动时未设置 REGISTRY_CREDENTIAL_KEY，请参考 README 配置密钥后重启`,
        'CREDENTIAL_KEY_MISSING'
      )
    );
    return;
  }
  next();
}

function ensureProxiesAvailable(req, res, next) {
  ensureSecretsAvailable(res, next, proxyStore, '代理库');
}

function readCredentialId(req) {
  return String(req.params.id ?? '').trim();
}

// 注意：凭据读取是同步的，且会在「密钥不匹配 / 文件被破坏」时抛错。
// 必须自己 try/catch，否则 Express 会兜成 500 HTML，前端拿不到 CREDENTIAL_DECRYPT_FAILED 这类可读错误。
app.get('/api/credentials', ensureCredentialsAvailable, (req, res) => {
  try {
    const items = credentialStore.list();
    ok(res, { data: items.map(pickCredentialPublic) });
  } catch (error) {
    fail(res, error);
  }
});

app.get('/api/credentials/:id', ensureCredentialsAvailable, (req, res) => {
  try {
    const item = credentialStore.get(readCredentialId(req));
    if (!item) {
      fail(res, new RegistryError('凭据不存在', 'JOB_NOT_FOUND'));
      return;
    }
    ok(res, { data: pickCredentialPublic(item) });
  } catch (error) {
    fail(res, error);
  }
});

app.post('/api/credentials', ensureCredentialsAvailable, async (req, res) => {
  try {
    const item = await credentialStore.create(req.body ?? {});
    ok(res, { data: pickCredentialPublic(item), message: '已创建凭据' });
  } catch (error) {
    fail(res, error);
  }
});

app.patch('/api/credentials/:id', ensureCredentialsAvailable, async (req, res) => {
  try {
    const item = await credentialStore.update(readCredentialId(req), req.body ?? {});
    ok(res, { data: pickCredentialPublic(item), message: '已更新凭据' });
  } catch (error) {
    fail(res, error);
  }
});

app.delete('/api/credentials/:id', ensureCredentialsAvailable, async (req, res) => {
  try {
    const result = await credentialStore.remove(readCredentialId(req));
    ok(res, { data: result, message: '已删除凭据' });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * 测试凭据：用此凭据对 registryUrl 跑一次 GET /v2/。
 * 用来确认账号密码有效，避免拉一半才发现 401。
 */
app.post('/api/credentials/:id/test', ensureCredentialsAvailable, async (req, res) => {
  const id = readCredentialId(req);
  const c = credentialStore.get(id);
  if (!c) {
    fail(res, new RegistryError('凭据不存在', 'JOB_NOT_FOUND'));
    return;
  }
  try {
    const client = new RegistryClient({
      url: c.registryUrl,
      auth: { username: c.username, password: c.password },
    });
    const probe = await client.probe({ origin: 'source' });
    ok(res, {
      data: {
        ...probe,
        registryUrl: c.registryUrl,
      },
    });
  } catch (error) {
    // 这条路径是"拿已存的账号密码去连"，401 的含义是凭据本身不对，
    // 而不是"没配认证"——换一条专门的文案，避免用户去改错误的地方。
    if (error instanceof RegistryError && error.code === 'UNAUTHORIZED') {
      fail(
        res,
        new RegistryError(
          `凭据「${c.name}」认证失败（HTTP 401）：账号或密码不正确，或该账号无权访问 ${c.registryUrl}。`,
          'CREDENTIAL_INVALID'
        )
      );
      return;
    }
    fail(res, error);
  }
});

// ---------------------------------------------------------------------------
// 代理库（只服务外部源；本 registry 的代理在配置文件的 proxy 里）
// ---------------------------------------------------------------------------

function readProxyId(req) {
  return String(req.params.id ?? '').trim();
}

app.get('/api/proxies', ensureProxiesAvailable, (req, res) => {
  try {
    ok(res, { data: proxyStore.list().map(pickProxyPublic) });
  } catch (error) {
    fail(res, error);
  }
});

app.get('/api/proxies/:id', ensureProxiesAvailable, (req, res) => {
  try {
    const item = proxyStore.get(readProxyId(req));
    if (!item) {
      fail(res, new RegistryError('代理不存在', 'JOB_NOT_FOUND'));
      return;
    }
    ok(res, { data: pickProxyPublic(item) });
  } catch (error) {
    fail(res, error);
  }
});

app.post('/api/proxies', ensureProxiesAvailable, async (req, res) => {
  try {
    const item = await proxyStore.create(req.body ?? {});
    ok(res, { data: pickProxyPublic(item), message: '已创建代理' });
  } catch (error) {
    fail(res, error);
  }
});

app.patch('/api/proxies/:id', ensureProxiesAvailable, async (req, res) => {
  try {
    const item = await proxyStore.update(readProxyId(req), req.body ?? {});
    ok(res, { data: pickProxyPublic(item), message: '已更新代理' });
  } catch (error) {
    fail(res, error);
  }
});

app.delete('/api/proxies/:id', ensureProxiesAvailable, async (req, res) => {
  try {
    const result = await proxyStore.remove(readProxyId(req));
    ok(res, { data: result, message: '已删除代理' });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * 测试代理连通性：实际穿过这个代理去访问一个目标，报告状态码与耗时。
 *
 * `targetUrl` 可选，默认本 registry 的 `/v2/`（这是最常需要经代理访问的目标）；
 * 想验证"能不能出外网"就填 https://registry-1.docker.io/v2/ 之类。
 */
app.post('/api/proxies/:id/test', ensureProxiesAvailable, async (req, res) => {
  const id = readProxyId(req);
  const proxy = proxyStore.get(id);
  if (!proxy) {
    fail(res, new RegistryError('代理不存在', 'JOB_NOT_FOUND'));
    return;
  }
  const rawTarget = String(req.body?.targetUrl ?? '').trim();
  const targetUrl = rawTarget || `${config.url.replace(/\/+$/, '')}/v2/`;
  if (!/^https?:\/\//i.test(targetUrl)) {
    fail(res, new RegistryError('测试目标必须以 http:// 或 https:// 开头', 'INVALID_REQUEST'));
    return;
  }
  try {
    new URL(targetUrl);
  } catch {
    fail(res, new RegistryError(`测试目标无法解析：${targetUrl}`, 'INVALID_REQUEST'));
    return;
  }
  const result = await testProxyConnectivity(proxy, targetUrl);
  if (result.ok) {
    ok(res, { data: result });
    return;
  }
  fail(res, new RegistryError(result.error, 'PROXY_TEST_FAILED'));
});

// ───────────────────────────── 热度统计 ─────────────────────────────

/** 读取并夹紧一个整数查询参数。 */
function readInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

/**
 * registry 推来的热度事件。
 *
 * 这是**唯一面向机器的写接口**（Distribution 的 notifications.endpoints 会 POST 到这里），
 * 所以和浏览器接口刻意有三点不同：
 *   - **先验共享密钥再解析 body**，未授权的请求不消耗解析成本；
 *   - **失败返回真实的 HTTP 状态码** —— registry 靠状态码决定要不要重试与告警，
 *     统一回 200 会让"配置写错了"彻底静默，用户永远等不到热度数据。
 *   - 成功仍带 `{success}` 信封，与其它接口一致（registry 不看 body）。
 */
app.post(
  EVENT_PATH,
  (req, res, next) => {
    if (!config.allowRegistryEvents) {
      res.status(503).json({
        success: false,
        code: 'EVENTS_DISABLED',
        message: '服务端已关闭热度事件接收（REGISTRY_ALLOW_REGISTRY_EVENTS=false）。',
      });
      return;
    }
    if (!activityStore) {
      res.status(503).json({
        success: false,
        code: 'STATS_UNAVAILABLE',
        message: statsInitError?.message ?? '热度统计不可用。',
      });
      return;
    }
    const verdict = verifyNotifyToken(req.get('authorization'), config.notifyToken);
    if (!verdict.ok) {
      // 既不回显收到的值，也不回显期望值。
      res.status(401).json({ success: false, code: verdict.code, message: verdict.message });
      return;
    }
    next();
  },
  (req, res, next) => {
    // `type: () => true` 是必需的，不是偷懒：Distribution 发事件时用的
    // `Content-Type` 是 `application/vnd.docker.distribution.events.v2+json`，
    // 而 express.json 默认只解析 `application/json` —— 不放开的话 req.body 会是 {}，
    // 每条事件都被静默吞掉，接口还回 200，用户永远等不到热度数据。
    express.json({ limit: '256kb', type: () => true })(req, res, (error) => {
      if (error) {
        res.status(400).json({
          success: false,
          code: 'INVALID_REQUEST',
          message: `热度事件体无法解析：${error.message}`,
        });
        return;
      }
      next();
    });
  },
  (req, res) => {
    // 与上面的放开配套：body 解不出来时**大声拒绝**，而不是当成"零条事件"回 200。
    // 静默成功会让配置问题完全不可见 —— 接口全绿、热度永远是空的。
    if (!Array.isArray(req.body?.events)) {
      res.status(400).json({
        success: false,
        code: 'INVALID_REQUEST',
        message: '热度事件体缺少 events 数组。请确认 registry 的 notifications 配置指向本接口。',
      });
      return;
    }
    try {
      ok(res, { data: activityStore.ingest(req.body) });
    } catch (error) {
      fail(res, error);
    }
  }
);

/**
 * 热度查询。
 *
 * 统计不可用（数据库初始化失败）或尚未收到任何事件时，一律返回**空结构**而不是报错 ——
 * 页面的"未启用"空状态依赖 /api/config 里的 statsEnabled / statsError 来解释原因，
 * 不该让查询接口变成一个错误弹窗。
 */
app.get('/api/stats/summary', (req, res) => {
  const days = readInt(req.query.days, 30, 1, 3650);
  ok(res, { data: activityStore ? activityStore.summary(days) : emptySummary(days) });
});

app.get('/api/stats/top', (req, res) => {
  const days = readInt(req.query.days, 30, 1, 3650);
  const limit = readInt(req.query.limit, 20, 1, 500);
  const by = req.query.by === 'tag' ? 'tag' : 'repository';
  ok(res, {
    data: { days, by, items: activityStore ? activityStore.top({ days, limit, by }) : [] },
  });
});

app.get('/api/stats/series', (req, res) => {
  const days = readInt(req.query.days, 30, 1, 3650);
  const repository = String(req.query.repository ?? '').trim();
  ok(res, {
    data: { days, repository, points: activityStore ? activityStore.series({ days, repository }) : [] },
  });
});

/** 全部**有热度**的仓库，供镜像列表页做一次 join（返回 map 便于前端 O(1) 查）。 */
app.get('/api/stats/repositories', (req, res) => {
  const days = readInt(req.query.days, 30, 1, 3650);
  const map = activityStore ? activityStore.forRepositories(days) : new Map();
  ok(res, { data: { days, items: Object.fromEntries(map) } });
});

/** 最近收到的原始事件。**排查用**：事件没到、口径不对，都靠它定位。 */
app.get('/api/stats/events', (req, res) => {
  const limit = readInt(req.query.limit, 50, 1, 200);
  ok(res, {
    data: {
      items: activityStore ? activityStore.recentEvents(limit) : [],
      totals: activityStore ? activityStore.totals() : { accepted: 0, rejected: 0, buffered: 0 },
    },
  });
});

/**
 * 清空**全部热度数据**（不按保留期）。
 *
 * 用途是"口径改正后从头重计"：热度一旦被某个自动化进程刷高，修正过滤只对以后生效，
 * 已经聚合进 `activity_daily` 的行追溯不出来，只能清掉重新累计。
 * **不碰拉取历史** —— 那是任务记录，不是统计口径的产物。
 */
app.delete('/api/stats/heat', (req, res) => {
  if (!activityStore) {
    fail(
      res,
      new RegistryError('热度统计未启用，没有可清空的数据。', 'STATS_DISABLED')
    );
    return;
  }
  try {
    const removed = activityStore.purge();
    ok(res, {
      data: removed,
      message: `已清空热度数据（${removed.activity} 行按天聚合、${removed.seen} 条去重记录），从现在重新累计`,
    });
  } catch (error) {
    fail(res, error);
  }
});

// 生产态同源托管前端；开发态由 Vite 提供页面。
const distDir = resolve(import.meta.dirname, '../web/dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) {
      next();
      return;
    }
    res.sendFile(resolve(distDir, 'index.html'));
  });
}

app.use((req, res) => {
  res.status(404).json({ success: false, code: 'NOT_FOUND', message: `未知接口: ${req.method} ${req.path}` });
});

const server = app.listen(config.port, () => {
  console.log(`[registry-manager] 已启动: http://127.0.0.1:${config.port}`);
  console.log(`[registry-manager] 目标仓库: ${config.url}${config.proxy ? ` (经代理 ${config.proxy})` : ''}`);
  if (!credentialStore && credentialInitError) {
    // 具体原因已在上面的初始化分支打过 ERROR；这里只补一句影响面。
    console.warn(
      `[registry-manager] 凭据库不可用（${credentialInitError.code}）。镜像拉取仍可工作（匿名源 / 临时输入），但不能使用凭据库。`
    );
  }
  if (!existsSync(distDir)) {
    console.log('[registry-manager] 未发现 web/dist，开发态请访问 Vite 地址（默认 http://127.0.0.1:5273）');
  }
  if (activityStore) {
    console.log(
      `[registry-manager] 热度统计已启用（保留 ${config.statsRetentionDays} 天）` +
        (config.allowRegistryEvents ? '' : '，但已关闭事件接收')
    );
    if (!config.notifyToken) {
      // 安全默认值：没配密钥时拒绝所有事件。必须说清楚，否则用户会以为配好了 registry 就有数据。
      console.warn(
        '[registry-manager] 未设置 REGISTRY_NOTIFY_TOKEN，热度事件会被全部拒绝。' +
          '配置该变量并在 registry 的 notifications.headers.Authorization 里填同一个值，重启后开始统计。'
      );
    } else if (activityStore.earliestDay() === null) {
      /*
       * "配了一半"的典型情形：这边设了密钥，但 registry 侧没加 notifications ——
       * 页面永远是空的，而日志里没有任何线索。这是最容易卡住人的一种状态，主动说一句。
       */
      console.warn(
        '[registry-manager] 还没收到过任何热度事件。热度需要 registry 侧配合：' +
          '在它的 config.yml 里加一段 notifications 指向本服务的 /api/registry-events、' +
          '用同一个密钥，然后**重启 registry 容器**（Distribution 没有配置热重载）。' +
          '步骤见 README 的「镜像热度」一节。'
      );
    }
  } else if (statsInitError) {
    console.warn(`[registry-manager] 热度统计不可用（${statsInitError.code}）。其余功能不受影响。`);
  }
  if (db) {
    console.log(
      `[registry-manager] 拉取历史已落库（保留 ${config.pullHistoryRetentionDays} 天），重启不再丢失`
    );
  }
});

// 每天清一次超期数据。unref 掉，避免它阻止进程退出。
// 每 24 小时清一次超期数据（热度 + 拉取历史，各自的保留期）。unref 掉，避免它阻止进程退出。
const cleanupTimer = db
  ? setInterval(() => {
      const removed = cleanupExpired();
      if (removed.activity > 0 || removed.dedup > 0 || removed.pulls > 0) {
        console.log(
          `[registry-manager] 数据清理：热度聚合 ${removed.activity} 行、去重 ${removed.dedup} 行、拉取历史 ${removed.pulls} 条`
        );
      }
    }, 24 * 3600 * 1000)
  : null;
cleanupTimer?.unref();

// 容器里 docker stop 发的是 SIGTERM。先停止接收新连接、等在途请求结束再退出，
// 避免部署重启时打断正在进行的扫描。
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[registry-manager] 收到 ${signal}，正在关闭…`);
    clearInterval(cleanupTimer);
    const shutdown = () => {
      // 让 SQLite 走完 WAL 检查点，避免容器重启后留下 -wal / -shm 残留文件。
      activityStore?.close();
      process.exit(0);
    };
    server.close(shutdown);
    // 兜底：连接迟迟不释放时强制退出，避免容器卡在 stopping。
    setTimeout(shutdown, 5000).unref();
  });
}
