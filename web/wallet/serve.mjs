#!/usr/bin/env node
// The local static server for the web wallet. It exists to make one directory readable by one
// browser on this machine, and to refuse everything else.
//
//   * **127.0.0.1 only.** Never 0.0.0.0: a wallet on a laptop's Wi-Fi address is a wallet anyone
//     on the café network can load and then phish with.
//   * **The Host header must name this server.** A browser will happily resolve some attacker's
//     domain to 127.0.0.1 and load this origin under *their* name (DNS rebinding); anything but
//     `127.0.0.1:<port>` or `localhost:<port>` is refused before a file is read.
//   * **No path escapes the served directory.** The URL is decoded, normalised, and the resolved
//     path must still be inside the root — symlinks included, because the check is on the real
//     path, not the textual one.
//   * **The CSP is the point of the whole exercise.** `script-src 'self' 'wasm-unsafe-eval'` is
//     what lets the wasm core run and nothing else; `connect-src *` is what lets the user point
//     the wallet at whichever Rand node they trust. No inline script, no remote script, no
//     framing, no form posts.
//
// Run: `node web/wallet/serve.mjs` (after build.sh), or `web/wallet/serve.sh` for both.
// `RAND_WALLET_ROOT` and `RAND_WALLET_PORT` override the directory and the port; port 0 asks the
// OS for a free one, which is what the tests use.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;
const HERE = fileURLToPath(new URL('.', import.meta.url));

export const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; "
  + "img-src 'self' data:; font-src 'self'; connect-src *; worker-src 'self'; base-uri 'none'; "
  + "form-action 'none'; frame-ancestors 'none'";

const TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}));

function contentType(path) {
  const dot = path.lastIndexOf('.');
  const ext = dot === -1 ? '' : path.slice(dot).toLowerCase();
  return TYPES.get(ext) || 'application/octet-stream';
}

/** Every response carries these, success or failure. */
function securityHeaders() {
  return {
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'geolocation=(), camera=(), microphone=(), payment=(), usb=()',
    'cache-control': 'no-store',
  };
}

function send(res, status, body, extra = {}) {
  res.writeHead(status, { ...securityHeaders(), 'content-type': 'text/plain; charset=utf-8', ...extra });
  res.end(body);
}

/** True only for `127.0.0.1:<port>` / `localhost:<port>` (and, before listen, any port). */
export function hostAllowed(host, port) {
  if (typeof host !== 'string' || host === '') return false;
  const m = /^([^:]+|\[[^\]]+\]):?(\d+)?$/.exec(host.trim());
  if (!m) return false;
  const name = m[1].toLowerCase();
  const given = m[2] === undefined ? 80 : Number(m[2]);
  if (name !== '127.0.0.1' && name !== 'localhost' && name !== '[::1]') return false;
  return given === Number(port);
}

/**
 * Resolves `urlPath` inside `root`, or `null` if it escapes. The real path is compared, so a
 * symlink out of the directory is refused too.
 */
export async function resolveInRoot(root, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const rootReal = await realpath(root);
  // `resolve` normalises `..` textually; the realpath check below is what catches symlinks.
  const candidate = resolve(rootReal, `.${decoded.startsWith('/') ? '' : '/'}${decoded}`);
  if (candidate !== rootReal && !candidate.startsWith(rootReal + sep)) return null;
  let target = candidate;
  let info;
  try { info = await stat(target); } catch { return null; }
  if (info.isDirectory()) {
    target = join(target, 'index.html');
    try { info = await stat(target); } catch { return null; }
  }
  if (!info.isFile()) return null;
  let real;
  try { real = await realpath(target); } catch { return null; }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) return null;
  return { path: real, size: info.size };
}

export function createWalletServer({ root, port = DEFAULT_PORT } = {}) {
  const dir = resolve(root);
  let boundPort = port;
  const server = createServer((req, res) => {
    (async () => {
      if (!hostAllowed(req.headers.host, boundPort)) {
        send(res, 403, 'This wallet is served to this machine only.\n');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, 'Only GET and HEAD.\n', { allow: 'GET, HEAD' });
        return;
      }
      const urlPath = (req.url || '/').split('?')[0].split('#')[0];
      const found = await resolveInRoot(dir, urlPath === '/' ? '/index.html' : urlPath);
      if (!found) {
        send(res, 404, 'Not found.\n');
        return;
      }
      res.writeHead(200, { ...securityHeaders(), 'content-type': contentType(found.path), 'content-length': String(found.size) });
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(found.path).on('error', () => res.destroy()).pipe(res);
    })().catch(() => { try { send(res, 500, 'Server error.\n'); } catch { res.destroy(); } });
  });
  server.on('listening', () => { boundPort = server.address().port; });
  return server;
}

// ------------------------------------------------------------------------------------ the CLI --
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const root = process.env.RAND_WALLET_ROOT || join(HERE, 'dist');
  const port = Number(process.env.RAND_WALLET_PORT ?? DEFAULT_PORT);
  try {
    await stat(root);
  } catch {
    console.error(`nothing to serve: ${root} does not exist — run web/wallet/build.sh first`);
    process.exit(1);
  }
  const server = createWalletServer({ root, port });
  server.listen(port, HOST, () => {
    const { address, port: bound } = server.address();
    // One machine-readable line first (the tests read it), then the human one.
    console.log(JSON.stringify({ address, port: bound, root }));
    console.log(`Rand Wallet is at http://${HOST}:${bound}/  (serving ${root}; this machine only)`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500).unref(); });
  }
}
