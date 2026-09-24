#!/usr/bin/env node
/**
 * 验证「镜像热度」的接收与聚合口径。
 *
 * 这里断言的不是"代码能跑"，而是**口径本身**。三条判据各自对应一个会静默污染数据的坑
 * （见 docs/pull-heat.md §3），所以每条都必须有一条断言钉住：
 *
 *   1. blob 事件（mediaType = application/octet-stream）必须被丢弃
 *      —— 否则一次 15 层的 pull 会产生 15 条计数，热度被层数放大十几倍；
 *   2. pull 的内容下载（method=GET、按 digest、无 tag）必须被丢弃
 *      —— Docker 的 pull 是先按 tag HEAD 再按 digest GET，两条都算就是翻倍；
 *   3. `docker push` 在探测 blob 存在性时会发出 action="pull" + method=HEAD 的事件
 *      —— 不过滤的话推一个 20 层的镜像会凭空多出 20 次"拉取"。
 *
 * 事件形状全部照抄真实 registry:3.1.1 抓到的 payload（见同目录的实测记录），
 * 不用"我以为"的结构 —— mock 与真实不同形过一次（/v2/ 挑战是否带 scope），
 * 那次教训写进了 AGENTS.md。
 *
 * 用法：node --disable-warning=ExperimentalWarning scripts/verify-stats.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ActivityStore, classifyEvent, verifyNotifyToken } from '../server/events.mjs';
import { Db } from '../server/db.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const MANIFEST = 'application/vnd.docker.distribution.manifest.v2+json';

let seq = 0;
const nextId = () => `01a0d165-0000-7000-8000-${String(++seq).padStart(12, '0')}`;
/** 用"一小时前"而不是固定日期，这样断言与运行日期无关。 */
const recentIso = () => new Date(Date.now() - 3600_000).toISOString();

/** manifest 事件。tag 只在按 tag 请求时出现 —— 真实 payload 就是这样。 */
function manifestEvent({ repository, action, method, tag, digest = 'sha256:beef' }) {
  const target = { mediaType: MANIFEST, digest, size: 3247, repository };
  if (tag !== undefined) {
    target.tag = tag;
  }
  return {
    id: nextId(),
    timestamp: recentIso(),
    action,
    target,
    request: { id: nextId(), method, useragent: 'docker/29.6.1 go/go1.26.4' },
    actor: {},
  };
}

/** blob 事件：mediaType 恒为 application/octet-stream（实测）。 */
function blobEvent({ repository, action, method, digest = 'sha256:cafe', size = 1024 }) {
  return {
    id: nextId(),
    timestamp: recentIso(),
    action,
    target: { mediaType: 'application/octet-stream', digest, size, length: size, repository },
    request: { id: nextId(), method, useragent: 'docker/29.6.1 go/go1.26.4' },
    actor: {},
  };
}

