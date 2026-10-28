// The wallet against a real `rand-node`: the client side of the node's JSON-RPC contract.
//
// What this file proves that the wallet's unit suites cannot: that the engine's real transport
// (`ui/engine/rpc.js`, real `fetch`), its reply validators (`ui/engine/validate.js`) and its flows
// (`ui/engine/wallet.js`, over the real wasm core) accept what a real node actually says and
// refuse what a real node actually refuses. One `rand-node` is spawned for the whole file — a
// one-validator Test-profile chain with the faucet on and 2 s blocks — and shared by the cases,
// which run in file order:
//
//   a. chain identity   the wallet's `chainIdentity` agrees with the genesis the node was cut from;
//                       a wrong chain id / genesis is refused with the wallet's own words
//   b. the contract     EVERY method in ui/lib/rpc-methods.js, called on the real node, the reply
//                       run through the wallet's validator: the empty shape, then — after a faucet
//                       mint — the populated one, then the refusals
//   c. wallet flows     keygen → faucet → scan → balance → activity → rescan from the same key →
//                       idempotent scan → anchor and witness
//   d. spend            wallet A sends to wallet B through a real `rand-prover` (needs
//                       RAND_PROVER_BIN; one real bundle proof, a couple of minutes on a laptop)
//   e. transport        failover past a dead port, a submit never repeated elsewhere, the node's own
//                       JSON-RPC error passed through with its code and message
//   f. restart          the node is stopped and started again on the same data directory; the
//                       wallet's scan continues from its cursor and its balance is unchanged
//
// Skipped, with the reason, unless both are present:
//   RAND_NODE_BIN   a `rand-node` (a fullnode release asset or a build of core/vendor/fullnode)
//   the wasm core   extension/shared/core/rand_wallet_bg.wasm (`core/scripts/build-wasm.sh`)
// and the spend case additionally needs RAND_PROVER_BIN. `scripts/e2e-node.sh` runs this file; CI
// runs it against the fullnode v0.7.1 release (.github/workflows/node-integration.yml), so nothing
// here may depend on a node feature newer than that.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { makeRpc, RpcError, RPC_METHOD_RE, SUBMIT_METHODS, isTransportFailure } from '../../../ui/engine/rpc.js';
import { METHODS, wireName } from '../../../ui/lib/rpc-methods.js';
import {
  makeWallet, emptyNoteStore, balanceOf, activity, toUnits, waitForTransaction,
} from '../../../ui/engine/wallet.js';
import {
  checkHead, checkTreeInfo, checkAnchor, checkWitness, checkCommitments, checkNullifiers, checkBlockHeaders,
  checkBlockHeader, checkBlockActions, checkTransaction, checkLimits, checkBridgeState, checkAssets,
  checkTokens, checkFee, checkGenesisHash, checkSubmitted, checkProgramCode, checkProgramPublic,
  checkProgramCell, checkProgramCells, checkProgramVault, NodeReplyError,
} from '../../../ui/engine/validate.js';
import {
  CORE_JS, CORE_WASM, realCore, wallet, freePort, rpc, until, launch, stopAndWait, running,
  chainArgs, splitAuthorisation, spendableRand,
} from './node-harness.mjs';

const NODE_BIN = process.env.RAND_NODE_BIN || '';
const PROVER_BIN = process.env.RAND_PROVER_BIN || '';
const PASSWORD = 'an-e2e-password-for-a-real-vault';
const CHAIN_ID = 21; // the chain this build's core was made for (`version.default_chain_id`)
const FAUCET_UNITS = 100_000_000_000n; // one `rand_mint`: 100 RAND
const SEND_UNITS = '2000000000'; // 2 RAND out of the faucet's 100
const ZERO32 = '00'.repeat(32);
const NODE_ENV = { ...process.env, RAND_ALLOW_TEST_FRI_PROFILE: '1' }; // a release node refuses a `test` genesis without it

const missing = [
  !NODE_BIN && 'RAND_NODE_BIN is not set',
  NODE_BIN && !existsSync(NODE_BIN) && `RAND_NODE_BIN ${NODE_BIN} does not exist`,
  !(existsSync(CORE_JS) && existsSync(CORE_WASM)) && 'the wasm core is not built (core/scripts/build-wasm.sh)',
].filter(Boolean);
const skip = missing.length ? `real-node e2e skipped: ${missing.join('; ')} — run scripts/e2e-node.sh` : false;
const proverMissing = [
  !PROVER_BIN && 'RAND_PROVER_BIN is not set',
  PROVER_BIN && !existsSync(PROVER_BIN) && `RAND_PROVER_BIN ${PROVER_BIN} does not exist`,
].filter(Boolean);
const skipSpend = skip || (proverMissing.length ? `the spend round trip needs a rand-prover: ${proverMissing.join('; ')}` : false);

// ------------------------------------------------------------------------------ the pieces ----

/** A note store in memory, the two methods `makeWallet` needs. */
function memoryStore() {
  let held = null;
  return {
    async getNoteStore() { return held ? JSON.parse(JSON.stringify(held)) : null; },
    async setNoteStore(v) { held = JSON.parse(JSON.stringify(v)); },
    peek: () => held,
  };
}

/** A wallet engine (`makeWallet`) over the real core and a real `makeRpc` client to `url`. */
function engine(url, { chainId = CHAIN_ID, genesis } = {}) {
  const store = memoryStore();
  const client = makeRpc(url, { chainId, genesis });
  const w = makeWallet({
    core: env.core, store, rpc: client, settings: async () => ({ chainId }),
  });
  return { store, client, w };
}

/** A listener that does what `behave(socket)` says with each connection, and counts them. */
function rawServer(behave) {
  return new Promise((resolve) => {
    const sockets = new Set();
    const srv = createServer((socket) => {
      srv.connections += 1;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      socket.once('data', () => { srv.requests += 1; }); // a connection that carried a request
      behave(socket);
    });
    srv.connections = 0;
    srv.requests = 0;
    srv.listen(0, '127.0.0.1', () => {
      srv.url = `http://127.0.0.1:${srv.address().port}`;
      srv.shutdown = () => new Promise((done) => { for (const s of sockets) s.destroy(); srv.close(() => done()); });
      resolve(srv);
    });
  });
}

/** A JSON-RPC forwarder to `target` that counts the requests it was given, by method. */
function forwarder(target) {
  return new Promise((resolve) => {
    const seen = [];
    const srv = createHttpServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks).toString();
      try { seen.push(JSON.parse(body).method); } catch { seen.push('?'); }
      const upstream = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
    });
    srv.seen = seen;
    srv.listen(0, '127.0.0.1', () => {
      srv.url = `http://127.0.0.1:${srv.address().port}`;
      srv.shutdown = () => new Promise((done) => { srv.closeAllConnections(); srv.close(() => done()); });
      resolve(srv);
    });
  });
}

/** Mints through the wallet's own client and waits for the block. Returns {hash, height}. */
async function mintAndWait(client, address) {
  const hash = checkSubmitted('rand_mint', await client.mint(address));
  const tx = await until(`the mint ${hash.slice(0, 8)} to be committed`, async () => checkTransaction(await client.getTransaction(hash)), { timeoutMs: 60_000, everyMs: 200 });
  return { hash, height: tx.height };
}

