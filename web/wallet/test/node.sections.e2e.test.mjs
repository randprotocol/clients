// The wallet against a real `rand-node` on a chain with EVERY genesis section the wallet reads.
//
// node.e2e.test.mjs runs the whole RPC contract on a plain chain, where the gated reads answer
// `{"enabled": false}`, `null` or `[]` — so the wallet's validators and screens were checked only
// against the ABSENT shape of the token registry, the bridge, program state, perps, multisig,
// vesting, staking and fee rules. Chain 21 runs all of them. This file cuts a one-validator
// Test-profile chain 21 that does too — its bridge, zUSD registry and perps sections are chain 21's
// own (fixtures/chain21-sections.json, from fullnode's deploy/genesis-chain21.json), the rest are
// written here — and checks, on the real node:
//
//   a. the limits    rand_getLimits through the wallet's `checkLimits`: program state, the gas pin,
//                    the proof window, the memo envelope; the raw fee rules, multisig and perps rows
//   b. the registry  the backend's `assets.list()` over the real `rand_getTokens`: RAND, then zUSD
//                    at its own eight decimals with all seven backings; `rand_getAssets` and the
//                    bridge state through `checkAssets`/`checkBridgeState` and `bridge.state()`
//   c. programs      `quoteInvoke` on a chain that runs programs refuses a program that is not
//                    there as NO_PROGRAM — not PROGRAMS_UNSUPPORTED, which is the plain chain's
//                    answer — and the cell, cells and vault reads pass their validators
//   d. the registers perps, multisig, vesting, admission and the supply, each value equal to the
//                    section it came from
//   e. the faucet    an allow-listed wallet is minted to and scans its note, through the backend;
//                    a wallet off the list is refused with the node's own JSON-RPC error
//
// A change on the node that alters any of these shapes or refusals fails here. fullnode runs this
// file on every pull request (.github/workflows/clients.yml there), and this repository runs it
// every night against fullnode main (node-integration.yml, job `fullnode-main`).
//
// Skipped, with the reason, unless RAND_NODE_BIN is set, the wasm core is built and the node
// understands every section flag (fullnode v0.8.0 and later). `scripts/e2e-node.sh` runs it.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRpc, RpcError, isTransportFailure } from '../../../ui/engine/rpc.js';
import { makeWallet, emptyNoteStore, toUnits } from '../../../ui/engine/wallet.js';
import {
  checkLimits, checkTokens, checkAssets, checkBridgeState, checkProgramCell, checkProgramCells,
  checkProgramVault, checkSubmitted, checkTransaction, checkFee,
} from '../../../ui/engine/validate.js';
import {
  CORE_JS, CORE_WASM, realCore, wallet, freePort, rpc, until, launch, stopAndWait, chainArgs, spendableRand,
} from './node-harness.mjs';

const NODE_BIN = process.env.RAND_NODE_BIN || '';
const PASSWORD = 'an-e2e-password-for-a-real-vault';
const CHAIN_ID = 21;
const FAUCET_UNITS = 100_000_000_000n; // one `rand_mint`: 100 RAND
const ZERO32 = '00'.repeat(32);
const NODE_ENV = { ...process.env, RAND_ALLOW_TEST_FRI_PROFILE: '1' };
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/chain21-sections.json', import.meta.url), 'utf8'));

// The sections this file writes itself (the fixture's are chain 21's).
const MULTISIG = { create_fee: '1000000000', threshold: 2, balance: '500000000000', salt: 'aa'.repeat(32) };
const VESTING = { id: 'bb'.repeat(32), class: 'investor', amount: '7000000000000', linear_ms: 3_600_000 };
const STAKE_UNITS = 1_000_000_000_000n; // the validator's 1000 RAND

/** The section flags this file needs; a node without one of them cannot cut this chain. */
const SECTION_FLAGS = ['--tokens', '--program-state-cell-fee', '--multisig', '--vesting', '--staking', '--fees', '--perps', '--testnet', '--hardening-v6', '--proof-window-blocks'];
function unsupported() {
  if (!NODE_BIN || !existsSync(NODE_BIN)) return null;
  const help = execFileSync(NODE_BIN, ['genesis', '--help'], { stdio: 'pipe' }).toString();
  const lacking = SECTION_FLAGS.filter((f) => !help.includes(f));
  return lacking.length ? `this rand-node has no ${lacking.join(', ')} (it predates fullnode v0.8.0)` : null;
}

