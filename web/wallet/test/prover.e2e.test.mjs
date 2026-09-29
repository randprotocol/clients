// End to end: a wasm wallet — the real core, the real engine, real `fetch` — pairs a real
// `rand-prover`, sends through it to a real `rand-node`, and the note lands in a second wallet.
//
// Delegated proving, Phase 1 (task 6). Everything in the path is the shipped code: the core's
// `prepare_transfer`/`finish_proof`, the engine's `prover` group and remote proving, a Test-profile
// chain (`rand-node genesis --fri-profile test`, like fullnode's `wallet_flow.rs`) and the prover's
// own queue. One real bundle proof, made by the prover (~100–120 s on a laptop).
//
// Skipped, with the reason, unless all three are present:
//   RAND_NODE_BIN    a `rand-node` built from the fullnode this repo vendors (core/vendor/fullnode)
//   RAND_PROVER_BIN  a `rand-prover` from the same build
//   the wasm core    extension/shared/core/rand_wallet_bg.wasm (`core/scripts/build-wasm.sh`)
// `scripts/e2e-prover.sh` builds the first two and runs this file.
//
// It runs under Node, not a browser, so CORS does not apply; a browser page needs the node's and
// the prover's CORS answers, which are tested on the fullnode side.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { makeWasmBackend, CANNOT_PROVE_REASON } from '../../../ui/engine/backend-wasm.js';

const CORE_JS = new URL('../../../extension/shared/core/rand_wallet.js', import.meta.url);
const CORE_WASM = new URL('../../../extension/shared/core/rand_wallet_bg.wasm', import.meta.url);
const NODE_BIN = process.env.RAND_NODE_BIN || '';
const PROVER_BIN = process.env.RAND_PROVER_BIN || '';
const PASSWORD = 'an-e2e-password-for-a-real-vault';
const CHAIN_ID = 18; // the chain this build's core was made for (`version.default_chain_id`)
const SEND_UNITS = '2000000000'; // 2 RAND out of the faucet's 100

const missing = [
  !NODE_BIN && 'RAND_NODE_BIN is not set',
  NODE_BIN && !existsSync(NODE_BIN) && `RAND_NODE_BIN ${NODE_BIN} does not exist`,
  !PROVER_BIN && 'RAND_PROVER_BIN is not set',
  PROVER_BIN && !existsSync(PROVER_BIN) && `RAND_PROVER_BIN ${PROVER_BIN} does not exist`,
  !(existsSync(CORE_JS) && existsSync(CORE_WASM)) && 'the wasm core is not built (core/scripts/build-wasm.sh)',
].filter(Boolean);
const skip = missing.length
  ? `delegated-proving e2e skipped: ${missing.join('; ')} — run scripts/e2e-prover.sh`
  : false;

// ------------------------------------------------------------------------------ the pieces ----

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
    local,
    sessionMap: session,
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

/** Real `fetch`, with every request's URL and body kept for the key-leak scan. */
function recordingFetch() {
  const requests = [];
  const wrapped = async (url, init = {}) => {
    requests.push({ url: String(url), body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body ?? null) });
    return fetch(url, init);
  };
  wrapped.requests = requests;
  return wrapped;
}

async function wallet(core) {
  const storage = mapStorage();
  const fetchImpl = recordingFetch();
  const backend = makeWasmBackend({
    core, storage, fetch: fetchImpl,
    platform: { name: 'node-e2e', openExternal() {}, copy() {} },
    locks: null, broadcast: null,
  });
  return { backend, storage, fetch: fetchImpl };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function rpc(url, method, params = []) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const reply = await res.json();
  if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
  return reply.result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, check, { timeoutMs, everyMs = 1000 }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
}

/** A child process whose output is kept (and printed if the test fails), killed in `after`. */
function launch(bin, args, label) {
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.log = [];
  const keep = (chunk) => {
    child.log.push(chunk.toString());
    if (child.log.length > 400) child.log.splice(0, child.log.length - 400);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.label = label;
  return child;
}

function stop(child) {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}

const running = (child) => !!child && child.exitCode === null && child.signalCode === null;

/** Resolves when `child` has exited, or after `ms` — whichever is first; `true` if it exited. */
function exited(child, ms) {
  if (!running(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.off('exit', done); resolve(false); }, ms);
    function done() { clearTimeout(timer); resolve(true); }
    child.once('exit', done);
  });
}

/** SIGTERM, wait up to `ms` for the exit, then SIGKILL and wait for that exit too. */
async function stopAndWait(child, ms = 10_000) {
  if (!running(child)) return;
  stop(child);
  if (await exited(child, ms)) return;
  child.kill('SIGKILL');
  await exited(child, 5_000);
}

