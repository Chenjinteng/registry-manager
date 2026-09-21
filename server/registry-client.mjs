/**
 * CNCF Distribution（Docker Registry HTTP API V2）客户端。
 *
 * 只做四件事：探活、列仓库、列 tag、读/删 manifest。
 * 每个失败都带稳定 code，让页面能区分"地址不可达""删除未开启""镜像不存在"。
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici';

// 一次可接受的 manifest 类型；顺序即服务端优先级。
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 8_000;
const CATALOG_PAGE_SIZE = 100;
const MAX_CATALOG_PAGES = 200;

export class RegistryError extends Error {
  constructor(message, code, params = {}) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
    this.params = params;
  }
}

export function normalizeBaseUrl(raw) {
  const url = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!url) {
    throw new RegistryError('镜像仓库地址不能为空', 'INVALID_URL');
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new RegistryError('镜像仓库地址必须以 http:// 或 https:// 开头', 'INVALID_URL');
  }
  return url;
}

/** 从 Distribution 的 `{"errors":[{"code","message"}]}` 里取出第一项。 */
async function readDistributionError(response) {
  try {
    const payload = await response.json();
    const first = Array.isArray(payload?.errors) ? payload.errors[0] : null;
    return { code: first?.code ?? '', message: first?.message ?? '' };
  } catch {
    return { code: '', message: '' };
  }
}

export class RegistryClient {
  constructor({ url, proxy = '', timeoutMs = REQUEST_TIMEOUT_MS }) {
    this.baseUrl = normalizeBaseUrl(url);
    this.timeoutMs = timeoutMs;
    // registry 常在内网且只开 HTTP；经代理访问由 ProxyAgent 处理。
    this.dispatcher = proxy ? new ProxyAgent(normalizeBaseUrl(proxy)) : undefined;
  }