// ───────────────────── 一、口径：纯函数判定 ─────────────────────
{
  const repo = 'postgres';

  const tagProbe = classifyEvent(manifestEvent({ repository: repo, action: 'pull', method: 'HEAD', tag: '15' }));
  check(
    'pull 的 tag 解析（HEAD，带 tag）计入，且 tag 正确',
    tagProbe.counted === true && tagProbe.tag === '15' && tagProbe.action === 'pull',
    JSON.stringify(tagProbe)
  );

  const contentFetch = classifyEvent(manifestEvent({ repository: repo, action: 'pull', method: 'GET' }));
  check(
    'pull 的内容下载（GET，无 tag）不计入 —— 防翻倍',
    contentFetch.counted === false && contentFetch.reason === 'METHOD_GET',
    JSON.stringify(contentFetch)
  );

  const pushManifest = classifyEvent(manifestEvent({ repository: repo, action: 'push', method: 'PUT', tag: '15' }));
  check(
    'push 落库（PUT，带 tag）计入',
    pushManifest.counted === true && pushManifest.action === 'push' && pushManifest.tag === '15',
    JSON.stringify(pushManifest)
  );

  const layerPull = classifyEvent(blobEvent({ repository: repo, action: 'pull', method: 'GET' }));
  check(
    'blob 的 GET 不计入 —— 防层数放大',
    layerPull.counted === false && layerPull.reason === 'NOT_MANIFEST',
    JSON.stringify(layerPull)
  );

  const pushBlobProbe = classifyEvent(blobEvent({ repository: repo, action: 'pull', method: 'HEAD' }));
  check(
    'push 时的 blob 探测（action=pull + HEAD + octet-stream）不计入 —— 防假 pull',
    pushBlobProbe.counted === false && pushBlobProbe.reason === 'NOT_MANIFEST',
    JSON.stringify(pushBlobProbe)
  );

  const digestPull = classifyEvent(manifestEvent({ repository: repo, action: 'pull', method: 'HEAD' }));
  check(
    '无 tag 的 manifest 事件仍计入仓库（tag 为空）',
    digestPull.counted === true && digestPull.tag === '',
    JSON.stringify(digestPull)
  );

  const unknown = classifyEvent({
    ...manifestEvent({ repository: repo, action: 'pull', method: 'PUT', tag: 'x' }),
    target: { mediaType: 'application/vnd.example.unknown', digest: 'sha256:1', repository: repo, tag: 'x' },
  });
  check('未知 mediaType 被丢弃（白名单而非黑名单）', unknown.counted === false && unknown.reason === 'NOT_MANIFEST');

  const del = classifyEvent(manifestEvent({ repository: repo, action: 'delete', method: 'DELETE', tag: 'x' }));
  check('delete 动作不计入', del.counted === false && del.reason === 'ACTION_delete');

  const noRepo = classifyEvent({
    id: 'x',
    action: 'pull',
    target: { mediaType: MANIFEST, digest: 'sha256:1' },
    request: { method: 'HEAD' },
  });
  check('缺 repository 的事件被丢弃', noRepo.counted === false && noRepo.reason === 'NO_REPOSITORY');

  const ociIndex = classifyEvent({
    ...manifestEvent({ repository: repo, action: 'pull', method: 'HEAD', tag: 'latest' }),
    target: {
      mediaType: 'application/vnd.oci.image.index.v1+json',
      digest: 'sha256:2',
      repository: repo,
      tag: 'latest',
    },
  });
  check('OCI index 属于 manifest 白名单', ociIndex.counted === true);
}

// ───────────────────── 二、密钥校验 ─────────────────────
{
  check('未配置 token 时拒绝一切事件', verifyNotifyToken('Bearer anything', '').code === 'NOTIFY_TOKEN_MISSING');
  check('缺失 Authorization 头被拒', verifyNotifyToken(undefined, 's3cret').code === 'NOTIFY_UNAUTHORIZED');
  check('错误密钥被拒', verifyNotifyToken('Bearer wrong', 's3cret').code === 'NOTIFY_UNAUTHORIZED');
  check('密钥只有前缀相同时被拒（防前缀比较）', verifyNotifyToken('Bearer s3cre', 's3cret').ok === false);
  check('正确密钥通过（带 Bearer 前缀）', verifyNotifyToken('Bearer s3cret', 's3cret').ok === true);
  check('正确密钥通过（不带 Bearer 前缀）', verifyNotifyToken('s3cret', 's3cret').ok === true);
}

// ───────────────────── 三、端到端：一次真实形状的 pull ─────────────────────
const dir = mkdtempSync(join(tmpdir(), 'registry-manager-stats-'));
const dbFile = join(dir, 'registry-manager.db');
// 持久层与 ActivityStore 分开：拉取历史用的是同一个 Db（见 verify-stats 的拉取历史段）。
const db = new Db({ filePath: dbFile });
const store = new ActivityStore({ db, retentionDays: 90 });

