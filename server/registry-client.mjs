/**
 * CNCF Distribution（Docker Registry HTTP API V2）客户端。
 *
 * 只做四件事：探活、列仓库、列 tag、读/删 manifest。
 * 每个失败都带稳定 code，让页面能区分"地址不可达""删除未开启""镜像不存在"。
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { Readable, Transform } from 'node:stream';

// 一次可接受的 manifest 类型；顺序即服务端优先级。
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

// 流式复制用的空闲超时：超过这个时间没有新字节就放弃本次拉取。
// 不放整体超时 —— 镜像几 GB 整体耗时可能很长，但长时间一片死寂通常说明对端断流。
const BLOB_IDLE_TIMEOUT_MS = 60_000;

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
    /**
     * 哪一侧出错了：
     *  - undefined：与方向无关的内部错误（参数校验、协议解析等）
     *  - 'source'：源 registry（这次拉取要去读的地方）
     *  - 'dest'  ：本仓库（这次拉取要写入的地方）
     *
     * 前端用这个字段把"源/目的"贴在错误提示里，避免 CONNECTION_FAILED 一刀切。
     */
    this.origin = undefined;
  }

  withOrigin(origin) {
    this.origin = origin;
    return this;
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

/**
 * 源端 401 / 403 的可照做提示。
 *
 * 401 是"需要认证"——本工具支持 basic auth，所以要直接告诉用户去哪儿配，
 * 而不是像过去那样说"本工具未配置凭据"（那是凭据功能上线前的旧文案，会误导）。
 */
function sourceAuthMessage(status, { bearerRealm } = {}) {
  if (status === 401) {
    if (bearerRealm) {
      return (
        `源 registry 要求认证（HTTP 401，Bearer 令牌服务 ${bearerRealm}）。` +
        '本工具会自动申请匿名令牌；仍失败说明该镜像不是公开的，' +
        '请在任务的「高级选项 → 源认证」中选择一条凭据（账号 / 令牌）。'
      );
    }
    return (
      '源 registry 要求认证（HTTP 401）。请在任务的「高级选项 → 源认证」中选择一条凭据，' +
      '或临时输入账号 / 密码后重试。'
    );
  }
  return `源 registry 拒绝访问（HTTP ${status}）：账号可能没有该镜像的读取权限。`;
}

/** 目的端 401 / 403 的可照做提示。 */
function destAuthMessage(status, destRepo) {
  if (status === 401) {
    return (
      `本 registry 要求认证（HTTP 401）。这是部署级配置，请在 registry.config.json 里填 ` +
      `username / password，或设置环境变量 REGISTRY_USERNAME / REGISTRY_PASSWORD 后重启服务。`
    );
  }
  return `本 registry 拒绝写入 ${destRepo}（HTTP 403）：该账号可能没有推送权限。`;
}

/**
 * 解析 `WWW-Authenticate: Bearer realm="...",service="...",scope="..."`。
 *
 * 这是 Docker Hub / ghcr / quay 这类 registry 的**标准**认证方式：
 * 匿名请求先吃 401，客户端拿 realm 去换一个（匿名或带账号的）token，
 * 再用 `Authorization: Bearer <token>` 重试。`docker pull` 自动做这件事。
 */
export function parseBearerChallenge(headerValue) {
  if (!headerValue) return null;
  const head = /^\s*Bearer\s+(.*)$/i.exec(String(headerValue));
  if (!head) return null;
  const params = {};
  // key="value" 或 key=value，值里可能有逗号（scope 常有），所以优先吃引号形式。
  const re = /([a-zA-Z0-9_]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let match;
  while ((match = re.exec(head[1])) !== null) {
    params[match[1].toLowerCase()] = match[2] ?? match[3];
  }
  if (!params.realm) return null;
  return { realm: params.realm, service: params.service ?? '', scope: params.scope ?? '' };
}

/**
 * 从请求路径与方法推出 token 需要的 scope。
 *
 * 挑战头里通常不带 scope，得自己拼；读用 `pull`，写用 `pull,push`。
 * 匿名账号申请 `push` 会被拒，所以不能一律要 `pull,push`。
 */
export function scopeForPath(path, method = 'GET') {
  const matched = /^\/v2\/(.+?)\/(manifests|blobs|tags)\b/.exec(String(path ?? ''));
  if (!matched) return null;
  const name = matched[1];
  const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method).toUpperCase());
  return `repository:${name}:${write ? 'pull,push' : 'pull'}`;
}

