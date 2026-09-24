#!/usr/bin/env node
/**
 * 验证镜像拉取历史的持久化契约。
 *
 * 三类断言，各自对应一个会静默出错的点：
 *
 *   1. **迁移不丢数据**：老部署的库只有热度表（user_version=1）。升级程序后必须
 *      在保留原有热度的前提上补出 `pull_jobs` —— 直接"删表重建"会让用户的历史凭空消失。
 *   2. **只记终态**：queued / running 的任务不该落库（半截数据固化进历史毫无意义，
 *      而且运行态本来就有内存里的实时进度）。
 *   3. **保留期清理**：超期的历史按 `finished_at` 删掉，且**不碰热度数据**
 *      （两者的保留期是两个独立配置，混在一起迟早会串）。
 *
 * 用法：node --disable-warning=ExperimentalWarning scripts/verify-pull-history.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Db } from '../server/db.mjs';
import { PullQueue } from '../server/puller.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const dir = mkdtempSync(join(tmpdir(), 'registry-manager-pullhistory-'));
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400_000).toISOString();

/** 造一条终态任务（形状对齐 PullQueue 里的 job）。 */
const terminalJob = (over = {}) => ({
  id: over.id ?? `job-${Math.random().toString(36).slice(2, 10)}`,
  sourceUrl: 'https://registry-1.docker.io',
  sourceRef: 'library/alpine:3.19',
  sourceRepo: 'library/alpine',
  sourceTag: '3.19',
  destRepo: 'library/alpine',
  destTag: '3.19',
  status: 'succeeded',
  bytes: 3072000,
  totalBytes: 3072000,
  finalDigest: 'sha256:abc',
  createdAt: iso(0),
  startedAt: iso(0),
  finishedAt: iso(0),
  phases: [{ name: 'manifest', status: 'success' }],
  ...over,
});

// ───────────────────── 一、迁移：v1 老库升级不丢热度 ─────────────────────
{
  const legacy = join(dir, 'legacy.db');
  {
    // 手工造一个"升级前"的库：只有热度表，user_version=1，并且已经有一条热度数据。
    const raw = new DatabaseSync(legacy);
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec(`
      CREATE TABLE activity_daily(
        day TEXT NOT NULL, repository TEXT NOT NULL, tag TEXT NOT NULL, action TEXT NOT NULL,
        events INTEGER NOT NULL DEFAULT 0, last_at TEXT NOT NULL,
        PRIMARY KEY(day, repository, tag, action)) WITHOUT ROWID;
      CREATE TABLE event_seen(id TEXT PRIMARY KEY, seen_at TEXT NOT NULL) WITHOUT ROWID;
      INSERT INTO activity_daily VALUES ('2026-09-20', 'alpine', '3.19', 'pull', 7, '2026-09-20T00:00:00.000Z');
      PRAGMA user_version = 1;
    `);
    raw.close();
  }

  const upgraded = new Db({ filePath: legacy });
  // 另开一个连接直接读库：测试要看的是"文件里的真实状态"，
  // 而不是给生产代码开一个 raw SQL 的口子（那会破坏"SQL 只在本文件里"的纪律）。
  const inspect = () => {
    const raw = new DatabaseSync(legacy);
    const version = Number(raw.prepare('PRAGMA user_version').get().user_version);
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    raw.close();
    return { version, tables };
  };

  check('老库（user_version=1）一路升到当前版本', inspect().version === 4, String(inspect().version));
  check(
    '升级后原有的热度数据一条没丢',
    upgraded.summary({ days: 3650 }).total === 7,
    JSON.stringify(upgraded.summary({ days: 3650 }))
  );
  check('升级后补出了 pull_jobs 表', inspect().tables.includes('pull_jobs'), inspect().tables.join(','));
  check(
    '升级没有重建表（activity_daily 还在，老数据不可能被清）',
    inspect().tables.includes('activity_daily'),
    inspect().tables.join(',')
  );
  // 迁移后新表要能正常用
  upgraded.recordPullJob(terminalJob({ id: 'after-upgrade' }));
  check('升级后立刻就能写入拉取历史', upgraded.getPullJob('after-upgrade')?.id === 'after-upgrade');
  check('升级后补出了忽略规则表（v3）', inspect().tables.includes('ignored_clients'), inspect().tables.join(','));
  /*
   * v1 → v3 是**跨两步**升上来的（v1→v2→v3）。逐版本迁移最容易在这里出错：
   * 中间某一步被 `return` 掉、或者只有一步用了 `current === N` 判断，都会少建表。
   */
  check(
    '跨版本升级（v1→v4）每一步都跑到了：拉取历史、忽略规则、客户端清单都在',
    inspect().tables.includes('pull_jobs') &&
      inspect().tables.includes('ignored_clients') &&
      inspect().tables.includes('client_seen')
  );
  upgraded.addIgnoredClient('after-upgrade/1.0', iso(0));
  check(
    '升级后的库立刻就能写忽略规则',
    upgraded.listIgnoredClients().some((r) => r.useragent === 'after-upgrade/1.0'),
    JSON.stringify(upgraded.listIgnoredClients())
  );
  upgraded.close();
}