const missing = [
  !NODE_BIN && 'RAND_NODE_BIN is not set',
  NODE_BIN && !existsSync(NODE_BIN) && `RAND_NODE_BIN ${NODE_BIN} does not exist`,
  !(existsSync(CORE_JS) && existsSync(CORE_WASM)) && 'the wasm core is not built (core/scripts/build-wasm.sh)',
  unsupported(),
].filter(Boolean);
const skip = missing.length ? `all-sections e2e skipped: ${missing.join('; ')} — run scripts/e2e-node.sh` : false;

const env = {};

/** A wallet engine (`makeWallet`) over the real core and a real `makeRpc` client to the node. */
function engine() {
  let held = null;
  const store = {
    async getNoteStore() { return held ? JSON.parse(JSON.stringify(held)) : emptyNoteStore(); },
    async setNoteStore(v) { held = JSON.parse(JSON.stringify(v)); },
  };
  const client = makeRpc(env.rpcUrl, { chainId: CHAIN_ID, genesis: env.genesisHash });
  return { client, w: makeWallet({ core: env.core, store, rpc: client, settings: async () => ({ chainId: CHAIN_ID }) }) };
}

before(async () => {
  if (skip) return;
  env.dir = mkdtempSync(join(tmpdir(), 'rand-node-sections-'));
  env.core = await realCore();
  env.rpcPort = await freePort();
  env.rpcUrl = `http://127.0.0.1:${env.rpcPort}`;

  // A is on the faucet allow-list (and is the validator's payout address); B is not.
  env.a = await wallet(env.core);
  env.b = await wallet(env.core);
  env.aInfo = await env.a.backend.wallet.create(PASSWORD);
  env.bInfo = await env.b.backend.wallet.create(PASSWORD);
  env.spendKey = await env.a.backend.wallet.exportSpendKey();
  for (const w of [env.a, env.b]) await w.backend.settings.set({ rpcUrl: env.rpcUrl });

  const file = (name, value) => { const p = join(env.dir, name); writeFileSync(p, JSON.stringify(value)); return p; };
  const keygen = (name) => {
    const p = join(env.dir, name);
    execFileSync(NODE_BIN, ['keygen', '--out', p], { stdio: 'pipe' });
    return { path: p, ...JSON.parse(readFileSync(p, 'utf8')) };
  };
  env.key = keygen('node.key.json').path;
  env.signers = ['s1', 's2', 's3'].map((n) => keygen(`${n}.key.json`).public_key);
  env.vestStart = Date.now();

  // The base, as `rand-node genesis` writes it: the registry with no tokens yet (a listed token
  // needs a bridge section, which no flag writes), and no perps (its collateral is zUSD, index 1).
  const base = [
    'genesis', '--chain-id', String(CHAIN_ID), '--fri-profile', 'test', '--faucet', '--testnet',
    '--validator', `${env.key},1000,${env.aInfo.address}`, '--out', join(env.dir, 'genesis.json'),
    ...chainArgs(NODE_BIN), '--envelope-bytes', '1860', '--hardening-v6', '--proof-window-blocks', '1024',
    '--consensus-domain', '1',
    '--tokens', file('tokens.json', { ...FIXTURE.tokens, tokens: [] }),
    '--program-state-cell-fee', String(FIXTURE.program_state.cell_fee),
    '--fees', file('fees.json', FIXTURE.fees),
    '--multisig', file('multisig.json', {
      create_fee: MULTISIG.create_fee,
      accounts: [{ salt: MULTISIG.salt, signers: env.signers, threshold: MULTISIG.threshold, balance: MULTISIG.balance }],
    }),
    '--vesting', file('vesting.json', { entries: [{
      id: VESTING.id, class: VESTING.class, beneficiary: env.signers[0], amount: VESTING.amount,
      start_ms: env.vestStart, cliff_ms: 0, linear_ms: VESTING.linear_ms,
    }] }),
    '--staking', file('staking.json', {
      faucet_budget_per_epoch: '10000000000000', bond_activation_epochs: 2, max_weight_bps: 10000,
      registration_v2: true, admission_by_vote: true, faucet_recipients: [env.aInfo.address],
    }),
  ];
  const cut = execFileSync(NODE_BIN, base, { stdio: 'pipe', env: NODE_ENV }).toString();
  env.multisigId = /^\s*multisig ([0-9a-f]{64}) /m.exec(cut)?.[1];

  // Then the splice chain 21's cut makes: its bridge, its zUSD and its perps market.
  const genesis = JSON.parse(readFileSync(join(env.dir, 'genesis.json'), 'utf8'));
  genesis.tokens.tokens = FIXTURE.tokens.tokens;
  genesis.bridge = FIXTURE.bridge;
  genesis.perps = FIXTURE.perps;
  writeFileSync(join(env.dir, 'genesis.json'), JSON.stringify(genesis, null, 2));

  env.datadir = join(env.dir, 'data');
  const init = execFileSync(NODE_BIN, ['init', '--datadir', env.datadir, '--genesis', join(env.dir, 'genesis.json')], { stdio: 'pipe', env: NODE_ENV }).toString();
  env.genesisHash = /at genesis ([0-9a-f]{64})/.exec(init)?.[1];
  env.node = launch(NODE_BIN, [
    'run', '--datadir', env.datadir, '--key', env.key, '--validator',
    '--rpc', `127.0.0.1:${env.rpcPort}`, '--listen', '/ip4/127.0.0.1/tcp/0', '--no-mdns',
    '--block-interval-ms', '2000', '--view-timeout-ms', '6000', '--min-free-disk-mb', '0',
  ], 'rand-node', { env: NODE_ENV });
  await until('rand-node to answer rand_status', async () => (await rpc(env.rpcUrl, 'rand_status')).height >= 1, { timeoutMs: 60_000, everyMs: 200 });
});

