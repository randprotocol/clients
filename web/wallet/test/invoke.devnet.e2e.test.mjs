// End to end, against a REAL chain: durian.market's devnet (chain 1919, fullnode feat/rpl2 "v0.6.8",
// program_state on). A wasm wallet — the devnet build of the real core, the real engine, real
// `fetch` — is funded by the devnet faucet, pairs a real `rand-prover` that is NOT its own (viewing-
// key jobs only), and swaps 1 RAND for DUR in the live RAND/DUR pool through `backend.program`, the
// code path the extension's approval window runs. The DUR note must then turn up in its own scan.
//
// The swap request is the one durian.market's page would send: `durian swap --dry-run` plans it
// against the pool as it is now (its `deposit` is the page's `inflow`).
//
// Three real proofs: the call (tier 12) and the auth proof in this process's wasm core, the bundle
// at the prover. Several minutes. Opt-in, because it spends devnet faucet RAND (5 mints an hour):
//
//   DEVNET_E2E=1 RAND_PROVER_BIN=… DURIAN_BIN=… node --test web/wallet/test/invoke.devnet.e2e.test.mjs
//
//   the wasm core   dist/devnet-core-1919/ (scripts/devnet/pack-devnet.sh)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { makeWasmBackend } from '../../../ui/engine/backend-wasm.js';

const CORE_DIR = new URL('../../../dist/devnet-core-1919/', import.meta.url);
const CORE_JS = new URL('rand_wallet.js', CORE_DIR);
const CORE_WASM = new URL('rand_wallet_bg.wasm', CORE_DIR);
const RPC = process.env.DEVNET_RPC || 'https://durian.market/api/wallet-rpc';
const PROGRAM = process.env.DURIAN_PROGRAM || 'db2148e6b81a2268b840bbad271068a37b2b75babaf534f1cd5bd6329a532bda';
const PROVER_BIN = process.env.RAND_PROVER_BIN || '';
const DURIAN_BIN = process.env.DURIAN_BIN || '';
const PASSWORD = 'an-e2e-password-for-a-real-vault';

const missing = [
  process.env.DEVNET_E2E !== '1' && 'DEVNET_E2E=1 is not set (it spends devnet faucet RAND)',
  !(PROVER_BIN && existsSync(PROVER_BIN)) && 'RAND_PROVER_BIN is not a file',
  !(DURIAN_BIN && existsSync(DURIAN_BIN)) && 'DURIAN_BIN is not a file',
  !(existsSync(CORE_JS) && existsSync(CORE_WASM)) && 'the devnet core is not built (scripts/devnet/pack-devnet.sh)',
].filter(Boolean);
const skip = missing.length ? `devnet invoke e2e skipped: ${missing.join('; ')}` : false;

async function realCore() {
  const mod = await import(CORE_JS.href);
  mod.initSync({ module: readFileSync(CORE_WASM) });
  return {
    async call(method, params = {}) {
      const reply = JSON.parse(mod.call(method, JSON.stringify(params)));
      if (!reply.ok) throw new Error(reply.error);
      return reply.value;
    },
  };
}

function mapStorage() {
  const local = new Map();
  const session = new Map();
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    async get(k) { return clone(local.get(k)); },
    async set(k, v) { local.set(k, clone(v)); },
    async remove(k) { local.delete(k); },
    async clear() { local.clear(); session.clear(); },
    session: {
      async get(k) { return session.get(k); },
      async set(k, v) { session.set(k, v); },
      async remove(k) { session.delete(k); },
    },
  };
}

function recordingFetch() {
  const requests = [];
  const wrapped = async (url, init = {}) => {
    requests.push({ url: String(url), body: typeof init.body === 'string' ? init.body : '' });
    return fetch(url, init);
  };
  wrapped.requests = requests;
  return wrapped;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function rpc(url, method, params = []) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const reply = await res.json();
  if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
  return reply.result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, check, { timeoutMs, everyMs = 2000 }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { const v = await check(); if (v) return v; } catch (err) { last = err; }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
}