  get host() {
    return this.baseUrl.replace(/^https?:\/\//i, '');
  }

  async #request(method, path, { accept = '', timeoutMs, redirect = 'follow' } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    const headers = { 'Cache-Control': 'no-cache' };
    if (accept) {
      headers.Accept = accept;
    }
    try {
      return await undiciFetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        redirect,
        signal: controller.signal,
        dispatcher: this.dispatcher,
      });
    } catch (error) {
      const reason = error?.name === 'AbortError' ? '请求超时' : '无法连接到镜像仓库';
      throw new RegistryError(reason, 'CONNECTION_FAILED', { detail: String(error?.message ?? error) });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 有界读取响应体，避免异常响应撑爆内存。 */
  async #readJson(response) {
    const raw = await response.arrayBuffer();
    if (raw.byteLength > MAX_BODY_BYTES) {
      throw new RegistryError(`registry 响应超过 ${MAX_BODY_BYTES} 字节上限`, 'RESPONSE_TOO_LARGE');
    }
    try {
      return JSON.parse(Buffer.from(raw).toString('utf8'));
    } catch {
      throw new RegistryError('registry 返回了非 JSON 响应', 'INVALID_RESPONSE');
    }
  }

  async #raiseForStatus(response, { notFoundCode, notFoundParams = {}, what }) {
    if (response.ok) {
      return;
    }
    const status = response.status;
    const distribution = await readDistributionError(response);
    if (status === 401) {
      throw new RegistryError('镜像仓库要求认证，本工具未配置凭据', 'UNAUTHORIZED');
    }
    if (status === 404) {
      throw new RegistryError(`${what}不存在`, notFoundCode, notFoundParams);
    }
    // Distribution 只接受按 digest 删除。本工具始终先解析 digest 再删，
    // 因此这个分支只会在账本与 registry 不一致时出现。
    if (status === 400 && distribution.code === 'DIGEST_INVALID') {
      throw new RegistryError(
        '删除被拒绝：Distribution 只支持按 digest 删除 manifest，不支持按 tag 删除。请先重新扫描以对齐清单。',
        'DIGEST_INVALID'
      );
    }
    // 注意：405 只说明这次请求的方法不被接受，不能反推"删除已关闭"是否成立；
    // 反过来，OPTIONS 声称 Allow: DELETE 也不能证明删除可用（实测为假）。
    if (status === 405) {
      throw new RegistryError(
        '该 registry 拒绝了删除请求（405）。若 registry 未开启删除，需设置 ' +
          'REGISTRY_STORAGE_DELETE_ENABLED=true 并重启；开启后删除 manifest 也不立即释放磁盘，' +
          '还需运行 registry garbage-collect。',
        'DELETE_REJECTED'
      );
    }
    throw new RegistryError(`${what}请求失败: HTTP ${status}`, 'HTTP_FAILED', {
      status,
      detail: distribution.message,
    });
  }

  async #getJson(path, { accept = '', notFoundCode, notFoundParams, what, redirect } = {}) {
    const response = await this.#request('GET', path, { accept, redirect });
    await this.#raiseForStatus(response, { notFoundCode, notFoundParams, what });
    return {
      payload: await this.#readJson(response),
      mediaType: (response.headers.get('content-type') ?? '').split(';')[0].trim(),
      digest: (response.headers.get('docker-content-digest') ?? '').trim(),
    };
  }

  /**
   * 探测 `/v2/`。
   *
   * 不能用 OPTIONS 的 Allow 头判断删除能力：Distribution 对已关闭删除的实例
   * 同样宣告 `Allow: DELETE`，只有真正 DELETE 才会返回 405。
   */
  async probe() {
    const response = await this.#request('GET', '/v2/', { timeoutMs: PROBE_TIMEOUT_MS });
    const apiVersion = (response.headers.get('docker-distribution-api-version') ?? '').trim();
    if (response.status === 401) {
      throw new RegistryError('镜像仓库要求认证，本工具未配置凭据', 'UNAUTHORIZED');
    }
    if (!response.ok) {
      throw new RegistryError(`仓库探测失败: HTTP ${response.status}`, 'HTTP_FAILED', {
        status: response.status,
      });
    }
    if (!apiVersion) {
      throw new RegistryError('目标不是符合 Docker Registry HTTP API V2 的镜像仓库', 'NOT_A_REGISTRY');
    }
    return { apiVersion, host: this.host };
  }

  /** 按 `_catalog` 分页遍历仓库名。 */
  async listRepositories() {
    const names = [];
    let last = '';
    for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
      const query = new URLSearchParams({ n: String(CATALOG_PAGE_SIZE) });
      if (last) {
        query.set('last', last);
      }
      const { payload } = await this.#getJson(`/v2/_catalog?${query.toString()}`, {
        notFoundCode: 'REPOSITORY_NOT_FOUND',
        what: '仓库目录',
      });
      const batch = Array.isArray(payload?.repositories) ? payload.repositories : null;
      if (!batch) {
        throw new RegistryError('仓库目录响应缺少 repositories 字段', 'INVALID_RESPONSE');
      }
      if (batch.length === 0) {
        break;
      }
      names.push(...batch.map(String));
      if (batch.length < CATALOG_PAGE_SIZE) {
        break;
      }
      last = String(batch[batch.length - 1]);
    }
    return names;
  }

  async listTags(repository) {
    const { payload } = await this.#getJson(`/v2/${repository}/tags/list`, {
      notFoundCode: 'REPOSITORY_NOT_FOUND',
      notFoundParams: { name: repository },
      what: `仓库 ${repository} 的 tag 列表`,
    });
    // 空仓库返回 {"name":..., "tags": null}
    return Array.isArray(payload?.tags) ? payload.tags.map(String) : [];
  }

  async fetchManifest(repository, reference) {
    return this.#getJson(`/v2/${repository}/manifests/${reference}`, {
      accept: MANIFEST_ACCEPT,
      notFoundCode: 'MANIFEST_NOT_FOUND',
      notFoundParams: { reference: `${repository}:${reference}` },
      what: `${repository}:${reference} 的 manifest`,
    });
  }

  async fetchConfigBlob(repository, digest) {
    const { payload } = await this.#getJson(`/v2/${repository}/blobs/${digest}`, {
      notFoundCode: 'MANIFEST_NOT_FOUND',
      notFoundParams: { reference: digest },
      what: `镜像配置 ${digest}`,
    });
    return payload;
  }

  /** Distribution 只接受按 digest 删除，按 tag 删同样返回 405。 */
  async deleteManifest(repository, digest) {
    const response = await this.#request('DELETE', `/v2/${repository}/manifests/${digest}`, {
      redirect: 'manual',
    });
    await this.#raiseForStatus(response, {
      notFoundCode: 'MANIFEST_NOT_FOUND',
      notFoundParams: { reference: `${repository}@${digest}` },
      what: `${repository} 的 manifest`,
    });
  }
}
