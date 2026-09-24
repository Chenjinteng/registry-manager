/**
 * 镜像拉取任务队列与执行器。
 *
 * 设计要点：
 * - 单并发：一个 PullJob 占住执行槽；其他任务按 FIFO 排队。
 * - 优雅取消：标记 cancelled → 关掉源/目的 stream；当前正在发的 chunk 会写完。
 * - 任务生命周期：queued → running → succeeded | failed | cancelled
 * - 状态仅存内存（与现有 Inventory 一致），重启即丢。
 *
 * 不做的事：
 * - 源认证：源 registry 要认证时透传错误，本工具不存凭据；
 * - 任务持久化；
 * - 自动并发配置；
 * - 自动重试 / 失败重入。
 */
import { randomUUID } from 'node:crypto';

import { RegistryClient, RegistryError, normalizeBaseUrl } from './registry-client.mjs';
import { assertCredentialUsable } from './credentials.mjs';
import { buildProxyUrl } from './proxies.mjs';

const INDEX_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);

// 仓库名 / tag 的合法字符（与 Docker / Distribution 一致）。
const REPO_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/**
 * Docker Hub 的各个别名（`docker pull nginx` 实际打的是 registry-1.docker.io）。
 */
const DOCKER_HUB_HOSTS = new Set([
  'docker.io',
  'index.docker.io',
  'registry-1.docker.io',
  'registry.docker.io',
]);

function isDockerHubUrl(url) {
  try {
    return DOCKER_HUB_HOSTS.has(new URL(String(url)).hostname);
  } catch {
    return false;
  }
}

/**
 * Docker Hub 的官方镜像（alpine / nginx 这类单段名字）实际位于 `library/` 下。
 * `docker pull nginx` 能用是因为 CLI 自动补了前缀；直接请求 `/v2/nginx/...` 拿不到，
 * 而 Docker Hub 对不存在的仓库也回 401，于是表现为"要求认证"——很容易误判。
 *
 * 只对 Docker Hub 生效，其它 registry 没有这个约定。
 */
function applyDockerHubLibraryPrefix(ref) {
  const value = String(ref ?? '').replace(/^\/+/, '');
  const colon = value.lastIndexOf(':');
  const repo = colon >= 0 && !value.slice(colon + 1).includes('/') ? value.slice(0, colon) : value;
  const tag = colon >= 0 && !value.slice(colon + 1).includes('/') ? value.slice(colon + 1) : '';
  if (!repo || repo.includes('/')) {
    return value;
  }
  return tag ? `library/${repo}:${tag}` : `library/${repo}`;
}

/** 把 sourceRef 拆成 <repo>:<tag>。tag 不允许含 '/';镜像引用形如 library/alpine:3.19。 */
function splitSourceRef(ref) {
  const value = String(ref ?? '').trim();
  if (!value) {
    throw new RegistryError('缺少 sourceRef', 'INVALID_REQUEST');
  }
  const colon = value.lastIndexOf(':');
  if (colon < 0) {
    throw new RegistryError('sourceRef 必须形如 <repo>:<tag>', 'INVALID_REQUEST');
  }
  const repo = value.slice(0, colon).replace(/^\/+/, '');
  const tag = value.slice(colon + 1);
  if (!repo || !tag) {
    throw new RegistryError('sourceRef 必须形如 <repo>:<tag>', 'INVALID_REQUEST');
  }
  if (tag.includes('/')) {
    throw new RegistryError('sourceRef 标签部分不能包含 "/"', 'INVALID_REQUEST');
  }
  return { repo, tag };
}

/**
 * 归一化入参。
 *
 * 目标引用默认就是「源仓库路径 + 源 tag」——工具只管理一个 registry，
 * 目的端主机固定来自配置，所以这里能自动补全的全部自动补全，
 * 调用方（含 curl）只需要给一个镜像名。
 *
 * 注意：`destRepo` 只是**本 registry 内的路径**，写不进别的主机。
 * 含 `:` 的值（例如 `192.0.2.20:10001/foo`）会被 REPO_RE 直接拒掉，
 * 因此不存在"配成 push 到另一个 registry"的可能。
 */
