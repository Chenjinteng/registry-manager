/**
 * 本工具**唯一的 SQLite 持久层**：**本文件独占全部 SQL**，其它模块只调方法、不写语句。
 *
 * 目前装两类数据：
 *   1. `activity_daily` / `event_seen` —— 镜像热度按天预聚合的计数（策略见 events.mjs）
 *   2. `pull_jobs` —— 镜像拉取任务的**历史**（只在任务到达终态时写入；
 *      运行态仍留在内存，见 puller.mjs）
 *
 * 为什么用 SQLite 而不是 Postgres：这个工具的定位是"单进程、单文件、无运维"。
 * 两类数据都是"写入极少、按时间查询"的形态，远达不到 SQLite 的写入瓶颈
 * （瓶颈在多进程并发写，而本工具的产品决定就是单实例）。
 * `node:sqlite` 是 Node 22 自带的，**不引入任何依赖**，也不用维护第二个容器。
 *
 * **凭据与代理刻意不进这里**（仍是整份 AES-256-GCM 加密的独立 JSON 文件）。
 * 理由不是"SQLite 太重"，而是进表**会变差**：`name` / `registry_url` / `username`
 * 会变成明文，只剩密码加密，等于从"整份不可读"退化成"元数据全暴露"；
 * 而且非敏感的统计数据和敏感凭据分文件，备份与传阅的边界才清楚。
 * 详见 docs/design.md。
 *
 * 为什么用 `WITHOUT ROWID`：主键就是全部列，没有自增 id 的需求，
 * 聚簇存储让按主键的 upsert 与范围扫描都更快。
 *
 * 注意：`DatabaseSync` 是同步 API。这里刻意不包装成异步 ——
 * 每次写入是一条 upsert，微秒级；而把它异步化会让"去重 + 计数"必须跨 await，
 * 反而引入竞态。调用方本来就是同步的。
 */
import { DatabaseSync } from 'node:sqlite';

/** 当前 schema 版本。加表/改列时 +1，并在 #migrate 里补迁移分支。 */
const SCHEMA_VERSION = 2;

/** 单条 SQL 的忙等上限：并发写时宁可等一会，也不要直接抛 SQLITE_BUSY。 */
const BUSY_TIMEOUT_MS = 5000;

export class Db {
  #db;

  /**
   * @param {object} opts
   * @param {string} opts.filePath 数据库文件路径（目录必须已存在且可写）
   */
  constructor({ filePath }) {
    this.#db = new DatabaseSync(filePath);
    // WAL：读写不互相阻塞。这是单进程 + 偶发查询的场景下最合适的模式。
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.#migrate();
  }

