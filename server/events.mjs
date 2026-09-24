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
 * 本工具自己发的请求用的 User-Agent 前缀（与 `registry-client.mjs` 的 `USER_AGENT` 对应）。
 *
 * 为什么要把它们单独挑出来：**一次「重新扫描」就会产生 ≈ 2 × tag 数 条事件**
 * （每个 tag 一次 manifest GET + 一次 image config blob GET）。实测一台 76 仓库 / 88 tag
 * 的 registry，一次盘点就是 178 条 —— 正好把 200 条的排查缓冲冲干净，
 * 用户看到的「最近事件」全是自己的噪音，真正要查的（例如同步工具的 UA）只剩 22 条。
 *
 * 所以自身请求**不进排查缓冲**，只单独计数并在面板上显示条数：
 * 信息没被藏起来（"我扫过、产生了多少条"仍然看得到），但不会淹没真正的信号。
 *
 * 计数行为**不受影响** —— 自身请求照常走口径判定：盘点读的是 GET manifest 与 blob，
 * 本来就不计入；拉取任务往本仓库写 manifest（PUT）仍然计入。
 */
export const SELF_USERAGENT_PREFIX = 'registry-manager/';

/**
 * 截断成有界字符串。
 *
 * 这几个身份字段来自**外部输入**并且会进内存里的排查缓冲，不能让它无界增长
 * （User-Agent 之类的头理论上没有长度上限）。截断而不是丢弃：前 200 个字符足够
 * 认出是哪个客户端，超出部分没有诊断价值。
 */
function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 命中哪条忽略规则（返回命中的片段，用来写进 reason）；没命中返回空串。
 *
 * **子串匹配、忽略大小写**：`regclient/regsync` 要能匹配 `regclient/regsync (v0.11.5)`，
 * 不然对方升个小版本就得跟着改配置。返回值保留配置里的原始大小写，便于回显核对。
 */
export function matchIgnoredUseragent(useragent, patterns) {
  const ua = String(useragent ?? '').toLowerCase();
  if (!ua) {
    return '';
  }
  /*
   * 空片段必须显式跳过：`''.includes` 恒为真，一个手滑写进去的空规则会把**所有**事件
   * 都判成忽略、热度直接归零。这里挡一道，比指望每个调用方都校验更可靠。
   */
  return (
    (patterns ?? []).find((pattern) => {
      const needle = String(pattern ?? '').trim().toLowerCase();
      return needle.length > 0 && ua.includes(needle);
    }) ?? ''
  );
}

/**
 * 判定一条事件是否计入热度。**纯函数**，便于在验证脚本里直接断言。
 *
 * @param {object} event registry 推来的单条事件
 * @param {{ignoreUseragents?: string[]}} [options] 要忽略的客户端 User-Agent 片段
 * @returns {{counted: boolean, reason: string, repository?: string, tag?: string,
 *            action?: string, day?: string, digest?: string}}
 */