// ───────────────────── 一点五、迁移：v2 库（有热度 + 拉取历史）升到 v4 ─────────────────────
{
  const v2File = join(dir, 'legacy-v2.db');
  {
    // 造一个 v2 库：热度、去重、拉取历史都有数据，唯独没有 ignored_clients。
    const raw = new DatabaseSync(v2File);
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec(`
      CREATE TABLE activity_daily(
        day TEXT NOT NULL, repository TEXT NOT NULL, tag TEXT NOT NULL, action TEXT NOT NULL,
        events INTEGER NOT NULL DEFAULT 0, last_at TEXT NOT NULL,
        PRIMARY KEY(day, repository, tag, action)) WITHOUT ROWID;
      CREATE TABLE event_seen(id TEXT PRIMARY KEY, seen_at TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE pull_jobs(
        id TEXT PRIMARY KEY, source_url TEXT NOT NULL, source_ref TEXT NOT NULL,
        source_repo TEXT NOT NULL, source_tag TEXT NOT NULL, dest_repo TEXT NOT NULL,
        dest_tag TEXT NOT NULL, status TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER, final_digest TEXT, error_code TEXT, error_message TEXT,
        error_origin TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT NOT NULL,
        phases TEXT) WITHOUT ROWID;
      INSERT INTO activity_daily VALUES ('2026-09-21', 'redis', '7', 'push', 3, '2026-09-21T00:00:00.000Z');
      PRAGMA user_version = 2;
    `);
    raw.close();
  }

  const upgradedV2 = new Db({ filePath: v2File });
  check(
    'v2 → v4：原有的热度数据一条没丢（跨两步迁移）',
    upgradedV2.summary({ days: 3650 }).total === 3,
    JSON.stringify(upgradedV2.summary({ days: 3650 }))
  );
  check('v2 → v4：忽略规则表是空的（不是"迁移时顺手塞规则"）', upgradedV2.listIgnoredClients().length === 0);
  upgradedV2.addIgnoredClient('v2-upgraded/1.0', iso(0));
  check('v2 → v4：升级后立刻能写规则', upgradedV2.listIgnoredClients().length === 1);
  check('v2 → v4：补出了客户端清单表且是空的', upgradedV2.listClients({ days: 0 }).length === 0);
  upgradedV2.recordClient({ useragent: 'v2-upgraded/1.0', at: iso(0), counted: true });
  check(
    'v2 → v4：升级后立刻能记客户端',
    upgradedV2.listClients({ days: 0 })[0]?.useragent === 'v2-upgraded/1.0',
    JSON.stringify(upgradedV2.listClients({ days: 0 }))
  );
  check(
    'v2 → v4：没有被"重建表"（老的热度行还在，不可能被清）',
    (() => {
      const raw = new DatabaseSync(v2File);
      const row = raw.prepare("SELECT events FROM activity_daily WHERE repository='redis'").get();
      raw.close();
      return Number(row?.events) === 3;
    })()
  );
  upgradedV2.close();
}

// ───────────────────── 二、只记终态 ─────────────────────
{
  const db = new Db({ filePath: join(dir, 'terminal.db') });
  check('queued 的任务不落库', db.recordPullJob(terminalJob({ id: 'q1', status: 'queued' })) === false);
  check('running 的任务不落库', db.recordPullJob(terminalJob({ id: 'r1', status: 'running' })) === false);
  check('两种非终态都没写进去', db.listPullJobs().length === 0, String(db.listPullJobs().length));

  db.recordPullJob(terminalJob({ id: 'ok1', status: 'succeeded' }));
  db.recordPullJob(terminalJob({ id: 'bad1', status: 'failed', errorCode: 'SOURCE_UNAUTHORIZED',
    errorMessage: '源 registry 要求认证', errorOrigin: 'source', bytes: 1234 }));
  db.recordPullJob(terminalJob({ id: 'can1', status: 'cancelled' }));
  check('三种终态都写进去了', db.listPullJobs().length === 3, String(db.listPullJobs().length));

  const failed = db.getPullJob('bad1');
  check(
    '失败任务的错误信息与 origin 完整回读',
    failed?.errorCode === 'SOURCE_UNAUTHORIZED' &&
      failed?.errorOrigin === 'source' &&
      failed?.errorMessage === '源 registry 要求认证' &&
      failed?.bytes === 1234,
    JSON.stringify({ c: failed?.errorCode, o: failed?.errorOrigin, b: failed?.bytes })
  );
  check(
    '失败任务保留了阶段明细（排查要看它）',
    Array.isArray(failed?.phases) && failed.phases.length === 1,
    JSON.stringify(failed?.phases)
  );
  check(
    '成功任务不存阶段明细（20 层会有 22 条，存了只会把行撑胖）',
    Array.isArray(db.getPullJob('ok1')?.phases) && db.getPullJob('ok1').phases.length === 0,
    JSON.stringify(db.getPullJob('ok1')?.phases)
  );
  check(
    '历史里的任务补齐了前端类型要求的字段（否则渲染路径会炸在 undefined）',
    typeof failed?.sourceProxy === 'string' && Array.isArray(failed?.phases) && failed?.fromHistory === true,
    JSON.stringify({ proxy: failed?.sourceProxy, fromHistory: failed?.fromHistory })
  );

  // 幂等：同一个任务重复写不该炸，也不该变成两条
  db.recordPullJob(terminalJob({ id: 'ok1', status: 'succeeded' }));
  check('同一任务重复写入仍然只有一条', db.listPullJobs().length === 3, String(db.listPullJobs().length));

  check(
    '按 finished_at 倒序返回：最新的在前、最旧的垫底',
    (() => {
      db.recordPullJob(terminalJob({ id: 'old', finishedAt: iso(5), createdAt: iso(5) }));
      const list = db.listPullJobs();
      return list[0].id !== 'old' && list[list.length - 1].id === 'old';
    })(),
    db.listPullJobs().map((j) => j.id).join(' > ')
  );

  check('removePullJob 能删掉一条', db.removePullJob('old') === true && db.getPullJob('old') === null);
  check('删不存在的返回 false', db.removePullJob('nope') === false);
  db.close();
}

