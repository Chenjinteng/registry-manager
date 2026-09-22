/**
 * 加密 JSON 文件存储的共用原语。
 *
 * 凭据库与代理库都用它：两者都是"需要落盘、必须加密、用同一个密钥"的小集合，
 * 所以把 AES-GCM、密钥派生、原子写、文件锁抽在这里，避免各写一份。
 * 各自用**独立的文件**（credentials.json / proxies.json），互不影响、无需迁移。
 *
 * 设计要点：
 * - AES-256-GCM 加密整个数组，密文里不含条目数量与字段长度信息；
 * - 密钥由 masterKey 经 scrypt 派生，salt 每次写入随机，随密文一起存放；
 * - 写入是原子的（写 tmp + rename），进程被中断不会留下半截文件；
 * - 每个文件一把进程内锁，串行化写操作。
 *
 * 限制（README 会再次提醒）：密钥 + 文件同时丢失 = 永久不可恢复，
 * 这是 AES-GCM 的固有限制，不是本实现的缺陷。
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { RegistryError } from './registry-client.mjs';

const SCHEMA_VERSION = 1;
const KDF = 'scrypt';
const KDF_KEYLEN = 32;
const KDF_SALT_BYTES = 16;
const KDF_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/** 派生 32 字节密钥。同 masterKey + 同 salt 必得到同密钥。 */
function deriveKey(masterKey, salt) {
  return scryptSync(masterKey, salt, KDF_KEYLEN, KDF_PARAMS);
}

/** 加密成 base64（拼装：salt | iv | tag | ciphertext）。 */
function encryptPayload(plain, masterKey) {
  const salt = randomBytes(KDF_SALT_BYTES);
  const key = deriveKey(masterKey, salt);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(plain), 'utf8')),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, authTag, ciphertext]).toString('base64');
}

function decryptPayload(b64, masterKey) {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length < KDF_SALT_BYTES + IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error('密文长度不足，文件被破坏');
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

/** 生成 UUIDv4（不引外部依赖）。 */
export function randomId() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 去掉尾部斜杠，用于 URL 比较。 */
export function normalizeUrl(url) {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

/**
 * 一个加密文件里的条目集合。
 *
 * 读取是**同步**的（只用 readFileSync + 同步 crypto，没有等待点），
 * 这样调用方在入队/校验等同步路径里也能查；写操作经内部锁串行化后异步完成。
 *
 * @param {object} opts
 * @param {string} opts.filePath  加密文件路径
 * @param {string} opts.masterKey 主密钥（来自 REGISTRY_CREDENTIAL_KEY）
 * @param {string} opts.label    错误信息里的人话名称，如「凭据」「代理」
 */
export class EncryptedCollection {
  #filePath;
  #masterKey;
  #label;
  #lock = Promise.resolve();

  constructor({ filePath, masterKey, label = '数据' }) {
    if (!masterKey) {
      throw new Error(`${label}库未配置密钥：请设置环境变量 REGISTRY_CREDENTIAL_KEY`);
    }
    this.#filePath = filePath;
    this.#masterKey = masterKey;
    this.#label = label;
    this.#ensureDir();
  }

  get filePath() {
    return this.#filePath;
  }

  /**
   * 准备目录，并**主动验证可写**。
   *
   * 为什么要探测而不是等第一次写入：目录"存在但不可写"时，mkdir 不会执行、
   * chmod 失败又被忽略，构造会静默成功 —— 页面显示一切正常，直到用户第一次
   * 新增凭据才失败，而且错误信息跟权限毫无关系，极难排查。
   * 这里建一个探针文件，把问题在启动时就钉死在数据目录上。
   */
  #ensureDir() {
    const dir = dirname(this.#filePath);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'n/a';
    const gid = typeof process.getgid === 'function' ? process.getgid() : 'n/a';

    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      try {
        chmodSync(dir, 0o700);
      } catch {
        // 某些平台（macOS 开发机）拿不到权限位，忽略。
      }
      const probe = `${dir}/.write-probe`;
      writeFileSync(probe, '');
      rmSync(probe, { force: true });
    } catch (error) {
      const code = error?.code ?? 'UNKNOWN';
      throw new Error(
        `数据目录不可用：${dir}\n` +
          `  原因：${code} ${error?.message ?? error}\n` +
          `  当前进程身份：uid=${uid} gid=${gid}\n` +
          `  该目录必须【存在】且对上面这个 uid 可写。按部署方式挑一条：\n` +
          `  · 容器：本镜像已预建 /app/data 并交给 node 用户，报这个错多半是在用旧镜像 ——\n` +
          `      docker compose up -d --build\n` +
          `  · 容器：命名卷是早先用旧镜像建的，属主成了 root。卷里本来就没数据，删掉重建：\n` +
          `      docker compose down\n` +
          `      docker volume ls | grep registry-manager   # 找到卷名\n` +
          `      docker volume rm <上面那个卷名>\n` +
          `      docker compose up -d\n` +
          `  · bind mount：宿主机目录属主必须是 uid 1000 ——\n` +
          `      sudo chown -R 1000:1000 ./data\n` +
          `  · 只想先跑起来（不持久化）：加 -e REGISTRY_CREDENTIALS_DIR=/tmp/registry-manager-data`
      );
    }
  }

  /** 读全部条目（明文，含密码）。文件不存在 = 空集合。 */
  readAll() {
    if (!existsSync(this.#filePath)) {
      return [];
    }
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.#filePath, 'utf8'));
    } catch (error) {
      throw new RegistryError(
        `${this.#label}文件被破坏（不是合法 JSON）：${error.message}`,
        'CREDENTIAL_FILE_BROKEN'
      );
    }
    if (raw?.schema !== SCHEMA_VERSION) {
      throw new RegistryError(
        `${this.#label}文件 schema 不支持：${raw?.schema}`,
        'CREDENTIAL_FILE_BROKEN'
      );
    }
    if (raw.kdf !== KDF) {
      throw new RegistryError(`${this.#label}文件 KDF 不支持：${raw.kdf}`, 'CREDENTIAL_FILE_BROKEN');
    }
    let plain;
    try {
      plain = decryptPayload(raw.ciphertext, this.#masterKey);
    } catch (error) {
      throw new RegistryError(
        `${this.#label}文件解密失败：${error.message}。通常是密钥不匹配或文件被篡改`,
        'CREDENTIAL_DECRYPT_FAILED'
      );
    }
    if (!Array.isArray(plain)) {
      throw new RegistryError(`${this.#label}文件内容不是数组`, 'CREDENTIAL_FILE_BROKEN');
    }
    return plain;
  }

  get(id) {
    return this.readAll().find((item) => item.id === id) ?? null;
  }

  /** 原子写：写 tmp + rename + 收紧权限。 */
  async writeAll(items) {
    const run = async () => {
      const ciphertext = encryptPayload(items, this.#masterKey);
      const payload = JSON.stringify({ schema: SCHEMA_VERSION, kdf: KDF, ciphertext }, null, 2);
      const tmp = `${this.#filePath}.tmp`;
      writeFileSync(tmp, payload, 'utf8');
      try {
        chmodSync(tmp, 0o600);
      } catch {
        // ignore
      }
      renameSync(tmp, this.#filePath);
      try {
        chmodSync(this.#filePath, 0o600);
      } catch {
        // ignore
      }
    };
    const next = this.#lock.then(run);
    // 吞掉链上的失败，避免一次写失败让后续写永远拿不到锁。
    this.#lock = next.catch(() => {});
    return next;
  }
}
