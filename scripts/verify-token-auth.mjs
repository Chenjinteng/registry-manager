#!/usr/bin/env node
/**
 * 验证 Bearer 令牌认证流程（Docker Hub / ghcr / quay 的标准认证方式）。
 *
 * 起一个 mock registry，行为对齐 Docker Hub：
 *   - 未带 token 的请求 → 401 + `WWW-Authenticate: Bearer realm=...,service=...`
 *   - `/token` 按 scope 签发匿名 token；只有 scope 覆盖到的仓库才放行
 *   - 带正确 token 且仓库存在 → 200
 *
 * 断言匿名（不配任何凭据）就能完成 manifest 读取 —— 即 `docker pull nginx` 的等价能力。
 *
 * 用法：node scripts/verify-token-auth.mjs
 */
import { createServer } from 'node:http';

import {
  RegistryClient,
  RegistryError,
  parseBearerChallenge,
  scopeForPath,
} from '../server/registry-client.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

// ---------------- 单元：挑战头解析与 scope 推导 ----------------
{
  const challenge = parseBearerChallenge(
    'Bearer realm="https://auth.example.com/token",service="registry.example.com",scope="repository:library/nginx:pull"'
  );
  check(
    '解析 WWW-Authenticate 挑战头',
    challenge?.realm === 'https://auth.example.com/token' &&
      challenge?.service === 'registry.example.com' &&
      challenge?.scope === 'repository:library/nginx:pull',
    JSON.stringify(challenge)
  );

  // Docker Hub 的 /v2/ 挑战不带 scope
  const noScope = parseBearerChallenge(
    'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"'
  );
  check('挑战头可以不带 scope', noScope?.realm === 'https://auth.docker.io/token' && noScope.scope === '');

  check(
    'scope 推导：读 pull、写 pull,push、_catalog 无 scope',
    scopeForPath('/v2/library/nginx/manifests/latest', 'GET') === 'repository:library/nginx:pull' &&
      scopeForPath('/v2/foo/bar/blobs/uploads/', 'POST') === 'repository:foo/bar:pull,push' &&
      scopeForPath('/v2/_catalog', 'GET') === null,
    scopeForPath('/v2/library/nginx/manifests/latest', 'GET')
  );
}

// ---------------- mock：registry + 令牌服务 ----------------
const EXISTING_REPO = 'library/nginx';
const manifest = Buffer.from(
  JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    config: {
      mediaType: 'application/vnd.docker.container.image.v1+json',
      size: 2,
      digest: `sha256:${'0'.repeat(64)}`,
    },
    layers: [],
  })
);
const manifestDigest = `sha256:${'a'.repeat(64)}`;

const issuedTokens = [];
const manifestHits = [];
let serverBase = '';

const server = createServer((req, res) => {
  // 令牌服务
  if (req.url.startsWith('/token')) {
    const url = new URL(req.url, 'http://x');
    const scope = url.searchParams.get('scope') ?? '';
    const token = `tok${issuedTokens.length + 1}`;
    issuedTokens.push({ token, scope, service: url.searchParams.get('service') });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ token, expires_in: 300 }));
    return;
  }

  res.setHeader('Docker-Distribution-Api-Version', 'registry/2.0');
  const challenge = () => {
    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', `Bearer realm="${serverBase}/token",service="mock-registry"`);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED' }] }));
  };

  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) {
    challenge();
    return;
  }
  const issued = issuedTokens.find((t) => t.token === auth.slice('Bearer '.length));
  if (!issued) {
    challenge();
    return;
  }

  if (req.url === '/v2/') {
    res.statusCode = 200;
    res.end();
    return;
  }

  const matched = /^\/v2\/(.+)\/manifests\/([^/?]+)/.exec(req.url);
  if (!matched) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const repo = matched[1];
  manifestHits.push({ repo, scope: issued.scope });

  // token 的 scope 必须覆盖被请求的仓库，否则视为无权（真实 registry 同样如此）
  if (!issued.scope.includes(`repository:${repo}:`)) {
    challenge();
    return;
  }
  if (repo !== EXISTING_REPO) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }));
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/vnd.docker.distribution.manifest.v2+json');
  res.setHeader('Docker-Content-Digest', manifestDigest);
  if (req.method === 'HEAD') {
    res.setHeader('Content-Length', String(manifest.length));
    res.end();
  } else {
    res.end(manifest);
  }
});

const baseUrl = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
});
serverBase = baseUrl;

// ---------------- 场景 1：匿名读取存在的仓库 ----------------
{
  const client = new RegistryClient({ url: baseUrl });
  const result = await client.probeManifest(EXISTING_REPO, 'latest', { origin: 'source' });
  check('匿名（不配任何凭据）即可读到 manifest', result.exists === true, JSON.stringify(result));
  check(
    '确实去令牌服务换了 token，scope 为 pull',
    issuedTokens.some((t) => t.scope === `repository:${EXISTING_REPO}:pull`),
    issuedTokens.map((t) => t.scope).join(' | ')
  );
  check(
    '令牌请求带上了 service 参数',
    issuedTokens.every((t) => t.service === 'mock-registry'),
    String(issuedTokens[0]?.service)
  );
}

// ---------------- 场景 2：token 缓存复用 ----------------
{
  const before = issuedTokens.length;
  const client = new RegistryClient({ url: baseUrl });
  await client.probeManifest(EXISTING_REPO, 'latest', { origin: 'source' });
  await client.probeManifest(EXISTING_REPO, 'latest', { origin: 'source' });
  const issued = issuedTokens.length - before;
  check('token 被缓存复用（两次读只换一次）', issued === 1, `换了 ${issued} 次`);
}

// ---------------- 场景 3：漏了 library/ 前缀 ----------------
// 用户报的现象：nginx:latest 被查成 /v2/nginx/...；这里断言它不会"看起来成功"。
{
  const client = new RegistryClient({ url: baseUrl });
  try {
    const result = await client.probeManifest('nginx', 'latest', { origin: 'source' });
    check('裸 nginx 不应被当作存在', result.exists === false, JSON.stringify(result));
  } catch (error) {
    check(
      '裸 nginx 给出可读错误而非静默成功',
      error instanceof RegistryError &&
        ['SOURCE_UNAUTHORIZED', 'MANIFEST_NOT_FOUND'].includes(error.code),
      `${error.code}: ${String(error.message).slice(0, 50)}`
    );
  }
}

// ---------------- 场景 4：私有仓库（令牌服务拒绝匿名）----------------
{
  const client = new RegistryClient({ url: baseUrl });
  client.tokenFor = async () => {
    throw new RegistryError('申请访问令牌失败（HTTP 401，令牌服务 mock）', 'UNAUTHORIZED');
  };
  try {
    await client.probeManifest('library/private', 'latest', { origin: 'source' });
    check('令牌申请失败应抛错', false, '竟然成功了');
  } catch (error) {
    check('令牌申请失败抛 UNAUTHORIZED', error.code === 'UNAUTHORIZED', error.code);
  }
}

// ---------------- 场景 5：Basic 凭据用于换 token（私有仓库路径）----------------
{
  issuedTokens.length = 0;
  const client = new RegistryClient({
    url: baseUrl,
    auth: { username: 'alice', password: 's3cret' },
  });
  // 客户端会先用 Basic 直连 → 401 → 拿挑战 → 用 Basic 去换 token
  await client.probeManifest(EXISTING_REPO, 'latest', { origin: 'source' });
  check(
    '配了 Basic 凭据时仍能走通（Basic 探路 → 换 token）',
    issuedTokens.length >= 1,
    `换 token ${issuedTokens.length} 次`
  );
}

server.close();
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
