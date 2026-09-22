const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/** 人类可读体积。 */
export function formatBytes(bytes?: number | null): string {
  const value = Number(bytes ?? 0);
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }
  let index = 0;
  let size = value;
  while (size >= 1024 && index < UNITS.length - 1) {
    size /= 1024;
    index += 1;
  }
  const digits = index === 0 ? 0 : size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${UNITS[index]}`;
}

export function shortDigest(digest?: string | null): string {
  if (!digest) {
    return '--';
  }
  const [algorithm, value = ''] = digest.split(':');
  return value ? `${algorithm}:${value.slice(0, 12)}` : digest;
}

export function formatDateTime(value?: string | null, fallback = '--'): string {
  if (!value) {
    return fallback;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const pad = (input: number) => String(input).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

/** registry 引用不带协议头：docker pull 里用 host[:port]/path:tag。 */
export function buildPullCommand(host: string, repository: string, tag: string): string {
  return `docker pull ${host}/${repository}:${tag}`;
}

/**
 * 把用户输入的镜像名拆成 (sourceUrl, sourceRef)。
 *
 *  - `alpine:3.19` / `library/alpine:3.19`             → docker.io
 *  - `ghcr.io/<repo>:<tag>` / `quay.io/...`             → 对应官方源（https）
 *  - `192.0.2.10:10001/<repo>:<tag>`                   → http（端口 443 → https）
 *  - 任意主机作为前缀且 ref 里还含 `:` 时，按前缀切；否则视为 docker.io。
 *
 * 输入只信任前半段的"主机"形状，repo/tag 完整性由后端决定，
 * 返回的 sourceUrl / sourceRef 都不再做正则二次校验。
 */
export interface ParsedImageRef {
  sourceUrl: string;
  sourceRef: string;
}

const KNOWN_HOSTS = new Set([
  'docker.io',
  'index.docker.io',
  'registry-1.docker.io',
  'ghcr.io',
  'gcr.io',
  'quay.io',
  'registry.k8s.io',
  'mcr.microsoft.com',
  'registry.access.redhat.com',
]);

/** Docker Hub 的各个别名，以及它们真正的 API 主机。 */
const DOCKER_HUB_HOSTS = new Set([
  'docker.io',
  'index.docker.io',
  'registry-1.docker.io',
  'registry.docker.io',
]);
const DOCKER_HUB_API = 'https://registry-1.docker.io';

function isHostSegment(segment: string): boolean {
  if (!segment) return false;
  // 含点 / 含端口 / 已知公共镜像源 视为"主机段"
  if (KNOWN_HOSTS.has(segment)) return true;
  if (segment.includes('.')) return true;
  if (segment.includes(':')) return true;
  return false;
}

function inferProtocol(host: string): 'http' | 'https' {
  // 端口 443 或 8443 走 https；显式带端口且不是 80/443 的内网 registry 走 http。
  const portMatch = host.match(/:(\d+)$/);
  if (!portMatch) return 'https';
  const port = Number(portMatch[1]);
  if (port === 443 || port === 8443 || port === 5000) return 'https';
  return 'http';
}

/**
 * Docker Hub 官方镜像（alpine / nginx 这类单段名字）在 Hub 上实际位于
 * `library/` 命名空间下。`docker pull nginx` 能用是因为 CLI 自动补了前缀，
 * 直接请求 `/v2/nginx/...` 是拿不到的。
 *
 * 这里做同样的补全，只对 Docker Hub 生效 —— 其它 registry（ghcr、内网仓库）
 * 没有这个约定。
 */
function applyDockerHubLibraryPrefix(repo: string): string {
  const name = String(repo ?? '').replace(/^\/+/, '');
  if (!name) return name;
  // 只要没有 `/`，就是官方镜像的单段名。
  return name.includes('/') ? name : `library/${name}`;
}

/**
 * 判断一个 registry URL 是不是 Docker Hub（含各种别名）。
 * 用于决定是否补 `library/` 前缀。
 */
export function isDockerHubUrl(url: string): boolean {
  try {
    return DOCKER_HUB_HOSTS.has(new URL(String(url)).hostname);
  } catch {
    return false;
  }
}

/** 把任意 Docker Hub 别名归一到真正的 API 主机。 */
function normalizeDockerHubHost(host: string): string {
  return DOCKER_HUB_HOSTS.has(host) ? DOCKER_HUB_API : `${inferProtocol(host)}://${host}`;
}

