/**
 * 凭据库：只存**外部源** registry 的 basic auth。
 *
 * 加密与落盘细节见 secret-file.mjs（AES-256-GCM + scrypt + 原子写）。
 * API 输出永远不带明文密码（pickCredentialPublic 把 password 换成 hasPassword）。
 *
 * 本 registry 自身的凭据属于部署配置（没有它连镜像列表都打不开），
 * 放在 config.mjs 里，不由这里管理 —— 因此没有"用途"这个维度。
 */
import { EncryptedCollection, normalizeUrl, randomId } from './secret-file.mjs';
import { RegistryError } from './registry-client.mjs';

/**
 * 验证创建/更新请求的字段合法性。
 */
function validateCredentialInput(input) {
  const name = String(input?.name ?? '').trim();
  const registryUrl = String(input?.registryUrl ?? '').trim();
  const username = String(input?.username ?? '').trim();
  const password = String(input?.password ?? '');
  const note = input?.note ? String(input.note) : undefined;

  if (!name) {
    throw new RegistryError('凭据名称不能为空', 'INVALID_REQUEST');
  }
  if (!/^https?:\/\//i.test(registryUrl)) {
    throw new RegistryError('registryUrl 必须以 http:// 或 https:// 开头', 'INVALID_REQUEST');
  }
  if (!username) {
    throw new RegistryError('用户名不能为空', 'INVALID_REQUEST');
  }
  if (password && password.length < 1) {
    throw new RegistryError('密码不能为空字符串', 'INVALID_REQUEST');
  }
  return { name, registryUrl, username, password, note };
}

/**
 * 凭据库：单例。
 */
export class CredentialStore {
  #store;

  constructor({ filePath, masterKey }) {
    this.#store = new EncryptedCollection({ filePath, masterKey, label: '凭据' });
  }

  get filePath() {
    return this.#store.filePath;
  }

  /**
   * 读全部凭据（明文，含 password）。
   *
   * **同步**：内部只用 readFileSync + 同步 crypto，没有等待点；
   * 保持同步让 enqueue 时的凭据校验（id 存在 / registryUrl 匹配）不必变成异步。
   * 写路径才是异步的（经 EncryptedCollection 的锁串行化）。
   */
  #readAll() {
    return this.#store.readAll();
  }

  #writeAll(items) {
    return this.#store.writeAll(items);
  }

  list() {
    return this.#readAll();
  }

  get(id) {
    return this.#store.get(id);
  }

  /**
   * 按 registryUrl 严格匹配返回第一条；没有命中返回 null。
   * 注意：任务不会自动套用凭据（必须显式选），这里仅供显式选择路径使用。
   */
  findByUrl(url) {
    const target = String(url ?? '').trim().replace(/\/+$/, '');
    const all = this.#readAll();
    return (
      all.find((c) => c.registryUrl.replace(/\/+$/, '') === target) ?? null
    );
  }

  async create(input) {
    const validated = validateCredentialInput(input);
    const all = this.#readAll();
    const id = randomId();
    const now = new Date().toISOString();
    const item = {
      id,
      name: validated.name,
      registryUrl: validated.registryUrl.replace(/\/+$/, ''),
      username: validated.username,
      password: validated.password,
      note: validated.note,
      createdAt: now,
      updatedAt: now,
    };
    await this.#writeAll([...all, item]);
    return item;
  }

  async update(id, patch) {
    const all = this.#readAll();
    const index = all.findIndex((c) => c.id === id);
    if (index < 0) {
      throw new RegistryError('凭据不存在', 'JOB_NOT_FOUND');
    }
    const current = all[index];
    const next = { ...current };

    if (patch?.name !== undefined) {
      if (!String(patch.name).trim()) {
        throw new RegistryError('凭据名称不能为空', 'INVALID_REQUEST');
      }
      next.name = String(patch.name).trim();
    }
    if (patch?.registryUrl !== undefined) {
      const url = String(patch.registryUrl).trim();
      if (!/^https?:\/\//i.test(url)) {
        throw new RegistryError('registryUrl 必须以 http:// 或 https:// 开头', 'INVALID_REQUEST');
      }
      next.registryUrl = url.replace(/\/+$/, '');
    }
    if (patch?.username !== undefined) {
      const u = String(patch.username).trim();
      if (!u) throw new RegistryError('用户名不能为空', 'INVALID_REQUEST');
      next.username = u;
    }
    if (patch?.password !== undefined) {
      const p = String(patch.password);
      if (!p) {
        throw new RegistryError('密码不能为空字符串', 'INVALID_REQUEST');
      }
      next.password = p;
    }
    if (patch?.note !== undefined) {
      next.note = patch.note ? String(patch.note) : undefined;
    }

    next.updatedAt = new Date().toISOString();
    const copy = [...all];
    copy[index] = next;
    await this.#writeAll(copy);
    return next;
  }

  async remove(id) {
    const all = this.#readAll();
    const next = all.filter((c) => c.id !== id);
    if (next.length === all.length) {
      throw new RegistryError('凭据不存在', 'JOB_NOT_FOUND');
    }
    await this.#writeAll(next);
    return { id };
  }
}

/**
 * 把凭据脱敏成对外形态：永远不带 password 字段。
 * @param {Credential} c
 * @returns {CredentialPublic}
 */
export function pickCredentialPublic(c) {
  return {
    id: c.id,
    name: c.name,
    registryUrl: c.registryUrl,
    username: c.username,
    hasPassword: Boolean(c.password),
    note: c.note,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/**
 * 校验一条凭据能否用于目标源地址；不能则抛 RegistryError。
 *
 * 凭据只用于外部源，所以唯一的判定就是「registryUrl 必须严格匹配」。
 * 入队时（同步）与执行时（runner 内）共用这一份判定，
 * 避免"入队成功、执行立刻失败"这种让用户白点一次确认的体验。
 *
 * @param {Credential} credential
 * @param {string} targetUrl 实际要访问的源 registry 地址
 */
export function assertCredentialUsable(credential, targetUrl) {
  const target = normalizeUrl(targetUrl);
  const stored = normalizeUrl(credential.registryUrl);
  if (target !== stored) {
    throw new RegistryError(
      `凭据「${credential.name}」的 registryUrl（${stored}）与实际源地址（${target}）不一致，已拒绝使用`,
      'CREDENTIAL_URL_MISMATCH'
    ).withOrigin('source');
  }
}