// ───────────────────── 三、保留期：清历史但不碰热度 ─────────────────────
{
  const db = new Db({ filePath: join(dir, 'retention.db') });
  db.record({ id: 'e1', day: '2026-09-20', repository: 'alpine', tag: '3.19', action: 'pull', at: iso(0) });
  db.recordPullJob(terminalJob({ id: 'fresh', finishedAt: iso(1), createdAt: iso(1) }));
  db.recordPullJob(terminalJob({ id: 'stale', finishedAt: iso(200), createdAt: iso(200) }));

  const removed = db.cleanupPullJobs({ retentionDays: 90 });
  check('超期的拉取历史被删掉', removed.pulls === 1, JSON.stringify(removed));
  check('保留期内的历史还在', db.getPullJob('fresh') !== null);
  check('超期的那条没了', db.getPullJob('stale') === null);
  check(
    '清理拉取历史**不影响热度数据**（两者保留期独立）',
    db.summary({ days: 3650 }).total === 1,
    JSON.stringify(db.summary({ days: 3650 }))
  );

  // 热度的 cleanup 也不该顺手把拉取历史删了
  db.cleanup({ retentionDays: 90, dedupDays: 7 });
  check('热度的 cleanup 不碰拉取历史', db.getPullJob('fresh') !== null);

  /*
   * 「清空热度、从头重计」也不该碰拉取历史。
   *
   * 这条边界容易写错：purgeHeat 和 cleanupPullJobs 都长得像"清数据"，顺手一起清掉
   * 就变成"口径改一次，任务记录一起没"—— 那是两件不同的事，保留期也是分开配的。
   */
  const purged = db.purgeHeat();
  check('清空热度确实清掉了聚合行', purged.activity === 1, JSON.stringify(purged));
  check('清空热度后热度归零', db.summary({ days: 3650 }).total === 0, String(db.summary({ days: 3650 }).total));
  check('清空热度**不碰拉取历史**', db.getPullJob('fresh') !== null, JSON.stringify(db.listPullJobs().map((j) => j.id)));

  db.close();
}

// ───────────────────── 四、队列层：终态真的会追写历史 ─────────────────────
//
// 上面几段测的是 Db 的契约，这一段测**队列会不会调它** —— 少了这层，
// `#settle` 忘了调用（或调错分支）时上面全绿，历史却一条都不落。
{
  const history = [];
  const queue = new PullQueue({
    client: { host: 'example.invalid' }, // 只入队不执行，用不到真实 client
    history: { recordPullJob: (job) => history.push({ id: job.id, status: job.status, phases: job.phases?.length ?? 0 }) },
    historyLimit: 5,
  });

  const queued = queue.enqueue({
    sourceUrl: 'https://registry-1.docker.io',
    sourceRef: 'library/alpine:3.19',
    destRepo: 'library/alpine',
    destTag: '3.19',
  });
  check('刚入队的任务（queued）不写历史', history.length === 0, JSON.stringify(history));

  queue.cancel(queued.id);
  check(
    '排队中被取消的任务会追写历史，且状态是 cancelled',
    history.length === 1 && history[0].id === queued.id && history[0].status === 'cancelled',
    JSON.stringify(history)
  );

  // 幂等：同一个任务再 settle 一次不该重复写
  queue.cancel(queued.id);
  check('重复调用 cancel 不会重复写历史', history.length === 1, JSON.stringify(history));

  // 不传 history 时必须照常工作（verify-pull.mjs 走的就是这条路）
  const noHistory = new PullQueue({ client: { host: 'example.invalid' }, historyLimit: 5 });
  const j2 = noHistory.enqueue({
    sourceUrl: 'https://registry-1.docker.io',
    sourceRef: 'library/alpine:3.19',
    destRepo: 'library/alpine',
    destTag: '3.19',
  });
  noHistory.cancel(j2.id);
  check('未注入 history 时队列照常工作（退化成纯内存历史）', noHistory.get(j2.id)?.status === 'cancelled');
}

rmSync(dir, { recursive: true, force: true });
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
