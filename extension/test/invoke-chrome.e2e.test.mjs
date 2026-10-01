// End to end, in a real Chrome: the packed DEVNET extension (dist/chrome-devnet, chain 1919) and a
// page on localhost that calls `window.rand.invoke` exactly as durian.market does. The approval
// window is the real one (invoke.html): it must name the site and show what leaves the wallet and
// what comes back; Reject must reach the page as USER_REJECTED; Approve must prove (the call and
// auth proofs in the extension's wasm worker, the bundle at a paired rand-prover) and reach the
// page as `{tx}`, a transaction the devnet commits.
//
// Opt-in — it spends devnet faucet RAND (5 mints an hour) and takes minutes:
//
//   DEVNET_E2E=1 RAND_PROVER_BIN=… DURIAN_BIN=… node --test extension/test/invoke-chrome.e2e.test.mjs
//
//   dist/chrome-devnet   scripts/devnet/pack-devnet.sh
//   playwright           npm --prefix extension install (or RAND_E2E_MODULES)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = resolve(new URL('../../', import.meta.url).pathname);
const EXT_DIR = process.env.RAND_EXT_DIR || join(ROOT, 'dist', 'chrome-devnet');
const MODULES = process.env.RAND_E2E_MODULES || join(ROOT, 'extension', 'node_modules');
const RPC = process.env.DEVNET_RPC || 'https://durian.market/api/wallet-rpc';
const PROGRAM = process.env.DURIAN_PROGRAM || 'db2148e6b81a2268b840bbad271068a37b2b75babaf534f1cd5bd6329a532bda';
const PROVER_BIN = process.env.RAND_PROVER_BIN || '';
const DURIAN_BIN = process.env.DURIAN_BIN || '';
const PASSWORD = 'an-e2e-password-for-a-real-vault';

function loadPlaywright() {
  try { return createRequire(join(MODULES, 'package.json'))('playwright'); } catch { return null; }
}
const playwright = loadPlaywright();
const missing = [
  process.env.DEVNET_E2E !== '1' && 'DEVNET_E2E=1 is not set (it spends devnet faucet RAND)',
  !existsSync(join(EXT_DIR, 'manifest.json')) && `${EXT_DIR} is not packed (scripts/devnet/pack-devnet.sh)`,
  !playwright && `playwright is not under ${MODULES}`,
  !(PROVER_BIN && existsSync(PROVER_BIN)) && 'RAND_PROVER_BIN is not a file',
  !(DURIAN_BIN && existsSync(DURIAN_BIN)) && 'DURIAN_BIN is not a file',
].filter(Boolean);
const skip = missing.length ? `Chrome invoke e2e skipped: ${missing.join('; ')}` : false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(url, method, params = []) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const reply = await res.json();
  if (reply.error) throw new Error(reply.error.message);
  return reply.result;
}
async function until(what, check, timeoutMs, everyMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { const v = await check(); if (v) return v; } catch (err) { last = err; }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${last.message})` : ''}`);
}