after(async () => {
  await stopAndWait(env.node);
  if (env.dir) rmSync(env.dir, { recursive: true, force: true });
});

const withLogs = (fn) => async (t) => {
  try { await fn(t); } catch (err) {
    if (env.node) t.diagnostic(`--- rand-node (last lines) ---\n${env.node.log.join('').split('\n').slice(-12).join('\n')}`);
    throw err;
  }
};

test('the all-sections e2e either runs or says why not', (t) => {
  if (skip) t.diagnostic(skip);
});

test('setup: the chain was cut and opened with every section', { skip }, withLogs(async () => {
  assert.match(env.genesisHash, /^[0-9a-f]{64}$/, 'rand-node init printed the genesis hash');
  assert.match(env.multisigId, /^[0-9a-f]{64}$/, 'rand-node genesis printed the seeded multisig id');
  const { w, client } = engine();
  assert.deepEqual(await w.chainIdentity(client), { chainId: CHAIN_ID, genesis: env.genesisHash, reachable: true });
}));

// ---- a. the limits ------------------------------------------------------------------------------

test('a. rand_getLimits on a chain-21-shaped chain, through checkLimits and raw', { skip }, withLogs(async () => {
  const { client } = engine();
  const raw = await client.getLimits();
  assert.deepEqual(checkLimits(raw), {
    envelopeBytes: 1860,
    maxProofBytes: 4194304,
    bundleGasLimit: 20479,
    programState: { cellFee: String(FIXTURE.program_state.cell_fee), maxReads: raw.program_state.max_reads, maxWrites: raw.program_state.max_writes, maxPayouts: raw.program_state.max_payouts },
    proofWindowBlocks: 1024,
  });
  for (const k of ['max_reads', 'max_writes', 'max_payouts']) assert.ok(raw.program_state[k] >= 1, `program_state.${k}`);
  assert.equal(raw.binding_domain, 1);
  assert.equal(raw.testnet, true);
  assert.equal(raw.hardening_v6, true);
  assert.equal(raw.admission_by_vote, true);
  assert.equal(raw.gas_metering, 'circuit');
  assert.equal(raw.gas_price, '100');
  assert.equal(raw.byte_price, '800');
  // The fee rules chain 21 runs: burn the base fee, with a floor.
  assert.equal(raw.fee_rules.burn_base, FIXTURE.fees.burn_base);
  assert.equal(raw.fee_rules.burn_floor, FIXTURE.fees.burn_floor);
  assert.equal(raw.fee_rules.subsidy_net_of_fees, false);
  assert.equal(raw.fee_rules.usd_subsidy, null);
  assert.equal(raw.multisig.create_fee, MULTISIG.create_fee);
  assert.ok(raw.multisig.max_signers >= 3, 'the seeded account has three signers');
  const p = FIXTURE.perps;
  assert.deepEqual(
    { collateral_asset: raw.perps.collateral_asset, max_block_inputs: raw.perps.max_block_inputs, max_tier: raw.perps.max_tier, max_window_blocks: raw.perps.max_window_blocks, min_deposit: raw.perps.min_deposit },
    { collateral_asset: p.collateral_asset, max_block_inputs: p.max_block_inputs, max_tier: p.max_tier, max_window_blocks: p.max_window_blocks, min_deposit: String(p.min_deposit) },
  );
  // The fee is still a decimal string the core agrees with, under the gas section and the burn.
  assert.equal(checkFee(await client.estimateFee({ kind: 'bundle' })), (await env.core.call('version')).bundle_base_fee);
}));