const spendableRand = (scan) => (scan.notes || []).filter((n) => !n.spent && !n.pending && Number(n.asset) === 0);

// ------------------------------------------------------------------------------ the fixture ---

const env = {};

before(async () => {
  if (skip) return;
  env.dir = mkdtempSync(join(tmpdir(), 'rand-prover-e2e-'));
  env.core = await realCore();
  env.rpcPort = await freePort();
  env.proverPort = await freePort();
  env.rpcUrl = `http://127.0.0.1:${env.rpcPort}`;
  env.proverUrl = `http://127.0.0.1:${env.proverPort}`;

  // The two wallets first: the sender's address doubles as the validator's payout address, which
  // genesis requires and nothing here ever withdraws to.
  env.a = await wallet(env.core);
  env.b = await wallet(env.core);
  env.aInfo = await env.a.backend.wallet.create(PASSWORD);
  env.bInfo = await env.b.backend.wallet.create(PASSWORD);
  env.spendKey = await env.a.backend.wallet.exportSpendKey();
  for (const w of [env.a, env.b]) await w.backend.settings.set({ rpcUrl: env.rpcUrl });

  // A one-validator Test-profile chain with the faucet on, at 3 s blocks: a bundle's anchor and
  // time windows are 256 blocks, which must outlast a proof (fullnode `wallet_flow.rs`).
  const key = join(env.dir, 'node.key.json');
  const genesis = join(env.dir, 'genesis.json');
  const datadir = join(env.dir, 'data');
  execFileSync(NODE_BIN, ['keygen', '--out', key], { stdio: 'pipe' });
  execFileSync(NODE_BIN, [
    'genesis', '--chain-id', String(CHAIN_ID), '--fri-profile', 'test', '--faucet',
    '--validator', `${key},1000,${env.aInfo.address}`, '--out', genesis,
  ], { stdio: 'pipe' });
  execFileSync(NODE_BIN, ['init', '--datadir', datadir, '--genesis', genesis], { stdio: 'pipe' });
  env.node = launch(NODE_BIN, [
    'run', '--datadir', datadir, '--key', key, '--validator',
    '--rpc', `127.0.0.1:${env.rpcPort}`, '--listen', '/ip4/127.0.0.1/tcp/0', '--no-mdns',
    '--block-interval-ms', '3000', '--view-timeout-ms', '6000', '--min-free-disk-mb', '0',
  ], 'rand-node');
  await until('rand-node to answer rand_status', async () => {
    const st = await rpc(env.rpcUrl, 'rand_status');
    return st && st.fri_profile === 'test' && st.height >= 1;
  }, { timeoutMs: 60_000, everyMs: 500 });

  // The prover's key and an own-machine pairing; it is started by the send test, after the
  // no-prover case has run.
  env.proverHome = join(env.dir, 'prover');
  execFileSync(PROVER_BIN, ['--home', env.proverHome, 'keygen'], { stdio: 'pipe' });
  env.link = execFileSync(PROVER_BIN, [
    '--home', env.proverHome, 'pair', '--name', 'laptop', '--own', '--url', env.proverUrl,
  ], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim().split('\n').find((l) => l.startsWith('randprover:'));
  assert.ok(env.link, 'rand-prover pair printed a randprover: link');
});

after(async () => {
  // The data directory goes only once both have actually exited (a SIGKILL after a bounded wait),
  // never while RocksDB may still be writing into it.
  await Promise.all([env.prover, env.node].map((child) => stopAndWait(child)));
  if (env.dir) rmSync(env.dir, { recursive: true, force: true });
});

function dumpLogs(t) {
  for (const child of [env.node, env.prover]) {
    if (child) t.diagnostic(`--- ${child.label} (last lines) ---\n${child.log.join('').split('\n').slice(-40).join('\n')}`);
  }
}

// ------------------------------------------------------------------------------ the cases -----

test('the e2e either runs or says why not', (t) => {
  if (skip) t.diagnostic(skip);
});

test('with no prover running, a wasm wallet cannot prove and says how to', { skip }, async () => {
  // Nothing is paired: the wasm sentence, which names the prover option.
  const unpaired = await env.a.backend.send.canProve();
  assert.equal(unpaired.ok, false);
  assert.equal(unpaired.reason, CANNOT_PROVE_REASON);
  assert.match(unpaired.reason, /Pair your own prover/);

  // A pairing against a prover that is not listening is refused, and nothing is stored.
  await assert.rejects(() => env.a.backend.prover.pair(env.link, PASSWORD, { name: 'laptop' }));
  assert.equal((await env.a.backend.settings.get()).prover.mode, 'device');
  const still = await env.a.backend.send.canProve();
  assert.equal(still.ok, false);
  assert.match(still.reason, /Pair your own prover/);
});

test('a wasm wallet pairs its own rand-prover, sends through it, and the note lands', { skip, timeout: 20 * 60_000 }, async (t) => {
  const started = Date.now();
  try {
    env.prover = launch(PROVER_BIN, [
      '--home', env.proverHome, 'run', '--listen', `127.0.0.1:${env.proverPort}`,
      '--accept-spend-key', '--skip-memory-check',
    ], 'rand-prover');
    await until('rand-prover to answer prover_info', () => rpc(env.proverUrl, 'prover_info'), { timeoutMs: 30_000, everyMs: 300 });

    // Faucet the sender through the engine, and scan until the note is spendable.
    await env.a.backend.faucet.request();
    const funded = await until('the faucet note to be spendable', async () => {
      const scan = await env.a.backend.sync.scan(() => {});
      return spendableRand(scan).length > 0 ? scan : null;
    }, { timeoutMs: 120_000, everyMs: 2000 });
    t.diagnostic(`funded in ${((Date.now() - started) / 1000).toFixed(1)} s: ${spendableRand(funded).map((n) => n.amount).join(', ')} units`);

    // Pair, and the wasm wallet can now prove — through the prover.
    const paired = await env.a.backend.prover.pair(env.link, PASSWORD, { name: 'laptop' });
    assert.equal(paired.mode, 'remote');
    assert.equal(paired.name, 'laptop');
    assert.equal(paired.own, true);
    assert.deepEqual(await env.a.backend.send.canProve(), { ok: true, via: 'prover' });

    // The send: the proof is made by the prover, the rest by the engine, against the real node.
    const phases = [];
    const proveStarted = Date.now();
    const out = await env.a.backend.send.send(
      { asset: 0, to: env.bInfo.address, amount: SEND_UNITS },
      (phase, detail) => phases.push(detail === undefined ? [phase] : [phase, detail]),
    );
    t.diagnostic(`send (prove + submit + commit) took ${((Date.now() - proveStarted) / 1000).toFixed(1)} s`);
    assert.match(out.hash, /^[0-9a-f]{64}$/);
    assert.match(out.txKey, /^[0-9a-f]{64}$/);
    const names = phases.map(([p]) => p);
    assert.ok(phases.some(([p, d]) => p === 'proving' && d && d.prover === 'laptop' && d.position === undefined),
      `a 'proving' phase with {prover: 'laptop'}; got ${JSON.stringify(phases)}`);
    for (const p of ['selecting', 'witness', 'submitting', 'confirming']) assert.ok(names.includes(p), `phase ${p} in ${JSON.stringify(names)}`);
    assert.ok(names.indexOf('proving') < names.indexOf('submitting'), 'proved before submitted');
    assert.equal(await env.a.backend.send.pending(), null, 'nothing left pending after the send');

    // The node has it committed.
    const tx = await rpc(env.rpcUrl, 'rand_getTransaction', [out.hash]);
    assert.ok(tx, 'the node knows the transaction');

    // The receiver scans and finds exactly the amount sent.
    const received = await until('the payment to reach the second wallet', async () => {
      const scan = await env.b.backend.sync.scan(() => {});
      return (scan.notes || []).find((n) => Number(n.asset) === 0 && String(n.amount) === SEND_UNITS && !n.spent) || null;
    }, { timeoutMs: 60_000, everyMs: 2000 });
    assert.equal(String(received.amount), SEND_UNITS);

    // The spend key went to the prover only inside the sealed job: not one request body this
    // wallet made — to the node or to the prover — carries it in the clear.
    assert.ok(env.a.fetch.requests.some((r) => r.url.startsWith(env.proverUrl) && r.body.includes('prover_submit')), 'the job went to the prover');
    for (const r of [...env.a.fetch.requests, ...env.b.fetch.requests]) {
      assert.equal(r.body.includes(env.spendKey), false, `the spend key is in a request to ${r.url}`);
      assert.equal(r.url.includes(env.spendKey), false, 'the spend key is in a URL');
    }
    t.diagnostic(`e2e total ${((Date.now() - started) / 1000).toFixed(1)} s`);
  } catch (err) {
    dumpLogs(t);
    throw err;
  }
});

test('a paired prover that stops answering is no longer a way to prove', { skip }, async () => {
  if (!env.prover) return; // the send case never started it
  stop(env.prover);
  await until('rand-prover to exit', () => env.prover.exitCode !== null || env.prover.signalCode !== null, { timeoutMs: 10_000, everyMs: 100 });
  const answer = await env.a.backend.send.canProve();
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /Pair your own prover/);
});
