import type {
  ApiResult,
  AppConfig,
  Credential,
  CredentialInput,
  CredentialPatch,
  DeleteTagPayload,
  DestStatus,
  Inventory,
  ProxyEntry,
  ProxyInput,
  ProxyPatch,
  ProxyTestResult,
  PullJob,
  PullJobInput,
} from './types';

/**
 * 所有接口都返回 `{ success, code, message, data }`。
 * 失败不抛异常而是返回结构体：错误原因是页面要内联展示的领域事实
 * （例如 registry 未开启删除），需要连同 code 一起渲染。
 */
async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const response = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
    const payload = (await response.json()) as ApiResult<T>;
    if (typeof payload?.success !== 'boolean') {
      return { success: false, code: 'INVALID_RESPONSE', message: '服务返回了非预期响应' };
    }
    return payload;
  } catch (error) {
    return {
      success: false,
      code: 'NETWORK_ERROR',
      message: `无法连接管理服务: ${(error as Error)?.message ?? error}`,
    };
  }
}

export const fetchConfig = () => request<AppConfig>('/api/config');

export const fetchInventory = () => request<Inventory>('/api/inventory');

export const refreshInventory = () => request<Inventory>('/api/refresh', { method: 'POST' });

export const probeRegistry = () =>
  request<{ apiVersion: string; host: string }>('/api/probe', { method: 'POST' });

export const deleteTag = (repository: string, tag: string) =>
  request<DeleteTagPayload>(
    `/api/tags?repository=${encodeURIComponent(repository)}&tag=${encodeURIComponent(tag)}`,
    { method: 'DELETE' }
  );

export const createPullJob = (input: PullJobInput) =>
  request<PullJob>('/api/pull/jobs', {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const listPullJobs = () => request<PullJob[]>('/api/pull/jobs');

export const getPullJob = (id: string) => request<PullJob>(`/api/pull/jobs/${encodeURIComponent(id)}`);

export const cancelPullJob = (id: string) =>
  request<PullJob>(`/api/pull/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });

export const removePullJob = (id: string) =>
  request<{ id: string }>(`/api/pull/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const probePullSource = (input: {
  sourceUrl: string;
  sourceProxy?: string;
  proxyId?: string;
  credentialId?: string;
  /** 传了源引用，服务端就会顺带探测目标 tag 现状（是否已存在 / 会不会被覆盖）。 */
  sourceRef?: string;
  destRepo?: string;
  destTag?: string;
}) =>
  request<{
    apiVersion: string;
    host: string;
    sourceUrl: string;
    usingProxy: boolean;
    /** 该源使用 Bearer 令牌认证（公开镜像也会匿名取 token，属于正常情况）。 */
    authRequired?: boolean;
    /** 令牌服务地址，便于排查。 */
    tokenRealm?: string;
    /** 令牌申请失败的原因（此时仍算"可达"，只是拿不到 token）。 */
    tokenError?: string;
    dest?: DestStatus;
  }>('/api/pull/probe', { method: 'POST', body: JSON.stringify(input) });

export const listCredentials = () => request<Credential[]>('/api/credentials');

export const getCredential = (id: string) =>
  request<Credential>(`/api/credentials/${encodeURIComponent(id)}`);

export const createCredential = (input: CredentialInput) =>
  request<Credential>('/api/credentials', { method: 'POST', body: JSON.stringify(input) });

export const updateCredential = (id: string, patch: CredentialPatch) =>
  request<Credential>(`/api/credentials/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });

export const deleteCredential = (id: string) =>
  request<{ id: string }>(`/api/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const testCredential = (id: string) =>
  request<{ apiVersion: string; host: string; registryUrl: string; purpose: string }>(
    `/api/credentials/${encodeURIComponent(id)}/test`,
    { method: 'POST' }
  );

export const listProxies = () => request<ProxyEntry[]>('/api/proxies');

export const getProxy = (id: string) =>
  request<ProxyEntry>(`/api/proxies/${encodeURIComponent(id)}`);

export const createProxy = (input: ProxyInput) =>
  request<ProxyEntry>('/api/proxies', { method: 'POST', body: JSON.stringify(input) });

export const updateProxy = (id: string, patch: ProxyPatch) =>
  request<ProxyEntry>(`/api/proxies/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });

export const deleteProxy = (id: string) =>
  request<{ id: string }>(`/api/proxies/${encodeURIComponent(id)}`, { method: 'DELETE' });

/** 测试代理连通性；targetUrl 留空则服务端用本 registry 的 /v2/。 */
export const testProxy = (id: string, targetUrl?: string) =>
  request<ProxyTestResult>(`/api/proxies/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    body: JSON.stringify({ targetUrl: targetUrl || '' }),
  });