/** Starts `rand-node run` on the file's data directory and RPC port, and waits until it answers. */
async function startNode() {
  env.node = launch(NODE_BIN, [
    'run', '--datadir', env.datadir, '--key', env.key, '--validator',
    '--rpc', `127.0.0.1:${env.rpcPort}`, '--listen', '/ip4/127.0.0.1/tcp/0', '--no-mdns',
    '--block-interval-ms', '2000', '--view-timeout-ms', '6000', '--min-free-disk-mb', '0',
  ], 'rand-node', { env: NODE_ENV });
  await until('rand-node to answer rand_status', async () => {
    const st = await rpc(env.rpcUrl, 'rand_status');
    return st && st.fri_profile === 'test' && st.height >= 1;
  }, { timeoutMs: 60_000, everyMs: 200 });
}

// ------------------------------------------------------------------------------ the fixture ---

const env = {};

before(async () => {
  if (skip) return;
  env.dir = mkdtempSync(join(tmpdir(), 'rand-node-e2e-'));
  env.core = await realCore();
  env.rpcPort = await freePort();
  env.rpcUrl = `http://127.0.0.1:${env.rpcPort}`;

  // The two backend wallets first: A's address doubles as the validator's payout address, which
  // genesis requires and nothing here ever withdraws to. They are the spend case's A and B.
  env.a = await wallet(env.core);
  env.b = await wallet(env.core);
  env.aInfo = await env.a.backend.wallet.create(PASSWORD);
  env.bInfo = await env.b.backend.wallet.create(PASSWORD);
  env.spendKey = await env.a.backend.wallet.exportSpendKey();
  for (const w of [env.a, env.b]) await w.backend.settings.set({ rpcUrl: env.rpcUrl });

  env.key = join(env.dir, 'node.key.json');
  env.genesis = join(env.dir, 'genesis.json');
  env.datadir = join(env.dir, 'data');
  const help = execFileSync(NODE_BIN, ['genesis', '--help'], { stdio: 'pipe' }).toString();
  // A memo chain, as chains 20 and 21 are: every envelope is exactly 1860 bytes, so `rand_getLimits` names it.
  env.envelopeBytes = help.includes('--envelope-bytes') ? 1860 : null;
  execFileSync(NODE_BIN, ['keygen', '--out', env.key], { stdio: 'pipe' });
  const cut = execFileSync(NODE_BIN, [
    'genesis', '--chain-id', String(CHAIN_ID), '--fri-profile', 'test', '--faucet',
    '--validator', `${env.key},1000,${env.aInfo.address}`, '--out', env.genesis, ...chainArgs(NODE_BIN),
    ...(env.envelopeBytes ? ['--envelope-bytes', String(env.envelopeBytes)] : []),
  ], { stdio: 'pipe', env: NODE_ENV }).toString();
  // Two independent statements of the genesis hash: the one `genesis` printed when it cut the
  // file, and the one `init` printed when it opened the data directory from that file.
  env.cutHash = /genesis hash ([0-9a-f]{64})/.exec(cut)?.[1];
  const init = execFileSync(NODE_BIN, ['init', '--datadir', env.datadir, '--genesis', env.genesis], { stdio: 'pipe', env: NODE_ENV }).toString();
  env.initHash = /at genesis ([0-9a-f]{64})/.exec(init)?.[1];
  await startNode();
});

after(async () => {
  // The data directory goes only once the processes have actually exited (a SIGKILL after a
  // bounded wait), never while RocksDB may still be writing into it.
  await Promise.all([env.prover, env.node].map((child) => stopAndWait(child)));
  if (env.dir) rmSync(env.dir, { recursive: true, force: true });
});

function dumpLogs(t) {
  for (const child of [env.node, env.prover]) {
    if (child) t.diagnostic(`--- ${child.label} (last lines) ---\n${child.log.join('').split('\n').slice(-12).join('\n')}`);
  }
}

/** Runs a case body; on a failure prints the node's last log lines before rethrowing. */
const withLogs = (fn) => async (t) => {
  try { await fn(t); } catch (err) { dumpLogs(t); throw err; }
};

// ------------------------------------------------------------------------------ the cases -----

test('the e2e either runs or says why not', (t) => {
  if (skip) t.diagnostic(skip);
  else if (skipSpend) t.diagnostic(skipSpend);
});

// ---- a. chain identity ------------------------------------------------------------------------

test('a. chainIdentity() from the real client names the chain the node was cut from', { skip }, withLogs(async () => {
  assert.match(env.cutHash, /^[0-9a-f]{64}$/, 'rand-node genesis printed the genesis hash');
  assert.equal(env.initHash, env.cutHash, 'rand-node init opened the data directory at the hash genesis printed');
  const file = JSON.parse(readFileSync(env.genesis, 'utf8'));
  assert.equal(Number(file.chain_id), CHAIN_ID);

  const { w, client } = engine(env.rpcUrl);
  const identity = await w.chainIdentity(client);
  assert.deepEqual(identity, { chainId: CHAIN_ID, genesis: env.cutHash, reachable: true });
  // The same two facts, as the wire spells them.
  assert.equal(await client.chainId(), CHAIN_ID);
  assert.equal(checkGenesisHash(await client.getGenesisHash()), env.cutHash);
  // The core this wallet was built with was made for this chain id.
  assert.equal((await env.core.call('version')).default_chain_id, CHAIN_ID);
}));

test('a. a wallet configured for another chain refuses the node, and persists nothing', { skip }, withLogs(async () => {
  const wrong = engine(env.rpcUrl, { chainId: CHAIN_ID + 1 });
  const first = await wrong.w.scan('00'.repeat(32).replace(/^../, '01'), {});
  assert.deepEqual(first.wrongChain, {
    expected: { chainId: CHAIN_ID + 1, genesis: null },
    got: { chainId: CHAIN_ID, genesis: env.cutHash },
  });
  assert.equal(wrong.store.peek(), null, 'a refused scan wrote nothing');

  // A store that was built from another chain's genesis: same id, different hash.
  const real = engine(env.rpcUrl);
  const impostor = { ...emptyNoteStore(), chain_id: CHAIN_ID, genesis: 'ab'.repeat(32) };
  await real.store.setNoteStore(impostor);
  const refused = await real.w.scan('01'.repeat(32), {});
  assert.deepEqual(refused.wrongChain, {
    expected: { chainId: CHAIN_ID, genesis: 'ab'.repeat(32) },
    got: { chainId: CHAIN_ID, genesis: env.cutHash },
  });
  assert.equal(refused.scanned_index, 0);
  assert.deepEqual(real.store.peek(), impostor, 'the impostor store was left exactly as it was');
}));

test('a. a pool of endpoints on the wrong chain or genesis is refused with the wallet\'s own sentence', { skip }, withLogs(async () => {
  const [p1, p2] = await Promise.all([forwarder(env.rpcUrl), forwarder(env.rpcUrl)]);
  try {
    const wrongChain = makeRpc([p1.url, p2.url], { chainId: CHAIN_ID + 1 });
    await assert.rejects(() => wrongChain.getHead(), (err) => {
      assert.ok(err instanceof RpcError);
      assert.equal(err.code, -1);
      assert.equal(
        err.message,
        `no endpoint could answer rand_getHead; tried ${p1.url} (is on chain ${CHAIN_ID}, not ${CHAIN_ID + 1}), ${p2.url} (is on chain ${CHAIN_ID}, not ${CHAIN_ID + 1})`,
      );
      return true;
    });
    // `acquire()` never throws: it hands back the endpoint whose failure says the most, for the
    // wallet's own chain gate to refuse — here the same two facts, from the pinned client.
    const pinned = await wrongChain.acquire();
    assert.equal(pinned.pinnedTo, p1.url);
    assert.deepEqual(pinned.skipped.map((s) => s.url), [p2.url]);

    const wrongGenesis = makeRpc([p1.url, p2.url], { chainId: CHAIN_ID, genesis: 'cd'.repeat(32) });
    await assert.rejects(() => wrongGenesis.getHead(), (err) => {
      assert.match(err.message, new RegExp(`^no endpoint could answer rand_getHead; tried ${p1.url} \\(has a different genesis hash\\), ${p2.url} \\(has a different genesis hash\\)$`));
      return true;
    });
    // And the right expectation passes through either endpoint.
    const right = makeRpc([p1.url, p2.url], { chainId: CHAIN_ID, genesis: env.cutHash });
    assert.ok(checkHead(await right.getHead()).height >= 1);
  } finally {
    await Promise.all([p1.shutdown(), p2.shutdown()]);
  }
}));

