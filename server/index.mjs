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

const config = loadConfig();
const client = new RegistryClient({ url: config.url, proxy: config.proxy });
const inventory = new Inventory(client, { ttlSeconds: config.cacheTtlSeconds });
const pullQueue = new PullQueue({ client, historyLimit: config.pullQueueSize });

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
  res.json({ success: false, code: registryError.code, message: registryError.message });
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
    });
    ok(res, { data: job, message: '已加入队列' });
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
