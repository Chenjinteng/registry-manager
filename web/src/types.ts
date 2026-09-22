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