{
  const repository = 'postgres';
  // 实测 `docker pull postgres:15`（15 层）的真实事件序列：
  // 1 条 tag 解析 + 1 条内容下载 + 15 条 blob。
  const events = [
    manifestEvent({ repository, action: 'pull', method: 'HEAD', tag: '15', digest: 'sha256:d07c' }),
    manifestEvent({ repository, action: 'pull', method: 'GET', digest: 'sha256:d07c' }),
  ];
  for (let i = 0; i < 15; i += 1) {
    events.push(blobEvent({ repository, action: 'pull', method: 'GET', digest: `sha256:layer${i}` }));
  }

  const result = store.ingest({ events });
  check(
    '一次 17 条事件的 pull 只计入 1 次',
    result.received === 17 && result.accepted === 1 && result.skipped === 16,
    JSON.stringify(result)
  );

  const summary = store.summary(30);
  check(
    '总览：合计 1、拉取 1、推送 0、仓库 1',
    summary.total === 1 && summary.pull === 1 && summary.push === 0 && summary.repositories === 1,
    JSON.stringify(summary)
  );

  const top = store.top({ days: 30, limit: 10, by: 'tag' });
  check(
    'Top（按 tag）落在 tag=15 上',
    top.length === 1 && top[0].repository === repository && top[0].tag === '15' && top[0].events === 1,
    JSON.stringify(top)
  );
}

// ───────────────────── 四、重复投递只计一次 ─────────────────────
{
  const event = manifestEvent({ repository: 'redis', action: 'pull', method: 'HEAD', tag: '7' });
  const first = store.ingest({ events: [event] });
  const second = store.ingest({ events: [event] });
  check(
    '同一个 event.id 重复投递只计一次',
    first.accepted === 1 && second.accepted === 0 && second.duplicates === 1,
    `first=${JSON.stringify(first)} second=${JSON.stringify(second)}`
  );

  const noIdStore = store.ingest({ events: [{ ...event, id: undefined }] });
  check('缺 event.id 的事件被丢弃（无法幂等）', noIdStore.accepted === 0 && noIdStore.skipped === 1);

  // 排查面板上必须能区分"重试重复"和"被过滤掉"，否则会出现 reason=OK 却 counted=false 的迷惑记录。
  const dupEntry = store.recentEvents(2).find((e) => e.reason === 'DUPLICATE');
  check('重复投递在最近事件里标为 DUPLICATE', Boolean(dupEntry), JSON.stringify(dupEntry));
}

// ───────────────────── 五、一个 push + 一个 pull 分开计 ─────────────────────
{
  const repository = 'alpine';
  const pushEvents = [
    blobEvent({ repository, action: 'push', method: 'PUT' }),
    blobEvent({ repository, action: 'pull', method: 'HEAD' }),
    manifestEvent({ repository, action: 'push', method: 'PUT', tag: '3.19' }),
  ];
  const pullEvents = [manifestEvent({ repository, action: 'pull', method: 'HEAD', tag: '3.19' })];
  store.ingest({ events: pushEvents });
  store.ingest({ events: pullEvents });

  const rows = store.top({ days: 30, limit: 10, by: 'repository' });
  const alpine = rows.find((r) => r.repository === repository);
  check(
    '推一个 3 层镜像只计 1 次 push（blob 与其 HEAD 探测都不计）',
    alpine?.push === 1 && alpine?.pull === 1 && alpine?.events === 2,
    JSON.stringify(alpine)
  );

  const map = store.forRepositories(30);
  check(
    '按仓库热度的 map 能供列表页直接 join',
    map.get(repository)?.events === 2 && map.get('postgres')?.events === 1,
    JSON.stringify(Object.fromEntries(map))
  );
}

// ───────────────────── 六、时间序列与保留期 ─────────────────────
{
  const points = store.series({ days: 30, repository: '' });
  check('全部仓库的时间序列至少有一个点', points.length >= 1 && typeof points[0].day === 'string', JSON.stringify(points));
  check(
    '时间序列按天升序',
    points.every((p, i) => i === 0 || points[i - 1].day <= p.day),
    points.map((p) => p.day).join(',')
  );

  const single = store.series({ days: 30, repository: 'postgres' });
  check('单仓库时间序列只含该仓库的量', single.length === 1 && single[0].events === 1);

  // 保留期：塞一条 20 年前的数据，清理后应消失。
  const ancient = {
    ...manifestEvent({ repository: 'ancient', action: 'pull', method: 'HEAD', tag: 'old' }),
    timestamp: '2000-01-01T00:00:00Z',
  };
  store.ingest({ events: [ancient] });
  check('保留期外的数据先被写入（用于验证清理）', store.summary(3650 * 4).repositories >= 4);

  const removed = store.cleanup();
  check('cleanup 删掉了超出保留期的行', removed.activity >= 1, JSON.stringify(removed));
  check(
    '清理后 ancient 仓库不再出现',
    store.summary(30).repositories === 3,
    JSON.stringify(store.summary(30))
  );
}