// ---- b. the client-side contract --------------------------------------------------------------

/** Every `'rand_…'`/`"rand_…"` string literal the wallet's own code puts on the wire. */
function wireNamesInSource() {
  const root = new URL('../../../', import.meta.url).pathname;
  const names = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'test', 'vendor', 'rpc-methods.js'].includes(entry.name)) continue; // the table itself only names things in prose
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(js|mjs)$/.test(entry.name)) {
        for (const m of readFileSync(path, 'utf8').matchAll(/['"`](rand_[A-Za-z0-9]+)['"`]/g)) names.add(m[1]);
      }
    }
  };
  walk(join(root, 'ui'));
  walk(join(root, 'extension/shared'));
  return names;
}

/** The methods the contract cases below exercise on the real node, filled in as they run. */
const CONTRACT_METHODS = new Set();

/**
 * Whether the node serves the seven reads fullnode v0.8.0 added (getRandPrice, getScanLeaves,
 * getPerps, getPerpAccount, getPerpAccounts, getPerpInputs, getMultisig). The release this suite
 * runs against in CI (v0.7.1) answers each with -32601; a v0.8.0-candidate answers. Decided once,
 * by `rand_getRandPrice`; every method then has exactly one acceptable outcome, never "either".
 */
async function servesV08Reads(client) {
  if (env.v08 !== undefined) return env.v08;
  try {
    await client.rpc('rand_getRandPrice', []);
    env.v08 = true;
  } catch (err) {
    assert.ok(err instanceof RpcError && err.code === -32601 && err.message === 'unknown method rand_getRandPrice', `an older node refuses by name, got ${err && err.message}`);
    env.v08 = false;
  }
  return env.v08;
}

test('b. before any note: the empty shapes of every read the wallet makes', { skip }, withLogs(async () => {
  const client = makeRpc(env.rpcUrl, { chainId: CHAIN_ID, genesis: env.cutHash });
  const call = async (name, ...args) => { CONTRACT_METHODS.add(name); return client[name](...args); };

  // Identity and node info.
  assert.equal(await call('chainId'), CHAIN_ID);
  assert.equal(checkGenesisHash(await call('getGenesisHash')), env.cutHash);
  const status = await call('status');
  assert.equal(status.fri_profile, 'test');
  assert.equal(status.faucet, true);
  assert.equal(status.binding_domain, 1);
  assert.match(status.hc_bundle, /^[0-9a-f]{64}$/);
  assert.ok(Number.isSafeInteger(status.height) && status.height >= 1);
  const alias = await client.rpc('rand_syncStatus', []);
  for (const key of ['fri_profile', 'hc_bundle', 'hc_auth', 'faucet', 'address']) assert.deepEqual(alias[key], status[key], `rand_syncStatus.${key}`);
  assert.deepEqual(await call('tokenInfo'), { decimals: 9, symbol: 'RAND' });
  assert.equal((await call('getVersion')).chain_id, CHAIN_ID);
  assert.deepEqual(await call('getHealth'), { status: 'ok' });
  const head = checkHead(await call('getHead'));
  assert.ok(head.height >= 1);
  assert.match(head.hash, /^[0-9a-f]{64}$/);
  assert.equal((await call('getEpoch')).epoch, 0);
  assert.equal((await call('getValidators')).length, 1);
  assert.deepEqual(await call('getPeers'), []);
  assert.equal((await call('getSupply')).invariant_holds, true);
  assert.equal((await call('getMempoolInfo')).count, 0);
  assert.equal((await call('getEmission')).faucet, true);

  // The limits the wallet seals and proves to.
  const limits = checkLimits(await call('getLimits'));
  assert.equal(limits.envelopeBytes, env.envelopeBytes);
  if (env.envelopeBytes) assert.ok(limits.envelopeBytes > 0);
  assert.equal(limits.bundleGasLimit, 20479);
  assert.equal(limits.programState, null);
  if (splitAuthorisation(NODE_BIN)) assert.equal(limits.maxProofBytes, 4194304);
  // The fee is a decimal string, and the node and the core agree on what a bundle costs.
  const fee = checkFee(await call('estimateFee', { kind: 'bundle' }));
  assert.match(fee, /^[0-9]+$/);
  assert.equal(typeof fee, 'string');
  assert.equal(fee, (await env.core.call('version')).bundle_base_fee);

  // The tree, empty.
  const info = checkTreeInfo(await call('getTreeInfo'));
  assert.equal(info.next_index, 0);
  assert.equal(info.nullifiers, 0);
  const anchor = checkAnchor(await call('getAnchor'));
  assert.equal(anchor.root, info.root);
  assert.deepEqual(checkCommitments(await call('getCommitments', 0, 10), { from: 0, limit: 10, leafCount: 0 }), []);
  assert.deepEqual(checkNullifiers(await call('getNullifiers', 0, 10), { from: 0, limit: 10, tip: head.height }), []);
  assert.equal(checkWitness(await call('getWitness', 0)), null, 'no leaf 0 yet');
  const witnesses = await call('getWitnesses', [0, 1]);
  assert.equal(witnesses.root, info.root);
  assert.deepEqual(witnesses.witnesses, [{ index: 0, path: null }, { index: 1, path: null }]);

  // Blocks: a contiguous run from the start, genesis first.
  const headers = checkBlockHeaders(await call('getBlocks', 0, head.height), { from: 0, to: head.height });
  assert.equal(headers[0].height, 0);
  assert.ok(headers.length >= 2);
  assert.ok(headers.every((h) => h.tx_count === 0));
  const block1 = checkBlockHeader(await call('getBlockByHeight', 1));
  assert.deepEqual(block1.transactions, []);
  assert.ok(block1.timestamp_ms > 0);
  assert.deepEqual(checkBlockActions(await call('getBlockByHeight', 1)), []);
  assert.equal(await call('getBlockByHeight', 999_999), null, 'an unknown height is null');
  assert.equal(checkBlockHeader(null), null);
  assert.deepEqual(checkBlockActions(null), []);
  assert.equal(await call('getBlockByHash', ZERO32), null);
  assert.equal((await call('getFinality', 1)).status, 'committed');
  assert.equal((await call('getProposer', 1)).proposers.length, 1);
  assert.deepEqual((await call('getCompactBlocks', 0, 1)).map((b) => b.height), [0, 1]);

  // Transactions that do not exist.
  assert.equal(checkTransaction(await call('getTransaction', ZERO32)), null);
  assert.equal(await call('getRawTransaction', ZERO32), null);
  assert.equal(await call('getReceipt', ZERO32), null);
  assert.deepEqual(await call('getReceipts', ZERO32, 0, 10), { next_height: null, receipts: [] });
  assert.equal(await call('getCallEnvelope', ZERO32), null);
  assert.deepEqual(await call('getTransactionStatus', [ZERO32]), [{ hash: ZERO32, status: 'unknown' }]);
  assert.equal(await call('checkTransaction', ZERO32, ZERO32), null);

  // A chain with no bridge, no token registry, no programs, no vesting, no aggregation.
  assert.deepEqual(checkBridgeState(await call('getBridgeState')), { enabled: false, chains: [], assets: [], mintPaused: false, fees: null });
  assert.deepEqual(checkAssets(await call('getAssets')), []);
  const tokens = checkTokens(await call('getTokens', 0, 1000), { from: 0 });
  assert.deepEqual(tokens, { enabled: false, next_index: 0, registration_fee: '0', tokens: [] });
  assert.equal(await call('getToken', 1), null);
  assert.equal(await call('getTokenSupply', 1), null);
  assert.equal(await call('getBridgeBurn', 0), null);
  assert.match(await call('bridgeAssetId', 1, ZERO32), /^[0-9a-f]{64}$/);
  assert.equal(await call('getProgram', ZERO32), null);
  assert.equal(checkProgramCode(await call('getProgramCode', ZERO32)), null);
  assert.equal(checkProgramPublic(await call('getProgramPublic', ZERO32)), null);
  assert.equal(checkProgramCell(await call('getProgramCell', ZERO32, ZERO32), ZERO32), null, 'no program_state section');
  assert.equal(checkProgramCells(await call('getProgramCells', ZERO32, { after: null, limit: 10 })), null);
  assert.equal(checkProgramVault(await call('getProgramVault', ZERO32)), null);
  for (const name of ['getVesting', 'getVestingSummary', 'getVestingSchedule']) {
    const args = { getVesting: [ZERO32], getVestingSummary: [], getVestingSchedule: [0, 1000, 100] }[name];
    assert.deepEqual(await call(name, ...args), { enabled: false }, name);
  }
  assert.deepEqual(await call('getAggregators'), []);
  assert.equal(await call('getAggregate', ZERO32), null);
  assert.deepEqual(await call('getUnsealed', 0, 10), { bundles: [], next_from: null });
  assert.equal((await call('getAdmitted')).admission_by_vote, false);

  // The reads fullnode v0.8.0 added: served with exact shapes there, refused by name on v0.7.1.
  const NEW = ['getRandPrice', 'getScanLeaves', 'getPerps', 'getPerpAccount', 'getPerpAccounts', 'getPerpInputs', 'getMultisig'];
  const newArgs = {
    getRandPrice: [], getScanLeaves: [0, 10], getPerps: [], getPerpAccount: [ZERO32],
    getPerpAccounts: [{ after: null, limit: 10 }], getPerpInputs: [1], getMultisig: [ZERO32],
  };
  if (await servesV08Reads(client)) {
    assert.equal(await call('getRandPrice'), null, 'no usd_subsidy section: no voted price');
    assert.deepEqual(await call('getScanLeaves', 0, 10), []);
    assert.deepEqual(await call('getScanLeaves', 100, 10), []);
    assert.deepEqual(await call('getPerps'), { enabled: false });
    assert.equal(await call('getPerpAccount', ZERO32), null);
    assert.deepEqual(await call('getPerpAccounts', { after: null, limit: 10 }), { accounts: [], next: null });
    assert.equal(await call('getPerpInputs', 1), null);
    assert.equal(await call('getPerpInputs', 999_999), null);
    assert.deepEqual(await call('getMultisig', ZERO32), { enabled: false });
  } else {
    for (const name of NEW) {
      await assert.rejects(() => call(name, ...newArgs[name]), (err) => {
        assert.ok(err instanceof RpcError);
        assert.equal(err.code, -32601);
        assert.equal(err.message, `unknown method ${wireName(name)}`);
        return true;
      }, name);
    }
  }

  // The node-held viewing-key facility (loopback only, which this test is).
  assert.deepEqual(await call('importViewingKey', ZERO32), { imported: true, rescan_from_height: 0, viewing_keys: 1 });
  assert.deepEqual(await call('getViewingNotes', ZERO32), { complete: true, next_index: 0, notes: [], scanned_index: 0 });
  assert.deepEqual(await call('removeViewingKey', ZERO32), { removed: true, viewing_keys: 0 });
}));

