export interface RegistryTag {
  tag: string;
  digest: string;
  size: number;
  layerCount: number;
  architecture: string;
  os: string;
  platformCount: number;
  createdAt: string | null;
}

export interface RegistryRepository {
  name: string;
  tags: RegistryTag[];
  tagCount: number;
  totalSize: number;
}

export interface InventoryError {
  repository: string;
  tag: string;
  code: string;
  message: string;
}

export interface Inventory {
  refreshedAt: string;
  apiVersion: string;
  host: string;
  durationMs: number;
  truncated: boolean;
  repositories: RegistryRepository[];
  errors: InventoryError[];
  errorCount: number;
}

export interface AppConfig {
  name: string;
  /** 当前运行中的版本（服务端从 package.json 读取）；取不到时为空串。 */
  version: string;
  url: string;
  host: string;
  usingProxy: boolean;
  /** 是否给本 registry 配了 basic auth（密码不会回传）。 */
  usingAuth: boolean;
  cacheTtlSeconds: number;
  /** false 时服务端会拒绝删除请求，页面也要隐藏删除入口。 */
  allowDelete: boolean;
  /** false 时服务端拒绝一切拉取写入（GET 列表仍可读）。 */
  allowPull: boolean;
  pullQueueSize: number;
  /** false 时服务端没配密钥或加密存储初始化失败，凭据库不可用。 */
  allowCredentials: boolean;
  /** 代理库是否可用（与凭据库同源，取决于 REGISTRY_CREDENTIAL_KEY）。 */
  allowProxies: boolean;
  credentialsDir: string;
  /** 凭据库不可用时的具体原因；可用时为 null。 */
  credentialError: { code: string; message: string } | null;
  /**
   * 热度统计是否可用：开关打开**且**统计库初始化成功。
   * false 时热度页要显示解释性空状态，而不是报错。
   */
  statsEnabled: boolean;
  /** false 时服务端关闭了事件接收（REGISTRY_ALLOW_REGISTRY_EVENTS=false）。 */
  allowRegistryEvents: boolean;
  /** 统计库初始化失败的原因；正常时为 null。用来区分「坏了」和「还没配」。 */
  statsError: { code: string; message: string } | null;
  /** 是否配了事件共享密钥；密钥本身不回传。false 时事件会被全部拒绝。 */
  notifyTokenConfigured: boolean;
  /** 热度数据最早的一天（YYYY-MM-DD）；从未收到事件时为 null。 */
  statsSince: string | null;
  /** 热度数据的保留天数。 */
  statsRetentionDays: number;
}

export interface ApiResult<T> {
  success: boolean;
  code: string;
  message: string;
  data?: T;
}

export interface DeleteTagPayload {
  deletedTag: string;
  digest: string;
  affectedTags: string[];
  repository: RegistryRepository;
}

export type PullJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type PullPhaseStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface PullPhase {
  /** 'manifest' / 'config' / 'blob:<index>'。layer phase 用 blob:<index> 表达"第 N 个 layer"。 */
  name: string;
  digest: string;
  status: PullPhaseStatus;
  bytes: number;
  totalBytes: number | null;
  message: string;
}

export interface PullJob {
  id: string;
  sourceUrl: string;
  sourceRef: string;
  /** 仅用于判断"是否填了代理"；不回显具体地址以避免误以为是凭据。 */
  sourceProxy: string;
  sourceProxyId?: string;
  sourceRepo: string;
  sourceTag: string;
  destRepo: string;
  destTag: string;
  status: PullJobStatus;
  bytes: number;
  totalBytes: number | null;
  phases: PullPhase[];
  finalDigest?: string;
  errorCode?: string;
  errorMessage?: string;
  /** 'source' | 'dest' | undefined。区分错误发生在源还是目的端。 */
  errorOrigin?: 'source' | 'dest';
  sourceCredentialId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /**
   * 这条任务是**从数据库的历史里读出来的**（不是本次运行内存里的）。
   * 历史任务没有实时进度，且成功任务不保留阶段明细 —— 界面据此区别对待。
   */
  fromHistory?: boolean;
}

export interface PullJobInput {
  sourceUrl: string;
  sourceRef: string;
  sourceProxy?: string;
  /** 代理库里的代理 id；与 sourceProxy 二选一（id 优先）。 */
  sourceProxyId?: string;
  destRepo: string;
  destTag?: string;
  sourceCredentialId?: string;
  /** 临时 inline 凭据：不落库，仅当次任务使用。目的端凭据来自服务配置，不在此处。 */
  sourceAuthInline?: { username: string; password: string };
}

/**
 * 预览时对目标 tag 现状的探测结果。
 * 目标引用一律是「本仓库地址 + 源镜像路径」，所以这里只涉及本 registry 内的路径。
 */
