/**
 * 凭据库：加密 JSON 文件。
 *
 * 设计要点：
 * - AES-256-GCM 加密整个凭据数组（不含密码长度信息）；
 * - 密钥从环境变量 REGISTRY_CREDENTIAL_KEY 派生（scrypt），不落盘 / 不进镜像；
 * - API 输出永远不带明文密码（pickPublic 把 password 替换成 hasPassword 布尔）；
 * - 单进程单文件锁，写入是原子的（write tmp + rename）。
 *
 * 失败 / 限制：
 * - 密钥 + 文件同时丢失 = 永久不可恢复。这是 AES-GCM 的固有限制，README 会再次提醒。
 * - 这里只存 source / dest 双向的 basic auth；不做 OAuth / token rotation。
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { RegistryError } from './registry-client.mjs';

const SCHEMA_VERSION = 1;
const KDF = 'scrypt';
const KDF_KEYLEN = 32;
const KDF_SALT_BYTES = 16;
const KDF_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * @typedef {'source' | 'dest' | 'both'} CredentialPurpose
 *
 * @typedef {object} Credential
 * @property {string} id
 * @property {string} name
 * @property {string} registryUrl
 * @property {CredentialPurpose} purpose
 * @property {string} username
 * @property {string} password
 * @property {string} [note]
 * @property {string} createdAt
 * @property {string} updatedAt
 *
 * @typedef {object} CredentialPublic
 * @property {string} id
 * @property {string} name
 * @property {string} registryUrl
 * @property {CredentialPurpose} purpose
 * @property {string} username
 * @property {boolean} hasPassword
 * @property {string} [note]
 * @property {string} createdAt
 * @property {string} updatedAt
 */

let fileLock = Promise.resolve();

/**
 * 派生 32 字节密钥。两次调用同 masterKey + 同 salt 必得到同密钥。
 */
function deriveKey(masterKey, salt) {
  return scryptSync(masterKey, salt, KDF_KEYLEN, KDF_PARAMS);
}

/**
 * 把对象加密成 base64 字符串（AES-256-GCM + 12B IV + 16B tag）。
 */
function encryptPayload(plain, masterKey) {
  const salt = randomBytes(KDF_SALT_BYTES);
  const key = deriveKey(masterKey, salt);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(plain), 'utf8')), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // 拼装：salt | iv | tag | ciphertext
  return Buffer.concat([salt, iv, authTag, ciphertext]).toString('base64');
}