// ---- b. the registry and the bridge ------------------------------------------------------------

test('b. assets.list() over the real registry: RAND, then zUSD at eight decimals with every backing', { skip }, withLogs(async () => {
  const listed = await env.a.backend.assets.list();
  assert.equal(listed.length, 2, `RAND and zUSD, got ${listed.map((a) => a.symbol).join(', ')}`);
  assert.deepEqual({ index: listed[0].index, symbol: listed[0].symbol, decimals: listed[0].decimals }, { index: 0, symbol: 'RAND', decimals: 9 });
  const zusd = listed[1];
  const spec = FIXTURE.tokens.tokens[0];
  assert.equal(zusd.index, 1);
  assert.equal(zusd.symbol, spec.symbol);
  assert.equal(zusd.name, spec.name);
  assert.equal(zusd.decimals, 8, 'a bridged token is eight decimals on Rand');
  assert.equal(zusd.unlisted, undefined, 'the chain lists it; the wallet did not make it up');
  assert.match(zusd.id, /^[0-9a-f]{64}$/);
  assert.equal(zusd.balance, '0');
  assert.deepEqual(
    zusd.backings.map((b) => ({ chain: b.chain, token: b.token, decimals: b.decimals })),
    spec.backings.map((b) => ({ chain: b.chain, token: b.token, decimals: b.decimals })),
  );

  // The raw page the backend walked, through the same validator, with the registry's own fields.
  const { client } = engine();
  const page = await client.getTokens(0, 1000);
  const checked = checkTokens(page, { from: 0 });
  assert.equal(checked.tokens.length, 1);
  assert.equal(page.enabled, true);
  assert.equal(page.registration_fee, String(FIXTURE.tokens.registration_fee));
  assert.equal(page.max_tokens, FIXTURE.tokens.max_tokens);
  assert.equal(page.bound_note_value, FIXTURE.tokens.bound_note_value);
  assert.equal(page.burn_registration_fee, FIXTURE.tokens.burn_registration_fee);
  assert.equal(page.next_index, 2, 'the next registration would be index 2');
  assert.deepEqual(checkTokens(await client.getTokens(2, 1000), { from: 2 }).tokens, [], 'a page past the end is empty');
  const one = await client.getToken(1);
  assert.equal(one.symbol, spec.symbol);
  assert.equal(one.authority.backings.length, spec.backings.length);
  assert.equal((await client.getTokenSupply(1)).backings.length, spec.backings.length);
  assert.equal(await client.getToken(2), null);
}));