function validateInputs({ sourceRef, destRepo, destTag }) {
  const split = splitSourceRef(sourceRef);
  const effectiveDestRepo = destRepo || split.repo;
  if (!REPO_RE.test(effectiveDestRepo)) {
    throw new RegistryError(
      `destRepo 不合法（仅允许小写字母、数字、._-/ 分段，且只能是本 registry 内的路径）：${effectiveDestRepo}`,
      'INVALID_REQUEST'
    );
  }
  if (destTag && !TAG_RE.test(destTag)) {
    throw new RegistryError(
      'destTag 不合法（仅允许字母数字与 ._- 并允许，1-128 字符）',
      'INVALID_REQUEST'
    );
  }
  return {
    sourceRepo: split.repo,
    sourceTag: split.tag,
    destRepo: effectiveDestRepo,
    destTag: destTag || split.tag,
  };
}

/**
 * 多架构索引本身没有 layers/config，体积与架构都不明确；
 * 取第一个子 manifest 作为代表（与 inventory.mjs 一致）。
 *
 * 返回值：
 *   - isIndex=false：单平台 manifest，body/digest/mediaType 直接来自 ref
 *   - isIndex=true：多架构索引，body/digest/mediaType 是子 manifest 的；indexBody 是索引原字节
 */
async function selectChildManifest(client, repository, ref, { signal, dispatcher }) {
  const head = await client.headSourceManifest(repository, ref, { signal, dispatcher });
  if (!INDEX_MEDIA_TYPES.has(head.mediaType)) {
    const fetched = await client.fetchSourceManifestBytes(repository, ref, { signal, dispatcher });
    return {
      isIndex: false,
      mediaType: head.mediaType,
      digest: head.digest,
      body: fetched.body,
    };
  }
  // 多架构索引：先 GET 索引拿到子 manifest 列表，再取第一个子 manifest 的内容。
  const indexBytes = await client.fetchSourceManifestBytes(repository, ref, { signal, dispatcher });
  let indexJson;
  try {
    indexJson = JSON.parse(indexBytes.body.toString('utf8'));
  } catch {
    throw new RegistryError('源 manifest 索引不是合法 JSON', 'SOURCE_MANIFEST_INVALID').withOrigin('source');
  }
  const childDigest = Array.isArray(indexJson?.manifests) ? indexJson.manifests[0]?.digest : null;
  if (!childDigest) {
    throw new RegistryError('源 manifest 索引为空', 'SOURCE_MANIFEST_INVALID').withOrigin('source');
  }
  const childHead = await client.headSourceManifest(repository, childDigest, {
    signal,
    dispatcher,
  });
  const childBody = await client.fetchSourceManifestBytes(repository, childDigest, {
    signal,
    dispatcher,
  });
  return {
    isIndex: true,
    mediaType: childHead.mediaType,
    digest: childHead.digest,
    body: childBody.body,
  };
}

/** 单个 PullJob 的执行器；不持有任何调度状态。 */
class PullJobRunner {
  /**
   * @param {object} args
   * @param {RegistryClient} args.destClient  本仓库的 RegistryClient（沿用全局 dispatcher）
   * @param {object} args.job
   * @param {AbortSignal} args.signal
   */
  constructor({ destClient, job, signal, credentialStore, proxyStore }) {
    this.destClient = destClient;
    this.job = job;
    this.signal = signal;
    this.credentialStore = credentialStore;
    this.proxyStore = proxyStore;
  }