export function parseImageReference(raw: string): ParsedImageRef {
  const value = String(raw ?? '').trim();
  if (!value) {
    return { sourceUrl: DOCKER_HUB_API, sourceRef: '' };
  }
  const firstSlash = value.indexOf('/');
  if (firstSlash > 0) {
    const head = value.slice(0, firstSlash);
    const tail = value.slice(firstSlash + 1);
    if (isHostSegment(head)) {
      if (DOCKER_HUB_HOSTS.has(head)) {
        // 显式写了 docker.io 也要归一 + 补 library/
        return {
          sourceUrl: DOCKER_HUB_API,
          sourceRef: applyDockerHubLibraryPrefix(tail),
        };
      }
      return { sourceUrl: normalizeDockerHubHost(head), sourceRef: tail };
    }
  }
  // 没有主机前缀 → Docker Hub，补 library/
  return { sourceUrl: DOCKER_HUB_API, sourceRef: applyDockerHubLibraryPrefix(value) };
}

/**
 * 把 `<repo>[:<tag>]` 拆成仓库路径与 tag（tag 可缺省）。
 *
 * 只有"最后一个冒号右边不含 `/`"才算 tag，否则整个串都是仓库路径 ——
 * 这样 `192.0.2.20:10001/foo` 不会被误拆成 repo=`192.0.2.20`、tag=`10001/foo`，
 * 而是整体作为（非法的）仓库路径被校验拒掉。
 */
export function splitRepoTag(ref: string): { repo: string; tag: string } {
  const value = String(ref ?? '').trim().replace(/^\/+/, '');
  const colon = value.lastIndexOf(':');
  if (colon >= 0 && !value.slice(colon + 1).includes('/')) {
    return { repo: value.slice(0, colon), tag: value.slice(colon + 1) };
  }
  return { repo: value, tag: '' };
}

/** 本 registry 内仓库路径的合法字符（与后端 REPO_RE 一致）。 */
export const DEST_REPO_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
/** tag 的合法字符（与后端 TAG_RE 一致）。 */
export const DEST_TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/**
 * 复制文本到剪贴板，返回是否成功。
 *
 * `navigator.clipboard` **只在安全上下文**（HTTPS 或 localhost）下存在。
 * 这个工具通常部署在内网 `http://<ip>:<port>`，属于非安全上下文，此时
 * `navigator.clipboard` 是 undefined，直接调 `writeText` 必然抛错。
 * 因此必须回退到 `document.execCommand('copy')`（已废弃但各浏览器仍支持，
 * 且非安全上下文可用）。
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 无焦点、权限被拒或其它限制 —— 继续走回退路径。
    }
  }
  return execCommandCopy(text);
}

function execCommandCopy(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  // 固定定位 + 1px + 透明：能被 select，但不影响布局、不触发滚动。
  textarea.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;outline:0;opacity:0;';
  document.body.appendChild(textarea);

  const selection = document.getSelection();
  const savedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  let copied = false;
  try {
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
    // 还原用户原有选区，别让"复制"破坏正在选择的内容。
    if (savedRange && selection) {
      selection.removeAllRanges();
      selection.addRange(savedRange);
    }
  }
  return copied;
}

/**
 * 任务列表「哪些行展开」的状态迁移（纯函数，便于单测）。
 *
 * 规则：
 *   - 首屏（firstLoad）保持全部收起 —— 那是历史记录，一上来铺满详情很吵；
 *   - 之后新出现的失败 / 取消任务自动展开一次，让用户不用点就知道原因；
 *   - 用户手动收放完全自由：同一个任务不会被重复自动展开。
 *
 * 为什么需要它：AntD Table 的 expandedRowKeys 是**受控**属性，
 * 只传它而不传 onExpandedRowsChange，用户点了也改不了状态（收不回去）。
 * 状态必须由这里管，组件通过回调同步。
 */
export function nextJobExpansion({
  jobs,
  prevKeys,
  autoHandled,
  firstLoad,
}: {
  jobs: { id: string; status: string }[];
  prevKeys: string[];
  autoHandled: Set<string>;
  firstLoad: boolean;
}): { keys: string[]; autoHandled: Set<string>; firstLoad: boolean } {
  const alive = new Set(jobs.map((j) => j.id));
  const handled = new Set(autoHandled);

  if (firstLoad) {
    // 首屏：全部都标记为"已处理"，但一行都不展开
    jobs.forEach((j) => handled.add(j.id));
    return { keys: prevKeys.filter((id) => alive.has(id)), autoHandled: handled, firstLoad: false };
  }

  const fresh = jobs
    .filter(
      (j) =>
        (j.status === 'failed' || j.status === 'cancelled') && !handled.has(j.id)
    )
    .map((j) => j.id);
  fresh.forEach((id) => handled.add(id));

  const kept = prevKeys.filter((id) => alive.has(id));
  return { keys: [...kept, ...fresh], autoHandled: handled, firstLoad: false };
}