test('b. the bridge: checkAssets, checkBridgeState and bridge.state() agree with chain 21\'s section', { skip }, withLogs(async () => {
  const { client } = engine();
  const spec = FIXTURE.tokens.tokens[0];
  const assets = checkAssets(await client.getAssets());
  assert.equal(assets.length, spec.backings.length, 'one registry row per backing coin');
  assert.ok(assets.every((a) => a.index === 1), 'every backing is zUSD\'s');
  assert.deepEqual(assets.map((a) => [a.chain, a.token]), spec.backings.map((b) => [b.chain, b.token]));

  const state = checkBridgeState(await client.getBridgeState());
  const emitterChains = Object.keys(FIXTURE.bridge.emitters).map(Number).sort((x, y) => x - y);
  assert.equal(state.enabled, true);
  assert.deepEqual(state.chains, emitterChains);
  assert.equal(state.mintPaused, false);
  assert.deepEqual(state.assets, assets);
  assert.deepEqual(state.fees, {
    mintBps: FIXTURE.bridge.fees.mint_bps, burnBps: FIXTURE.bridge.fees.burn_bps, recipient: FIXTURE.bridge.fees.recipient,
  });
  // Each backing's asset id is the one `rand_bridgeAssetId` derives from its (chain, token).
  for (const a of assets) assert.equal(await client.bridgeAssetId(a.chain, a.token), a.assetId ?? a.asset_id);
  assert.equal(await client.getBridgeBurn(0), null, 'no burn on a fresh chain');

  // …and what a wallet screen is told.
  assert.ok(env.a.backend.bridge, 'the wasm shell has the bridge group');
  assert.deepEqual(await env.a.backend.bridge.state(), { enabled: true, chains: emitterChains, mintPaused: false });
}));

// ---- c. programs -------------------------------------------------------------------------------

test('c. on a chain that runs programs, quoteInvoke refuses a missing program as NO_PROGRAM', { skip }, withLogs(async () => {
  const { w, client } = engine();
  const request = {
    program: ZERO32, inputs: [], reads: [], writes: [], pays: [], mints: [],
    inflow: { kind: 'none', rand: '0' },
  };
  await assert.rejects(() => w.quoteInvoke(env.spendKey, request, { client, scanFirst: false }), (err) => {
    assert.equal(err.code, 'NO_PROGRAM', `the plain chain says PROGRAMS_UNSUPPORTED; this one runs programs (${err.code}: ${err.message})`);
    return true;
  });
  // The reads an invoke makes, on a section-enabled chain: a cell is a value (zero when unset), not
  // the plain chain's `null`; the cell page and the vault are empty.
  assert.equal(checkProgramCell(await client.getProgramCell(ZERO32, ZERO32), ZERO32), ZERO32);
  assert.deepEqual(checkProgramCells(await client.getProgramCells(ZERO32, { after: null, limit: 10 })), { cells: [], next: null });
  assert.deepEqual(checkProgramVault(await client.getProgramVault(ZERO32)), []);
}));

// ---- d. the registers --------------------------------------------------------------------------

test('d. perps: the market, the roots and the empty book are chain 21\'s section', { skip }, withLogs(async () => {
  const { client } = engine();
  const p = FIXTURE.perps;
  const perps = await client.getPerps();
  assert.equal(perps.enabled, true);
  assert.equal(perps.collateral_asset, p.collateral_asset);
  assert.equal(perps.engine_hc, p.engine_hc);
  assert.equal(perps.genesis_root, p.genesis_root);
  assert.equal(perps.proved_root, p.genesis_root, 'nothing proved yet');
  assert.equal(perps.proved_height, 0);
  assert.equal(perps.accounts, 0);
  assert.equal(perps.min_deposit, String(p.min_deposit));
  assert.deepEqual(perps.markets, p.markets);
  assert.deepEqual(perps.medians.map((m) => m.market), p.markets.map((m) => m.id));
  assert.equal(await client.getPerpAccount(ZERO32), null);
  assert.deepEqual(await client.getPerpAccounts({ after: null, limit: 10 }), { accounts: [], next: null });
  const inputs = await client.getPerpInputs(1);
  assert.equal(inputs.height, 1);
  assert.match(inputs.digest, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(inputs.words) && inputs.words.every(Number.isSafeInteger));
  assert.equal(await client.getPerpInputs(999_999), null);
}));

test('d. multisig: the seeded account under the id genesis printed', { skip }, withLogs(async () => {
  const { client } = engine();
  const account = await client.getMultisig(env.multisigId);
  assert.ok(account, 'the seeded account is there');
  assert.equal(account.enabled, true);
  assert.equal(account.id, env.multisigId);
  assert.deepEqual(account.signers, env.signers);
  assert.equal(account.threshold, MULTISIG.threshold);
  assert.equal(account.nonce, 0);
  assert.deepEqual(account.vault, [{ asset: 0, amount: MULTISIG.balance }], 'the genesis balance is RAND in the vault');
  assert.equal(await client.getMultisig(ZERO32), null, 'an unknown id on a chain with the section is null, not {enabled: false}');
}));

