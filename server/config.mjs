/**
 * 运行配置。
 *
 * 优先级：环境变量 > registry.config.json > 默认值。
 * 只管理一个 registry —— 这是刻意的：多实例配置属于平台能力，
 * 这个工具的目标是"把眼前这个仓库的镜像看清、管住"。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CONFIG_FILE = process.env.REGISTRY_MANAGER_CONFIG || resolve(ROOT, 'registry.config.json');

/**
 * 当前运行中的版本号。
 *
 * **从 package.json 读，不另设一份**：AGENTS.md 规定版本号以 package.json 为准，
 * 若在代码里再写一遍必然漂移。镜像里也 COPY 了 package.json，容器内同样读得到。
 * 读不到时返回空串 —— 界面不显示即可，不该因为一个展示字段影响服务启动。
 */
export function readAppVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    return typeof pkg?.version === 'string' ? pkg.version : '';
  } catch {
    return '';
  }
}

const DEFAULTS = {
  name: '镜像仓库',
  url: '',
  proxy: '',
  /**
   * 本 registry 自身的 basic auth。
   *
   * 放在配置而不是凭据库里，理由是：这是**部署级**凭据 —— 连不上就无法列镜像、
   * 无法盘点，所以必须在服务启动时就具备；把它做成任务级选项没有意义
   * （没有它连「镜像列表」都打不开）。凭据库只负责**外部源**。
   */
  username: '',
  password: '',
  cacheTtlSeconds: 60,
  allowDelete: true,
  port: 8787,
  // 镜像拉取：与"删除"对称的开关，默认开；false 时服务端拒绝所有 /api/pull/* 写入。
  allowPull: true,
  // 内存里保留的最近任务数（当前任务 + 等待队列 + 历史）；重启即丢。
  pullQueueSize: 50,
  // 凭据文件目录（加密 JSON 落盘位置；非数据库，仅本工具自用）。
  credentialsDir: '/app/data',
};

function readConfigFile() {
  if (!existsSync(CONFIG_FILE)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch (error) {
    throw new Error(`无法解析配置文件 ${CONFIG_FILE}: ${error.message}`);
  }
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 取值优先级：env（**存在即生效，哪怕是空串**）> 配置文件 > 默认值。
 *
 * 对 `proxy` / `username` / `password` 这类"空值是一个有意义的选择"的字段，
 * 不能用 `env || file`：那样 `REGISTRY_PROXY=` 会被当成"没设置"而回落成
 * 配置文件里的代理，与 README 写的"环境变量 > 配置文件""留空 = 直连"矛盾，
 * 排查时会很迷惑（明明清空了代理，请求还在走代理）。
 */
function pickEnvOrFile(envValue, fileValue, fallback) {
  if (envValue !== undefined) {
    return envValue;
  }
  if (fileValue !== undefined) {
    return fileValue;
  }
  return fallback;
}

/** 只把显式的假值当作关闭；未配置时沿用默认。 */
function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return !['false', '0', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

export function loadConfig() {
  const file = readConfigFile();
  const config = {
    name: process.env.REGISTRY_NAME || file.name || DEFAULTS.name,
    url: (process.env.REGISTRY_URL || file.url || DEFAULTS.url).trim(),
    // proxy / 认证三项允许"显式置空"来覆盖配置文件里的值（空 = 直连 / 匿名）。
    proxy: String(pickEnvOrFile(process.env.REGISTRY_PROXY, file.proxy, DEFAULTS.proxy)).trim(),
    username: String(
      pickEnvOrFile(process.env.REGISTRY_USERNAME, file.username, DEFAULTS.username)
    ).trim(),
    // 密码只从 env 或配置文件读；**绝不回显到任何接口**。
    password: String(pickEnvOrFile(process.env.REGISTRY_PASSWORD, file.password, DEFAULTS.password)),
    cacheTtlSeconds: toPositiveInt(
      process.env.REGISTRY_CACHE_TTL_SECONDS || file.cacheTtlSeconds,
      DEFAULTS.cacheTtlSeconds
    ),
    allowDelete: toBoolean(process.env.REGISTRY_ALLOW_DELETE ?? file.allowDelete, DEFAULTS.allowDelete),
    port: toPositiveInt(process.env.PORT || file.port, DEFAULTS.port),
    allowPull: toBoolean(process.env.REGISTRY_ALLOW_PULL ?? file.allowPull, DEFAULTS.allowPull),
    pullQueueSize: toPositiveInt(
      process.env.REGISTRY_PULL_QUEUE_SIZE || file.pullQueueSize,
      DEFAULTS.pullQueueSize
    ),
    credentialsDir: String(process.env.REGISTRY_CREDENTIALS_DIR || file.credentialsDir || DEFAULTS.credentialsDir),
  };

  if (!config.url) {
    throw new Error(
      '未配置镜像仓库地址。请设置环境变量 REGISTRY_URL，或创建 registry.config.json（参考 registry.config.example.json）。'
    );
  }
  return config;
}