export interface DestStatus {
  sourceRepo: string;
  sourceTag: string;
  destRepo: string;
  destTag: string;
  /** 目标 tag 是否已存在。probeError 存在时此字段无意义。 */
  exists?: boolean;
  existingDigest?: string | null;
  /** 源侧该 tag 是否存在 —— 拼错 tag 在这里就能拦下，不必等入队后失败。 */
  sourceExists?: boolean;
  sourceDigest?: string | null;
  /** 已存在且 digest 与源不同 —— 拉取会替换现有 tag。 */
  willReplace?: boolean;
  /** 已存在且 digest 与源相同 —— 重复拉取没有意义。 */
  identical?: boolean;
  /** 目标探测失败的原因（不影响源可达性判断）。 */
  probeError?: string;
}

/**
 * 凭据库只存**外部源**的 basic auth。
 * 本 registry 自身的凭据属于部署配置（registry.config.json / REGISTRY_USERNAME），
 * 因此这里没有"用途"维度。
 */
export interface Credential {
  id: string;
  name: string;
  registryUrl: string;
  username: string;
  /** 是否设置过密码；密码本身不会回传到前端。 */
  hasPassword: boolean;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialInput {
  name: string;
  registryUrl: string;
  username: string;
  password: string;
  note?: string;
}

export interface CredentialPatch {
  name?: string;
  registryUrl?: string;
  username?: string;
  /** 传空字符串视为不更新密码；省略同空。 */
  password?: string;
  note?: string;
}

/**
 * 代理库条目：只服务**外部源**。
 * 本 registry 自身的代理属于部署配置（registry.config.json 的 proxy），不在这里。
 */
export interface ProxyEntry {
  id: string;
  name: string;
  /** 形如 http://proxy.example.com:8080 */
  url: string;
  username: string;
  /** 是否配了账号（密码不回传）。 */
  hasAuth: boolean;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProxyInput {
  name: string;
  url: string;
  username?: string;
  password?: string;
  note?: string;
}

export interface ProxyPatch {
  name?: string;
  url?: string;
  username?: string;
  /** 传空字符串 = 清掉密码（改成匿名代理）。 */
  password?: string;
  note?: string;
}

/** 代理连通性测试结果。 */
export interface ProxyTestResult {
  ok: boolean;
  status?: number;
  statusText?: string;
  elapsedMs: number;
  targetUrl: string;
  registryApiVersion?: string | null;
  error?: string;
}

/** 热度统计窗口。页面只提供这三档，服务端本身接受任意天数。 */
export type StatsWindow = 7 | 30 | 90;

/** Top 榜单的聚合维度：按仓库或按 tag。 */
export type StatsTopBy = 'repository' | 'tag';

/** 总览（`/api/stats/summary`）。 */
export interface StatsSummary {
  days: number;
  total: number;
  repositories: number;
  tags: number;
  lastAt: string | null;
  push: number;
  pull: number;
}

/**
 * Top 榜单条目。
 * `by=repository` 时带 `tags`，`by=tag` 时带 `tag` —— 两个字段因此都是可选的。
 */
export interface StatsTopItem {
  repository: string;
  tag?: string;
  events: number;
  pull: number;
  push: number;
  tags?: number;
  lastAt: string | null;
}

export interface StatsTop {
  days: number;
  by: StatsTopBy;
  items: StatsTopItem[];
}

/** 按天趋势的一个点。`day` 是 YYYY-MM-DD。 */
export interface StatsSeriesPoint {
  day: string;
  events: number;
  pull: number;
  push: number;
}

export interface StatsSeries {
  days: number;
  repository: string;
  points: StatsSeriesPoint[];
}

/** 单个仓库在窗口内的热度，供镜像列表页做一次 join。 */
export interface StatsRepositoryStat {
  events: number;
  pull: number;
  push: number;
  lastAt: string | null;
}

export interface StatsRepositories {
  days: number;
  /** 只包含**有热度**的仓库；查不到的仓库表示窗口内没有事件。 */
  items: Record<string, StatsRepositoryStat>;
}

/** 最近收到的原始事件（排查用）。 */
export interface StatsEventItem {
  /** 服务端收到事件的时间（ISO8601）。 */
  at: string;
  /** registry 自己的事件时间戳；小数位不固定，交给 new Date 解析。 */
  eventAt: string;
  id: string;
  action: string;
  method: string;
  mediaType: string;
  repository: string;
  tag: string;
  /** 未计入时的原因（例如 NOT_MANIFEST / METHOD_GET）；计入时为 OK。 */
  reason: string;
  counted: boolean;
  /** true 表示 event.id 之前已经记过，本次按幂等丢弃。 */
  duplicate?: boolean;
}

export interface StatsEvents {
  items: StatsEventItem[];
  totals: { accepted: number; rejected: number; buffered: number };
}
