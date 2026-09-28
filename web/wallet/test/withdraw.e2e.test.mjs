// End to end: a wasm wallet — the real core, the real engine, real `fetch` — is minted a bridged
// token on a local chain and WITHDRAWS it (a `BridgeBurn`, one bundle proof) through a paired
// `rand-prover`, against a real `rand-node`. The burn commits, the bridge's books move, and the
// wallet's balance drops by exactly what it burned.
//
// Delegated proving, Phase 1, for the one flow the extension and the web wallet could not carry
// out before: a withdrawal. Everything in the path is the shipped code — `bridge.canWithdraw`,
// `bridge.estimate`, `bridge.withdraw` (ui/engine/backend-shared.js), the core's `prepare_burn` /
// `finish_proof`, the engine's prover group, and the prover's own queue.
//
// The chain is a one-validator Test-profile chain 16 with a bridged genesis: the fullnode test
// suite's six guardians, chain 2 (Ethereum) registered as a source, and one bridged token, zUSD
// backed by chain 2 USDT, listed at genesis. `e2e-fixtures` (core/crates/e2e-fixtures) writes
// that genesis and signs the deposit; `rand bridge-mint` (the fullnode's CLI) submits it.
// Two real bundle proofs: the mint's (made by the CLI) and the burn's (made by the prover),
// ~2 minutes each on a laptop. Do not run beside another proving job.
//
// Skipped, with the reason, unless all of these are present:
//   RAND_NODE_BIN      a `rand-node` — the fullnode this repo vendors, or a later one (v0.6.4 gas)
//   RAND_PROVER_BIN    a `rand-prover` from the fullnode this repo vendors
//   RAND_CLI_BIN       the fullnode's `rand` command-line wallet, from the same build as the node
//   RAND_FIXTURES_BIN  `e2e-fixtures` (cargo build --release -p e2e-fixtures, in core/)
//   the wasm core      extension/shared/core/rand_wallet_bg.wasm (`core/scripts/build-wasm.sh`)
// `scripts/e2e-withdraw.sh` builds all four and runs this file.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { makeWasmBackend } from '../../../ui/engine/backend-wasm.js';
import { recipientHash } from '../../../extension/shared/lib/recipient-hash.js';

const CORE_JS = new URL('../../../extension/shared/core/rand_wallet.js', import.meta.url);
const CORE_WASM = new URL('../../../extension/shared/core/rand_wallet_bg.wasm', import.meta.url);
const NODE_BIN = process.env.RAND_NODE_BIN || '';
const PROVER_BIN = process.env.RAND_PROVER_BIN || '';
const CLI_BIN = process.env.RAND_CLI_BIN || '';
const FIXTURES_BIN = process.env.RAND_FIXTURES_BIN || '';
const PASSWORD = 'an-e2e-password-for-a-real-vault';
const CHAIN_ID = 16; // the chain this build's core was made for (`version.default_chain_id`)
const SOURCE_CHAIN = 2; // Ethereum's bridge chain id
// Chain 2 USDT, the mainnet wire address: twelve zero bytes then the contract. The genesis
// `e2e-fixtures` writes lists zUSD backed by exactly this coin.
const USDT2 = '000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7';
const ZUSD_INDEX = 1;              // zUSD is the registry's first token; RAND is asset 0
const MINTED = 250_000_000_000n;   // 2500 zUSD deposited (eight decimals on Rand)
const WITHDRAWN = 100_000_000n;    // 1 zUSD burned — a whole release unit of a six-decimal coin
// The Ethereum address the burn releases to: twelve zero bytes then twenty address bytes.
const TO_ETH = '0'.repeat(24) + 'ab'.repeat(20);