  /**
   * 逐版本向上迁移，**不做"删表重建"**。
   *
   * 老库（例如只有热度的 user_version=1）只会跑它缺的那一步，
   * 所以升级程序不会丢已有数据。每加一版就在末尾补一个 `if (current < N)`。
   */
  #migrate() {
    const current = Number(this.#db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `数据库来自更新的版本（user_version=${current}，本程序支持 ${SCHEMA_VERSION}）。` +
          `请升级程序，或删掉该文件重建（会丢失热度与拉取历史）。`
      );
    }
    if (current === SCHEMA_VERSION) {
      return;
    }

    // v0 → v1：热度统计。
    if (current < 1) {
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS activity_daily(
          day        TEXT    NOT NULL,
          repository TEXT    NOT NULL,
          tag        TEXT    NOT NULL,
          action     TEXT    NOT NULL,
          events     INTEGER NOT NULL DEFAULT 0,
          last_at    TEXT    NOT NULL,
          PRIMARY KEY(day, repository, tag, action)
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS idx_activity_repo_day
          ON activity_daily(repository, day DESC);

        CREATE TABLE IF NOT EXISTS event_seen(
          id      TEXT PRIMARY KEY,
          seen_at TEXT NOT NULL
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS idx_event_seen_at ON event_seen(seen_at);
      `);
    }

    // v1 → v2：镜像拉取历史。
    if (current < 2) {
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS pull_jobs(
          id            TEXT    PRIMARY KEY,
          source_url    TEXT    NOT NULL,
          source_ref    TEXT    NOT NULL,
          source_repo   TEXT    NOT NULL,
          source_tag    TEXT    NOT NULL,
          dest_repo     TEXT    NOT NULL,
          dest_tag      TEXT    NOT NULL,
          status        TEXT    NOT NULL,
          bytes         INTEGER NOT NULL DEFAULT 0,
          total_bytes   INTEGER,
          final_digest  TEXT,
          error_code    TEXT,
          error_message TEXT,
          error_origin  TEXT,
          created_at    TEXT    NOT NULL,
          started_at    TEXT,
          finished_at   TEXT    NOT NULL,
          -- 每个 layer 一条 phase，20 层的拉取有 22 条，全存会让行很胖。
          -- 所以只在失败 / 取消时写入（排查主要看失败的），成功任务留空。
          phases        TEXT
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS idx_pull_jobs_finished
          ON pull_jobs(finished_at DESC);
      `);
    }

    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * 记录一条已通过过滤的事件：**去重与计数在同一个事务里完成**。
   *
   * 去重是必需的而不是保险：registry 的 notification 队列带 `threshold` / `backoff` 重试，
   * 同一个 `event.id` 会被投递多次，不按 id 幂等就会重复累加。
   *
   * @returns {{accepted: boolean}} accepted=false 表示这条事件之前已经记过
   */
  record({ id, day, repository, tag, action, at }) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const seen = this.#db
        .prepare('INSERT OR IGNORE INTO event_seen(id, seen_at) VALUES (?, ?)')
        .run(id, at);
      if (Number(seen.changes) === 0) {
        this.#db.exec('ROLLBACK');
        return { accepted: false };
      }
      this.#db
        .prepare(
          `INSERT INTO activity_daily(day, repository, tag, action, events, last_at)
           VALUES (?, ?, ?, ?, 1, ?)
           ON CONFLICT(day, repository, tag, action)
           DO UPDATE SET events = events + 1,
                         last_at = MAX(last_at, excluded.last_at)`
        )
        .run(day, repository, tag, action, at);
      this.#db.exec('COMMIT');
      return { accepted: true };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * 总览。
   * @param {number} days 统计窗口天数（按 day 字符串倒推，不用 SQLite 的日期函数，
   *                      避免依赖本地时区）
   */
  summary({ days }) {
    const since = daysAgo(days);
    const row = this.#db
      .prepare(
        `SELECT COALESCE(SUM(events), 0) AS total,
                COUNT(DISTINCT repository)   AS repositories,
                COUNT(DISTINCT tag)          AS tags,
                MAX(last_at)                 AS lastAt
           FROM activity_daily
          WHERE day >= ?`
      )
      .get(since);
    const byAction = this.#db
      .prepare(
        `SELECT action, COALESCE(SUM(events), 0) AS events
           FROM activity_daily
          WHERE day >= ?
          GROUP BY action`
      )
      .all(since);
    return {
      days,
      total: Number(row?.total ?? 0),
      repositories: Number(row?.repositories ?? 0),
      tags: Number(row?.tags ?? 0),
      lastAt: row?.lastAt ?? null,
      push: Number(byAction.find((r) => r.action === 'push')?.events ?? 0),
      pull: Number(byAction.find((r) => r.action === 'pull')?.events ?? 0),
    };
  }

  /**
   * Top N 榜单。
   * @param {'repository'|'tag'} by
   */
  top({ days, limit, by }) {
    const since = daysAgo(days);
    // 只有两个取值，直接分支而不是拼字符串插值 —— 保持"没有动态 SQL"这条纪律。
    if (by === 'tag') {
      return this.#db
        .prepare(
          `SELECT repository, tag,
                  SUM(events) AS events,
                  SUM(CASE WHEN action = 'pull' THEN events ELSE 0 END) AS pull,
                  SUM(CASE WHEN action = 'push' THEN events ELSE 0 END) AS push,
                  MAX(last_at) AS lastAt
             FROM activity_daily
            WHERE day >= ?
            GROUP BY repository, tag
            ORDER BY events DESC, repository ASC, tag ASC
            LIMIT ?`
        )
        .all(since, limit)
        .map((r) => ({
          repository: r.repository,
          tag: r.tag,
          events: Number(r.events),
          pull: Number(r.pull),
          push: Number(r.push),
          lastAt: r.lastAt,
        }));
    }
    return this.#db
      .prepare(
        `SELECT repository,
                SUM(events) AS events,
                SUM(CASE WHEN action = 'pull' THEN events ELSE 0 END) AS pull,
                SUM(CASE WHEN action = 'push' THEN events ELSE 0 END) AS push,
                COUNT(DISTINCT tag)  AS tags,
                MAX(last_at)         AS lastAt
           FROM activity_daily
          WHERE day >= ?
          GROUP BY repository
          ORDER BY events DESC, repository ASC
          LIMIT ?`
      )
      .all(since, limit)
      .map((r) => ({
        repository: r.repository,
        events: Number(r.events),
        pull: Number(r.pull),
        push: Number(r.push),
        tags: Number(r.tags),
        lastAt: r.lastAt,
      }));
  }

  /** 按天时间序列；repository 为空时是全部仓库的合计。 */
  series({ days, repository }) {
    const since = daysAgo(days);
    if (repository) {
      return this.#db
        .prepare(
          `SELECT day,
                  SUM(events) AS events,
                  SUM(CASE WHEN action = 'pull' THEN events ELSE 0 END) AS pull,
                  SUM(CASE WHEN action = 'push' THEN events ELSE 0 END) AS push
             FROM activity_daily
            WHERE day >= ? AND repository = ?
            GROUP BY day
            ORDER BY day ASC`
        )
        .all(since, repository)
        .map(toPoint);
    }
    return this.#db
      .prepare(
        `SELECT day,
                SUM(events) AS events,
                SUM(CASE WHEN action = 'pull' THEN events ELSE 0 END) AS pull,
                SUM(CASE WHEN action = 'push' THEN events ELSE 0 END) AS push
           FROM activity_daily
          WHERE day >= ?
          GROUP BY day
          ORDER BY day ASC`
      )
      .all(since)
      .map(toPoint);
  }

  /** 单个仓库（或某个 tag）的热度直读，供列表页内联展示。 */
  forRepositories(days) {
    const since = daysAgo(days);
    const rows = this.#db
      .prepare(
        `SELECT repository,
                SUM(events) AS events,
                SUM(CASE WHEN action = 'pull' THEN events ELSE 0 END) AS pull,
                SUM(CASE WHEN action = 'push' THEN events ELSE 0 END) AS push,
                MAX(last_at) AS lastAt
           FROM activity_daily
          WHERE day >= ?
          GROUP BY repository`
      )
      .all(since);
    return new Map(
      rows.map((r) => [
        r.repository,
        {
          events: Number(r.events),
          pull: Number(r.pull),
          push: Number(r.push),
          lastAt: r.lastAt,
        },
      ])
    );
  }

  /**
   * 记一条**已到终态**的拉取任务。
   *
   * 只写终态：queued / running 的任务留进程内存（需要高频更新，且只在进程活着时有意义）。
   * 用 `INSERT OR REPLACE`：同一个 id 理论上只落一次，但重复调用不该炸。
   *
   * @param {object} job PullQueue 里的任务对象
   */
  recordPullJob(job) {
    const terminal = job?.status === 'succeeded' || job?.status === 'failed' || job?.status === 'cancelled';
    if (!terminal) {
      // 防御性：宁可漏写一条，也不要把运行态的半截数据固化进历史。
      return false;
    }
    // 阶段明细只在失败 / 取消时保留（成功的任务每层都存会让行很胖，且没人看）。
    const phases = job.status === 'succeeded' ? null : JSON.stringify(job.phases ?? []).slice(0, 20000);
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO pull_jobs(
           id, source_url, source_ref, source_repo, source_tag, dest_repo, dest_tag, status,
           bytes, total_bytes, final_digest, error_code, error_message, error_origin,
           created_at, started_at, finished_at, phases
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        String(job.id),
        String(job.sourceUrl ?? ''),
        String(job.sourceRef ?? ''),
        String(job.sourceRepo ?? ''),
        String(job.sourceTag ?? ''),
        String(job.destRepo ?? ''),
        String(job.destTag ?? ''),
        String(job.status),
        Number(job.bytes ?? 0),
        job.totalBytes ?? null,
        job.finalDigest ?? null,
        job.errorCode ?? null,
        job.errorMessage ?? null,
        job.errorOrigin ?? null,
        String(job.createdAt ?? new Date().toISOString()),
        job.startedAt ?? null,
        String(job.finishedAt ?? new Date().toISOString()),
        phases
      );
    return true;
  }

  /** 拉取历史，最新的在前。 */
  listPullJobs({ limit = 200 } = {}) {
    return this.#db
      .prepare('SELECT * FROM pull_jobs ORDER BY finished_at DESC LIMIT ?')
      .all(Math.max(1, Math.floor(limit)))
      .map(rowToPullJob);
  }

  /** 单条历史（内存里没有的终态任务从这儿取）。 */
  getPullJob(id) {
    const row = this.#db.prepare('SELECT * FROM pull_jobs WHERE id = ?').get(String(id));
    return row ? rowToPullJob(row) : null;
  }

  /** 从历史里删掉一条；返回是否真的删了。 */
  removePullJob(id) {
    const res = this.#db.prepare('DELETE FROM pull_jobs WHERE id = ?').run(String(id));
    return Number(res.changes ?? 0) > 0;
  }

  /**
   * 清理**热度**数据；返回删掉的行数，用于启动日志。
   *
   * 刻意不碰 `pull_jobs`：两者的保留期是两个独立配置
   * （`REGISTRY_STATS_RETENTION_DAYS` 与 `REGISTRY_PULL_HISTORY_RETENTION_DAYS`），
   * 混在一个方法里迟早会把其中一个的保留期套到另一个头上。
   */
  cleanup({ retentionDays, dedupDays }) {
    const activity = this.#db
      .prepare('DELETE FROM activity_daily WHERE day < ?')
      .run(daysAgo(retentionDays));
    const dedup = this.#db
      .prepare('DELETE FROM event_seen WHERE seen_at < ?')
      .run(new Date(Date.now() - dedupDays * 86400_000).toISOString());
    return {
      activity: Number(activity.changes ?? 0),
      dedup: Number(dedup.changes ?? 0),
    };
  }

  /** 清理**拉取历史**；按 `finished_at` 的时间戳比，与热度的按天口径分开。 */
  cleanupPullJobs({ retentionDays }) {
    const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
    const removed = this.#db.prepare('DELETE FROM pull_jobs WHERE finished_at < ?').run(cutoff);
    return { pulls: Number(removed.changes ?? 0) };
  }

  /**
   * 清空**全部**热度数据（不是按保留期裁剪）。
   *
   * 用在"发现统计口径把机器流量也算进来了、修好之后想从头重计"。
   * 与 `cleanup` 一样**刻意不碰 `pull_jobs`** —— 拉取历史是任务记录，
   * 不是统计口径的产物，清热度不该把"上周搬了哪些镜像"一起抹掉。
   *
   * 两张表必须在**同一个事务**里删：只删 `activity_daily` 而留下 `event_seen`，
   * 会让清空后重投的事件被判成重复而永远计不进去（服务端已经有去重窗口）。
   */
  purgeHeat() {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const activity = this.#db.prepare('DELETE FROM activity_daily').run();
      const seen = this.#db.prepare('DELETE FROM event_seen').run();
      this.#db.exec('COMMIT');
      return { activity: Number(activity.changes ?? 0), seen: Number(seen.changes ?? 0) };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 最早的一条数据日期，用于界面上说明"热度从什么时候开始有"。 */
  earliestDay() {
    const row = this.#db.prepare('SELECT MIN(day) AS day FROM activity_daily').get();
    return row?.day ?? null;
  }

  close() {
    try {
      this.#db.close();
    } catch {
      // 已关闭时忽略。
    }
  }
}

function toPoint(r) {
  return {
    day: r.day,
    events: Number(r.events),
    pull: Number(r.pull),
    push: Number(r.push),
  };
}

/**
 * 表行 → 接口形状（snake_case 转回 camelCase）。
 *
 * 刻意补齐内存任务里一定有、但历史表里没存的字段（`sourceProxy` / `phases` …）：
 * 前端拿到的是同一个 `PullJob` 类型，缺字段会让渲染路径炸在 `undefined` 上。
 * 历史里的任务一律是终态，所以 `phases` 为空数组时前端应显示"无阶段明细"。
 */
function rowToPullJob(row) {
  return {
    id: row.id,
    sourceUrl: row.source_url,
    sourceRef: row.source_ref,
    sourceRepo: row.source_repo,
    sourceTag: row.source_tag,
    // 任务级代理与凭据**刻意不落历史**：它们是过程信息，且凭据 id 属于另一份存储。
    sourceProxy: '',
    destRepo: row.dest_repo,
    destTag: row.dest_tag,
    status: row.status,
    bytes: Number(row.bytes ?? 0),
    totalBytes: row.total_bytes ?? null,
    finalDigest: row.final_digest ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    errorOrigin: row.error_origin ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at,
    phases: row.phases ? JSON.parse(row.phases) : [],
    // 供前端区分"这次运行里的任务"与"从历史读出来的"（历史没有实时进度）。
    fromHistory: true,
  };
}

/** 从"今天"往前推 n 天的 UTC 日期字符串（YYYY-MM-DD）。 */
function daysAgo(n) {
  const d = new Date(Date.now() - Math.max(0, n - 1) * 86400_000);
  return d.toISOString().slice(0, 10);
}

/** 把事件时间戳归一成 UTC 日期；无法解析时退回今天（宁可记在当天，也不要丢事件）。 */
export function dayOf(timestamp) {
  const t = Date.parse(String(timestamp ?? ''));
  const d = Number.isFinite(t) ? new Date(t) : new Date();
  return d.toISOString().slice(0, 10);
}
