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
  cacheTtlSeconds: number;
  /** false 时服务端会拒绝删除请求，页面也要隐藏删除入口。 */
  allowDelete: boolean;
  /** false 时服务端拒绝一切拉取写入（GET 列表仍可读）。 */
  allowPull: boolean;
  pullQueueSize: number;
  /** false 时服务端没配密钥或凭据库初始化失败，凭据库不可用。 */
  allowCredentials: boolean;
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
  destCredentialId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface PullJobInput {
  sourceUrl: string;
  sourceRef: string;
  sourceProxy?: string;
  destRepo: string;
  destTag?: string;
  sourceCredentialId?: string;
  destCredentialId?: string;
  /** 临时 inline 凭据：不落库，仅当次任务使用。 */
  sourceAuthInline?: { username: string; password: string };
  destAuthInline?: { username: string; password: string };
}

export type CredentialPurpose = 'source' | 'dest' | 'both';

export interface Credential {
  id: string;
  name: string;
  registryUrl: string;
  purpose: CredentialPurpose;
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
  purpose: CredentialPurpose;
  note?: string;
}

export interface CredentialPatch {
  name?: string;
  registryUrl?: string;
  username?: string;
  /** 传空字符串视为不更新密码；省略同空。 */
  password?: string;
  purpose?: CredentialPurpose;
  note?: string;
}