const missing = [
  !NODE_BIN && 'RAND_NODE_BIN is not set',
  NODE_BIN && !existsSync(NODE_BIN) && `RAND_NODE_BIN ${NODE_BIN} does not exist`,
  !PROVER_BIN && 'RAND_PROVER_BIN is not set',
  PROVER_BIN && !existsSync(PROVER_BIN) && `RAND_PROVER_BIN ${PROVER_BIN} does not exist`,
  !CLI_BIN && 'RAND_CLI_BIN is not set',
  CLI_BIN && !existsSync(CLI_BIN) && `RAND_CLI_BIN ${CLI_BIN} does not exist`,
  !FIXTURES_BIN && 'RAND_FIXTURES_BIN is not set',
  FIXTURES_BIN && !existsSync(FIXTURES_BIN) && `RAND_FIXTURES_BIN ${FIXTURES_BIN} does not exist`,
  !(existsSync(CORE_JS) && existsSync(CORE_WASM)) && 'the wasm core is not built (core/scripts/build-wasm.sh)',
].filter(Boolean);
const skip = missing.length
  ? `withdraw e2e skipped: ${missing.join('; ')} — run scripts/e2e-withdraw.sh`
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

const run = (bin, args, opts = {}) => execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, ...opts }).toString();
const spendable = (scan, asset) => (scan.notes || []).filter((n) => !n.spent && !n.pending && Number(n.asset) === asset);
const sum = (notes) => notes.reduce((t, n) => t + BigInt(n.amount), 0n);
/** The zUSD backing row for chain 2 USDT in `rand_getAssets` (one row per backing): `locked` is
 *  what the bridge holds of that coin, and a burn releases out of it. */
async function usdtBacking(url) {
  const rows = (await rpc(url, 'rand_getAssets')) || [];
  return rows.find((r) => Number(r.index) === ZUSD_INDEX && Number(r.chain) === SOURCE_CHAIN && String(r.token).toLowerCase() === USDT2) || null;
}

// ------------------------------------------------------------------------------ the fixture ---

const env = {};

before(async () => {
  if (skip) return;
  env.dir = mkdtempSync(join(tmpdir(), 'rand-withdraw-e2e-'));
  env.core = await realCore();
  env.rpcPort = await freePort();
  env.proverPort = await freePort();
  env.rpcUrl = `http://127.0.0.1:${env.rpcPort}`;
  env.proverUrl = `http://127.0.0.1:${env.proverPort}`;

  // The wasm wallet first: its address doubles as the validator's payout address, which genesis
  // requires and nothing here ever pays.
  env.a = await wallet(env.core);
  env.aInfo = await env.a.backend.wallet.create(PASSWORD);
  env.spendKey = await env.a.backend.wallet.exportSpendKey();
  await env.a.backend.settings.set({ rpcUrl: env.rpcUrl });

  // A one-validator Test-profile chain with the faucet on, at 3 s blocks, and a bridged genesis:
  // the fixtures helper adds the `bridge` and `tokens` sections to what `rand-node genesis` wrote.
  const key = join(env.dir, 'node.key.json');
  const genesis = join(env.dir, 'genesis.json');
  const datadir = join(env.dir, 'data');
  run(NODE_BIN, ['keygen', '--out', key]);
  run(NODE_BIN, [
    'genesis', '--chain-id', String(CHAIN_ID), '--fri-profile', 'test', '--faucet',
    '--validator', `${key},1000,${env.aInfo.address}`, '--out', genesis,
  ]);
  run(FIXTURES_BIN, ['genesis', '--in', genesis, '--out', genesis, '--source-chain', String(SOURCE_CHAIN)]);
  run(NODE_BIN, ['init', '--datadir', datadir, '--genesis', genesis]);
  env.node = launch(NODE_BIN, [
    'run', '--datadir', datadir, '--key', key, '--validator',
    '--rpc', `127.0.0.1:${env.rpcPort}`, '--listen', '/ip4/127.0.0.1/tcp/0', '--no-mdns',
    '--block-interval-ms', '3000', '--view-timeout-ms', '6000', '--min-free-disk-mb', '0',
  ], 'rand-node');
  await until('rand-node to answer rand_status', async () => {
    const st = await rpc(env.rpcUrl, 'rand_status');
    return st && st.fri_profile === 'test' && st.height >= 1;
  }, { timeoutMs: 60_000, everyMs: 500 });

  // The prover's key and an own-machine pairing.
  env.proverHome = join(env.dir, 'prover');
  run(PROVER_BIN, ['--home', env.proverHome, 'keygen']);
  env.link = run(PROVER_BIN, ['--home', env.proverHome, 'pair', '--name', 'laptop', '--own', '--url', env.proverUrl])
    .trim().split('\n').find((l) => l.startsWith('randprover:'));
  assert.ok(env.link, 'rand-prover pair printed a randprover: link');

  // The depositor's side: a CLI wallet with faucet RAND pays the mint's fee bundle.
  env.cliKey = join(env.dir, 'cli.key.json');
  run(CLI_BIN, ['keygen', '--key', env.cliKey]);
});