export class RegistryClient {
  constructor({ url, proxy = '', timeoutMs = REQUEST_TIMEOUT_MS, auth }) {
    this.baseUrl = normalizeBaseUrl(url);
    this.timeoutMs = timeoutMs;
    // registry 常在内网且只开 HTTP；经代理访问由 ProxyAgent 处理。
    this.dispatcher = proxy ? new ProxyAgent(normalizeBaseUrl(proxy)) : undefined;
    // Basic auth：拼成 `Authorization: Basic <base64>`。空 password 视为不传。
    if (auth && auth.username) {
      const credentials = `${auth.username}:${auth.password ?? ''}`;
      this.authHeader = `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
    } else {
      this.authHeader = undefined;
    }
    /** scope -> { token, expiresAt }；Bearer token 缓存，避免每个请求都去换一次。 */
    this.tokenCache = new Map();
    /** 缓存最近一次看到的 Bearer 挑战，用于给"不可重放的流式请求"提前取 token。 */
    this.bearerChallenge = null;
  }

  get host() {
    return this.baseUrl.replace(/^https?:\/\//i, '');
  }

  /**
   * 取一个可用的 Bearer token（命中缓存则直接返回）。
   *
   * 没有挑战信息时先 ping 一次 `/v2/` 把挑战头拿回来 —— 这是流式请求
   * （body 不可重放、无法"401 后重试"）能够带认证的前提。
   */
  async tokenFor(scope, { signal, dispatcher } = {}) {
    if (!scope) return null;
    const hit = this.tokenCache.get(scope);
    if (hit && Date.now() < hit.expiresAt) {
      return hit.token;
    }
    this.tokenCache.delete(scope);

    if (!this.bearerChallenge) {
      const discovered = await this.#discoverChallenge({ signal, dispatcher });
      if (!discovered) return null;
    }
    const challenge = this.bearerChallenge;
    const url = new URL(challenge.realm);
    if (challenge.service) {
      url.searchParams.set('service', challenge.service);
    }
    const effectiveScope = challenge.scope || scope;
    if (effectiveScope) {
      url.searchParams.set('scope', effectiveScope);
    }
    const headers = { 'Cache-Control': 'no-cache' };
    // 私有仓库要用账号去换 token；匿名场景不带。
    if (this.authHeader) {
      headers.Authorization = this.authHeader;
    }
    const response = await undiciFetch(url, {
      method: 'GET',
      headers,
      signal,
      dispatcher: dispatcher ?? this.dispatcher,
    });
    if (!response.ok) {
      throw new RegistryError(
        `申请访问令牌失败（HTTP ${response.status}，令牌服务 ${url.host}）`,
        response.status === 401 || response.status === 403 ? 'UNAUTHORIZED' : 'AUTH_FAILED',
        { status: response.status }
      );
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new RegistryError('令牌服务返回了非 JSON 响应', 'INVALID_RESPONSE');
    }
    const token = payload?.token || payload?.access_token;
    if (!token) {
      throw new RegistryError('令牌服务未返回 token / access_token', 'AUTH_FAILED');
    }
    const expiresIn = Number(payload?.expires_in) || 60;
    this.tokenCache.set(scope, {
      token,
      // 留 30s 余量，避免"刚拿到就过期"。
      expiresAt: Date.now() + Math.max(30, expiresIn - 30) * 1000,
    });
    return token;
  }

  /** 当前已知的 Bearer 挑战信息（用于把 realm 写进报错，便于定位）。 */
  #challengeInfo() {
    return this.bearerChallenge?.realm ? { bearerRealm: this.bearerChallenge.realm } : {};
  }

  /** ping `/v2/` 只为拿挑战头；401 也算成功（本就是为了拿 realm）。 */
  async #discoverChallenge({ signal, dispatcher } = {}) {
    try {
      const response = await undiciFetch(`${this.baseUrl}/v2/`, {
        method: 'GET',
        headers: { 'Cache-Control': 'no-cache' },
        redirect: 'follow',
        signal,
        dispatcher: dispatcher ?? this.dispatcher,
      });
      const challenge = parseBearerChallenge(response.headers.get('www-authenticate'));
      if (challenge) {
        this.bearerChallenge = challenge;
        return challenge;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 单次 HTTP 出口。所有上层方法都走这里。
   *
   * - `signal` 由调用方持有（典型用法：把它绑给一个 PullJob 的 AbortController）。
   *   PullJob 取消时 controller.abort() 会让所有正在路上的请求立即终止。
   * - `dispatcher` 不传时用实例默认（通常是访问本仓库的代理）。
   *   跨源场景（拉外部镜像）调用方可以传自己的 dispatcher 走另一个代理。
   */
  async #request(method, path, { accept = '', timeoutMs, redirect = 'follow', signal, dispatcher, origin } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    // 串联外部 signal：调用方取消 → 我们的 controller 也 abort。
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    const headers = { 'Cache-Control': 'no-cache' };
    if (accept) {
      headers.Accept = accept;
    }
    if (this.authHeader) {
      headers.Authorization = this.authHeader;
    }

    // 有缓存 token 就直接带上，省掉一次 401 往返。
    const scope = scopeForPath(path, method);
    const cachedToken = scope ? this.tokenCache.get(scope)?.token : undefined;
    if (cachedToken) {
      headers.Authorization = `Bearer ${cachedToken}`;
    }

    const send = (overrideHeaders) =>
      undiciFetch(`${this.baseUrl}${path}`, {
        method,
        headers: overrideHeaders,
        redirect,
        signal: controller.signal,
        dispatcher: dispatcher ?? this.dispatcher,
      });

    try {
      let response = await send(headers);
      // 401 + Bearer 挑战 → 去 realm 换 token 再重试一次。
      // 这是 Docker Hub / ghcr / quay 的标准路径；只靠 Basic 是进不去的。
      if (response.status === 401) {
        const challenge = parseBearerChallenge(response.headers.get('www-authenticate'));
        if (challenge) {
          this.bearerChallenge = challenge;
          // 之前那个 token 没能通过，清掉强制重取。
          if (scope) {
            this.tokenCache.delete(scope);
          }
          const token = await this.tokenFor(scope, { signal, dispatcher });
          if (token) {
            response = await send({ ...headers, Authorization: `Bearer ${token}` });
          }
        }
      }
      return response;
    } catch (error) {
      // 已经带语义的错误（例如令牌申请失败）原样抛出，别包装成"连不上" ——
      // 那会把真实的认证失败掩盖成网络问题，排查方向完全跑偏。
      if (error instanceof RegistryError) {
        throw error;
      }
      // undici 在不可达 IP 上抛 ECONNREFUSED，错误名也是 AbortError；
      // 通过 message / code 进一步区分"对端拒连"和"我们自己主动取消"。
      const name = error?.name ?? '';
      const code = error?.code ?? '';
      const isCanceled = name === 'AbortError' && code === 'UND_ERR_ABORTED';
      const reason = isCanceled
        ? '请求被取消'
        : name === 'AbortError' || code === 'UND_ERR_SOCKET'
        ? '无法连接到镜像仓库（连接被拒 / 超时）'
        : '无法连接到镜像仓库';
      throw new RegistryError(reason, 'CONNECTION_FAILED', { detail: String(error?.message ?? error) }).withOrigin(origin);
    } finally {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
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
    if (status === 401 || status === 403) {
      throw new RegistryError(`${what}需要认证或被拒绝（HTTP ${status}）`, 'UNAUTHORIZED', { status });
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

  async #getJson(path, { accept = '', notFoundCode, notFoundParams, what, redirect, signal, dispatcher } = {}) {
    const response = await this.#request('GET', path, { accept, redirect, signal, dispatcher });
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
  async probe({ origin } = {}) {
    const response = await this.#request('GET', '/v2/', { timeoutMs: PROBE_TIMEOUT_MS, origin });
    const apiVersion = (response.headers.get('docker-distribution-api-version') ?? '').trim();
    if (response.status === 401) {
      const message =
        origin === 'source'
          ? sourceAuthMessage(401, this.#challengeInfo())
          : origin === 'dest'
          ? destAuthMessage(401, this.host)
          : '镜像仓库要求认证（HTTP 401）：本仓库的凭据在 registry.config.json / REGISTRY_USERNAME 里配置，外部源的凭据在「凭据管理」里维护。';
      throw new RegistryError(message, 'UNAUTHORIZED').withOrigin(origin);
    }
    if (!response.ok) {
      throw new RegistryError(`仓库探测失败: HTTP ${response.status}`, 'HTTP_FAILED', {
        status: response.status,
      }).withOrigin(origin);
    }
    if (!apiVersion) {
      throw new RegistryError('目标不是符合 Docker Registry HTTP API V2 的镜像仓库', 'NOT_A_REGISTRY').withOrigin(
        origin
      );
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

  /**
   * HEAD manifest，返回是否存在与 digest。
   *
   * 与 `fetchManifest` 的区别：**不存在不算错误**，返回 `{ exists: false }`。
   * 用于创建任务前的预览探测（"目标 tag 是否已存在、会不会被覆盖"），
   * 那种场景下 404 是正常结果，不该变成异常。
   */
  async probeManifest(repository, reference, { origin, dispatcher } = {}) {
    const response = await this.#request('HEAD', `/v2/${repository}/manifests/${reference}`, {
      accept: MANIFEST_ACCEPT,
      redirect: 'follow',
      origin,
      dispatcher,
    });
    if (response.status === 404) {
      return { exists: false, digest: null };
    }
    if (response.status === 401 || response.status === 403) {
      throw new RegistryError(
        origin === 'source'
          ? sourceAuthMessage(response.status, this.#challengeInfo())
          : destAuthMessage(response.status, repository),
        origin === 'source' ? 'SOURCE_UNAUTHORIZED' : 'DEST_FORBIDDEN',
        { status: response.status }
      ).withOrigin(origin);
    }
    if (!response.ok) {
      throw new RegistryError(
        `读取 ${repository}:${reference} 的 manifest 失败: HTTP ${response.status}`,
        'HTTP_FAILED',
        { status: response.status }
      ).withOrigin(origin);
    }
    return {
      exists: true,
      digest: (response.headers.get('docker-content-digest') ?? '').trim() || null,
    };
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

  // -----------------------------------------------------------------------
  // 镜像拉取相关：扩展方法，构造时传入的 dispatcher 仍然可用。
  //
  // 设计要点：
  // - 拉取源可能在另一个网络域，需要独立 dispatcher / proxy；
  // - 所有方法都接 signal，绑定到 PullJob 的 AbortController；
  // - 这组方法只在本仓库与源都是 Distribution 时可用，不做兼容层。
  // -----------------------------------------------------------------------

  /** 源端 HEAD /v2/<repo>/manifests/<ref>：拿 mediaType 与 docker-content-digest。 */
  async headSourceManifest(repository, reference, { signal, dispatcher } = {}) {
    const response = await this.#request('HEAD', `/v2/${repository}/manifests/${reference}`, {
      accept: MANIFEST_ACCEPT,
      redirect: 'follow',
      signal,
      dispatcher,
      origin: 'source',
    });
    if (response.status === 404) {
      throw new RegistryError(
        `${repository}:${reference} 的 manifest 不存在`,
        'SOURCE_MANIFEST_NOT_FOUND',
        { reference: `${repository}:${reference}` }
      ).withOrigin('source');
    }
    if (response.status === 401 || response.status === 403) {
      throw new RegistryError(sourceAuthMessage(response.status, this.#challengeInfo()), 'SOURCE_UNAUTHORIZED', {
        status: response.status,
      }).withOrigin('source');
    }
    if (!response.ok) {
      throw new RegistryError(`读取源 manifest 失败: HTTP ${response.status}`, 'SOURCE_HTTP_FAILED', {
        status: response.status,
      }).withOrigin('source');
    }
    return {
      mediaType: (response.headers.get('content-type') ?? '').split(';')[0].trim(),
      digest: (response.headers.get('docker-content-digest') ?? '').trim(),
      contentLength: Number(response.headers.get('content-length') ?? '') || null,
    };
  }

  /** 源端 GET manifest（不解析，返回字节流以便原样转发给目的端）。 */
  async fetchSourceManifestBytes(repository, reference, { signal, dispatcher } = {}) {
    const response = await this.#request('GET', `/v2/${repository}/manifests/${reference}`, {
      accept: MANIFEST_ACCEPT,
      redirect: 'follow',
      signal,
      dispatcher,
      origin: 'source',
    });
    if (response.status === 404) {
      throw new RegistryError(
        `${repository}:${reference} 的 manifest 不存在`,
        'SOURCE_MANIFEST_NOT_FOUND',
        { reference: `${repository}:${reference}` }
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new RegistryError(sourceAuthMessage(response.status, this.#challengeInfo()), 'SOURCE_UNAUTHORIZED', {
        status: response.status,
      }).withOrigin('source');
    }
    if (!response.ok) {
      throw new RegistryError(`读取源 manifest 失败: HTTP ${response.status}`, 'SOURCE_HTTP_FAILED', {
        status: response.status,
      }).withOrigin('source');
    }
    const arrayBuffer = await response.arrayBuffer();
    return {
      mediaType: (response.headers.get('content-type') ?? '').split(';')[0].trim(),
      digest: (response.headers.get('docker-content-digest') ?? '').trim(),
      body: Buffer.from(arrayBuffer),
    };
  }

  /**
   * 源端流式读 blob。
   *
   * 返回 `{ response, contentLength }`，**调用方负责把 body pipe 到目的端**。
   * 这样可以避免把几 GB 的镜像吃进 Buffer 再转发。
   */
  async openSourceBlob(repository, digest, { signal, dispatcher } = {}) {
    const response = await this.#request('GET', `/v2/${repository}/blobs/${digest}`, {
      redirect: 'follow',
      signal,
      dispatcher,
      origin: 'source',
    });
    if (response.status === 404) {
      throw new RegistryError(`源 blob ${digest} 不存在`, 'SOURCE_BLOB_NOT_FOUND', { digest }).withOrigin(
        'source'
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new RegistryError(sourceAuthMessage(response.status, this.#challengeInfo()), 'SOURCE_UNAUTHORIZED', {
        status: response.status,
      }).withOrigin('source');
    }
    if (!response.ok) {
      throw new RegistryError(`读取源 blob 失败: HTTP ${response.status}`, 'SOURCE_HTTP_FAILED', {
        status: response.status,
        digest,
      }).withOrigin('source');
    }
    return {
      response,
      contentLength: Number(response.headers.get('content-length') ?? '') || null,
    };
  }

  /**
   * 目的端尝试 mount 一个已存在的 blob。
   *
   * 201 Created → 已挂载（命中）；
   * 202 Accepted → 源 registry 不允许 / 没开 mount，调用方需回落流式复制。
   */
  async mountDestBlob(destRepo, digest, fromRepo, { signal } = {}) {
    const query = new URLSearchParams({ mount: digest, from: fromRepo });
    const response = await this.#request(
      'POST',
      `/v2/${destRepo}/blobs/uploads/?${query.toString()}`,
      { redirect: 'manual', signal, origin: 'dest' }
    );
    if (response.status === 201) {
      return { mounted: true };
    }
    if (response.status === 202 || response.status === 404 || response.status === 405) {
      // 202：未挂载但 upload session 创建成功，调用方走流式；
      // 404/405：mount 接口不支持。
      // 顺手把 body 读完，避免连接挂着。
      await response.arrayBuffer().catch(() => {});
      return { mounted: false };
    }
    if (response.status === 401 || response.status === 403) {
      throw new RegistryError(destAuthMessage(response.status, destRepo), 'DEST_FORBIDDEN', {
        status: response.status,
      }).withOrigin('dest');
    }
    throw new RegistryError(
      `目的 mount 失败: HTTP ${response.status}`,
      'BLOB_MOUNT_FAILED',
      { status: response.status, digest }
    ).withOrigin('dest');
  }

  /** 目的端 POST /v2/<repo>/blobs/uploads/：拿 upload session 的 Location。 */
  async initDestUpload(destRepo, { signal } = {}) {
    const response = await this.#request('POST', `/v2/${destRepo}/blobs/uploads/`, {
      redirect: 'manual',
      signal,
      origin: 'dest',
    });
    if (response.status === 401 || response.status === 403) {
      throw new RegistryError(destAuthMessage(response.status, destRepo), 'DEST_FORBIDDEN', {
        status: response.status,
      }).withOrigin('dest');
    }
    if (response.status !== 202) {
      throw new RegistryError(
        `目的上传初始化失败: HTTP ${response.status}`,
        'BLOB_UPLOAD_INIT_FAILED',
        { status: response.status }
      ).withOrigin('dest');
    }
    const location = response.headers.get('location') || response.headers.get('Location');
    if (!location) {
      throw new RegistryError('目的 registry 未返回 Location 头', 'BLOB_UPLOAD_INIT_FAILED').withOrigin(
        'dest'
      );
    }
    return { location };
  }

  /**
   * 目的端 PATCH 上传 stream：把 `source` 的 body 作为目的端 PATCH 的 body。
   *
   * undici 7.x 返回的 `response.body` 是 Web ReadableStream（不是 Node Readable），
   * 不能直接拿来做 undici PATCH 的 body；也不能 `body.on('data')` 监听数据。
   * 我们用 Web reader 读取 chunk，每 chunk 推进进度，同时通过一个 Transform 流
   * 同步推给 PATCH —— 这样源数据**始终在两个连接之间流式搬运**，不经我们进程的内存。
   *
   * 取消语义：
   *   ① `signal.aborted` → 解锁 reader、关掉下游 Transform，PATCH 自然失败；
   *   ② 但当前正在读 / 写的那个 chunk 会完成（这就是"优雅"的分界点）。
   */
  async streamBlobToDest({ location, source, contentLength, signal, onProgress }) {
    if (!source.body) {
      throw new RegistryError('源 blob 响应缺少可读 body', 'INVALID_RESPONSE');
    }
    // 把 undici 的 Web ReadableStream 转成 Node Readable，
    // 后面就跟普通流式处理一致：on('data') / pipeline 都很稳。
    let nodeSource;
    try {
      nodeSource = Readable.fromWeb(source.body);
    } catch (error) {
      throw new RegistryError('源 blob 无法转为可读流', 'INVALID_RESPONSE', {
        detail: String(error?.message ?? error),
      });
    }

    const url = new URL(location, this.baseUrl);
    const controller = new AbortController();

    const abortPipeline = () => {
      // 关掉 controller 让 undici PATCH 失败；同时 destroy 源流以免挂起。
      controller.abort();
      nodeSource.destroy();
    };
    if (signal) {
      if (signal.aborted) {
        abortPipeline();
      } else {
        signal.addEventListener('abort', abortPipeline, { once: true });
      }
    }

    let idleTimer = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => abortPipeline(), BLOB_IDLE_TIMEOUT_MS);
    };

    let totalWritten = 0;
    // Transform：源 → Transform 累加进度 → Transform 输出给 PATCH 作 Node Readable。
    const passthrough = new Transform({
      transform(chunk, _enc, callback) {
        resetIdle();
        totalWritten += chunk.length;
        if (typeof onProgress === 'function') {
          onProgress(totalWritten);
        }
        callback(null, chunk);
      },
    });

    resetIdle();

    // 源端读错误单独记下来：源断流时 Transform 也会连带出错，
    // 两者都要有归属，否则会变成未捕获异常 / 悬空的 promise。
    let sourceError = null;
    nodeSource.on('error', (error) => {
      sourceError = error;
    });
    // PATCH 中途失败（或我们主动 abort）时 undici 会销毁 body，
    // Transform 随之报错；这是预期路径，吞掉即可，真正的失败由 response 表达。
    passthrough.on('error', () => {});

    try {
      nodeSource.pipe(passthrough);

      // 流式 body 不可重放，没法走"401 后换 token 重试"。
      //
      // 但只在**已经发现过 Bearer 挑战**时才预取：这个上传流程的第一个请求
      // （POST /blobs/uploads/）已经走过 #request，真需要 token 的话那时就发现了。
      // 无条件调用会为了拿挑战而多打一次匿名 /v2/，对 Basic / 匿名的 registry
      // 纯属浪费，在受保护的仓库上还可能触发匿名访问告警。
      const scope = scopeForPath(url.pathname, 'PATCH');
      let bearer;
      if (scope && this.bearerChallenge) {
        try {
          bearer = await this.tokenFor(scope, { signal });
        } catch {
          // 取 token 失败不在这里报错：让下面正式的请求去暴露真实状态码。
          bearer = undefined;
        }
      }

      const headers = { 'Content-Type': 'application/octet-stream' };
      if (contentLength && Number.isFinite(contentLength)) {
        headers['Content-Length'] = String(contentLength);
      }
      if (bearer) {
        headers.Authorization = `Bearer ${bearer}`;
      } else if (this.authHeader) {
        headers.Authorization = this.authHeader;
      }
      const response = await undiciFetch(url, {
        method: 'PATCH',
        headers,
        body: passthrough,
        // 流式 body 必须显式声明 duplex，否则 undici / Node fetch 会在把请求
        // 发出去之前就抛错（表现为"目的 PATCH 失败"但服务端根本没收到请求）。
        duplex: 'half',
        signal: controller.signal,
        dispatcher: this.dispatcher,
      });

      // undici 解析出 response 就说明 body 已经写完，不需要再等额外的 pump promise。
      if (sourceError) {
        throw sourceError;
      }

      if (signal && signal.aborted) {
        throw new RegistryError('拉取已取消', 'CANCELLED');
      }
      if (!response.ok) {
        const distribution = await readDistributionError(response);
        throw new RegistryError(
          `目的 PATCH 失败: HTTP ${response.status}`,
          'BLOB_UPLOAD_FAILED',
          { status: response.status, detail: distribution.message }
        ).withOrigin('dest');
      }
      return { bytes: totalWritten, location };
    } catch (error) {
      if (error instanceof RegistryError && error.code === 'CANCELLED') {
        throw error;
      }
      if (controller.signal.aborted || (signal && signal.aborted)) {
        throw new RegistryError('拉取已取消', 'CANCELLED');
      }
      const reason = error?.name === 'AbortError' ? '目的 PATCH 超时或中断' : '目的 PATCH 失败';
      throw new RegistryError(reason, 'BLOB_UPLOAD_FAILED', {
        detail: String(error?.message ?? error),
      }).withOrigin('dest');
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (signal) signal.removeEventListener('abort', abortPipeline);
    }
  }

  /** 目的端 PUT <Location>?digest=<digest>：结束 monolithic upload。 */
  async putDestUpload(location, digest, { signal } = {}) {
    const url = new URL(location, this.baseUrl);
    const query = url.searchParams;
    query.set('digest', digest);
    const finalUrl = `${url.origin}${url.pathname}?${query.toString()}`;
    const response = await this.#request('PUT', finalUrl.replace(this.baseUrl, ''), {
      signal,
      redirect: 'manual',
      origin: 'dest',
    });
    if (response.status === 201) {
      return { finalDigest: (response.headers.get('docker-content-digest') ?? '').trim() || digest };
    }
    const distribution = await readDistributionError(response);
    if (response.status === 400 && distribution.code === 'DIGEST_INVALID') {
      throw new RegistryError('目的上传 digest 校验失败', 'BLOB_UPLOAD_FAILED', {
        detail: distribution.message,
      }).withOrigin('dest');
    }
    throw new RegistryError(
      `目的 PUT 失败: HTTP ${response.status}`,
      'BLOB_UPLOAD_FAILED',
      { status: response.status, detail: distribution.message }
    ).withOrigin('dest');
  }

  /** 目的端 PUT /v2/<repo>/manifests/<tag>：落库 manifest。 */
  async putDestManifest(destRepo, tag, body, contentType, { signal } = {}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    try {
      const headers = { 'Content-Type': contentType };
      const manifestScope = scopeForPath(`/v2/${destRepo}/manifests/${tag}`, 'PUT');
      const manifestToken = manifestScope ? this.tokenCache.get(manifestScope)?.token : undefined;
      if (manifestToken) {
        headers.Authorization = `Bearer ${manifestToken}`;
      } else if (this.authHeader) {
        headers.Authorization = this.authHeader;
      }
      const response = await undiciFetch(`${this.baseUrl}/v2/${destRepo}/manifests/${tag}`, {
        method: 'PUT',
        headers,
        body,
        signal: controller.signal,
        dispatcher: this.dispatcher,
      });
      if (response.status === 201) {
        return {
          digest: (response.headers.get('docker-content-digest') ?? '').trim() || null,
        };
      }
      const distribution = await readDistributionError(response);
      if (response.status === 401 || response.status === 403) {
        throw new RegistryError(destAuthMessage(response.status, destRepo), 'DEST_FORBIDDEN', {
          status: response.status,
        }).withOrigin('dest');
      }
      throw new RegistryError(
        `目的 manifest PUT 失败: HTTP ${response.status}`,
        'MANIFEST_PUT_FAILED',
        { status: response.status, detail: distribution.message }
      ).withOrigin('dest');
    } catch (error) {
      if (error instanceof RegistryError) {
        throw error;
      }
      if (controller.signal.aborted || (signal && signal.aborted)) {
        throw new RegistryError('拉取已取消', 'CANCELLED');
      }
      throw new RegistryError('目的 manifest PUT 失败', 'MANIFEST_PUT_FAILED', {
        detail: String(error?.message ?? error),
      }).withOrigin('dest');
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
}