// ───────────────────── 七、排查用的原始事件缓冲 ─────────────────────
{
  const totals = store.totals();
  check(
    '累计计数区分"计入"与"拒绝"',
    totals.accepted >= 4 && totals.rejected >= 18,
    JSON.stringify(totals)
  );

  const recent = store.recentEvents(10);
  check('最近事件新的在前', recent.length === 10 && Date.parse(recent[0].at) >= Date.parse(recent[9].at));
  check(
    '被拒绝的事件也留在缓冲里，并带上 reason',
    recent.some((e) => e.counted === false && typeof e.reason === 'string' && e.reason.length > 0),
    JSON.stringify(recent.map((e) => e.reason).slice(0, 5))
  );
}

store.close();

// ───────────────────── 八、schema 版本落盘（重启不重复迁移） ─────────────────────
{
  const reopened = new ActivityStore({ db: new Db({ filePath: dbFile }), retentionDays: 90 });
  check('重新打开已有数据库不会报错（user_version 已落盘）', reopened.summary(30).total === 4);
  reopened.close();
}

// ───────────────────── 九、HTTP 层：Content-Type 必须能被解析 ─────────────────────
//
// 这一条**只能在 HTTP 层测**，模块级断言永远发现不了它：
// Distribution 发事件用的 Content-Type 是
// `application/vnd.docker.distribution.events.v2+json`，而 express.json 默认只解析
// `application/json`。漏配时接口照样回 200、body 却是空的，每条事件被静默吞掉，
// 表现是"配置全对、热度永远是 0"。
{
  const port = 18000 + Math.floor(Math.random() * 2000);
  const httpDir = mkdtempSync(join(tmpdir(), 'registry-manager-http-'));
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.mjs'], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      REGISTRY_URL: 'http://192.0.2.10:10001',
      REGISTRY_CREDENTIALS_DIR: httpDir,
      REGISTRY_NOTIFY_TOKEN: 'http-test-token',
      PORT: String(port),
    },
    stdio: 'ignore',
  });

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 50 && !ready; i += 1) {
    try {
      const r = await fetch(`${base}/api/config`);
      ready = r.ok;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  if (!ready) {
    check('热度服务能在 HTTP 层启动', false, '等待 /api/config 超时');
  } else {
    const envelope = JSON.stringify({
      events: [
        {
          id: 'http-1',
          timestamp: '2026-09-24T03:10:55.787408402Z',
          action: 'pull',
          target: {
            mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
            digest: 'sha256:http',
            repository: 'postgres',
            tag: '15',
          },
          request: { method: 'HEAD' },
        },
      ],
    });

    const post = (contentType) =>
      fetch(`${base}/api/registry-events`, {
        method: 'POST',
        headers: { 'Content-Type': contentType, Authorization: 'Bearer http-test-token' },
        body: envelope,
      });

    const registryType = await post('application/vnd.docker.distribution.events.v2+json');
    const registryBody = await registryType.json();
    check(
      'Distribution 的真实 Content-Type 能被解析并计入（防止静默吞事件）',
      registryType.status === 200 && registryBody?.data?.accepted === 1,
      `HTTP ${registryType.status} ${JSON.stringify(registryBody?.data)}`
    );

    const noEvents = await fetch(`${base}/api/registry-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer http-test-token' },
      body: JSON.stringify({ foo: 1 }),
    });
    check('body 缺少 events 数组时返回 400，而不是静默成功', noEvents.status === 400, `HTTP ${noEvents.status}`);

    const badToken = await fetch(`${base}/api/registry-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
      body: envelope,
    });
    check('HTTP 层用错误密钥返回 401', badToken.status === 401, `HTTP ${badToken.status}`);
  }

  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  rmSync(httpDir, { recursive: true, force: true });
}

rmSync(dir, { recursive: true, force: true });

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