/** What durian.market's page would send for `sell <amount> RAND for DUR`, planned now. */
function swapRequest(amount = '1') {
  const out = execFileSync(DURIAN_BIN, ['--rpc', RPC, '--program', PROGRAM, 'swap', '--sell', amount, '--of', 'RAND', '--for', 'DUR', '--dry-run'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
  const t = JSON.parse(json);
  const inputs = JSON.parse(out.match(/^inputs: (\[[^\]]*\])/m)[1]);
  return {
    program: PROGRAM, inputs, reads: t.reads, writes: t.writes, inflow: t.deposit, pays: t.pays, mints: t.mints,
    summary: { title: `Swap ${amount} RAND for DUR`, spend: [], receive: [] },
  };
}

const env = {};

before(async () => {
  if (skip) return;
  env.dir = mkdtempSync(join(tmpdir(), 'rand-invoke-devnet-'));
  env.core = await realCore();
  const v = await env.core.call('version');
  assert.equal(v.default_chain_id, 1919, 'the devnet build of the core');
  env.fetch = recordingFetch();
  env.backend = makeWasmBackend({
    core: env.core, storage: mapStorage(), fetch: env.fetch,
    platform: { name: 'node-e2e', openExternal() {}, copy() {} }, locks: null, broadcast: null,
  });
  env.info = await env.backend.wallet.create(PASSWORD);
  env.spendKey = await env.backend.wallet.exportSpendKey();
  env.proverPort = await freePort();
  env.proverUrl = `http://127.0.0.1:${env.proverPort}`;
  env.proverHome = join(env.dir, 'prover');
  execFileSync(PROVER_BIN, ['--home', env.proverHome, 'keygen'], { stdio: 'pipe' });
  // NOT `--own`: on a split-authorisation chain any paired prover takes a viewing-key job.
  env.link = execFileSync(PROVER_BIN, ['--home', env.proverHome, 'pair', '--name', 'e2e-prover', '--url', env.proverUrl], { stdio: ['ignore', 'pipe', 'pipe'] })
    .toString().trim().split('\n').find((l) => l.startsWith('randprover:'));
  env.prover = spawn(PROVER_BIN, ['--home', env.proverHome, 'run', '--listen', `127.0.0.1:${env.proverPort}`, '--skip-memory-check'], { stdio: ['ignore', 'pipe', 'pipe'] });
  env.prover.log = [];
  for (const s of [env.prover.stdout, env.prover.stderr]) s.on('data', (c) => { env.prover.log.push(String(c)); if (env.prover.log.length > 200) env.prover.log.shift(); });
  await until('rand-prover to answer', () => rpc(env.proverUrl, 'prover_info'), { timeoutMs: 30_000, everyMs: 300 });
});

after(async () => {
  if (env.prover && env.prover.exitCode === null) env.prover.kill('SIGTERM');
  await sleep(500);
  if (env.dir) rmSync(env.dir, { recursive: true, force: true });
});

test('the devnet e2e either runs or says why not', (t) => { if (skip) t.diagnostic(skip); });

test('a wasm wallet swaps 1 RAND for DUR on the devnet through a paired prover, and the DUR lands', { skip, timeout: 40 * 60_000 }, async (t) => {
  const started = Date.now();
  try {
    await env.backend.faucet.request();
    await until('the faucet note', async () => {
      const scan = await env.backend.sync.scan(() => {});
      return (scan.notes || []).some((n) => Number(n.asset) === 0 && !n.spent && !n.pending);
    }, { timeoutMs: 180_000 });
    t.diagnostic(`funded in ${((Date.now() - started) / 1000).toFixed(0)} s`);

    // Before pairing: no route, and the code the site branches on.
    const before = await env.backend.program.canInvoke();
    assert.equal(before.ok, false);
    assert.equal(before.code, 'PROVER_UNAVAILABLE');

    const paired = await env.backend.prover.pair(env.link, PASSWORD, { name: 'e2e-prover' });
    assert.equal(paired.own, false);
    assert.deepEqual(await env.backend.program.canInvoke(), { ok: true, via: 'prover' });

    // The approval window's quote: this wallet's own reading of the site's request.
    let request = swapRequest('1');
    const quote = await env.backend.program.quote(request);
    t.diagnostic(`quote: ${JSON.stringify(quote)}`);
    assert.deepEqual(quote.spend, [{ asset: 0, amount: '1000000000' }]);
    assert.equal(quote.receive.length, 1);
    assert.equal(quote.receive[0].asset, 1);
    assert.equal(quote.tier, 12);

    // Approve. A stale read is re-quoted, as the site does.
    const phases = [];
    let out;
    for (let attempt = 1; ; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        out = await env.backend.program.invoke(request, (p, d) => phases.push(d === undefined ? [p] : [p, d]));
        break;
      } catch (err) {
        if (err.code !== 'STALE_READ' || attempt >= 3) throw err;
        t.diagnostic('stale read: re-quoting');
        request = swapRequest('1');
      }
    }
    t.diagnostic(`invoke accepted in ${((Date.now() - started) / 1000).toFixed(0)} s total: ${out.hash}`);
    assert.match(out.hash, /^[0-9a-f]{64}$/);
    assert.ok(phases.some(([p, d]) => p === 'proving' && d && d.prover === 'e2e-prover'), JSON.stringify(phases));

    const committed = await until('the invoke to commit', () => rpc(RPC, 'rand_getTransaction', [out.hash]), { timeoutMs: 120_000 });
    t.diagnostic(`committed at height ${committed.height}`);
    const want = request.pays[0].amount;
    const dur = await until('the DUR payout in this wallet', async () => {
      const scan = await env.backend.sync.scan(() => {});
      return (scan.notes || []).find((n) => Number(n.asset) === 1 && String(n.amount) === want && !n.spent) || null;
    }, { timeoutMs: 120_000 });
    assert.equal(String(dur.amount), want);

    for (const r of env.fetch.requests) assert.equal(r.body.includes(env.spendKey), false, `the spend key went to ${r.url}`);
    t.diagnostic(`e2e total ${((Date.now() - started) / 1000).toFixed(0)} s`);
  } catch (err) {
    t.diagnostic(`--- rand-prover ---\n${(env.prover && env.prover.log.join('')) || ''}`.slice(-4000));
    throw err;
  }
});
