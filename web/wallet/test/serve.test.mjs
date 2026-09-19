// The local static server. A wallet served over HTTP is only as trustworthy as the server, so
// this file is about what the server refuses as much as what it serves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';

const SERVE = new URL('../serve.mjs', import.meta.url).pathname;

/** A temp directory laid out like a `dist/`, plus one file *outside* it to try to escape to. */
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'rand-serve-'));
  const root = join(base, 'dist');
  await mkdir(join(root, 'core'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Rand Wallet</title>');
  await writeFile(join(root, 'main.js'), 'export const x = 1;\n');
  await writeFile(join(root, 'base.css'), ':root { color: red }\n');
  await writeFile(join(root, 'core', 'rand_wallet_bg.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d]));
  await writeFile(join(base, 'SECRET.txt'), 'not servable');
  return { base, root };
}

/** Starts serve.mjs on an ephemeral port and resolves once it has printed where it bound. */
function start(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVE], {
      env: { ...process.env, RAND_WALLET_ROOT: root, RAND_WALLET_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`serve.mjs did not start: ${err || out}`)); }, 10_000);
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => {
      out += d;
      const line = out.split('\n').find((l) => l.trim().startsWith('{'));
      if (!line) return;
      clearTimeout(timer);
      const { address, port } = JSON.parse(line);
      resolve({ child, address, port, stop: () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); }) });
    });
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/** One raw HTTP/1.1 request, so the Host header can be anything at all. */
function raw(port, requestLines) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(`${requestLines.join('\r\n')}\r\n\r\n`));
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (d) => { data += d; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
    setTimeout(() => { socket.destroy(); resolve(data); }, 5000);
  });
}

function statusOf(response) {
  return Number(String(response).split('\r\n')[0].split(' ')[1]);
}

/** The header set every response must carry — a 403 and a 404 are served to a browser too. */
const REQUIRED_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; "
    + "img-src 'self' data:; font-src 'self'; connect-src *; worker-src 'self'; base-uri 'none'; "
    + "form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cache-control': 'no-store',
};

/** Parses a raw HTTP/1.1 response's headers into a lower-cased map. */
function headersOf(response) {
  const head = String(response).split('\r\n\r\n')[0].split('\r\n').slice(1);
  const out = {};
  for (const line of head) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function assertSecurityHeaders(headers, what) {
  for (const [name, value] of Object.entries(REQUIRED_HEADERS)) {
    assert.equal(headers[name], value, `${what}: ${name}`);
  }
}

test('serve.mjs: headers, MIME, binding, traversal and Host', async (t) => {
  const { base, root } = await fixture();
  const server = await start(root);
  t.after(async () => { await server.stop(); await rm(base, { recursive: true, force: true }); });

  const origin = `http://127.0.0.1:${server.port}`;

  await t.test('binds 127.0.0.1 only', () => {
    assert.equal(server.address, '127.0.0.1');
  });

  await t.test('serves index.html with the whole header set', async () => {
    const res = await fetch(`${origin}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    const csp = res.headers.get('content-security-policy');
    assert.equal(
      csp,
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; "
      + "font-src 'self'; connect-src *; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(res.headers.get('cross-origin-embedder-policy'), 'require-corp');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(await res.text(), /Rand Wallet/);
  });

  await t.test('serves wasm as application/wasm', async () => {
    const res = await fetch(`${origin}/core/rand_wallet_bg.wasm`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/wasm');
    assert.equal(res.headers.get('cross-origin-embedder-policy'), 'require-corp');
  });

  await t.test('serves js and css with their own types', async () => {
    const js = await fetch(`${origin}/main.js`);
    assert.match(js.headers.get('content-type'), /^text\/javascript/);
    const css = await fetch(`${origin}/base.css`);
    assert.match(css.headers.get('content-type'), /^text\/css/);
  });

  await t.test('refuses to escape the served directory', async () => {
    for (const path of ['/../SECRET.txt', '/%2e%2e/SECRET.txt', '/core/../../SECRET.txt', '/..%2fSECRET.txt']) {
      const res = await raw(server.port, [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${server.port}`, 'Connection: close']);
      const status = statusOf(res);
      assert.ok(status === 403 || status === 404, `${path} answered ${status}`);
      assert.equal(res.includes('not servable'), false, `${path} leaked a file outside the root`);
    }
  });

  await t.test('refuses a Host header that is not this loopback server', async () => {
    const bad = await raw(server.port, ['GET / HTTP/1.1', 'Host: wallet.example.com', 'Connection: close']);
    assert.equal(statusOf(bad), 403);
    const alsoBad = await raw(server.port, ['GET / HTTP/1.1', `Host: 127.0.0.1:${server.port + 1}`, 'Connection: close']);
    assert.equal(statusOf(alsoBad), 403);
    const good = await raw(server.port, ['GET / HTTP/1.1', `Host: localhost:${server.port}`, 'Connection: close']);
    assert.equal(statusOf(good), 200);
  });

  await t.test('only GET and HEAD', async () => {
    const res = await fetch(`${origin}/`, { method: 'POST' });
    assert.equal(res.status, 405);
  });

  await t.test('a refusal carries the same headers as a success', async () => {
    // A 403 or a 404 is rendered by the browser in this origin too, so dropping the CSP on the
    // error path would leave exactly the responses an attacker can most easily provoke unprotected.
    const forbidden = await raw(server.port, ['GET / HTTP/1.1', 'Host: evil.example', 'Connection: close']);
    assert.equal(statusOf(forbidden), 403);
    assertSecurityHeaders(headersOf(forbidden), 'a 403 (bad Host)');

    const missing = await raw(server.port, [`GET /nope.js HTTP/1.1`, `Host: 127.0.0.1:${server.port}`, 'Connection: close']);
    assert.equal(statusOf(missing), 404);
    assertSecurityHeaders(headersOf(missing), 'a 404');

    const traversal = await raw(server.port, ['GET /../SECRET.txt HTTP/1.1', `Host: 127.0.0.1:${server.port}`, 'Connection: close']);
    assert.ok([403, 404].includes(statusOf(traversal)));
    assertSecurityHeaders(headersOf(traversal), 'a refused traversal');

    const wrongMethod = await raw(server.port, ['POST / HTTP/1.1', `Host: 127.0.0.1:${server.port}`, 'Content-Length: 0', 'Connection: close']);
    assert.equal(statusOf(wrongMethod), 405);
    assertSecurityHeaders(headersOf(wrongMethod), 'a 405');
    assert.equal(headersOf(wrongMethod).allow, 'GET, HEAD');
  });

  await t.test('an unknown path is 404, and a directory serves its index', async () => {
    assert.equal((await fetch(`${origin}/nope.js`)).status, 404);
    assert.equal((await fetch(`${origin}/index.html`)).status, 200);
  });
});
