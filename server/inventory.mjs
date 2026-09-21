/**
 * 镜像清单的构建与缓存。
 *
 * registry 没有任何聚合或容量接口，所以要回答"有哪些镜像、多大"必须逐个 tag
 * 读 manifest 与 image config。因此清单在服务端构建一次并缓存，页面直接消费
 * 完整快照（实测 65 仓库 / 79 tag 约 1 秒）。
 */
import { RegistryError } from './registry-client.mjs';

const INDEX_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);

const MAX_REPOSITORIES = 2000;
const MAX_TAGS_PER_REPOSITORY = 500;
const MAX_REPORTED_ERRORS = 20;
const FETCH_CONCURRENCY = 8;

/** 并发受限的 map，避免对 registry 打出瞬时并发高峰。 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 解析镜像构建时间。
 *
 * OCI 允许任意精度的小数秒（实测 9 位纳秒 + Z），统一截断到毫秒再交给 Date，
 * 否则 Date 解析会得到 Invalid Date。
 */
export function parseRegistryTimestamp(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return null;
  }
  const value = raw.trim().replace(/(\.\d{3})\d+/, '$1');
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * 把 manifest 归一化成"单个平台"的形态。
 *
 * 多架构索引本身没有 layers/config，体积与架构都不明确；取第一个子 manifest
 * 作为代表（即 docker pull 实际取得的那一份），并保留平台数量。
 */
async function selectRepresentative(client, repository, manifest) {
  const mediaType = String(manifest.payload?.mediaType || manifest.mediaType || '');
  const entries = manifest.payload?.manifests;
  if (!INDEX_MEDIA_TYPES.has(mediaType) || !Array.isArray(entries) || entries.length === 0) {
    return { payload: manifest.payload, platformCount: 1 };
  }
  const childDigest = entries[0]?.digest;
  if (!childDigest) {
    return { payload: manifest.payload, platformCount: entries.length };
  }
  const child = await client.fetchManifest(repository, String(childDigest));
  return {
    payload: child.payload,
    platformCount: entries.length,
  };
}

export async function describeTag(client, repository, tag) {
  const manifest = await client.fetchManifest(repository, tag);
  const { payload, platformCount } = await selectRepresentative(client, repository, manifest);

  const config = payload?.config && typeof payload.config === 'object' ? payload.config : {};
  const layers = Array.isArray(payload?.layers) ? payload.layers : [];
  const size = layers.reduce((total, layer) => total + (Number(layer?.size) || 0), 0);
  const annotations =
    payload?.annotations && typeof payload.annotations === 'object' ? payload.annotations : {};

  let architecture = '';
  let os = '';
  let createdAt = null;
  if (config.digest) {
    try {
      const blob = await client.fetchConfigBlob(repository, String(config.digest));
      architecture = String(blob?.architecture ?? '');
      os = String(blob?.os ?? '');
      createdAt = parseRegistryTimestamp(blob?.created);
    } catch (error) {
      // config 读不到不该让整个 tag 消失：体积与层数仍然有效。
      if (!(error instanceof RegistryError)) {
        throw error;
      }
    }
  }
  createdAt ??= parseRegistryTimestamp(annotations['org.opencontainers.image.created']);

  return {
    tag,
    digest: manifest.digest,
    size,
    layerCount: layers.length,
    architecture,
    os,
    platformCount,
    createdAt,
  };
}

/** 读取一个仓库的全部 tag；单个 tag 失败只登记为错误，不中断整个仓库。 */
export async function readRepository(client, name) {
  const tags = (await client.listTags(name)).slice(0, MAX_TAGS_PER_REPOSITORY);
  const errors = [];
  const described = await mapWithConcurrency(tags, FETCH_CONCURRENCY, async (tag) => {
    try {
      return await describeTag(client, name, tag);
    } catch (error) {
      const registryError =
        error instanceof RegistryError ? error : new RegistryError(String(error), 'UNKNOWN');
      errors.push({ repository: name, tag, code: registryError.code, message: registryError.message });
      return null;
    }
  });

  const kept = described.filter(Boolean).sort((left, right) => left.tag.localeCompare(right.tag));
  return {
    name,
    tags: kept,
    tagCount: kept.length,
    totalSize: kept.reduce((total, item) => total + item.size, 0),
  };
}

export class Inventory {
  #client;
  #ttlMs;
  #state = null;
  #inflight = null;

  constructor(client, { ttlSeconds = 60 } = {}) {
    this.#client = client;
    this.#ttlMs = ttlSeconds * 1000;
  }

  invalidate() {
    this.#state = null;
  }

  /** 缓存是否仍然新鲜。 */
  get isFresh() {
    return Boolean(this.#state) && Date.now() - this.#state.builtAt < this.#ttlMs;
  }

  async get({ force = false } = {}) {
    if (!force && this.isFresh) {
      return this.#state;
    }
    // 并发请求共享同一次构建，避免同时打出多轮全量抓取。
    if (!this.#inflight) {
      this.#inflight = this.#build().finally(() => {
        this.#inflight = null;
      });
    }
    return this.#inflight;
  }

  async #build() {
    const startedAt = Date.now();
    const probe = await this.#client.probe();
    const names = (await this.#client.listRepositories()).slice(0, MAX_REPOSITORIES);
    const truncated = names.length >= MAX_REPOSITORIES;

    const errors = [];
    const repositories = (
      await mapWithConcurrency(names, FETCH_CONCURRENCY, async (name) => {
        try {
          return await readRepository(this.#client, name);
        } catch (error) {
          // 单个仓库读不到（例如被并发删除）不阻断整次盘点。
          const registryError =
            error instanceof RegistryError ? error : new RegistryError(String(error), 'UNKNOWN');
          errors.push({ repository: name, tag: '', code: registryError.code, message: registryError.message });
          return null;
        }
      })
    )
      .filter(Boolean)
      .sort((left, right) => left.name.localeCompare(right.name));

    this.#state = {
      builtAt: Date.now(),
      refreshedAt: new Date().toISOString(),
      apiVersion: probe.apiVersion,
      host: probe.host,
      durationMs: Date.now() - startedAt,
      truncated,
      repositories,
      errors: errors.slice(0, MAX_REPORTED_ERRORS),
      errorCount: errors.length,
    };
    return this.#state;
  }

  /**
   * 删除后只重读受影响的那一个仓库并回填缓存。
   *
   * 全量重扫会让用户在删除后干等数秒；只重读一个仓库既快，又保证台账
   * 来自 registry 的真实返回，而不是本地推断。
   *
   * 注意：删除最后一个 tag 后仓库**仍然留在列表里**（Tag 数 0）。Distribution
   * 删 manifest 不会移除仓库目录，它依旧出现在 `_catalog` 里；如果这里把它剔除，
   * 就会出现"删除后消失、重新扫描又回来"的矛盾。
   */
  async refreshRepository(name) {
    const repository = await readRepository(this.#client, name);
    if (this.#state) {
      const index = this.#state.repositories.findIndex((item) => item.name === name);
      if (index >= 0) {
        this.#state.repositories[index] = repository;
      } else {
        this.#state.repositories.push(repository);
        this.#state.repositories.sort((left, right) => left.name.localeCompare(right.name));
      }
    }
    return repository;
  }
}
