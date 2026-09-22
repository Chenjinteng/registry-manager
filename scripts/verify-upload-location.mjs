#!/usr/bin/env node
/**
 * 验证上传会话的 Location 指向「与配置不同的主机」时仍能正确收尾。
 *
 * 背景（真实事故）：Distribution 在上传走重定向 / 配了 REGISTRY_HTTP_HOST /
 * 用对象存储网关时，会返回**绝对 URL 且主机与 REGISTRY_URL 不同**的 Location。
 * 而 putDestUpload 曾用 `finalUrl.replace(baseUrl, '')` 去前缀 —— 跨源时什么都替不掉，
 * 路径变成完整 URL，再被拼成 `http://basehttp://other/...` 这种畸形地址，
 * 结果是「PATCH 成功、PUT 404」这种自相矛盾的现象。
 *
 * 这里让 mock 用 127.0.0.1 提供服务、却在 Location 里宣告 localhost（同一实例、
 * 不同 origin 字符串），精确复现那个分支。
 *
 * 用法：node scripts/verify-upload-location.mjs
 */
// 端到端验证：Location 的主机名与配置的 baseUrl 不同（但指向同一个 registry）时，
// PATCH 与 PUT 必须都能正确到达。修复前 PUT 会被字符串替换拼成畸形 URL → 404。
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { RegistryClient } from '../server/registry-client.mjs';

const hits = [];
let seq = 0;
const sessions = new Map();
let advertiseHost = '';

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    hits.push({ method: req.method, url: req.url, host: req.headers.host });
    res.setHeader('Docker-Distribution-Api-Version', 'registry/2.0');

    if (req.method === 'POST' && /\/blobs\/uploads\/?(\?|$)/.test(req.url)) {
      const name = /^\/v2\/(.+?)\/blobs\/uploads/.exec(req.url)[1];
      const id = `s${++seq}`;
      sessions.set(id, Buffer.alloc(0));
      res.statusCode = 202;
      res.setHeader('Location', `http://${advertiseHost}/v2/${name}/blobs/uploads/${id}`);
      res.end();
      return;
    }
    const m = /^\/v2\/(.+?)\/blobs\/uploads\/([^/?]+)/.exec(req.url);
    if (m) {
      if (!sessions.has(m[2])) {
        res.statusCode = 404;
        res.end(JSON.stringify({ errors: [{ code: 'BLOB_UPLOAD_UNKNOWN' }] }));
        return;
      }
      if (req.method === 'PATCH') {
        sessions.set(m[2], Buffer.concat([sessions.get(m[2]), buf]));
        res.statusCode = 202;
        res.setHeader('Location', `http://${advertiseHost}/v2/${m[1]}/blobs/uploads/${m[2]}`);
        res.end();
        return;
      }
      if (req.method === 'PUT') {
        const want = new URL(req.url, 'http://x').searchParams.get('digest');
        const actual = `sha256:${createHash('sha256').update(sessions.get(m[2])).digest('hex')}`;
        if (want !== actual) { res.statusCode = 400; res.end('{"errors":[{"code":"DIGEST_INVALID"}]}'); return; }
        sessions.delete(m[2]);
        res.statusCode = 201;
        res.setHeader('Docker-Content-Digest', want);
        res.end();
        return;
      }
    }
    res.statusCode = 404;
    res.end();
  });
});

// 监听所有网卡，这样 127.0.0.1 与 localhost 都能连上
const port = await new Promise((r) => server.listen(0, () => r(server.address().port)));
advertiseHost = `localhost:${port}`;          // Location 里宣告 localhost
const baseUrl = `http://127.0.0.1:${port}`;   // 配置里用的是 127.0.0.1

const payload = Buffer.from('blob-content-here');
const digest = `sha256:${createHash('sha256').update(payload).digest('hex')}`;

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const client = new RegistryClient({ url: baseUrl });
console.log('  配置 baseUrl  :', baseUrl);

// 整个流程包起来：畸形 URL 会让 undici 直接抛错，
// 那种情况也必须报成"失败"而不是让脚本崩掉 —— 否则它当不了回归守卫。
let upload = null;
let result = null;
let putResult = null;
let thrown = null;
try {
  upload = await client.initDestUpload('lib/app');
  console.log('  Location 宣告 :', upload.location);
  console.log();

  const { Readable } = await import('node:stream');
  const fakeResponse = {
    body: Readable.toWeb(Readable.from([payload])),
    headers: new Headers({ 'content-length': String(payload.length) }),
  };
  result = await client.streamBlobToDest({
    location: upload.location,
    source: fakeResponse,
    contentLength: payload.length,
  });
  console.log('  PATCH 后 Location:', result.location);
  putResult = await client.putDestUpload(result.location, digest);
  console.log('  PUT finalDigest  :', putResult.finalDigest.slice(0, 24));
  console.log();
} catch (error) {
  thrown = error;
  console.log('  流程抛错        :', error?.code ?? error?.name, String(error?.message).slice(0, 90));
  console.log();
}

const putHit = hits.find((h) => h.method === 'PUT');
check(
  'PUT 到达了 registry（未被拼成畸形 URL）',
  Boolean(putHit) && putHit.url.startsWith('/v2/'),
  putHit?.url ?? `未到达（${thrown?.code ?? '无 PUT 请求'}）`
);
check('PUT 打到了 Location 宣告的主机', putHit?.host === advertiseHost, `host=${putHit?.host ?? '-'}`);
check('上传成功收尾（201）', Boolean(putResult?.finalDigest), putResult?.finalDigest?.slice(0, 20) ?? thrown?.message?.slice(0, 60) ?? '-');
check(
  '全程没有任何畸形路径',
  hits.length > 0 && hits.every((h) => h.url.startsWith('/v2/')),
  JSON.stringify(hits.map((h) => h.url))
);

server.close();
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
