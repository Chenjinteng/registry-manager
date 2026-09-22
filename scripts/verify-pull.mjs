/**
 * 端到端验证脚本（非破坏性，不碰真实仓库）。
 *
 * 起两个进程内的 mock registry V2：
 *   SOURCE：要求 Basic auth，提供一个小镜像（config + 1 层）
 *   DEST  ：要求 Basic auth，接收 blob 上传与 manifest PUT
 *
 * 然后用真正的 PullQueue 跑一次完整拉取，断言：
 *   1. 源 / 目的两端都收到了正确的 Authorization 头；
 *   2. 流式 PATCH 真的到达了目的端（这是 duplex 缺失时会静默失败的点）；
 *   3. blob 字节与源端完全一致；
 *   4. manifest 原样落库。
 *
 * 用法：node scripts/verify-pull.mjs
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

import { PullQueue } from '../server/puller.mjs';
import { RegistryClient } from '../server/registry-client.mjs';
import { CredentialStore } from '../server/credentials.mjs';

const SRC_USER = 'src-user';
const SRC_PASS = 'src-pass';
const DST_USER = 'dst-user';
const DST_PASS = 'dst-pass';

const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
const SRC_AUTH = basic(SRC_USER, SRC_PASS);
const DST_AUTH = basic(DST_USER, DST_PASS);

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 构造一个 mock registry。
 * @param {object} opts
 * @param {string} opts.expectedAuth 期望的 Authorization 头
 * @param {object} opts.repos 初始仓库数据
 * @param {object[]} opts.seen 记录收到的请求
 */
function makeRegistry({ expectedAuth, repos, seen, label }) {
  const uploads = new Map();
  let seq = 0;

  return async function handler(req, res) {
    const url = req.url;
    const auth = req.headers.authorization ?? '(none)';
    seen.push({ label, method: req.method, url, auth });

    res.setHeader('Docker-Distribution-Api-Version', 'registry/2.0');

    if (auth !== expectedAuth) {
      res.statusCode = 401;
      res.setHeader('WWW-Authenticate', 'Basic realm="registry"');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED', message: 'authentication required' }] }));
      return;
    }

    if (req.method === 'GET' && url === '/v2/') {
      res.statusCode = 200;
      res.end();
      return;
    }

    // manifest GET / HEAD / PUT
    let m = url.match(/^\/v2\/(.+)\/manifests\/([^/]+)$/);
    if (m) {
      const [, name, ref] = m;
      const entry = repos[name]?.[ref];
      if (req.method === 'PUT') {
        const body = await readBody(req);
        const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
        repos[name] = repos[name] ?? {};
        repos[name][ref] = {
          manifest: body,
          mediaType: req.headers['content-type'],
          digest,
          blobs: repos[name].__blobs ?? {},
        };
        res.statusCode = 201;
        res.setHeader('Docker-Content-Digest', digest);
        res.end();
        return;
      }
      if (!entry) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }));
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', entry.mediaType);
      res.setHeader('Docker-Content-Digest', entry.digest);
      if (req.method === 'HEAD') {
        res.setHeader('Content-Length', String(entry.manifest.length));
        res.end();
      } else {
        res.end(entry.manifest);
      }
      return;
    }

    // blob GET
    m = url.match(/^\/v2\/(.+)\/blobs\/([^/]+)$/);
    if (m) {
      const [, name, digest] = m;
      const blob = repos[name]?.__blobs?.[digest];
      if (!blob) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ errors: [{ code: 'BLOB_UNKNOWN' }] }));
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Length', String(blob.length));
      res.setHeader('Docker-Content-Digest', digest);
      res.end(blob);
      return;
    }

    // blob upload start（含 mount 尝试）
    m = url.match(/^\/v2\/(.+)\/blobs\/uploads\/\?/);
    if (m && req.method === 'POST') {
      const q = new URL(url, 'http://x').searchParams;
      const mount = q.get('mount');
      if (mount && repos[m[1]]?.__blobs?.[mount]) {
        res.statusCode = 201;
        res.setHeader('Docker-Content-Digest', mount);
        res.end();
        return;
      }
      const id = String(++seq);
      uploads.set(id, { repo: m[1], bytes: Buffer.alloc(0) });
      res.statusCode = 202;
      res.setHeader('Location', `/v2/${m[1]}/blobs/uploads/${id}`);
      res.setHeader('Range', '0-0');
      res.end();
      return;
    }

    // 裸 uploads/（无 query）
    m = url.match(/^\/v2\/(.+)\/blobs\/uploads\/$/);
    if (m && req.method === 'POST') {
      const id = String(++seq);
      uploads.set(id, { repo: m[1], bytes: Buffer.alloc(0) });
      res.statusCode = 202;
      res.setHeader('Location', `/v2/${m[1]}/blobs/uploads/${id}`);
      res.setHeader('Range', '0-0');
      res.end();
      return;
    }

    // PATCH / PUT upload session
    // 注意 `([^/?]+)`：session id 必须排除 '?'，否则 query string 会被并进 id 里。
    m = url.match(/^\/v2\/(.+)\/blobs\/uploads\/([^/?]+)(\?.*)?$/);
    if (m) {
      const session = uploads.get(m[2]);
      if (!session) {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        session.bytes = Buffer.concat([session.bytes, body]);
        res.statusCode = 202;
        res.setHeader('Location', `/v2/${m[1]}/blobs/uploads/${m[2]}`);
        res.end();
        return;
      }
      if (req.method === 'PUT') {
        const digest = new URL(url, 'http://x').searchParams.get('digest');
        const actual = `sha256:${createHash('sha256').update(session.bytes).digest('hex')}`;
        if (digest !== actual) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ errors: [{ code: 'DIGEST_INVALID' }] }));
          return;
        }
        repos[session.repo] = repos[session.repo] ?? {};
        repos[session.repo].__blobs = repos[session.repo].__blobs ?? {};
        repos[session.repo].__blobs[digest] = session.bytes;
        uploads.delete(m[2]);
        res.statusCode = 201;
        res.setHeader('Docker-Content-Digest', digest);
        res.end();
        return;
      }
    }

    res.statusCode = 404;
    res.end();
  };
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

