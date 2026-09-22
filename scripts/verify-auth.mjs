/**
 * 一次性验证脚本：起一个要求 Basic auth 的 mock registry，
 * 确认 RegistryClient 真的把 Authorization 头发到了线路上。
 *
 * 用法：node scripts/verify-auth.mjs
 */
import { createServer } from 'node:http';
import { RegistryClient, RegistryError } from '../server/registry-client.mjs';

const USER = 'alice';
const PASS = 's3cret';
const EXPECTED = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;

const seen = [];
const server = createServer((req, res) => {
  const auth = req.headers.authorization ?? '(none)';
  seen.push({ url: req.url, auth });
  res.setHeader('Docker-Distribution-Api-Version', 'registry/2.0');
  if (auth !== EXPECTED) {
    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', 'Basic realm="registry"');
    res.end(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED' }] }));
    return;
  }
  if (req.url === '/v2/') {
    res.statusCode = 200;
    res.end();
    return;
  }
  res.statusCode = 404;
  res.end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const url = `http://127.0.0.1:${port}`;

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

// 1) 不传凭据 → 401 → UNAUTHORIZED（origin 与 code 要对）
{
  const client = new RegistryClient({ url });
  try {
    await client.probe({ origin: 'source' });
    check('无凭据应被拒', false, '竟然成功了');
  } catch (error) {
    check(
      '无凭据 → UNAUTHORIZED + origin=source',
      error instanceof RegistryError && error.code === 'UNAUTHORIZED' && error.origin === 'source',
      `${error.code} / origin=${error.origin}`
    );
  }
  check('服务端确实收到了无 Authorization 的请求', seen.at(-1).auth === '(none)', seen.at(-1).auth);
}

// 2) 正确凭据 → 通过，并且线路上带的是 Base64 Basic
{
  const client = new RegistryClient({ url, auth: { username: USER, password: PASS } });
  try {
    const probe = await client.probe({ origin: 'source' });
    check('正确凭据 → 探测成功', probe.apiVersion === 'registry/2.0', probe.apiVersion);
  } catch (error) {
    check('正确凭据 → 探测成功', false, error.message);
  }
  check(
    '线路上实际发送的 Authorization 头正确',
    seen.at(-1).auth === EXPECTED,
    seen.at(-1).auth
  );
}

// 3) 错误凭据 → 401
{
  const client = new RegistryClient({ url, auth: { username: USER, password: 'wrong' } });
  try {
    await client.probe({ origin: 'source' });
    check('错误凭据应被拒', false, '竟然成功了');
  } catch (error) {
    check('错误凭据 → UNAUTHORIZED', error.code === 'UNAUTHORIZED', error.code);
  }
}

// 4) 空用户名 → 视作不传凭据（不能发一个假的 Basic 头）
{
  const client = new RegistryClient({ url, auth: { username: '', password: PASS } });
  check('空用户名 → 不发 Authorization', client.authHeader === undefined, String(client.authHeader));
}

server.close();
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