  /**
   * 检查取消：所有 phase 入口与 blob 写入循环里都要查一次。
   * 命中就抛 RegistryError('CANCELLED')，由 PullQueue 翻译成终态。
   */
  #ensureNotCancelled() {
    if (this.signal.aborted) {
      throw new RegistryError('拉取已取消', 'CANCELLED');
    }
  }

  /**
   * 按凭据 id 取源的认证信息（账号 / 密码）。
   *
   * 校验与入队时共用 `assertCredentialUsable`；这里是纵深防御 ——
   * 万一任务入队后凭据被改写（改了 registryUrl），执行时仍会被拦下。
   */
  #resolveSourceAuth(credentialId, sourceUrl) {
    if (!credentialId) {
      return undefined;
    }
    const credential = this.credentialStore?.get(credentialId);
    if (!credential) {
      throw new RegistryError(`凭据不存在：${credentialId}`, 'JOB_NOT_FOUND').withOrigin('source');
    }
    assertCredentialUsable(credential, sourceUrl);
    return { username: credential.username, password: credential.password };
  }

  /**
   * 解析这次任务要用的源端代理。
   *
   * 优先代理库（按 id，带 basic auth 时在此拼出带凭据的 URL；**只在进程内使用**），
   * 回落到任务自带的临时代理串。
   */
  #resolveSourceProxy(job) {
    if (!job.sourceProxyId) {
      return job.sourceProxy || '';
    }
    const proxy = this.proxyStore?.get(job.sourceProxyId);
    if (!proxy) {
      throw new RegistryError(`代理不存在：${job.sourceProxyId}`, 'JOB_NOT_FOUND').withOrigin('source');
    }
    return buildProxyUrl(proxy);
  }

  /**
   * 跑完整流程：拉 manifest → 按 blob 复制 → 落 manifest。
   * 失败 / 取消都会通过异常表达；调用方根据异常.code 决定 job.status。
   */
  async run() {
    const { job } = this;
    const { sourceUrl } = job;
    const sourceProxy = this.#resolveSourceProxy(job);
    // 源端认证：优先凭据库（按 id 校验 registryUrl），回落到任务自带的临时 inline 账号密码。
    const sourceAuth = job.sourceCredentialId
      ? this.#resolveSourceAuth(job.sourceCredentialId, job.sourceUrl)
      : job.sourceAuthInline;
    const sourceClient = new RegistryClient({
      url: sourceUrl,
      proxy: sourceProxy || '',
      auth: sourceAuth,
    });

    // 目的端不做任务级覆盖：本 registry 的凭据属于部署配置，
    // 已在构造 destClient 时注入（见 index.mjs），#copyBlob / 落库都直接用 this.destClient。
    job.status = 'running';
    job.startedAt = new Date().toISOString();

    // 1) manifest + 下钻到单平台
    const manifestPhase = job.phases[0];
    manifestPhase.status = 'running';
    this.#ensureNotCancelled();
    const manifest = await selectChildManifest(sourceClient, job.sourceRepo, job.sourceTag, {
      signal: this.signal,
      dispatcher: sourceClient.dispatcher,
    });
    manifestPhase.status = 'success';
    manifestPhase.digest = manifest.digest;
    manifestPhase.message = manifest.isIndex ? 'manifest 索引已下钻' : 'manifest 已读取';

    // 取出 layers + config
    const manifestBody = manifest.body;
    let parsedManifest;
    try {
      parsedManifest = JSON.parse(manifestBody.toString('utf8'));
    } catch {
      throw new RegistryError('源 manifest 不是合法 JSON', 'SOURCE_MANIFEST_INVALID').withOrigin('source');
    }
    const layers = Array.isArray(parsedManifest.layers) ? parsedManifest.layers : [];
    const configDigest = parsedManifest.config?.digest;

    // 把 layer phase 占位补齐。manifest/config 已在 enqueue 里占好。
    for (let i = 0; i < layers.length; i += 1) {
      if (!job.phases[2 + i]) {
        job.phases.push(makePhase(`blob:${i}`));
      }
    }

    // 2) config blob
    const configPhase = job.phases[1];
    if (configDigest) {
      configPhase.digest = configDigest;
      configPhase.totalBytes = Number(parsedManifest.config?.size) || null;
      job.totalBytes = (job.totalBytes ?? 0) + (configPhase.totalBytes ?? 0);
      configPhase.status = 'running';
      this.#ensureNotCancelled();
      try {
        await this.#copyBlob({
          sourceClient,
          sourceRepo: job.sourceRepo,
          destRepo: job.destRepo,
          digest: configDigest,
          phase: configPhase,
          contentLengthHint: configPhase.totalBytes,
        });
        configPhase.status = 'success';
      } catch (error) {
        if (this.signal.aborted && error instanceof RegistryError && error.code === 'CANCELLED') {
          throw error;
        }
        configPhase.status = 'failed';
        configPhase.message = error.message;
        throw error;
      }
    } else {
      configPhase.status = 'skipped';
    }

    // 3) 每个 layer
    for (let index = 0; index < layers.length; index += 1) {
      this.#ensureNotCancelled();
      const layer = layers[index];
      const phase = job.phases[2 + index];
      phase.digest = layer.digest;
      phase.totalBytes = Number(layer.size) || null;
      job.totalBytes = (job.totalBytes ?? 0) + (phase.totalBytes ?? 0);
      phase.status = 'running';
      try {
        await this.#copyBlob({
          sourceClient,
          sourceRepo: job.sourceRepo,
          destRepo: job.destRepo,
          digest: layer.digest,
          phase,
          contentLengthHint: phase.totalBytes,
        });
        phase.status = 'success';
      } catch (error) {
        if (this.signal.aborted && error instanceof RegistryError && error.code === 'CANCELLED') {
          throw error;
        }
        phase.status = 'failed';
        phase.message = error.message;
        throw error;
      }
    }

    // 4) manifest 落库
    this.#ensureNotCancelled();
    const putResult = await this.destClient.putDestManifest(
      job.destRepo,
      job.destTag,
      manifestBody,
      manifest.mediaType,
      { signal: this.signal }
    );
    job.finalDigest = putResult.digest || manifest.digest;
    job.status = 'succeeded';
    job.finishedAt = new Date().toISOString();
  }

  /**
   * 复制单个 blob：先尝试 mount，失败回落流式。
   * 取消时抛 RegistryError('CANCELLED')。
   */
  async #copyBlob({ sourceClient, sourceRepo, destRepo, digest, phase, contentLengthHint }) {
    this.#ensureNotCancelled();
    const mount = await this.destClient.mountDestBlob(destRepo, digest, sourceRepo, {
      signal: this.signal,
    });
    if (mount.mounted) {
      // mount 是 0 字节传输；按已知 size 推进一次进度。
      const known = phase.totalBytes ?? 0;
      phase.bytes = known;
      phase.message = '已挂载（mount）';
      this.job.bytes = (this.job.bytes ?? 0) + known;
      return;
    }

    // 回落流式复制
    const source = await sourceClient.openSourceBlob(sourceRepo, digest, {
      signal: this.signal,
      dispatcher: sourceClient.dispatcher,
    });

    const upload = await this.destClient.initDestUpload(destRepo, { signal: this.signal });
    let lastReported = 0;
    const result = await this.destClient.streamBlobToDest({
      location: upload.location,
      source: source.response,
      contentLength: source.contentLength ?? contentLengthHint ?? null,
      signal: this.signal,
      onProgress: (bytes) => {
        // onProgress 触发的是源端累计值；我们自己只增不减。
        const delta = bytes - lastReported;
        lastReported = bytes;
        this.job.bytes = (this.job.bytes ?? 0) + delta;
      },
    });
    phase.bytes = result.bytes;
    if (phase.totalBytes == null) {
      phase.totalBytes = result.bytes;
    }
    await this.destClient.putDestUpload(result.location || upload.location, digest, {
      signal: this.signal,
    });
  }
}

