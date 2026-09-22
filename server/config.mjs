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

const DEFAULTS = {
  name: '镜像仓库',
  url: '',
  proxy: '',
  cacheTtlSeconds: 60,
  allowDelete: true,
  port: 8787,
  // 镜像拉取：与"删除"对称的开关，默认开；false 时服务端拒绝所有 /api/pull/* 写入。
  allowPull: true,
  // 内存里保留的最近任务数（当前任务 + 等待队列 + 历史）；重启即丢。
  pullQueueSize: 50,
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
    proxy: (process.env.REGISTRY_PROXY || file.proxy || DEFAULTS.proxy).trim(),
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
  };

  if (!config.url) {
    throw new Error(
      '未配置镜像仓库地址。请设置环境变量 REGISTRY_URL，或创建 registry.config.json（参考 registry.config.example.json）。'
    );
  }
  return config;
}
