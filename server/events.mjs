/**
 * 镜像热度的事件接收层：把 registry 推来的 notification 事件，变成可统计的计数。
 *
 * Distribution 的 `notifications.endpoints` 会在 manifest 的 push / pull 时回调这里。
 * **manager 只收事件，不碰数据面** —— `docker pull` 的字节一个包都不经过本进程。
 *
 * 过滤规则的三条判据全部来自真实 registry 的实测（见 docs/pull-heat.md §3），
 * 每一条都对应一个会静默污染数据的坑：
 *
 *   1. 只留 manifest 家族 —— blob 事件的 mediaType 是 `application/octet-stream`。
 *      不过滤的话，一次 15 层的 pull 会产生 15 条 blob 事件，
 *      热度被层数放大十几倍（"用了一次"却得到完全不同的分数）。
 *   2. method 只留 HEAD / PUT —— Docker 的 pull 是"先按 tag HEAD 拿 digest，
 *      再按 digest GET 取内容"。**带 tag 的是 HEAD**，GET 那条既没有 tag、
 *      又与 HEAD 同 digest，计入就是翻倍。
 *   3. 按 event.id 去重 —— registry 的队列带 threshold/backoff 重试，同一事件会重复投递。
 *
 * 另外实测发现：`docker push` 会在探测 blob 是否存在时发出 `action: "pull"` + `method: HEAD`
 * 的事件。所以 **`action == "pull"` 不等于"有人在拉镜像"** —— 判据 1 顺带把这个坑也堵住了。
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import { dayOf } from './db.mjs';

/**
 * manifest 白名单。**是白名单不是黑名单**：未知类型默认丢弃。
 * 理由不对称 —— 漏算一个未知的 manifest 类型只是少算，
 * 误算一类 blob 类型会把热度放大几十倍。
 */
export const MANIFEST_MEDIA_TYPES = new Set([
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
]);

/** 计入热度的方法。HEAD = pull 前的 tag 解析；PUT = push 落库。 */
export const COUNTED_METHODS = new Set(['HEAD', 'PUT']);

/** 内存里保留的最近事件条数，仅用于排查"registry 到底发了什么"。不落库。 */
const DEFAULT_BUFFER_SIZE = 200;

/**
 * 判定一条事件是否计入热度。**纯函数**，便于在验证脚本里直接断言。
 *
 * @returns {{counted: boolean, reason: string, repository?: string, tag?: string,
 *            action?: string, day?: string, digest?: string}}
 */
export function classifyEvent(event) {
  const action = String(event?.action ?? '');
  const target = event?.target ?? {};
  const request = event?.request ?? {};
  const method = String(request.method ?? '').toUpperCase();
  const mediaType = String(target.mediaType ?? '');
  const repository = String(target.repository ?? '');
  const tag = String(target.tag ?? '');

  if (!repository) {
    return { counted: false, reason: 'NO_REPOSITORY' };
  }
  if (action !== 'pull' && action !== 'push') {
    // delete / mount 之类不计入。
    return { counted: false, reason: `ACTION_${action || 'MISSING'}` };
  }
  if (!MANIFEST_MEDIA_TYPES.has(mediaType)) {
    // 绝大多数是 blob（application/octet-stream）。留在 reason 里以便排查未知类型。
    return { counted: false, reason: 'NOT_MANIFEST', mediaType };
  }
  if (!COUNTED_METHODS.has(method)) {
    // pull 的内容下载（GET，按 digest、无 tag）与多架构子 manifest 走这里。
    return { counted: false, reason: `METHOD_${method || 'MISSING'}`, mediaType };
  }
  return {
    counted: true,
    reason: 'OK',
    repository,
    tag,
    action,
    day: dayOf(event?.timestamp),
    digest: String(target.digest ?? ''),
  };
}

/**
 * 校验 registry 带来的共享密钥。
 *
 * 用 SHA-256 摘要再比对，而不是直接 `timingSafeEqual`：
 * 后者要求两个 Buffer 等长，长度不同会直接抛错并泄漏长度信息。
 *
 * @returns {{ok: boolean, code?: string, message?: string}}
 */
export function verifyNotifyToken(authorizationHeader, expectedToken) {
  const expected = String(expectedToken ?? '');
  if (!expected) {
    return {
      ok: false,
      code: 'NOTIFY_TOKEN_MISSING',
      message:
        '未配置 REGISTRY_NOTIFY_TOKEN，已拒绝所有热度事件。' +
        '请在服务端与 registry 的 notifications.headers.Authorization 里配置同一个密钥。',
    };
  }
  const raw = String(authorizationHeader ?? '').trim();
  // 容忍是否带 "Bearer " 前缀：registry 配置里写不写都能用。
  const provided = raw.replace(/^bearer\s+/i, '');
  if (!provided) {
    return {
      ok: false,
      code: 'NOTIFY_UNAUTHORIZED',
      message: '缺少 Authorization 头。请在 registry 的 notifications.headers 里带上 Bearer 密钥。',
    };
  }
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  if (!timingSafeEqual(a, b)) {
    return {
      ok: false,
      code: 'NOTIFY_UNAUTHORIZED',
      message: '热度事件的密钥不匹配。请确认 registry 的 notifications.headers.Authorization 与 REGISTRY_NOTIFY_TOKEN 一致。',
    };
  }
  return { ok: true };
}