/**
 * 进程内单例任务队列：
 *   - #current 正在执行的任务
 *   - #waiting FIFO 等待队列
 *   - #history 最近 historyLimit 条（含 waiting + current + 完成）
 */
export class PullQueue {
  /**
   * @param {object} args
   * @param {RegistryClient} args.client     本仓库 RegistryClient
   * @param {CredentialStore} [args.credentialStore] 凭据库；提供则任务 / probe 时按 id 取账号密码
   * @param {number}        [args.historyLimit]
   */
  constructor({ client, credentialStore, proxyStore, historyLimit = 50, history = null }) {
    this.client = client;
    this.credentialStore = credentialStore;
    this.proxyStore = proxyStore;
    this.historyLimit = Math.max(1, Math.floor(historyLimit));
    /**
     * 拉取历史的持久层（`server/db.mjs` 的 Db），可选。
     *
     * **可选是刻意的**：队列的运行态本来就不需要数据库，验证脚本（verify-pull.mjs）
     * 也就能在不建库的情况下跑完整流程。不传时退化成原来的"纯内存历史"。
     */
    this.history = history;
    /** @type {Map<string, object>} jobId -> job */
    this.#jobs = new Map();
    /** jobId -> AbortController，仅占 running 的状态 */
    this.#runningAborts = new Map();
    /** 当前执行中的 job id（同时只有 set / null） */
    this.#currentId = null;
    /** 等待队列（FIFO），只放 job id；按 enqueue 顺序处理 */
    this.#waiting = [];
  }

