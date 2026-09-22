#!/usr/bin/env node
/**
 * 对**真实**公共 registry 验证 Bearer 令牌流程（需要出网；连不上就跳过，不算失败）。
 *
 * 为什么需要它：mock 只能复现"我以为的"服务端行为。实测发现真实世界比 mock 严格得多 ——
 * ghcr.io 对 `/v2/` 的**无 scope** 令牌申请直接回 403，quay.io 回 401。
 * 如果只靠 mock，就会以为"探测端点总能拿到匿名 token"，从而把预览误报成"源不可达"。
 *
 * 断言的是"这几类真实形态都能工作"：
 *   - ghcr.io：Bearer 认证，且拒绝无 scope 的令牌申请
 *   - quay.io：Bearer 挑战存在，但公开仓库匿名可读
 *   - mcr.microsoft.com：完全不需要认证
 *
 * 用法：node scripts/verify-real-registries.mjs
 */
import { RegistryClient } from '../server/registry-client.mjs';

const PROBE_TIMEOUT_MS = 15_000;

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};
const skip = (label, why) => console.log(`- ${label}：跳过（${why}）`);

/** 先确认目标出网可达，避免在没网的环境里把"跳过"报成"失败"。 */
async function reachable(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${url}/v2/`, { signal: controller.signal });
    // 401 也算可达（正是我们要验证的形态）
    return response.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const CASES = [
  // tag 只作首选；取不到就回退到 tags 列表的第一个 ——
  // 上游删旧 tag 是常事，硬编码会变成"测试自己坏了"。
  {
    label: 'ghcr.io（Bearer，且拒绝无 scope 申请）',
    url: 'https://ghcr.io',
    repo: 'flannel-io/flannel',
    tag: 'latest',
  },
  { label: 'quay.io（Bearer）', url: 'https://quay.io', repo: 'coreos/etcd', tag: 'v3.5.0' },
  {
    label: 'mcr.microsoft.com（匿名）',
    url: 'https://mcr.microsoft.com',
    repo: 'hello-world',
    tag: 'latest',
  },
  {
    // 国内常见的"镜像同步站"实际承载在华为 SWR 上，仓库名带来源前缀。
    // 这条覆盖"Bearer 挑战里带 scope、且 service 不是 registry.docker.io"的形态。
    label: 'swr.cn-north-4.myhuaweicloud.com（镜像站承载）',
    url: 'https://swr.cn-north-4.myhuaweicloud.com',
    repo: 'ddn-k8s/docker.io/library/nginx',
    tag: 'latest',
  },
];

let ranAny = false;
for (const c of CASES) {
  if (!(await reachable(c.url))) {
    skip(c.label, '本机无法访问，可能是网络受限');
    continue;
  }
  ranAny = true;
  const client = new RegistryClient({ url: c.url });
  try {
    // 探测必须成功 —— 这是用户报的"源不可达"那个点
    const probe = await client.probe({ origin: 'source' });
    check(`${c.label} 探测成功`, Boolean(probe.apiVersion), probe.apiVersion);
    // 真正的读取（带 scope）也必须成功。
    // 首选 tag 不存在就退到 tags 列表里的第一个，避免上游删 tag 导致误报。
    let tag = c.tag;
    let manifest = await client.probeManifest(c.repo, tag, { origin: 'source' });
    if (!manifest.exists) {
      const tags = await client.listTags(c.repo);
      if (tags.length > 0) {
        tag = tags[0];
        manifest = await client.probeManifest(c.repo, tag, { origin: 'source' });
      }
    }
    check(
      `${c.label} 读到 manifest`,
      manifest.exists === true && Boolean(manifest.digest),
      `${c.repo}:${tag} digest=${String(manifest.digest).slice(0, 20)}`
    );
  } catch (error) {
    check(`${c.label} 全流程`, false, `${error.code}: ${String(error.message).slice(0, 80)}`);
  }
}

// ---------------- 反例：镜像站的「网站」不是 registry ----------------
{
  const url = 'https://docker.aityp.com';
  if (await reachable(url)) {
    ranAny = true;
    const client = new RegistryClient({ url });
    try {
      await client.probe({ origin: 'source' });
      check('镜像站网站应被识别为"不是 registry"', false, '竟然探测成功了');
    } catch (error) {
      // 它回的是 nginx 的 Basic realm，且没有 registry API 版本头 ——
      // 必须报 NOT_A_REGISTRY 而不是"需要认证"，否则用户会去配一个永远配不对的凭据。
      check(
        '镜像站网站被准确识别为「不是 registry」而非「需要认证」',
        error.code === 'NOT_A_REGISTRY',
        `${error.code}: ${String(error.message).slice(0, 60)}`
      );
    }
  } else {
    skip('docker.aityp.com 反例', '本机无法访问');
  }
}

if (!ranAny) {
  console.log('\n（本机没有任何可访问的公共 registry，全部跳过）');
} else {
  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
}
process.exit(failed === 0 ? 0 : 1);