test('d. vesting: the entry, the summary and the schedule add up to the section', { skip }, withLogs(async () => {
  const { client } = engine();
  const entry = await client.getVesting(VESTING.id);
  assert.equal(entry.id, VESTING.id);
  assert.equal(entry.class, VESTING.class);
  assert.equal(entry.amount, VESTING.amount);
  assert.equal(entry.start_ms, env.vestStart);
  assert.equal(entry.linear_ms, VESTING.linear_ms);
  assert.equal(entry.revocable, false);
  assert.equal(toUnits(entry.vested_now) + toUnits(entry.unvested_now), toUnits(VESTING.amount));
  assert.equal(entry.locked_now, entry.unvested_now);
  const summary = await client.getVestingSummary();
  assert.equal(summary.enabled, true);
  assert.equal(summary.entries, 1);
  assert.equal(summary.issued, VESTING.amount);
  assert.deepEqual(summary.classes.map((c) => [c.class, c.amount, c.entries]), [[VESTING.class, VESTING.amount, 1]]);
  const end = env.vestStart + VESTING.linear_ms;
  const schedule = await client.getVestingSchedule(env.vestStart, end, VESTING.linear_ms / 2);
  assert.equal(schedule.enabled, true);
  assert.deepEqual(schedule.points, [
    { t_ms: env.vestStart, locked: VESTING.amount },
    { t_ms: env.vestStart + VESTING.linear_ms / 2, locked: String(toUnits(VESTING.amount) / 2n) },
    { t_ms: end, locked: '0' },
  ]);
  await assert.rejects(() => client.getVesting('x'), (err) => err instanceof RpcError && err.code === -32602);
}));

test('d. admission by vote, emission and the supply invariant across every register', { skip }, withLogs(async () => {
  const { client } = engine();
  assert.deepEqual(await client.getAdmitted(), { admission_by_vote: true, admitted: [], max: 256 });
  assert.equal((await client.getEmission()).faucet, true);
  assert.equal(await client.getRandPrice(), null, 'no usd_subsidy: no voted price');
  const s = await client.getSupply();
  assert.equal(s.invariant_holds, true);
  assert.equal(s.multisig_issued, MULTISIG.balance);
  assert.equal(s.vesting_issued, VESTING.amount);
  assert.equal(s.genesis_staked, String(STAKE_UNITS));
  assert.equal(s.perps_rand_held, '0');
}));

// ---- e. the faucet -----------------------------------------------------------------------------

test('e. the allow-listed wallet is minted to and scans its note; one off the list is refused by the node', { skip }, withLogs(async () => {
  // B is not on staking.faucet_recipients: the node refuses, and the wallet passes that on intact.
  const { client } = engine();
  await assert.rejects(() => client.mint(env.bInfo.address), (err) => {
    assert.ok(err instanceof RpcError, `an RpcError, got ${err && err.constructor && err.constructor.name}`);
    assert.equal(isTransportFailure(err), false, 'the node answered');
    assert.match(err.message, /faucet may not mint to this recipient \(not in staking\.faucet_recipients\)/);
    return true;
  });

  // A is, through the backend a user's wallet is: request, scan until the note is spendable.
  const { hash } = await env.a.backend.faucet.request();
  checkSubmitted('rand_mint', hash);
  const funded = await until('the faucet note to be spendable', async () => {
    const scan = await env.a.backend.sync.scan(() => {});
    return spendableRand(scan).length > 0 ? scan : null;
  }, { timeoutMs: 120_000, everyMs: 500 });
  assert.equal(spendableRand(funded).reduce((a, n) => a + toUnits(n.amount), 0n), FAUCET_UNITS);
  assert.ok(checkTransaction(await client.getTransaction(hash)).height >= 1);
  const rand = (await env.a.backend.assets.list()).find((a) => a.index === 0);
  assert.equal(rand.balance, FAUCET_UNITS.toString());
  assert.equal((await client.getSupply()).faucet_minted, FAUCET_UNITS.toString());
}));