  #jobs;
  #runningAborts;
  #currentId;
  #waiting;

  /** 构造一个 PullJob 记录：queued + 初始化 phases。 */
  #createJobRecord({
    sourceUrl,
    sourceRef,
    sourceProxy,
    sourceProxyId,
    destRepo,
    destTag,
    sourceCredentialId,
    sourceAuthInline,
  }) {
    const validated = validateInputs({ sourceRef, destRepo, destTag });
    let normalizedSourceUrl;
    try {
      normalizedSourceUrl = normalizeBaseUrl(sourceUrl);
    } catch (error) {
      if (error instanceof RegistryError) {
        throw new RegistryError(error.message, 'INVALID_URL').withOrigin('source');
      }
      throw error;
    }
    if (sourceProxy) {
      // 校验代理格式；不能解析只校验字符串前缀（ProxyAgent 在构造时再解析）。
      if (!/^https?:\/\//i.test(sourceProxy.trim())) {
        throw new RegistryError('sourceProxy 必须以 http:// 或 https:// 开头', 'INVALID_URL').withOrigin(
          'source'
        );
      }
    }
    // Docker Hub 的别名统一到真正的 API 主机，并给官方镜像补上 library/
    // （curl / API 直接调用也要和页面行为一致）。
    const effectiveSourceUrl = isDockerHubUrl(normalizedSourceUrl)
      ? 'https://registry-1.docker.io'
      : normalizedSourceUrl;
    const effectiveSourceRef = isDockerHubUrl(normalizedSourceUrl)
      ? applyDockerHubLibraryPrefix(sourceRef)
      : sourceRef;
    const effectiveValidated = effectiveSourceRef === sourceRef
      ? validated
      : validateInputs({ sourceRef: effectiveSourceRef, destRepo, destTag });

    // 校验源凭据可用性（存在 + registryUrl 严格匹配）。
    // 放在入队时做，而不是等到 runner 执行：否则用户点了「确认入队」才失败，白点一次。
    if (sourceCredentialId && !this.credentialStore) {
      throw new RegistryError(
        '本次任务引用了凭据，但服务端未配置凭据库（缺少 REGISTRY_CREDENTIAL_KEY）。请重启服务并设置该环境变量，或改用匿名 / 临时输入。',
        'CREDENTIAL_KEY_MISSING'
      );
    }
    if (sourceCredentialId) {
      const c = this.credentialStore?.get(sourceCredentialId);
      if (!c) {
        throw new RegistryError(`源凭据不存在：${sourceCredentialId}`, 'JOB_NOT_FOUND').withOrigin('source');
      }
      assertCredentialUsable(c, effectiveSourceUrl);
    }
    // 代理库的 id 也要在入队时就校验：否则等到执行才发现代理被删了。
    if (sourceProxyId && !this.proxyStore) {
      throw new RegistryError(
        '本次任务引用了代理库中的代理，但服务端未配置加密存储（缺少 REGISTRY_CREDENTIAL_KEY）。请重启服务并设置该环境变量，或改用临时输入。',
        'CREDENTIAL_KEY_MISSING'
      );
    }
    if (sourceProxyId && !this.proxyStore?.get(sourceProxyId)) {
      throw new RegistryError(`代理不存在：${sourceProxyId}`, 'JOB_NOT_FOUND').withOrigin('source');
    }
    // inline 临时账号密码：不在凭据库中存在，但同样不进 PullJob 历史。
    const sourceAuth = sanitizeInlineAuth(sourceAuthInline, 'source');
    const jobId = randomUUID();
    const job = {
      id: jobId,
      sourceUrl: effectiveSourceUrl,
      sourceRef: effectiveSourceRef,
      sourceProxy: sourceProxy || '',
      sourceProxyId: sourceProxyId || undefined,
      sourceRepo: effectiveValidated.sourceRepo,
      sourceTag: effectiveValidated.sourceTag,
      destRepo: validated.destRepo,
      destTag: validated.destTag,
      sourceCredentialId: sourceCredentialId || undefined,
      sourceAuthInline: sourceAuth,
      status: 'queued',
      bytes: 0,
      totalBytes: null,
      phases: [],
      createdAt: new Date().toISOString(),
      errorCode: undefined,
      errorMessage: undefined,
      errorOrigin: undefined,
    };
    job.phases.push(makePhase('manifest', jobId));
    job.phases.push(makePhase('config', jobId));
    return job;
  }

  /**
   * 创建任务并入队。
   * 立即返回任务记录；执行异步进行。
   */
  enqueue({
    sourceUrl,
    sourceRef,
    sourceProxy,
    sourceProxyId,
    destRepo,
    destTag,
    sourceCredentialId,
    sourceAuthInline,
  }) {
    const job = this.#createJobRecord({
      sourceUrl,
      sourceRef,
      sourceProxy,
      sourceProxyId,
      destRepo,
      destTag,
      sourceCredentialId,
      sourceAuthInline,
    });
    this.#jobs.set(job.id, job);
    this.#waiting.push(job.id);
    this.#trimHistory();
    // 触发执行
    queueMicrotask(() => this.#drain());
    return stripInlineAuth(job);
  }

  /** 列出全部已知任务（含 waiting/running/已结束），按创建时间倒序。 */
  list() {
    return [...this.#jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(stripInlineAuth);
  }

  get(id) {
    const job = this.#jobs.get(id) ?? null;
    return job ? stripInlineAuth(job) : null;
  }

  /**
   * 取消：
   * - queued：从队列里剔除，标 cancelled；
   * - running：标记 cancelled，触发 AbortController；当前正在发的 chunk 会写完。
   */
  cancel(id) {
    const job = this.#jobs.get(id);
    if (!job) {
      throw new RegistryError(`任务 ${id} 不存在`, 'JOB_NOT_FOUND');
    }
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
      return job;
    }
    if (job.status === 'queued') {
      const idx = this.#waiting.indexOf(id);
      if (idx >= 0) {
        this.#waiting.splice(idx, 1);
      }
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      // 排队中被取消的任务不会走 #run，所以这里也要追写一次历史。
      this.#settle(job);
      return job;
    }
    // running：标记并 abort
    const abort = this.#runningAborts.get(id);
    if (abort) {
      abort.abort();
    }
    return job;
  }

  /** 从历史里移除一个已完成任务（不影响已落库的镜像）。 */
  remove(id) {
    const job = this.#jobs.get(id);
    if (!job) {
      return false;
    }
    if (job.status === 'running' || job.status === 'queued') {
      throw new RegistryError('运行中的任务不能直接删除', 'INVALID_REQUEST');
    }
    this.#jobs.delete(id);
    return true;
  }

  // ------------------- 调度 -------------------

  /**
   * 任务到达终态时把它追写进历史库。**幂等**：同一个任务只写一次。
   *
   * 为什么只写终态：queued / running 的任务需要高频更新，且只在进程活着时有意义；
   * 存进历史没有价值，还会把半截数据固化下来。运行态留在内存，历史才是完整的。
   *
   * 写失败**不影响任务本身的结果** —— 历史是辅助数据，不能因为落盘失败就改变任务状态。
   */
  #settle(job) {
    if (job.settled) {
      return;
    }
    if (job.status !== 'succeeded' && job.status !== 'failed' && job.status !== 'cancelled') {
      return;
    }
    job.settled = true;
    try {
      this.history?.recordPullJob?.(job);
    } catch (error) {
      console.error(`[registry-manager] 拉取历史写入失败（任务 ${job.id}）`, error);
    }
  }

  #trimHistory() {
    // 历史只保留 historyLimit 条；超出按创建时间最旧剔除。
    const jobs = [...this.#jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const keep = new Set(jobs.slice(0, this.historyLimit).map((j) => j.id));
    for (const id of this.#jobs.keys()) {
      if (!keep.has(id)) {
        this.#jobs.delete(id);
      }
    }
  }

  async #drain() {
    if (this.#currentId) {
      return;
    }
    const id = this.#waiting.shift();
    if (!id) {
      return;
    }
    const job = this.#jobs.get(id);
    if (!job || job.status !== 'queued') {
      // 已被取消 / 已不在表里
      queueMicrotask(() => this.#drain());
      return;
    }
    this.#currentId = id;

    const abort = new AbortController();
    this.#runningAborts.set(id, abort);
    const runner = new PullJobRunner({
      destClient: this.client,
      job,
      signal: abort.signal,
      credentialStore: this.credentialStore,
      proxyStore: this.proxyStore,
    });
    try {
      await runner.run();
    } catch (error) {
      const code = error instanceof RegistryError ? error.code : 'UNKNOWN';
      const message = error instanceof RegistryError ? error.message : String(error);
      const origin = error instanceof RegistryError ? error.origin : undefined;
      // 取消信号比异常优先级更高：
      //   - 显式 CANCELLED 错误 → cancelled；
      //   - signal.aborted 时任何异常（可能是 undici 抛的 ECONNREFUSED 抢先）→ cancelled。
      const cancelled =
        job.status === 'cancelled' || code === 'CANCELLED' || this.#runningAborts.get(id)?.signal.aborted;
      if (cancelled) {
        job.status = 'cancelled';
        job.errorCode = undefined;
        job.errorMessage = undefined;
        job.errorOrigin = undefined;
      } else {
        job.status = 'failed';
        job.errorCode = code;
        job.errorMessage = message;
        job.errorOrigin = origin;
      }
      job.finishedAt = new Date().toISOString();
      console.warn(
        `[registry-manager] 拉取任务 ${job.id} 终止：${job.status} ${origin ? `${origin} ` : ''}${cancelled ? '' : `${code} `}${message}`
      );
    } finally {
      // 此刻终态已确定（成功在 runner 里设、失败/取消在上面的 catch 里设），统一追写历史。
      this.#settle(job);
      this.#runningAborts.delete(id);
      this.#currentId = null;
      queueMicrotask(() => this.#drain());
    }
  }
}

