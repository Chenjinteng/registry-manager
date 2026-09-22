/**
 * 代理库：只存**外部源**用的 HTTP 代理。
 *
 * 与凭据库同一套加密落盘（见 secret-file.mjs），但用独立文件，
 * 互不影响、无需迁移。
 *
 * 为什么本 registry 的代理不在这里：那是**部署级**配置 —— 没有它连
 * 「镜像列表」都打不开，所以必须放在 registry.config.json / REGISTRY_PROXY 里；
 * 代理库服务的是"这次拉取走哪个代理去访问源"这种**任务级**选择。
 *
 * 支持带 basic auth 的代理（`http://user:pass@host:port`），
 * 但对外一律不回显密码，只给 `hasAuth` 布尔。
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici';

import { EncryptedCollection, randomId } from './secret-file.mjs';
import { RegistryError } from './registry-client.mjs';

const PROXY_TEST_TIMEOUT_MS = 8_000;

/**
 * @typedef {object} Proxy
 * @property {string} id
 * @property {string} name
 * @property {string} url        代理地址，形如 http://192.0.2.10:4433
 * @property {string} username   可空（匿名代理）
 * @property {string} password   可空
 * @property {string} [note]
 * @property {string} createdAt
 * @property {string} updatedAt
 *
 * @typedef {object} ProxyPublic
 * @property {string} id
 * @property {string} name
 * @property {string} url
 * @property {string} username
 * @property {boolean} hasAuth
 * @property {string} [note]
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/** 代理地址必须是 http(s)://host[:port]，且不允许带路径 / 查询串。 */
function validateProxyUrl(raw) {
  const value = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(value)) {
    throw new RegistryError('代理地址必须以 http:// 或 https:// 开头', 'INVALID_REQUEST');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new RegistryError(`代理地址无法解析：${value}`, 'INVALID_REQUEST');
  }
  if (!parsed.hostname) {
    throw new RegistryError('代理地址缺少主机名', 'INVALID_REQUEST');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new RegistryError('代理地址不应带路径（只填 http://主机:端口）', 'INVALID_REQUEST');
  }
  if (parsed.username || parsed.password) {
    // 账号密码走单独字段，避免在 URL 里以明文出现（也便于脱敏回显）。
    throw new RegistryError('代理地址里不要内嵌账号密码，请填到用户名 / 密码字段', 'INVALID_REQUEST');
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function validateProxyInput(input) {
  const name = String(input?.name ?? '').trim();
  const url = validateProxyUrl(input?.url);
  const username = String(input?.username ?? '').trim();
  const password = String(input?.password ?? '');
  const note = input?.note ? String(input.note) : undefined;

  if (!name) {
    throw new RegistryError('代理名称不能为空', 'INVALID_REQUEST');
  }
  return { name, url, username, password, note };
}

/**
 * 把代理条目拼成 ProxyAgent 能吃的 URL（含 basic auth）。
 *
 * 账号密码要 URL 编码，否则密码里的 `@` `:` `/` 会把 URL 拆坏。
 * 这个结果**只在进程内**用于建连，绝不进 API 响应或任务记录。
 */
export function buildProxyUrl(proxy) {
  const parsed = new URL(proxy.url);
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? '')}@`
    : '';
  return `${parsed.protocol}//${auth}${parsed.host}`;
}

/**
 * 通过代理访问一个目标地址，用来验证"这个代理能不能用"。
 *
 * 代理本身没有可直接 GET 的资源，必须实际穿过它访问一个目标才能测出来；
 * 所以调用方要指定 targetUrl（默认由路由给成本 registry 的 /v2/）。
 *
 * **超时用 Promise.race 硬兜底**，不能只靠 AbortController：
 * 实测当代理能建 TCP 但到不了目标时，undici 的 abort 不会穿透正在建立的
 * CONNECT 隧道，请求会永远挂着 —— 那样测试接口就永远不返回了。
 */