/** What durian.market's page would send for `sell 1 RAND for DUR`, planned now. */
function swapRequest() {
  const out = execFileSync(DURIAN_BIN, ['--rpc', RPC, '--program', PROGRAM, 'swap', '--sell', '1', '--of', 'RAND', '--for', 'DUR', '--dry-run'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const t = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
  const inputs = JSON.parse(out.match(/^inputs: (\[[^\]]*\])/m)[1]);
  return { program: PROGRAM, inputs, reads: t.reads, writes: t.writes, inflow: t.deposit, pays: t.pays, mints: t.mints, summary: { title: 'Swap 1 RAND for DUR', spend: [], receive: [] } };
}

const env = {};
/** The backend inside the extension's own app page. */
const inApp = (fn, arg) => env.app.evaluate(fn, arg);

before(async () => {
  if (skip) return;
  env.dir = mkdtempSync(join(tmpdir(), 'rand-invoke-chrome-'));
  // A page on localhost (the content scripts match it): durian.market's role, nothing more.
  env.server = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Rand Wallet automated test — please leave open</title><p>swap</p>'); });
  await new Promise((r) => env.server.listen(0, '127.0.0.1', r));
  env.pageUrl = `http://localhost:${env.server.address().port}/`;

  env.proverPort = 39600 + Math.floor(Math.random() * 300);
  const home = join(env.dir, 'prover');
  execFileSync(PROVER_BIN, ['--home', home, 'keygen'], { stdio: 'pipe' });
  env.link = execFileSync(PROVER_BIN, ['--home', home, 'pair', '--name', 'chrome-e2e', '--url', `http://127.0.0.1:${env.proverPort}`], { stdio: ['ignore', 'pipe', 'pipe'] })
    .toString().split('\n').find((l) => l.startsWith('randprover:'));
  env.prover = spawn(PROVER_BIN, ['--home', home, 'run', '--listen', `127.0.0.1:${env.proverPort}`, '--skip-memory-check'], { stdio: 'ignore' });
  await until('rand-prover', () => rpc(`http://127.0.0.1:${env.proverPort}`, 'prover_info'), 30_000, 300);

  env.profile = join(env.dir, 'profile');
  env.context = await playwright.chromium.launchPersistentContext(env.profile, {
    headless: false,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run'],
  });
  let worker = env.context.serviceWorkers()[0];
  if (!worker) worker = await env.context.waitForEvent('serviceworker', { timeout: 15_000 });
  env.extId = new URL(worker.url()).host;
  env.app = await env.context.newPage();
  await env.app.goto(`chrome-extension://${env.extId}/app.html`);
  env.address = await inApp(async (pw) => {
    const m = await import('./backend-extension.js');
    return (await m.extensionBackend().wallet.create(pw)).address;
  }, PASSWORD);
  env.page = await env.context.newPage();
  env.closed = [];
  env.context.on('close', () => env.closed.push('context closed'));
  env.page.on('close', () => env.closed.push('page closed'));
  env.page.on('crash', () => env.closed.push('page crashed'));
});

after(async () => {
  if (env.context) await env.context.close().catch(() => {});
  if (env.prover) env.prover.kill('SIGTERM');
  if (env.server) env.server.close();
  if (env.dir) rmSync(env.dir, { recursive: true, force: true });
});

test('the Chrome invoke e2e either runs or says why not', (t) => { if (skip) t.diagnostic(skip); });

test('a page asks, the wallet\'s window shows it, Reject is USER_REJECTED, Approve sends the swap', { skip, timeout: 40 * 60_000 }, async (t) => {
  const started = Date.now();
  // Funded and paired, through the extension's own backend.
  await inApp(async () => { const m = await import('./backend-extension.js'); await m.extensionBackend().faucet.request(); });
  await until('the faucet note', () => inApp(async () => {
    const m = await import('./backend-extension.js');
    const s = await m.extensionBackend().sync.scan(() => {});
    return (s.notes || []).some((n) => Number(n.asset) === 0 && !n.spent && !n.pending);
  }), 180_000, 3000);
  const paired = await inApp(async ([link, pw]) => {
    const m = await import('./backend-extension.js');
    return m.extensionBackend().prover.pair(link, pw, { name: 'chrome-e2e' });
  }, [env.link, PASSWORD]);
  assert.equal(paired.mode, 'remote');
  t.diagnostic(`funded and paired in ${((Date.now() - started) / 1000).toFixed(0)} s`);

  if (env.closed.length) t.diagnostic(`before goto: ${env.closed.join(', ')}`);
  if (env.page.isClosed()) env.page = await env.context.newPage();
  await env.page.goto(env.pageUrl);
  assert.equal(await env.page.evaluate(() => typeof window.rand?.invoke), 'function', 'the devnet build offers invoke');
  // Connect first (the consent window), as the site does.
  const consentOpened = env.context.waitForEvent('page', { timeout: 15_000 });
  const connected = env.page.evaluate(() => window.rand.connect());
  const consent = await consentOpened;
  await consent.getByRole('button', { name: 'Connect', exact: true }).click();
  assert.equal((await connected).address, env.address);

  // 1. Reject.
  let windowOpened = env.context.waitForEvent('page', { timeout: 15_000 });
  const rejected = env.page.evaluate((req) => window.rand.invoke(req).then(() => 'sent', (e) => e.code), swapRequest());
  let win = await windowOpened;
  await win.getByRole('button', { name: 'Approve' }).waitFor({ timeout: 120_000 });
  const shown = await win.locator('body').innerText();
  t.diagnostic(`approval window:\n${shown}`);
  assert.ok(shown.includes(new URL(env.pageUrl).host), 'the window names the site');
  assert.match(shown, /You pay[\s\S]*1 RAND/);
  assert.match(shown, /You receive[\s\S]*DUR/);
  assert.match(shown, /Network fee/);
  await win.getByRole('button', { name: 'Reject' }).click();
  assert.equal(await rejected, 'USER_REJECTED');

  // 2. Approve (re-planned: the pool may have moved).
  windowOpened = env.context.waitForEvent('page', { timeout: 15_000 });
  const request = swapRequest();
  const sent = env.page.evaluate((req) => window.rand.invoke(req).then((r) => ({ tx: r.tx }), (e) => ({ code: e.code, message: e.message })), request);
  win = await windowOpened;
  await win.getByRole('button', { name: 'Approve' }).click({ timeout: 120_000 });
  const out = await sent;
  t.diagnostic(`invoke answered in ${((Date.now() - started) / 1000).toFixed(0)} s: ${JSON.stringify(out)}`);
  assert.match(out.tx || '', /^[0-9a-f]{64}$/, JSON.stringify(out));
  const committed = await until('the swap to commit', () => rpc(RPC, 'rand_getTransaction', [out.tx]), 180_000);
  t.diagnostic(`committed at height ${committed.height}; e2e ${((Date.now() - started) / 1000).toFixed(0)} s`);
});