/** 创建一个 phase 记录；挂在 job.phases 数组里。 */
function makePhase(name) {
  return {
    name,
    digest: '',
    status: 'pending',
    bytes: 0,
    totalBytes: null,
    message: '',
  };
}

/**
 * 把任务里的 inline 凭据归一化成 `{ username, password }`，并做最小校验。
 * 任一字段缺失返回 undefined（视为"不传"）。
 * 注：inline 凭据只活到任务结束，不进 PullJob 历史 / API 响应。
 */
function sanitizeInlineAuth(input, origin) {
  if (!input) return undefined;
  const username = String(input.username ?? '').trim();
  const password = String(input.password ?? '');
  if (!username) {
    throw new RegistryError(`${origin} 临时认证：用户名不能为空`, 'INVALID_REQUEST').withOrigin(origin);
  }
  if (!password) {
    throw new RegistryError(`${origin} 临时认证：密码不能为空`, 'INVALID_REQUEST').withOrigin(origin);
  }
  return { username, password };
}

/**
 * 任务对象对外暴露时去掉 inline 凭据（保留 sourceCredentialId 给前端显示"用的是哪条凭据"）。
 * inline 凭据只活到 runner.run() 内部。
 */
function stripInlineAuth(job) {
  if (!job) return job;
  const { sourceAuthInline, ...rest } = job;
  return rest;
}