// ---------------- 准备镜像数据 ----------------
const configBytes = Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux' }));
const configDigest = `sha256:${createHash('sha256').update(configBytes).digest('hex')}`;
const layerBytes = Buffer.from('x'.repeat(300 * 1024)); // 300KB，足以产生多个 chunk
const layerDigest = `sha256:${createHash('sha256').update(layerBytes).digest('hex')}`;

const manifest = {
  schemaVersion: 2,
  mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
  config: {
    mediaType: 'application/vnd.docker.container.image.v1+json',
    size: configBytes.length,
    digest: configDigest,
  },
  layers: [
    { mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip', size: layerBytes.length, digest: layerDigest },
  ],
};
const manifestBytes = Buffer.from(JSON.stringify(manifest));
const manifestDigest = `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`;

const srcSeen = [];
const dstSeen = [];
const srcRepos = {
  'lib/demo': {
    v1: {
      manifest: manifestBytes,
      mediaType: manifest.mediaType,
      digest: manifestDigest,
      __blobs: { [configDigest]: configBytes, [layerDigest]: layerBytes },
    },
    __blobs: { [configDigest]: configBytes, [layerDigest]: layerBytes },
  },
};
const dstRepos = {};

const src = await listen(makeRegistry({ expectedAuth: SRC_AUTH, repos: srcRepos, seen: srcSeen, label: 'src' }));
const dst = await listen(makeRegistry({ expectedAuth: DST_AUTH, repos: dstRepos, seen: dstSeen, label: 'dst' }));

// ---------------- 凭据库（走真实加密存储） ----------------
const storePath = `/tmp/verify-pull-${Date.now()}.json`;
const store = new CredentialStore({ filePath: storePath, masterKey: 'verify-pull-master-key-0123456789' });
const srcCred = await store.create({
  name: '源凭据',
  registryUrl: src.url,
  username: SRC_USER,
  password: SRC_PASS,
  purpose: 'source',
});
const dstCred = await store.create({
  name: '目的凭据',
  registryUrl: dst.url,
  username: DST_USER,
  password: DST_PASS,
  purpose: 'dest',
});

// ---------------- 用真实 PullQueue 拉一次 ----------------
const queue = new PullQueue({
  client: new RegistryClient({ url: dst.url }),
  credentialStore: store,
  historyLimit: 5,
});

const job = queue.enqueue({
  sourceUrl: src.url,
  sourceRef: 'lib/demo:v1',
  destRepo: 'lib/demo',
  destTag: 'v1',
  sourceCredentialId: srcCred.id,
  destCredentialId: dstCred.id,
});

const finished = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('拉取超时（30s）')), 30_000);
  const poll = setInterval(() => {
    const current = queue.get(job.id);
    if (current && ['succeeded', 'failed', 'cancelled'].includes(current.status)) {
      clearInterval(poll);
      clearTimeout(timer);
      resolve(current);
    }
  }, 25);
});

console.log(`\n任务终态: ${finished.status}${finished.errorMessage ? ` — ${finished.errorCode}: ${finished.errorMessage}` : ''}\n`);

check('拉取成功', finished.status === 'succeeded', finished.errorMessage ?? '');
check(
  '源端收到了正确的 Basic auth',
  srcSeen.some((r) => r.auth === SRC_AUTH),
  `请求数 ${srcSeen.length}`
);
check(
  '目的端收到了正确的 Basic auth',
  dstSeen.some((r) => r.auth === DST_AUTH),
  `请求数 ${dstSeen.length}`
);
check(
  '流式 PATCH 真的到达了目的端',
  dstSeen.some((r) => r.method === 'PATCH'),
  `PATCH 数 ${dstSeen.filter((r) => r.method === 'PATCH').length}`
);
check(
  '目的端收到了 manifest PUT',
  dstSeen.some((r) => r.method === 'PUT' && r.url.includes('/manifests/'))
);

const storedLayer = dstRepos['lib/demo']?.__blobs?.[layerDigest];
check(
  '层字节与源端逐字节一致',
  Boolean(storedLayer) && storedLayer.equals(layerBytes),
  storedLayer ? `${storedLayer.length} bytes` : '缺失'
);
check(
  'manifest 原样落库',
  dstRepos['lib/demo']?.v1?.manifest?.equals(manifestBytes) === true
);
check(
  '所有请求都带认证（无匿名裸请求）',
  [...srcSeen, ...dstSeen].every((r) => r.auth !== '(none)'),
  `无认证请求数 ${[...srcSeen, ...dstSeen].filter((r) => r.auth === '(none)').length}`
);

src.server.close();
dst.server.close();
await import('node:fs').then((fs) => fs.rmSync(storePath, { force: true }));

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