function decryptPayload(b64, masterKey) {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length < KDF_SALT_BYTES + IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error('凭据文件被破坏');
  }
  const salt = raw.subarray(0, KDF_SALT_BYTES);
  const iv = raw.subarray(KDF_SALT_BYTES, KDF_SALT_BYTES + IV_BYTES);
  const tag = raw.subarray(KDF_SALT_BYTES + IV_BYTES, KDF_SALT_BYTES + IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = raw.subarray(KDF_SALT_BYTES + IV_BYTES + AUTH_TAG_BYTES);
  const key = deriveKey(masterKey, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/**
 * 验证创建/更新请求的字段合法性。
 */
function validateCredentialInput(input) {
  const name = String(input?.name ?? '').trim();
  const registryUrl = String(input?.registryUrl ?? '').trim();
  const username = String(input?.username ?? '').trim();
  const password = String(input?.password ?? '');
  const purpose = input?.purpose ?? 'both';
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
  if (!['source', 'dest', 'both'].includes(purpose)) {
    throw new RegistryError('purpose 必须是 source / dest / both 之一', 'INVALID_REQUEST');
  }
  return { name, registryUrl, username, password, purpose, note };
}

/**
 * 凭据库：单例。
 */
export class CredentialStore {
  constructor({ filePath, masterKey }) {
    if (!masterKey) {
      throw new Error('凭据库未配置密钥：请设置环境变量 REGISTRY_CREDENTIAL_KEY');
    }
    this.filePath = resolve(filePath);
    this.masterKey = masterKey;
    this.#ensureDir();
  }

  #ensureDir() {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    try {
      chmodSync(dir, 0o700);
    } catch {
      // 一些平台（macOS 开发机）拿不到权限位，忽略。
    }
  }

  /** 文件锁：串行化所有写操作，避免并发覆盖。 */
  #withLock(fn) {
    const next = fileLock.then(() => fn());
    fileLock = next.catch(() => {});
    return next;
  }

  /** 读全部凭据（明文，含 password）；解密失败抛 RegistryError。 */
  /**
   * 读全部凭据（明文，含 password）。
   *
   * **同步**：内部只用 readFileSync + 同步 crypto，没有等待点；
   * 保持同步让 enqueue 时的凭据校验（id 存在 / 用途 / url 匹配）不必变成异步。
   * 写路径才是异步的（#writeAll 经文件锁串行化）。
   */
  #readAll() {
    if (!existsSync(this.filePath)) {
      return [];
    }
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new RegistryError(`凭据文件被破坏（不是合法 JSON）：${error.message}`, 'CREDENTIAL_FILE_BROKEN');
    }
    if (raw?.schema !== SCHEMA_VERSION) {
      throw new RegistryError(`凭据文件 schema 不支持：${raw?.schema}`, 'CREDENTIAL_FILE_BROKEN');
    }
    if (raw.kdf !== KDF) {
      throw new RegistryError(`凭据文件 KDF 不支持：${raw.kdf}`, 'CREDENTIAL_FILE_BROKEN');
    }
    let plain;
    try {
      plain = decryptPayload(raw.ciphertext, this.masterKey);
    } catch (error) {
      throw new RegistryError(
        `凭据文件解密失败：${error.message}。通常是密钥不匹配或文件被篡改`,
        'CREDENTIAL_DECRYPT_FAILED'
      );
    }
    if (!Array.isArray(plain)) {
      throw new RegistryError('凭据文件内容不是数组', 'CREDENTIAL_FILE_BROKEN');
    }
    return plain;
  }

  /** 原子写：写 tmp + rename，进程被中断不会留下半截文件。 */
  async #writeAll(items) {
    return this.#withLock(async () => {
      const ciphertext = encryptPayload(items, this.masterKey);
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ schema: SCHEMA_VERSION, kdf: KDF, ciphertext }, null, 2), 'utf8');
      try {
        chmodSync(tmp, 0o600);
      } catch {
        // ignore
      }
      renameSync(tmp, this.filePath);
      try {
        chmodSync(this.filePath, 0o600);
      } catch {
        // ignore
      }
    });
  }

  list() {
    return this.#readAll();
  }

  get(id) {
    const all = this.#readAll();
    return all.find((c) => c.id === id) ?? null;
  }

  /**
   * 按 registryUrl 严格匹配返回第一条；用途筛选后没有命中返回 null。
   * 注意：这里**不**用于任务自动应用（那个决策在路由层做），仅供显式选择路径使用。
   */
  findByUrl(url, purpose) {
    const target = String(url ?? '').trim().replace(/\/+$/, '');
    const all = this.#readAll();
    return (
      all.find(
        (c) =>
          c.registryUrl.replace(/\/+$/, '') === target &&
          (purpose ? c.purpose === purpose || c.purpose === 'both' : true)
      ) ?? null
    );
  }

  async create(input) {
    const validated = validateCredentialInput(input);
    const all = this.#readAll();
    const id = randomBytesUUID();
    const now = new Date().toISOString();
    const item = {
      id,
      name: validated.name,
      registryUrl: validated.registryUrl.replace(/\/+$/, ''),
      username: validated.username,
      password: validated.password,
      purpose: validated.purpose,
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
    if (patch?.purpose !== undefined) {
      if (!['source', 'dest', 'both'].includes(patch.purpose)) {
        throw new RegistryError('purpose 必须是 source / dest / both 之一', 'INVALID_REQUEST');
      }
      next.purpose = patch.purpose;
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
    purpose: c.purpose,
    username: c.username,
    hasPassword: Boolean(c.password),
    note: c.note,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** 去掉尾部斜杠，用于 registryUrl 比较。 */
function normalizeUrl(url) {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

/**
 * 校验一条凭据能否用于指定方向与目标地址；不能则抛 RegistryError。
 *
 * 入队时（同步）与执行时（runner 内）共用这一份判定，
 * 避免"入队成功、执行立刻失败"这种让用户白点一次确认的体验。
 *
 * @param {Credential} credential
 * @param {'source' | 'dest'} purpose
 * @param {string} targetUrl 实际要访问的 registry 地址
 */
export function assertCredentialUsable(credential, purpose, targetUrl) {
  const side = purpose === 'source' ? '源' : '目的';
  if (credential.purpose !== purpose && credential.purpose !== 'both') {
    throw new RegistryError(`凭据「${credential.name}」未启用为「${side}」用途`, 'INVALID_REQUEST').withOrigin(
      purpose
    );
  }
  const target = normalizeUrl(targetUrl);
  const stored = normalizeUrl(credential.registryUrl);
  if (target !== stored) {
    throw new RegistryError(
      `凭据「${credential.name}」的 registryUrl（${stored}）与实际${side}地址（${target}）不一致，已拒绝使用`,
      'CREDENTIAL_URL_MISMATCH'
    ).withOrigin(purpose);
  }
}

function randomBytesUUID() {
  // 用 crypto.randomBytes 自己造一个 UUIDv4。避开 node:crypto 的 randomUUID
  // 以保持 ESM 单文件兼容；也不依赖外部包。
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}