export function classifyEvent(event, { ignoreUseragents = [] } = {}) {
  const action = String(event?.action ?? '');
  const target = event?.target ?? {};
  const request = event?.request ?? {};
  const method = String(request.method ?? '').toUpperCase();
  const mediaType = String(target.mediaType ?? '');
  const repository = String(target.repository ?? '');
  const tag = String(target.tag ?? '');

  /*
   * 客户端级的排除放在**最前面**。
   *
   * 整类客户端都不算的时候，它的 blob 事件、GET 事件也都不算 —— 这时说
   * "这个客户端被忽略了"比逐条去区分"它是 blob 还是 GET"有用得多：
   * 后者会让人以为只忽略了那一部分，进而怀疑配置没生效。
   */
  const ignored = matchIgnoredUseragent(request.useragent, ignoreUseragents);
  if (ignored) {
    return { counted: false, reason: `IGNORED_USERAGENT:${ignored}` };
  }

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
  /** 环境变量给的基线规则（只读，界面上删不掉）。 */
  #envUseragents;
  /** 界面上加的规则（存 SQLite，可增删）。 */
  #panelUseragents;
  /** 上面两者的并集，判定时用它。增删规则后立即重算，**不需要重启**。 */
  #ignoreUseragents;
  #accepted = 0;
  #rejected = 0;
  /** 本工具自己发的请求条数（不进缓冲，见 SELF_USERAGENT_PREFIX）。 */
  #self = 0;

  /**
   * @param {object} opts
   * @param {import('./db.mjs').Db} opts.db 共用的持久层（拉取历史也用它，所以由调用方注入，
   *                                        而不是各自开一个连接）
   * @param {string[]} [opts.ignoreUseragents] 不计入热度的客户端 User-Agent 片段
   *                                          （registry 侧的 notifications 排不掉它们，
   *                                          只能在这里排 —— 见 config.mjs）
   */
  constructor({
    db,
    retentionDays = 90,
    dedupDays = 7,
    bufferSize = DEFAULT_BUFFER_SIZE,
    ignoreUseragents = [],
  }) {
    this.#db = db;
    this.#retentionDays = retentionDays;
    this.#dedupDays = dedupDays;
    this.#bufferSize = bufferSize;
    /*
     * 规则有两个来源，判定时**取并集**：
     *   - 环境变量 `REGISTRY_STATS_IGNORE_USERAGENTS`：声明式部署用，只读；
     *   - 界面（存 SQLite）：日常入口，可随时增删、**立即生效不用重启**。
     * 分开存是为了能在界面上标出"这条来自环境变量、在这里删不掉" ——
     * 混成一条列表的话，用户删了没反应时根本不知道去哪找。
     */
    this.#envUseragents = [...ignoreUseragents];
    this.#panelUseragents = db.listIgnoredClients().map((r) => r.useragent);
    this.#refreshIgnoreRules();
    // 启动时先清一次，避免保留期改小后旧数据一直留着。
    this.cleanup();
  }

  /** 环境变量给的基线 + 界面加的，去重（忽略大小写，与匹配口径一致）。 */
  #refreshIgnoreRules() {
    const seen = new Set();
    const merged = [];
    for (const rule of [...this.#envUseragents, ...this.#panelUseragents]) {
      const key = String(rule ?? '').trim().toLowerCase();
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(String(rule).trim());
    }
    this.#ignoreUseragents = merged;
  }

  /**
   * 当前生效的规则，以及每条的来源。
   *
   * 界面要知道"哪些是环境变量给的" —— 那些在设置页里只能看、不能删。
   */
  ignoreRules() {
    return {
      env: [...this.#envUseragents],
      panel: [...this.#panelUseragents],
      /** 并集去重后的最终列表；判定与界面回显用的都是它。 */
      effective: [...this.#ignoreUseragents],
    };
  }

  /** 加一条界面规则。已存在（忽略大小写）时 added=false。 */
  addIgnoreRule(useragent, at = new Date().toISOString()) {
    const result = this.#db.addIgnoredClient(String(useragent).trim(), at);
    if (result.added) {
      this.#panelUseragents = this.#db.listIgnoredClients().map((r) => r.useragent);
      this.#refreshIgnoreRules();
    }
    return result;
  }

  /** 删一条界面规则。环境变量给的那些不在这里，删不到。 */
  removeIgnoreRule(useragent) {
    const result = this.#db.removeIgnoredClient(String(useragent).trim());
    if (result.removed) {
      this.#panelUseragents = this.#db.listIgnoredClients().map((r) => r.useragent);
      this.#refreshIgnoreRules();
    }
    return result;
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
      const verdict = classifyEvent(event, { ignoreUseragents: this.#ignoreUseragents });
      const base = {
        at: new Date().toISOString(),
        eventAt: String(event?.timestamp ?? ''),
        id: String(event?.id ?? ''),
        action: String(event?.action ?? ''),
        method: String(event?.request?.method ?? ''),
        mediaType: String(event?.target?.mediaType ?? ''),
        repository: String(event?.target?.repository ?? ''),
        tag: String(event?.target?.tag ?? ''),
        /*
         * 客户端身份。热度被"某个自动化进程"刷高时（例如镜像同步工具按点扫全量），
         * 这几个字段是唯一能把它和真人区分开的线索，所以必须在排查缓冲里留着：
         *   - `useragent` 通常是最可靠的判据（`docker/27.x ...` vs `regclient/...`）；
         *   - `addr` **看场景**：客户端在别的机器上是真实 IP（可用），与 registry 同宿主时
         *     才是 Docker 网桥网关（那时对所有人都是同一个值，区分不了任何东西）；
         *   - `host` 是客户端请求用的 Host 头，内网里常常全员相同；
         *   - `actor` 在**未开认证时是空的**，只有开了认证且用独立账号时才可用。
         */
        useragent: clip(event?.request?.useragent, 200),
        addr: clip(event?.request?.addr, 64),
        host: clip(event?.request?.host, 120),
        actor: clip(event?.actor?.name, 120),
        reason: verdict.reason,
      };

      /*
       * 本工具自己发的请求（见 SELF_USERAGENT_PREFIX）里，**只折叠"不计入"的那些**。
       *
       * 两类自身请求性质完全不同，早先把它们一并折叠是个错误：
       *   - 盘点读 manifest / config blob：一次上百条，永远不计入 → 纯噪音，折叠；
       *   - 拉取任务落目的端 manifest（PUT）：**它改了热度**，而每个 tag 只有一条
       *     → 必须留在面板里。挡掉它的后果是"用工具拉了个镜像，热度 +1 但面板里
       *     一条记录都没有"，于是"热度为什么变了"根本查不出来。
       *
       * `result.*` 是这次接收的真实账，与折叠无关，照常统计。
       */
      const self = base.useragent.startsWith(SELF_USERAGENT_PREFIX);
      const folded = self && !verdict.counted;

      if (!verdict.counted) {
        result.skipped += 1;
        if (folded) {
          this.#self += 1;
        } else {
          this.#rejected += 1;
        }
        this.#push({ ...base, counted: false }, folded);
        continue;
      }
      if (!base.id) {
        // 没有 id 就无法幂等，宁可丢弃也不冒重复计数的风险。
        result.skipped += 1;
        if (folded) {
          this.#self += 1;
        } else {
          this.#rejected += 1;
        }
        this.#push({ ...base, counted: false, reason: 'NO_EVENT_ID' }, folded);
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
        this.#push({ ...base, counted: true }, folded);
      } else {
        // registry 的重试会把同一个事件再投一次。这不是错误，但要和"被过滤掉了"区分开，
        // 否则排查面板上会出现一条 reason=OK 却 counted=false 的迷惑记录。
        result.duplicates += 1;
        this.#push({ ...base, counted: false, reason: 'DUPLICATE' }, folded);
      }
    }
    return result;
  }

  /**
   * 往排查缓冲里放一条。
   *
   * `folded` 为真表示这条要折叠掉（只有一种情况：**不计入的**自身请求，
   * 也就是盘点那一百多条读请求，理由见 `SELF_USERAGENT_PREFIX`）。
   * 它在调用方已经累加过 `#self`，这里只管不进缓冲。
   */
  #push(item, folded = false) {
    if (folded) {
      return;
    }
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
    return {
      accepted: this.#accepted,
      rejected: this.#rejected,
      buffered: this.#buffer.length,
      /** 被折叠的自身请求条数（不计入的那些，主要是盘点的读请求）；不在 accepted / rejected 里，也不在缓冲里。 */
      self: this.#self,
    };
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

  /**
   * 清空**全部**热度数据，用于"统计口径错了、想从头重计"。
   *
   * 和 `cleanup` 的区别是它不看保留期，一次清干净。**不碰拉取历史**
   * （那是任务记录，不是统计口径的产物）。
   *
   * 连**去重窗口与内存缓冲一起清**，不然会出现两种迷惑现象：
   *   - 留着 `event_seen` 的话，清空后同一批事件再投过来会被判成"重复投递"而不计入；
   *   - 留着内存缓冲的话，界面上「最近事件」还有 200 条旧记录，看着像没清成功。
   * 代价是清空瞬间如果 registry 正在重投旧事件，会有少量被重新计入 —— 对"从头重计"
   * 这个语义来说是合理的。
   */
  purge() {
    const removed = this.#db.purgeHeat();
    this.#buffer.length = 0;
    this.#accepted = 0;
    this.#rejected = 0;
    this.#self = 0;
    return removed;
  }

  close() {
    this.#db.close();
  }
}

/** 空的热度视图：未启用或还没有数据时返回它，让页面拿到稳定的结构而不是报错。 */
export function emptySummary(days) {
  return { days, total: 0, repositories: 0, tags: 0, lastAt: null, push: 0, pull: 0 };
}