after(async () => {
  for (const child of [env.prover, env.node]) stop(child);
  await sleep(500);
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

test('the bridge is on, zUSD is listed, and the extension\'s recipient hash is the ledger\'s', { skip }, async () => {
  const state = await env.a.backend.bridge.state();
  assert.equal(state.enabled, true);
  assert.ok(state.chains.includes(SOURCE_CHAIN), `chain ${SOURCE_CHAIN} in ${JSON.stringify(state.chains)}`);
  const backing = await usdtBacking(env.rpcUrl);
  assert.ok(backing, 'zUSD backed by chain 2 USDT is in the registry');
  assert.equal(BigInt(backing.locked), 0n, 'nothing locked before the deposit');

  // What the wallet vouches for on randbridge.org (extension/shared/lib/recipient-hash.js) is what
  // the ledger matches a deposit note by.
  const ledgerRule = run(FIXTURES_BIN, ['recipient-hash', env.aInfo.address]).trim();
  assert.equal(recipientHash(env.aInfo.address), ledgerRule);
});

test('a wasm wallet cannot withdraw until a prover is paired', { skip }, async () => {
  const answer = await env.a.backend.bridge.canWithdraw();
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /Pair your own prover/);
});

test('the wasm wallet is minted zUSD, pairs its prover, and withdraws it to Ethereum', { skip, timeout: 25 * 60_000 }, async (t) => {
  const started = Date.now();
  const lap = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;
  try {
    // 1. The deposit: the test guardians attest chain 2 USDT to the wallet's recipient hash; the
    //    CLI wallet, faucet-funded, submits it — one bundle proof, the CLI's.
    run(CLI_BIN, ['--rpc', env.rpcUrl, '--key', env.cliKey, 'faucet']);
    const to = run(FIXTURES_BIN, ['recipient-hash', env.aInfo.address]).trim();
    const fixtures = join(env.dir, 'fixtures');
    run(FIXTURES_BIN, ['attest', '--to', to, '--amount', MINTED.toString(), '--sequence', '1',
      '--source-chain', String(SOURCE_CHAIN), '--token', USDT2, '--chain-id', String(CHAIN_ID), '--out-dir', fixtures]);
    const mint = run(CLI_BIN, ['--rpc', env.rpcUrl, '--key', env.cliKey, 'bridge-mint',
      `@${join(fixtures, 'attestation.hex')}`, '--pq', `@${join(fixtures, 'pq.json')}`, '--to', env.aInfo.address], { timeout: 10 * 60_000 });
    t.diagnostic(`bridge-mint at ${lap()}: ${mint.trim().split('\n').slice(-3).join(' | ')}`);
    assert.equal(BigInt((await usdtBacking(env.rpcUrl)).locked), MINTED, 'the bridge holds the deposit');

    // 2. The wallet sees the zUSD, and faucet RAND for the burn's fee.
    await env.a.backend.faucet.request();
    const funded = await until('the zUSD note and the RAND note to be spendable', async () => {
      const scan = await env.a.backend.sync.scan(() => {});
      return spendable(scan, ZUSD_INDEX).length > 0 && spendable(scan, 0).length > 0 ? scan : null;
    }, { timeoutMs: 180_000, everyMs: 2000 });
    assert.equal(sum(spendable(funded, ZUSD_INDEX)), MINTED, 'the wallet holds exactly the deposit');
    t.diagnostic(`funded at ${lap()}`);

    // 3. Pair the prover: now the wallet can withdraw — through it.
    env.prover = launch(PROVER_BIN, [
      '--home', env.proverHome, 'run', '--listen', `127.0.0.1:${env.proverPort}`,
      '--accept-spend-key', '--skip-memory-check',
    ], 'rand-prover');
    await until('rand-prover to answer prover_info', () => rpc(env.proverUrl, 'prover_info'), { timeoutMs: 30_000, everyMs: 300 });
    const paired = await env.a.backend.prover.pair(env.link, PASSWORD, { name: 'laptop' });
    assert.equal(paired.mode, 'remote');
    assert.deepEqual(await env.a.backend.bridge.canWithdraw(), { ok: true, via: 'prover' });

    // 4. The withdrawal: estimate, then burn. The proof is the prover's; everything else — the
    //    plan, the witnesses, the submission, the wait for the commit — is the engine's.
    const req = { asset: ZUSD_INDEX, amount: WITHDRAWN.toString(), relayerFee: '0', toChain: SOURCE_CHAIN, token: USDT2, to: TO_ETH };
    const estimate = await env.a.backend.bridge.estimate(req);
    assert.equal(estimate.receive, WITHDRAWN.toString());
    assert.equal(estimate.proofs, 1, 'a burn is one bundle, one proof');
    const phases = [];
    const burnStarted = Date.now();
    const out = await env.a.backend.bridge.withdraw({ ...req, fee: estimate.fee },
      (phase, detail) => phases.push(detail === undefined ? [phase] : [phase, detail]));
    t.diagnostic(`withdraw (prove + submit + commit) took ${((Date.now() - burnStarted) / 1000).toFixed(1)} s; phases ${JSON.stringify(phases.map(([p]) => p))}`);
    assert.match(out.hash, /^[0-9a-f]{64}$/);
    const names = phases.map(([p]) => p);
    assert.ok(phases.some(([p, d]) => p === 'proving' && d && d.prover === 'laptop'), `a 'proving' phase with {prover: 'laptop'}; got ${JSON.stringify(phases)}`);
    for (const p of ['selecting', 'witness', 'submitting', 'confirming']) assert.ok(names.includes(p), `phase ${p} in ${JSON.stringify(names)}`);
    assert.ok(names.indexOf('proving') < names.indexOf('submitting'), 'proved before submitted');
    assert.equal(await env.a.backend.send.pending(), null, 'nothing left pending after the burn');

    // 5. The chain has it: the transaction is committed, the bridge released the coin, and the
    //    wallet's zUSD dropped by exactly the burn.
    const tx = await rpc(env.rpcUrl, 'rand_getTransaction', [out.hash]);
    assert.ok(tx, 'the node knows the burn');
    const backing = await until('the bridge to release the burn', async () => {
      const b = await usdtBacking(env.rpcUrl);
      return b && BigInt(b.locked) === MINTED - WITHDRAWN ? b : null;
    }, { timeoutMs: 60_000, everyMs: 2000 });
    assert.equal(BigInt(backing.locked), MINTED - WITHDRAWN);
    const afterScan = await until('the wallet to see its change', async () => {
      const scan = await env.a.backend.sync.scan(() => {});
      return sum(spendable(scan, ZUSD_INDEX)) === MINTED - WITHDRAWN ? scan : null;
    }, { timeoutMs: 60_000, everyMs: 2000 });
    assert.equal(sum(spendable(afterScan, ZUSD_INDEX)), MINTED - WITHDRAWN);

    // 6. The spend key went to the prover only inside the sealed job: not one request body this
    //    wallet made — to the node or to the prover — carries it in the clear.
    assert.ok(env.a.fetch.requests.some((r) => r.url.startsWith(env.proverUrl) && r.body.includes('prover_submit')), 'the job went to the prover');
    for (const r of env.a.fetch.requests) {
      assert.equal(r.body.includes(env.spendKey), false, `the spend key is in a request to ${r.url}`);
      assert.equal(r.url.includes(env.spendKey), false, 'the spend key is in a URL');
    }
    t.diagnostic(`e2e total ${lap()}`);
  } catch (err) {
    dumpLogs(t);
    throw err;
  }
});