test('b. after a faucet mint: the populated shapes, exact values, and the validators accept them', { skip }, withLogs(async () => {
  const client = makeRpc(env.rpcUrl, { chainId: CHAIN_ID, genesis: env.cutHash });
  const call = async (name, ...args) => { CONTRACT_METHODS.add(name); return client[name](...args); };
  const key = await env.core.call('keygen');

  const before = checkTreeInfo(await call('getTreeInfo'));
  assert.equal(before.next_index, 0, 'a fresh chain: this is the first mint');
  const { hash, height } = await mintAndWait(client, key.address);

  // The transaction, as the wallet's validator reads it, and as the node renders it.
  assert.deepEqual(checkTransaction(await call('getTransaction', hash)), { height });
  const record = await call('getTransaction', hash);
  assert.equal(record.tx.hash, hash);
  assert.equal(record.tx.chain_id, CHAIN_ID);
  assert.equal(record.tx.action.kind, 'mint');
  assert.equal(record.tx.action.amount, FAUCET_UNITS.toString());
  const status = (await call('getTransactionStatus', [hash]))[0];
  assert.equal(status.hash, hash);
  assert.equal(status.status, 'committed');
  assert.equal(status.height, height);
  assert.ok(await call('getRawTransaction', hash), 'the raw bytes of a committed transaction');

  // The tree grew by exactly the one leaf the mint made.
  const info = checkTreeInfo(await call('getTreeInfo'));
  assert.equal(info.next_index, 1);
  assert.notEqual(info.root, before.root);
  const anchor = checkAnchor(await call('getAnchor'));
  assert.equal(anchor.root, info.root);
  assert.ok(anchor.height >= height);

  // The leaf: the commitment the transaction named, at the height it was committed, with an
  // envelope the wallet's size limits accept — and exactly the size the chain declared.
  const rows = checkCommitments(await call('getCommitments', 0, 10), { from: 0, limit: 10, leafCount: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].index, 0);
  assert.equal(rows[0].cm, record.tx.action.cm);
  assert.equal(rows[0].height, height);
  if (env.envelopeBytes) {
    const e = rows[0].envelope;
    assert.equal((e.kem_ct.length + e.to_receiver.length + e.to_sender.length + e.body.length) / 2, env.envelopeBytes);
  }
  assert.deepEqual(checkCommitments(await call('getCommitments', 1, 10), { from: 1, limit: 10, leafCount: 1 }), []);
  // …and checkCommitments refuses what the real page is not: asked from 1, answered from 0.
  assert.throws(() => checkCommitments(rows, { from: 1, limit: 10 }), (err) => err instanceof NodeReplyError && /starts at leaf 0, not the 1 it was asked for/.test(err.message));
  assert.throws(() => checkCommitments(rows, { from: 0, limit: 10, leafCount: 0 }), (err) => err instanceof NodeReplyError && /past the 0 leaves the tree reports/.test(err.message));

  // v0.8.0's compact scan page: the same leaf, with the scan blob a wallet trial-decrypts.
  if (await servesV08Reads(client)) {
    const leaves = await call('getScanLeaves', 0, 10);
    assert.equal(leaves.length, 1);
    assert.deepEqual({ cm: leaves[0].cm, height: leaves[0].height, index: leaves[0].index }, { cm: rows[0].cm, height, index: 0 });
    assert.ok(typeof leaves[0].scan === 'string' && leaves[0].scan.length > 0);
    assert.deepEqual(await call('getScanLeaves', 1, 10), []);
  }

  // The witness: 32 levels, rooted at the anchor; leaf 1 does not exist.
  const witness = checkWitness(await call('getWitness', 0));
  assert.equal(witness.index, 0);
  assert.equal(witness.root, anchor.root);
  assert.equal(witness.path.length, 32);
  assert.equal(checkWitness(await call('getWitness', 1)), null);
  const batch = await call('getWitnesses', [0, 1]);
  assert.equal(batch.witnesses[0].index, 0);
  assert.deepEqual(batch.witnesses[0].path, witness.path);
  assert.equal(batch.witnesses[1].path, null);

  // The block that carried it.
  const headers = checkBlockHeaders(await call('getBlocks', height, height), { from: height, to: height });
  assert.deepEqual(headers, [{ height, tx_count: 1 }]);
  const header = checkBlockHeader(await call('getBlockByHeight', height));
  assert.deepEqual(header.transactions, [{ hash, commitments: [] }], 'a mint has no bundle, so the header lists no commitments');
  const actions = checkBlockActions(await call('getBlockByHeight', height));
  assert.deepEqual(actions.map((a) => a.kind), ['mint']);
  assert.equal(actions[0].amount, FAUCET_UNITS.toString());
  assert.equal(checkNullifiers(await call('getNullifiers', 0, 10), { from: 0, limit: 10, tip: (await call('getHead')).height }).length, 0);
  const supply = await call('getSupply');
  assert.equal(supply.faucet_minted, FAUCET_UNITS.toString());
  assert.equal(supply.invariant_holds, true);
  assert.deepEqual(await call('getFinality', height).then((f) => ({ height: f.height, status: f.status })), { height, status: 'committed' });
}));

