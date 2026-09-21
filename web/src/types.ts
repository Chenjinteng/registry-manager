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