/**
 * 热度仓库：持有 SQLite 与"最近事件"环形缓冲。
 *
 * 初始化失败由调用方捕获并降级 —— 热度是可重建的辅助数据，
 * 不该因为它写不进磁盘就让整个服务起不来。
 */
export class ActivityStore {
  #db;
  #buffer = [];
  #bufferSize;
  #retentionDays;
  #dedupDays;
  #accepted = 0;
  #rejected = 0;

  /**
   * @param {object} opts
   * @param {import('./db.mjs').Db} opts.db 共用的持久层（拉取历史也用它，所以由调用方注入，
   *                                        而不是各自开一个连接）
   */
  constructor({ db, retentionDays = 90, dedupDays = 7, bufferSize = DEFAULT_BUFFER_SIZE }) {
    this.#db = db;
    this.#retentionDays = retentionDays;
    this.#dedupDays = dedupDays;
    this.#bufferSize = bufferSize;
    // 启动时先清一次，避免保留期改小后旧数据一直留着。
    this.cleanup();
  }

  /**
   * 接收一个信封（`{events: [...]}`）。
   *
   * 文档允许一个信封里放多条事件（实测每条 1 条），所以必须按数组处理，
   * 不能假设 `events[0]` 就是全部。
   */
  ingest(envelope) {
    const events = Array.isArray(envelope?.events) ? envelope.events : [];
    const result = { received: events.length, accepted: 0, duplicates: 0, skipped: 0 };
    for (const event of events) {
      const verdict = classifyEvent(event);
      const base = {
        at: new Date().toISOString(),
        eventAt: String(event?.timestamp ?? ''),
        id: String(event?.id ?? ''),
        action: String(event?.action ?? ''),
        method: String(event?.request?.method ?? ''),
        mediaType: String(event?.target?.mediaType ?? ''),
        repository: String(event?.target?.repository ?? ''),
        tag: String(event?.target?.tag ?? ''),
        reason: verdict.reason,
      };

      if (!verdict.counted) {
        result.skipped += 1;
        this.#rejected += 1;
        this.#push({ ...base, counted: false });
        continue;
      }
      if (!base.id) {
        // 没有 id 就无法幂等，宁可丢弃也不冒重复计数的风险。
        result.skipped += 1;
        this.#rejected += 1;
        this.#push({ ...base, counted: false, reason: 'NO_EVENT_ID' });
        continue;
      }

      const { accepted } = this.#db.record({
        id: base.id,
        day: verdict.day,
        repository: verdict.repository,
        tag: verdict.tag,
        action: verdict.action,
        at: base.at,
      });
      if (accepted) {
        result.accepted += 1;
        this.#accepted += 1;
        this.#push({ ...base, counted: true });
      } else {
        // registry 的重试会把同一个事件再投一次。这不是错误，但要和"被过滤掉了"区分开，
        // 否则排查面板上会出现一条 reason=OK 却 counted=false 的迷惑记录。
        result.duplicates += 1;
        this.#push({ ...base, counted: false, reason: 'DUPLICATE' });
      }
    }
    return result;
  }

  #push(item) {
    this.#buffer.push(item);
    if (this.#buffer.length > this.#bufferSize) {
      this.#buffer.splice(0, this.#buffer.length - this.#bufferSize);
    }
  }

  /** 最近的原始事件（新的在前），供排查"事件没到 / 口径不对"。 */
  recentEvents(limit = 50) {
    const n = Math.max(1, Math.min(Number(limit) || 50, this.#bufferSize));
    return this.#buffer.slice(-n).reverse();
  }

  /** 接收端的累计计数，用于判断"到底有没有事件进来"。 */
  totals() {
    return { accepted: this.#accepted, rejected: this.#rejected, buffered: this.#buffer.length };
  }

  summary(days) {
    return this.#db.summary({ days });
  }

  top(options) {
    return this.#db.top(options);
  }

  series(options) {
    return this.#db.series(options);
  }

  forRepositories(days) {
    return this.#db.forRepositories(days);
  }

  earliestDay() {
    return this.#db.earliestDay();
  }

  cleanup() {
    return this.#db.cleanup({ retentionDays: this.#retentionDays, dedupDays: this.#dedupDays });
  }

  close() {
    this.#db.close();
  }
}

/** 空的热度视图：未启用或还没有数据时返回它，让页面拿到稳定的结构而不是报错。 */
export function emptySummary(days) {
  return { days, total: 0, repositories: 0, tags: 0, lastAt: null, push: 0, pull: 0 };
}