export async function testProxyConnectivity(proxy, targetUrl) {
  const startedAt = Date.now();
  const dispatcher = new ProxyAgent(buildProxyUrl(proxy));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TEST_TIMEOUT_MS);

  const attempt = (async () => {
    const response = await undiciFetch(targetUrl, {
      method: 'GET',
      headers: { 'Cache-Control': 'no-cache' },
      signal: controller.signal,
      dispatcher,
    });
    // 只关心能否穿过代理拿到响应；把 body 丢掉以免占用连接。
    await response.arrayBuffer().catch(() => {});
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      elapsedMs: Date.now() - startedAt,
      targetUrl,
      registryApiVersion:
        (response.headers.get('docker-distribution-api-version') ?? '').trim() || null,
    };
  })();

  const hardTimeout = new Promise((resolve) => {
    // 比 abort 略长：让 abort 先有机会正常收尾，它不生效时再由这里接管。
    setTimeout(
      () =>
        resolve({
          ok: false,
          elapsedMs: Date.now() - startedAt,
          targetUrl,
          error: `经代理访问超时（${PROXY_TEST_TIMEOUT_MS / 1000}s 无响应）`,
        }),
      PROXY_TEST_TIMEOUT_MS + 1_000
    ).unref?.();
  });

  try {
    const result = await Promise.race([
      attempt.catch((error) => {
        const aborted = error?.name === 'AbortError';
        return {
          ok: false,
          elapsedMs: Date.now() - startedAt,
          targetUrl,
          error: aborted
            ? `经代理访问超时（${PROXY_TEST_TIMEOUT_MS / 1000}s 无响应）`
            : `经代理访问失败：${String(error?.message ?? error)}`,
        };
      }),
      hardTimeout,
    ]);
    return result;
  } finally {
    clearTimeout(timer);
    // 不 await：连接卡住时 close() 也可能长时间不返回，不能因此拖住测试结果。
    dispatcher.close().catch(() => {});
    // attempt 若在超时后才失败，避免产生未处理的 rejection。
    attempt.catch(() => {});
  }
}

export class ProxyStore {
  #store;

  constructor({ filePath, masterKey }) {
    this.#store = new EncryptedCollection({ filePath, masterKey, label: '代理' });
  }

  get filePath() {
    return this.#store.filePath;
  }

  list() {
    return this.#store.readAll();
  }

  get(id) {
    return this.#store.get(id);
  }

  async create(input) {
    const validated = validateProxyInput(input);
    const all = this.list();
    const now = new Date().toISOString();
    const item = { id: randomId(), ...validated, createdAt: now, updatedAt: now };
    await this.#store.writeAll([...all, item]);
    return item;
  }

  async update(id, patch) {
    const all = this.list();
    const index = all.findIndex((p) => p.id === id);
    if (index < 0) {
      throw new RegistryError('代理不存在', 'JOB_NOT_FOUND');
    }
    const next = { ...all[index] };

    if (patch?.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw new RegistryError('代理名称不能为空', 'INVALID_REQUEST');
      next.name = name;
    }
    if (patch?.url !== undefined) {
      next.url = validateProxyUrl(patch.url);
    }
    if (patch?.username !== undefined) {
      next.username = String(patch.username).trim();
    }
    if (patch?.password !== undefined) {
      // 空字符串视为"清掉密码"（匿名代理），与凭据库"省略即保留"不同：
      // 代理常常要从带认证改成不带，这里显式支持清空。
      next.password = String(patch.password);
    }
    if (patch?.note !== undefined) {
      next.note = patch.note ? String(patch.note) : undefined;
    }

    next.updatedAt = new Date().toISOString();
    const copy = [...all];
    copy[index] = next;
    await this.#store.writeAll(copy);
    return next;
  }

  async remove(id) {
    const all = this.list();
    const next = all.filter((p) => p.id !== id);
    if (next.length === all.length) {
      throw new RegistryError('代理不存在', 'JOB_NOT_FOUND');
    }
    await this.#store.writeAll(next);
    return { id };
  }
}

/** 脱敏成对外形态：永远不带 password 字段。 */
export function pickProxyPublic(p) {
  return {
    id: p.id,
    name: p.name,
    url: p.url,
    username: p.username ?? '',
    hasAuth: Boolean(p.username),
    note: p.note,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
