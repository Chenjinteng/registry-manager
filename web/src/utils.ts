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
