import type {
  ApiResult,
  AppConfig,
  Credential,
  CredentialInput,
  CredentialPatch,
  DeleteTagPayload,
  Inventory,
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
  credentialId?: string;
}) =>
  request<{ apiVersion: string; host: string; sourceUrl: string; usingProxy: boolean }>(
    '/api/pull/probe',
    { method: 'POST', body: JSON.stringify(input) }
  );

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
