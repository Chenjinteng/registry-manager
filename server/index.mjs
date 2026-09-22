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

import { loadConfig } from './config.mjs';
import { Inventory } from './inventory.mjs';
import { RegistryClient, RegistryError } from './registry-client.mjs';
import { PullQueue } from './puller.mjs';
import { CredentialStore, pickCredentialPublic, assertCredentialUsable } from './credentials.mjs';
import { resolve as resolvePath, join } from 'node:path';

const config = loadConfig();
const client = new RegistryClient({ url: config.url, proxy: config.proxy });
const inventory = new Inventory(client, { ttlSeconds: config.cacheTtlSeconds });

/**
 * 凭据库：必填密钥 REGISTRY_CREDENTIAL_KEY。
 * 这里读 env；如果没设，服务启动时直接报错，避免无密钥凭据库静默运行。
 */
const credentialKey = String(process.env.REGISTRY_CREDENTIAL_KEY ?? '').trim();
if (!credentialKey) {
  // 不直接 throw —— 后面 server.listen 之前再处理，这里只 warning。
  // 但我们确实要 hard fail：在 listen 之前 throw。
  // 移到下面 listen 之前做。
}
const credentialsFile = resolvePath(join(config.credentialsDir, 'credentials.json'));
let credentialStore;
try {
  credentialStore = credentialKey
    ? new CredentialStore({ filePath: credentialsFile, masterKey: credentialKey })
    : null;
} catch (error) {
  console.error(`[registry-manager] 凭据库初始化失败：${error.message}`);
  credentialStore = null;
}

const pullQueue = new PullQueue({
  client,
  credentialStore: credentialStore ?? undefined,
  historyLimit: config.pullQueueSize,
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

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
      url: config.url,
      host: client.host,
      usingProxy: Boolean(config.proxy),
      cacheTtlSeconds: config.cacheTtlSeconds,
      allowDelete: config.allowDelete,
      allowPull: config.allowPull,
      pullQueueSize: config.pullQueueSize,
      allowCredentials: Boolean(credentialStore),
      credentialsDir: config.credentialsDir,
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
      destRepo: String(body.destRepo ?? ''),
      destTag: body.destTag ? String(body.destTag) : '',
      sourceCredentialId: body.sourceCredentialId ? String(body.sourceCredentialId) : '',
      destCredentialId: body.destCredentialId ? String(body.destCredentialId) : '',
      // 临时 inline 凭据：不落库；只在这一次任务的 runner 内使用。
      // 安全前提：网络层 HTTPS / 代理可信，HTTP body 仅在反向代理 / 进程内存中。
      sourceAuthInline: body.sourceAuthInline
        ? {
            username: String(body.sourceAuthInline.username ?? ''),
            password: String(body.sourceAuthInline.password ?? ''),
          }
        : undefined,
      destAuthInline: body.destAuthInline
        ? {
            username: String(body.destAuthInline.username ?? ''),
            password: String(body.destAuthInline.password ?? ''),
          }
        : undefined,
    });
    ok(res, { data: job, message: '已加入队列' });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * 源端预检：创建任务前先打一次 GET /v2/，确认源 registry 可达 + 兼容 V2。
 * 不创建任务，不入队。目的端的预检走 /api/probe（由目的客户端覆盖）。
 */
app.post('/api/pull/probe', ensurePullAllowed, async (req, res) => {
  const body = req.body ?? {};
  const rawUrl = String(body.sourceUrl ?? '');
  const proxy = body.sourceProxy ? String(body.sourceProxy) : '';
  const credentialId = body.credentialId ? String(body.credentialId) : '';
  let auth;
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
      assertCredentialUsable(c, 'source', rawUrl);
    } catch (error) {
      fail(res, error);
      return;
    }
    auth = { username: c.username, password: c.password };
  }
  try {
    const client = new RegistryClient({ url: rawUrl, proxy, auth });
    const probe = await client.probe({ origin: 'source' });
    ok(res, {
      data: { ...probe, sourceUrl: client.baseUrl, usingProxy: Boolean(proxy) },
    });
  } catch (error) {
    fail(res, error);
  }
});

app.get('/api/pull/jobs', (req, res) => {
  ok(res, { data: pullQueue.list() });
});

app.get('/api/pull/jobs/:id', (req, res) => {
  const job = pullQueue.get(readPullJobId(req));
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
    const removed = pullQueue.remove(id);
    if (!removed) {
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
  if (!credentialStore) {
    fail(
      res,
      new RegistryError(
        '凭据库未配置：服务启动时未设置 REGISTRY_CREDENTIAL_KEY，请参考 README 配置密钥后重启',
        'CREDENTIAL_KEY_MISSING'
      )
    );
    return;
  }
  next();
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
    const probe = await client.probe({ origin: c.purpose === 'dest' ? 'dest' : 'source' });
    ok(res, {
      data: {
        ...probe,
        registryUrl: c.registryUrl,
        purpose: c.purpose,
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
  if (!credentialStore) {
    console.warn(
      '[registry-manager] 未配置 REGISTRY_CREDENTIAL_KEY，凭据库不可用。镜像拉取仍可工作（匿名源），但不能添加 basic auth 凭据。'
    );
  }
  if (!existsSync(distDir)) {
    console.log('[registry-manager] 未发现 web/dist，开发态请访问 Vite 地址（默认 http://127.0.0.1:5273）');
  }
});

// 容器里 docker stop 发的是 SIGTERM。先停止接收新连接、等在途请求结束再退出，
// 避免部署重启时打断正在进行的扫描。
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[registry-manager] 收到 ${signal}，正在关闭…`);
    server.close(() => process.exit(0));
    // 兜底：连接迟迟不释放时强制退出，避免容器卡在 stopping。
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