test('b. the refusals: the node\'s own JSON-RPC errors reach the wallet with their code and message', { skip }, withLogs(async () => {
  const client = makeRpc(env.rpcUrl);
  for (const name of ['sendTransaction', 'mint']) CONTRACT_METHODS.add(name); // refused below, accepted by the mint above
  const refused = async (run, code, message) => {
    await assert.rejects(run, (err) => {
      assert.ok(err instanceof RpcError, `an RpcError, got ${err && err.constructor && err.constructor.name}`);
      assert.equal(err.code, code);
      assert.match(err.message, message);
      assert.equal(isTransportFailure(err), false, 'the node answered');
      assert.equal(err.failure, undefined);
      return true;
    });
  };
  await refused(() => client.getTransaction('zz'), -32602, /^hash: invalid hex encoding$/);
  await refused(() => client.getVesting('x'), -32602, /^id: 64 hex characters$/);
  await refused(() => client.getBlocks(5, 2), -32602, /^to_height 2 is below from_height 5$/);
  await refused(() => client.estimateFee(), -32602, /^missing param spec$/);
  await refused(() => client.estimateFee({ kind: 'bundle2' }), -32602, /^kind must be bundle, deploy, call or invoke$/);
  await refused(() => client.sendTransaction('zz'), -32602, /^tx must be hex$/);
  await refused(() => client.sendTransaction('00'), -32602, /^tx decode: io error: unexpected end of file$/);
  await refused(() => client.sendTransaction(), -32602, /^missing param tx$/);
  await refused(() => client.mint('not-an-address'), -32602, /./);
  await refused(() => client.getProgramCells(ZERO32, 10), -32602, /^the second param is an object: \{"after": key \| null, "limit": n\}$/);
  // The pre-account-removal names are refused by name, and unknown names by the same code.
  for (const old of ['rand_getBalance', 'rand_getAccount', 'rand_getAssetBalance', 'rand_doesNotExist']) {
    await refused(() => client.rpc(old, []), -32601, new RegExp(`^unknown method ${old}$`));
  }
  // The wallet refuses to put anything that is not the node's namespace on the wire, without a request.
  const probe = await forwarder(env.rpcUrl);
  try {
    const guarded = makeRpc(probe.url);
    for (const bad of ['eth_blockNumber', 'rand_', 'rand_get Head', 'RAND_getHead']) {
      await refused(() => guarded.rpc(bad, []), -32601, new RegExp(`^${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not allowed from this wallet$`));
    }
    assert.deepEqual(probe.seen, [], 'nothing reached the node');
  } finally {
    await probe.shutdown();
  }
  // The validators refuse what a node must never say, in the wallet's words.
  assert.throws(() => checkSubmitted('rand_mint', 'nope'), (err) => err instanceof NodeReplyError && /^rand_mint: the transaction hash is not a transaction hash \(nope\)$/.test(err.message));
  assert.throws(() => checkFee(12.5), (err) => err instanceof NodeReplyError);
}));

test('b. every method name the wallet can put on the wire is allowed, and each has a case above', { skip }, () => {
  const table = Object.keys(METHODS);
  assert.ok(table.length >= 51, 'the table covers every method the node dispatches');
  for (const name of table) assert.match(wireName(name), RPC_METHOD_RE, name);
  for (const name of SUBMIT_METHODS) assert.match(name, RPC_METHOD_RE);
  const wire = new Set(table.map(wireName));
  // Every literal in the wallet's source is a table method or the node's `rand_status` alias.
  for (const literal of wireNamesInSource()) {
    assert.ok(wire.has(literal) || literal === 'rand_syncStatus', `${literal} is used in the wallet's source but not in ui/lib/rpc-methods.js`);
  }
  // …and the contract cases below call every one of them.
  for (const name of table) assert.ok(CONTRACT_METHODS.has(name), `${name} has no contract case in this file`);
});

// ---- c. the wallet's flows over the real core -------------------------------------------------

/**
 * Wallet C: a fresh key funded by one faucet mint and scanned. Every case that needs it calls this;
 * the first caller sets it up and the rest reuse it, so each case also runs alone
 * (`--test-name-pattern`). What a case may assume about it is asserted at the top of that case.
 */
async function ensureC() {
  if (env.c) return env.c;
  const key = await env.core.call('keygen');
  const one = engine(env.rpcUrl, { genesis: env.cutHash });
  env.c = { key, ...one };
  env.c.hash = await one.w.faucet(key.spend_key, key.address);
  env.c.height = checkTransaction(await one.client.getTransaction(env.c.hash)).height;
  return env.c;
}

test('c. keygen → faucet → scan → balance → activity, then a second wallet rescans the same key to the same notes', { skip }, withLogs(async () => {
  const key = await env.core.call('keygen');
  assert.match(key.address, /^rand1/);
  const one = engine(env.rpcUrl, { genesis: env.cutHash });
  env.c = { key, ...one };

  const treeBefore = checkTreeInfo(await one.client.getTreeInfo());
  const head0 = checkHead(await one.client.getHead()).height;
  // Before any mint: a first scan adopts the node's identity, and finds nothing.
  const empty = await one.w.scan(key.spend_key, {});
  assert.deepEqual(empty.notes, []);
  assert.equal(empty.chain_id, CHAIN_ID);
  assert.equal(empty.genesis, env.cutHash);
  assert.equal(balanceOf(empty), 0n);
  assert.ok(empty.head >= head0);

  // The faucet, through the wallet's own flow: mint, wait for the block, scan.
  const hash = await one.w.faucet(key.spend_key, key.address);
  assert.match(hash, /^[0-9a-f]{64}$/);
  const tx = checkTransaction(await one.client.getTransaction(hash));
  const store = await one.w.loadStore();
  env.c.hash = hash;
  env.c.height = tx.height;

  const unspent = store.notes.filter((n) => !n.spent);
  assert.equal(unspent.length, 1, 'exactly one note came out of one mint');
  const note = unspent[0];
  assert.equal(note.index, treeBefore.next_index, 'the leaf the mint appended');
  assert.equal(note.amount, FAUCET_UNITS.toString());
  assert.equal(Number(note.asset), 0);
  assert.equal(note.height, tx.height);
  assert.equal(balanceOf(store), FAUCET_UNITS, 'the balance is exactly the minted amount');
  assert.equal(one.w.balanceOf(store), FAUCET_UNITS);
  assert.equal(store.scanned_index, treeBefore.next_index + 1);
  assert.equal(store.chain_id, CHAIN_ID);

  // The activity list: the mint, once as a received note at its height and once as the faucet
  // submission that asked for it (the submission is committed and names the hash).
  const rows = activity(store);
  const received = rows.filter((r) => r.kind === 'received');
  assert.equal(received.length, 1);
  assert.equal(received[0].height, tx.height);
  assert.equal(received[0].amount, FAUCET_UNITS.toString());
  assert.equal(received[0].index, note.index);
  assert.equal(received[0].spent, false);
  const faucetRow = rows.find((r) => r.kind === 'faucet');
  assert.equal(faucetRow.hash, hash);
  assert.equal(faucetRow.status, 'committed');
  assert.equal(faucetRow.amount, FAUCET_UNITS.toString());
  assert.equal(rows.length, 2);
  // The scan also learned the block's clock and the note's transaction (annotateBlocks).
  assert.ok(store.block_times[String(tx.height)] > 0, 'the block time was recorded');

  // A second wallet importing the same spend key sees the same chain's notes after a rescan.
  const two = engine(env.rpcUrl, { genesis: env.cutHash });
  const rescanned = await two.w.rescan(key.spend_key, {});
  assert.equal(balanceOf(rescanned), FAUCET_UNITS);
  const shape = (s) => s.notes.map((n) => ({ index: n.index, amount: n.amount, asset: Number(n.asset), height: n.height, spent: !!n.spent, nf: n.nf }));
  assert.deepEqual(shape(rescanned), shape(store));
  assert.equal(rescanned.scanned_index, store.scanned_index);
  assert.equal(rescanned.chain_id, CHAIN_ID);
  assert.equal(rescanned.genesis, env.cutHash);
  // …and a rescan of the first wallet changes nothing it had found.
  const again = await one.w.rescan(key.spend_key, {});
  assert.deepEqual(shape(again), shape(store));
  assert.equal(again.reset_epoch, store.reset_epoch + 1, 'a rescan bumps the reset epoch');
  // Another key sees none of it.
  const other = await env.core.call('keygen');
  const stranger = engine(env.rpcUrl, { genesis: env.cutHash });
  assert.deepEqual((await stranger.w.scan(other.spend_key, {})).notes, []);
}));

test('c. a second scan adds nothing: the cursors and the notes are where the first left them', { skip }, withLogs(async () => {
  const { w, store, key } = await ensureC();
  const first = await w.loadStore();
  const second = await w.scan(key.spend_key, {});
  const strip = (s) => ({ ...s, last_sync_ms: 0, head: 0, rev: undefined });
  assert.deepEqual(strip(second), strip(first));
  assert.deepEqual(strip(store.peek()), strip(first));
  // Mint again: the next scan adds exactly the new note and moves the cursor by exactly one.
  const hash2 = await w.faucet(key.spend_key, key.address);
  const third = await w.loadStore();
  assert.equal(third.notes.length, first.notes.length + 1);
  assert.equal(third.scanned_index, first.scanned_index + 1);
  assert.equal(balanceOf(third), balanceOf(first) + FAUCET_UNITS);
  assert.equal(third.notes.filter((n) => n.index === first.notes[0].index).length, 1, 'the first note is not duplicated');
  assert.deepEqual(third.notes.slice(0, first.notes.length), first.notes);
  assert.ok(third.submissions.some((s) => s.hash === hash2 && s.status === 'committed'));
}));

test('c. anchorAndWitnesses returns witnesses rooted at rand_getAnchor\'s root, and refuses a leaf that is not there', { skip }, withLogs(async () => {
  const { w, client, key } = await ensureC();
  const store = await w.loadStore();
  const chosen = store.notes.filter((n) => !n.spent);
  assert.ok(chosen.length >= 1, 'wallet C holds at least its faucet note');
  const { anchor, paths } = await w.anchorAndWitnesses(client, chosen);
  const wire = await rpc(env.rpcUrl, 'rand_getAnchor');
  assert.equal(anchor.root, wire.root);
  assert.equal(anchor.root, (await rpc(env.rpcUrl, 'rand_getTreeInfo')).root);
  assert.equal(paths.length, chosen.length);
  for (const [i, n] of chosen.entries()) {
    const raw = await rpc(env.rpcUrl, 'rand_getWitness', [n.index]);
    assert.equal(raw.root, anchor.root, `the witness for leaf ${n.index} is rooted at the anchor`);
    assert.deepEqual(paths[i], raw.path);
    assert.equal(paths[i].length, 32);
  }
  await assert.rejects(() => w.anchorAndWitnesses(client, [{ index: 10_000 }]), /^Error: no leaf at index 10000$/);
  assert.ok(key.spend_key);
}));

// ---- d. a spend through a real prover ---------------------------------------------------------

test('d. A sends to B through a real rand-prover: balances move by amount + fee exactly, B sees the note, a replay is refused', { skip: skipSpend, timeout: 20 * 60_000 }, async (t) => {
  try {
    const started = Date.now();
    const v3 = splitAuthorisation(NODE_BIN);
    env.proverPort = await freePort();
    env.proverUrl = `http://127.0.0.1:${env.proverPort}`;
    env.proverHome = join(env.dir, 'prover');
    execFileSync(PROVER_BIN, ['--home', env.proverHome, 'keygen'], { stdio: 'pipe' });
    const link = execFileSync(PROVER_BIN, [
      '--home', env.proverHome, 'pair', '--name', 'laptop', ...(v3 ? [] : ['--own']), '--url', env.proverUrl,
    ], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim().split('\n').find((l) => l.startsWith('randprover:'));
    assert.ok(link, 'rand-prover pair printed a randprover: link');
    env.prover = launch(PROVER_BIN, [
      '--home', env.proverHome, 'run', '--listen', `127.0.0.1:${env.proverPort}`,
      ...(v3 ? [] : ['--accept-spend-key']), '--skip-memory-check',
    ], 'rand-prover');
    await until('rand-prover to answer prover_info', () => rpc(env.proverUrl, 'prover_info'), { timeoutMs: 60_000, everyMs: 200 });
    const paired = await env.a.backend.prover.pair(link, PASSWORD, { name: 'laptop' });
    assert.equal(paired.mode, 'remote');

    // A is funded by the faucet; its note is the only one it has.
    await env.a.backend.faucet.request();
    const funded = await until('the faucet note to be spendable', async () => {
      const scan = await env.a.backend.sync.scan(() => {});
      return spendableRand(scan).length > 0 ? scan : null;
    }, { timeoutMs: 300_000, everyMs: 500 });
    const fundedUnits = spendableRand(funded).reduce((a, n) => a + toUnits(n.amount), 0n);
    assert.equal(fundedUnits, FAUCET_UNITS);
    const bScanBefore = await env.b.backend.sync.scan(() => {});
    assert.deepEqual(bScanBefore.notes, []);

    // The send, through the prover.
    const fee = BigInt(checkFee(await rpc(env.rpcUrl, 'rand_estimateFee', [{ kind: 'bundle' }])));
    const out = await env.a.backend.send.send({ asset: 0, to: env.bInfo.address, amount: SEND_UNITS }, () => {});
    t.diagnostic(`send (prove + submit + commit) took ${((Date.now() - started) / 1000).toFixed(1)} s`);
    assert.match(out.hash, /^[0-9a-f]{64}$/);
    const committed = checkTransaction(await rpc(env.rpcUrl, 'rand_getTransaction', [out.hash]));
    assert.ok(committed.height > 0);

    // A: the spent note's nullifier is on chain and the scan sees it; what is left is exactly the
    // change — the faucet amount less what was sent less the fee.
    const aScan = await until('A to see its nullifier', async () => {
      const scan = await env.a.backend.sync.scan(() => {});
      return (scan.notes || []).some((n) => n.spent) ? scan : null;
    }, { timeoutMs: 240_000, everyMs: 500 });
    const spentNotes = aScan.notes.filter((n) => n.spent);
    assert.equal(spentNotes.length, 1);
    assert.equal(spentNotes[0].amount, FAUCET_UNITS.toString());
    // The transaction's bundle, as the node renders it: four nullifiers (dummies included), all
    // published at the commit height; the fee it paid is the one the wallet was quoted; and on a
    // split-authorisation chain the auth proof rides beside the bundle proof.
    const bundle = (await rpc(env.rpcUrl, 'rand_getTransaction', [out.hash])).tx.bundle;
    assert.equal(bundle.nullifiers.length, 4);
    assert.equal(bundle.fee, fee.toString());
    if (v3) assert.ok(Number(bundle.auth_proof_bytes) > 0, 'an auth proof beside the bundle proof');
    const onChain = await rpc(env.rpcUrl, 'rand_getNullifiers', [0, 100]);
    assert.deepEqual(
      onChain.filter((r) => bundle.nullifiers.includes(r.nullifier)).map((r) => r.height),
      [committed.height, committed.height, committed.height, committed.height],
      'the bundle\'s nullifiers are published at the height the transaction committed',
    );
    // The block header lists the bundle's commitments, which is how a scan dates and links notes.
    const header = checkBlockHeader(await rpc(env.rpcUrl, 'rand_getBlockByHeight', [committed.height]));
    assert.deepEqual(header.transactions.find((x) => x.hash === out.hash).commitments, bundle.commitments);
    const aUnits = spendableRand(aScan).reduce((a, n) => a + toUnits(n.amount), 0n);
    assert.equal(aUnits, FAUCET_UNITS - BigInt(SEND_UNITS) - fee, 'A holds exactly its change');
    assert.equal(await env.a.backend.send.pending(), null);

    // B: the payment, exactly.
    const bScan = await until('B to see the payment', async () => {
      const scan = await env.b.backend.sync.scan(() => {});
      return (scan.notes || []).some((n) => String(n.amount) === SEND_UNITS) ? scan : null;
    }, { timeoutMs: 240_000, everyMs: 500 });
    const received = bScan.notes.filter((n) => toUnits(n.amount) > 0n);
    assert.equal(received.length, 1);
    assert.equal(String(received[0].amount), SEND_UNITS);
    assert.equal(received[0].spent, false);

    // A replay of the very bundle the wallet sent: the node refuses it, and the wallet surfaces the
    // node's own refusal as an RpcError carrying the node's code and message.
    const sent = env.a.fetch.requests
      .map((r) => { try { return JSON.parse(r.body); } catch { return null; } })
      .filter((b) => b && b.method === 'rand_sendTransaction');
    assert.equal(sent.length, 1, 'the wallet submitted exactly once');
    const direct = makeRpc(env.rpcUrl);
    await assert.rejects(() => direct.sendTransaction(sent[0].params[0]), (err) => {
      assert.ok(err instanceof RpcError);
      assert.equal(isTransportFailure(err), false);
      assert.equal(err.code, -32000);
      assert.equal(err.message, 'nullifier already spent');
      return true;
    });
    // …and the chain did not move: still one commit of that transaction, B still holds one note.
    assert.equal(checkTransaction(await rpc(env.rpcUrl, 'rand_getTransaction', [out.hash])).height, committed.height);
    assert.equal((await env.b.backend.sync.scan(() => {})).notes.filter((n) => toUnits(n.amount) > 0n).length, 1);
    env.d = { aUnits, committedHeight: committed.height };
  } catch (err) {
    dumpLogs(t);
    throw err;
  }
});

// ---- e. transport behaviour against a real node -----------------------------------------------

test('e. a dead port first: reads fail over to the live node, and the pool remembers', { skip }, withLogs(async () => {
  const dead = await freePort(); // nothing listens: connection refused
  const deadUrl = `http://127.0.0.1:${dead}`;
  const pool = makeRpc([deadUrl, env.rpcUrl], { timeoutMs: 5000 });
  assert.equal(pool.url, deadUrl);
  assert.equal(checkHead(await pool.getHead()).height >= 1, true);
  assert.equal(pool.url, env.rpcUrl, 'the pool moved to the endpoint that answered');
  assert.deepEqual(pool.endpoints().map((e) => [e.url, e.state]), [[deadUrl, 'down'], [env.rpcUrl, 'unknown']].map(([u, s]) => [u, s === 'unknown' ? 'unknown' : s]));
  assert.match(pool.endpoints()[0].reason, new RegExp(`^cannot reach ${deadUrl}: `));
  // Several reads in a row, every one answered.
  assert.equal(await pool.chainId(), CHAIN_ID);
  assert.equal(checkGenesisHash(await pool.getGenesisHash()), env.cutHash);
  // The same pool, expecting the right chain, probes the dead endpoint, steps over it, and the
  // pinned client a new operation acquires is the live one, with the dead one named.
  const gated = makeRpc([deadUrl, env.rpcUrl], { chainId: CHAIN_ID, genesis: env.cutHash, timeoutMs: 5000 });
  const pinned = await gated.acquire();
  assert.equal(pinned.url, env.rpcUrl);
  assert.deepEqual(pinned.skipped.map((s) => s.url), [deadUrl]);
  assert.equal(await pinned.chainId(), CHAIN_ID);
  // A pinned client never fails over: on the dead endpoint a read just fails, as a connect failure.
  const stuck = makeRpc([deadUrl, env.rpcUrl], { timeoutMs: 5000 }).pinned();
  await assert.rejects(() => stuck.getHead(), (err) => {
    assert.ok(err instanceof RpcError);
    assert.equal(err.failure, 'connect');
    assert.equal(err.code, -1);
    assert.match(err.message, new RegExp(`^cannot reach ${deadUrl}: `));
    return true;
  });
  // A listener that hangs up on every connection: the read is answered by the live node.
  const closer = await rawServer((socket) => socket.destroy());
  try {
    const hangup = makeRpc([closer.url, env.rpcUrl], { timeoutMs: 5000 });
    assert.ok(checkHead(await hangup.getHead()).height >= 1);
    assert.ok(closer.connections >= 1, 'the closing listener was tried first');
  } finally {
    await closer.shutdown();
  }
}));

test('e. a submit that timed out is never repeated on another endpoint', { skip }, withLogs(async () => {
  // A listener that accepts and never answers: whatever was sent may have been acted on.
  const mute = await rawServer(() => {});
  const live = await forwarder(env.rpcUrl);
  try {
    const pool = makeRpc([mute.url, live.url], { timeoutMs: 2000 });
    const before = checkTreeInfo(await rpc(env.rpcUrl, 'rand_getTreeInfo')).next_index;
    for (const [name, args] of [['sendTransaction', ['00']], ['mint', [(await env.core.call('keygen')).address]]]) {
      await assert.rejects(() => pool[name](...args), (err) => {
        assert.ok(err instanceof RpcError);
        assert.equal(err.failure, 'timeout');
        assert.equal(err.code, -1);
        assert.equal(err.message, `cannot reach ${mute.url}: timed out`);
        return true;
      }, name);
    }
    assert.equal(mute.requests, 2, 'each submit reached the mute listener once');
    assert.deepEqual(live.seen, [], 'neither submit was repeated on the live node');
    assert.equal(checkTreeInfo(await rpc(env.rpcUrl, 'rand_getTreeInfo')).next_index, before, 'and nothing was minted');
    // The same silence on a READ is retried elsewhere — that is what makes the submit rule matter.
    const read = await pool.getHead();
    assert.ok(checkHead(read).height >= 1);
    assert.deepEqual(live.seen, ['rand_getHead']);
  } finally {
    await Promise.all([mute.shutdown(), live.shutdown()]);
  }
}));

test('e. a submit to a port that is listening but hangs up is not repeated elsewhere', { skip }, withLogs(async () => {
  // The request reached the process listening on that port (it accepted the connection and read
  // the whole request) before the connection was dropped, so the wallet cannot know whether it
  // was acted on. `rpc.js` repeats a submit only on `connect` ("nothing was ever sent"), which
  // `requestOnce` files only when the fetch error's cause proves it (`neverSent`); undici reports
  // this one as `UND_ERR_SOCKET`/`ECONNRESET`, so it is `dropped`. The submit fails with that
  // endpoint's error and the live node sees nothing.
  const reader = await rawServer((socket) => { socket.once('data', () => socket.destroy()); });
  const live = await forwarder(env.rpcUrl);
  try {
    const pool = makeRpc([reader.url, live.url], { timeoutMs: 5000 });
    const payee = (await env.core.call('keygen')).address;
    await assert.rejects(() => pool.mint(payee), (err) => {
      assert.match(err.message, new RegExp(`^cannot reach ${reader.url}: `));
      assert.equal(err.failure, 'dropped');
      return true;
    });
    assert.deepEqual(live.seen, [], 'the live node was not asked to mint');
  } finally {
    await Promise.all([reader.shutdown(), live.shutdown()]);
  }
}));

test('e. a submit to a port nothing listens on IS repeated: nothing was sent', { skip }, withLogs(async () => {
  const dead = await freePort();
  const deadUrl = `http://127.0.0.1:${dead}`;
  const key = await env.core.call('keygen');
  const pool = makeRpc([deadUrl, env.rpcUrl], { timeoutMs: 5000 });
  const hash = checkSubmitted('rand_mint', await pool.mint(key.address));
  const tx = await until('the mint to commit', async () => checkTransaction(await pool.getTransaction(hash)), { timeoutMs: 60_000, everyMs: 200 });
  assert.ok(tx.height > 0);
  assert.equal(pool.url, env.rpcUrl);
}));

test('e. a malformed rand_sendTransaction comes back as the node\'s JSON-RPC error, code and message intact, and is not repeated', { skip }, withLogs(async () => {
  const counter = await forwarder(env.rpcUrl);
  const second = await forwarder(env.rpcUrl);
  try {
    const pool = makeRpc([counter.url, second.url]);
    const cases = [
      ['zz', -32602, 'tx must be hex'],
      ['00', -32602, 'tx decode: io error: unexpected end of file'],
      ['', -32602, 'tx decode: io error: unexpected end of file'],
      ['ff'.repeat(64), -32602, 'tx decode: tag for enum is not valid, found 255'],
    ];
    for (const [hex, code, message] of cases) {
      await assert.rejects(() => pool.sendTransaction(hex), (err) => {
        assert.ok(err instanceof RpcError, 'the wallet\'s error type');
        assert.equal(err.name, 'Error');
        assert.equal(err.code, code);
        assert.equal(err.message, message);
        assert.equal(err.failure, undefined);
        assert.equal(isTransportFailure(err), false);
        return true;
      }, `sendTransaction(${JSON.stringify(hex)})`);
    }
    assert.deepEqual(counter.seen, cases.map(() => 'rand_sendTransaction'));
    assert.deepEqual(second.seen, [], 'a refusal is an answer: it was not shopped to the second endpoint');
    // The same, byte for byte, over the wallet's own raw escape hatch.
    await assert.rejects(() => pool.rpc('rand_sendTransaction', ['zz']), (err) => err instanceof RpcError && err.code === -32602 && err.message === 'tx must be hex');
  } finally {
    await Promise.all([counter.shutdown(), second.shutdown()]);
  }
}));

// ---- f. restarting the node -------------------------------------------------------------------

test('f. after the node restarts on the same data directory, the wallet continues from its cursor with the same balance', { skip }, withLogs(async (t) => {
  const { w, key, store } = await ensureC();
  await w.scan(key.spend_key, {}); // catch up with the leaves the transport cases minted
  const before = await w.loadStore();
  const balanceBefore = balanceOf(before);
  const headBefore = checkHead(await rpc(env.rpcUrl, 'rand_getHead'));
  const treeBefore = await rpc(env.rpcUrl, 'rand_getTreeInfo');
  assert.equal(before.scanned_index, treeBefore.next_index);

  // Stop the node, and see the wallet say it cannot reach it — not that anything changed.
  const pidBefore = env.node.pid;
  await stopAndWait(env.node);
  assert.equal(running(env.node), false);
  await assert.rejects(() => w.scan(key.spend_key, {}), (err) => {
    assert.ok(err instanceof RpcError);
    assert.equal(err.failure, 'connect');
    return true;
  });
  assert.deepEqual(store.peek().notes, before.notes, 'a failed scan changed no note');
  assert.equal(store.peek().scanned_index, before.scanned_index);

  await startNode();
  assert.notEqual(env.node.pid, pidBefore, 'a new process');
  // Same chain, same tree, same height or later.
  assert.equal(checkGenesisHash(await rpc(env.rpcUrl, 'rand_getGenesisHash')), env.cutHash);
  const treeAfter = await rpc(env.rpcUrl, 'rand_getTreeInfo');
  assert.equal(treeAfter.next_index, treeBefore.next_index);
  assert.equal(treeAfter.root, treeBefore.root);
  assert.ok(checkHead(await rpc(env.rpcUrl, 'rand_getHead')).height >= headBefore.height);

  // The wallet scans on, from its cursor, against the new process.
  const resumed = await w.scan(key.spend_key, {});
  assert.equal(resumed.wrongChain, undefined);
  assert.equal(resumed.behind, undefined);
  assert.equal(balanceOf(resumed), balanceBefore);
  assert.deepEqual(resumed.notes, before.notes);
  assert.equal(resumed.scanned_index, before.scanned_index, 'nothing new to read: the cursor stayed');
  assert.ok(resumed.scanned_height >= before.scanned_height, 'and the spend cursor did not go back');
  assert.equal(resumed.chain_id, CHAIN_ID);

  // And it carries on: a mint after the restart is found from that cursor, one leaf further.
  await w.faucet(key.spend_key, key.address);
  const grown = await w.loadStore();
  assert.equal(grown.scanned_index, before.scanned_index + 1);
  assert.equal(balanceOf(grown), balanceBefore + FAUCET_UNITS);
  assert.deepEqual(grown.notes.slice(0, before.notes.length), before.notes);
  t.diagnostic(`restart: head ${headBefore.height} → ${checkHead(await rpc(env.rpcUrl, 'rand_getHead')).height}`);

  // Wallet A of the spend case reads its change from the restarted node just the same.
  if (env.d) {
    const aScan = await env.a.backend.sync.scan(() => {});
    assert.equal(spendableRand(aScan).reduce((a, n) => a + toUnits(n.amount), 0n), env.d.aUnits);
  }
}));
