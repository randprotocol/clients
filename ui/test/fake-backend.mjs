// In-memory fake implementation of the ui/backend.js contract, for tests (used both by this
// package's own tests and by later tasks' screen/flow tests). Every method is async and every
// call is recorded on `b.calls` as `['group.method', ...args]`.

const MIN_PASSWORD_LEN = 10;

function fixedAddress() {
  return 'rand1' + 'q'.repeat(40);
}

function fixedPk() {
  return 'ab'.repeat(32);
}

function defaultSettings() {
  return {
    rpcUrl: 'http://127.0.0.1:8899',
    rpcUrls: ['https://rpc1.randprotocol.org', 'https://rpc2.randprotocol.org', 'https://rpc3.randprotocol.org'],
    theme: 'system', autoLockMin: 15, explorerUrl: 'https://randscan.org', chainId: 13,
  };
}

function defaultAssets() {
  return [
    { index: 0, id: 'rand', name: 'Rand', symbol: 'RAND', decimals: 9, balance: '3500000000', pending: '0' },
    // A registry asset carries its **origin chain** (and the token address on it), exactly as the
    // real `assets.list()` now threads them through from `rand_getAssets`. Chain 2 is an EVM
    // chain, so the Withdraw flow validates a 20-byte address against it.
    {
      index: 1, id: 'wrapped-eth', name: 'Wrapped Ether', symbol: 'wETH', decimals: 9,
      balance: '120000000', pending: '0', chain: 2, token: 'ee'.repeat(32),
    },
  ];
}

/** The shape ui/ recognises as "this was cancelled", not "the node failed". */
function abortError() {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

function requirePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LEN} characters`);
  }
}

// Subscription-style members: they answer with an unsubscribe function (or nothing) and must not
// be made async, exactly as ui/app.js's SYNC_PASSTHROUGH describes. A fake that promise-wraps
// them would hide the very bug that list exists to prevent.
const PASSTHROUGH = new Set(['onLocked', 'noteActivity', 'onChanged']);

/** Wraps every function in `defs` (merged with `overridesGroup`) so calls are recorded on `calls`. */
function buildGroup(groupName, defs, overridesGroup, calls) {
  const merged = { ...defs, ...(overridesGroup || {}) };
  const out = {};
  for (const [key, val] of Object.entries(merged)) {
    if (typeof val === 'function' && PASSTHROUGH.has(key)) {
      out[key] = (...args) => { calls.push([`${groupName}.${key}`, ...args]); return val(...args); };
    } else if (typeof val === 'function') {
      out[key] = async (...args) => {
        calls.push([`${groupName}.${key}`, ...args]);
        return val(...args);
      };
    } else {
      out[key] = val;
    }
  }
  return out;
}

function createBackend(initial = {}, overrides = {}) {
  const state = {
    wallet: null, // { address, pk, password }
    unlocked: false,
    settings: defaultSettings(),
    assets: defaultAssets(),
    activity: [],
    notes: [],
    clipboard: '',
    scannedHeight: 1000,
    head: 1000,
    lastSyncMs: Date.now(),
    rescans: [],
    bridgeEnabled: true,
    bridgeChains: [2, 3, 4],
    ...initial,
  };

  const calls = [];

  const walletDefs = {
    exists: () => !!state.wallet,
    create: (password) => {
      requirePassword(password);
      state.wallet = { address: fixedAddress(), pk: fixedPk(), password };
      state.unlocked = true;
      return { address: state.wallet.address, pk: state.wallet.pk };
    },
    import: (secret, password) => {
      requirePassword(password);
      state.wallet = { address: fixedAddress(), pk: fixedPk(), password };
      state.unlocked = true;
      return { address: state.wallet.address, pk: state.wallet.pk };
    },
    unlock: (password) => {
      if (!state.wallet) throw new Error('no wallet');
      if (password !== state.wallet.password) throw new Error('wrong password');
      state.unlocked = true;
    },
    // Re-authentication only: it answers the question and changes nothing, so the wallet session
    // the caller is in survives it (see ui/backend.js).
    verifyPassword: (password) => !!state.wallet && password === state.wallet.password,
    lock: () => {
      state.unlocked = false;
    },
    isUnlocked: () => state.unlocked,
    info: () => {
      if (!state.wallet) throw new Error('no wallet');
      return { address: state.wallet.address, pk: state.wallet.pk };
    },
    parseAddress: (address) => {
      const valid = typeof address === 'string' && address.startsWith('rand1') && address.length >= 45;
      return valid ? { valid: true } : { valid: false, reason: 'not a rand1 address' };
    },
    viewingKey: () => `vk-${state.wallet ? state.wallet.pk : ''}`,
    exportSpendKey: () => `sk-${state.wallet ? state.wallet.pk : ''}`,
    wipe: () => {
      state.wallet = null;
      state.unlocked = false;
    },
  };

  const syncDefs = {
    // Return copies, not live references, so a caller mutating the result (or a later state
    // change) can never reach back into this backend's own arrays — the same convention
    // assets.list() already follows below.
    cached: () => ({
      notes: state.notes.map((n) => ({ ...n })),
      activity: state.activity.map((a) => ({ ...a })),
      scannedHeight: state.scannedHeight,
      head: state.head,
      lastSyncMs: state.lastSyncMs,
    }),
    // `options.signal` is the wallet session's AbortSignal (see ui/backend.js). This fake answers
    // immediately, so the only abort it can observe is one that already happened before the call;
    // it *rejects* with an AbortError then, the way a real backend would mid-scan. `async` on
    // purpose, rather than leaning on buildGroup's wrapper: the contract says every backend method
    // reports failure through a rejected promise, never a synchronous throw, and a fake that only
    // happens to satisfy that because of how it is wrapped is not pinning the contract down.
    scan: async (onProgress, options) => {
      const signal = options && options.signal;
      if (signal && signal.aborted) throw abortError();
      if (typeof onProgress === 'function') onProgress({ scanned: state.scannedHeight, head: state.head });
      return {
        notes: state.notes.map((n) => ({ ...n })),
        activity: state.activity.map((a) => ({ ...a })),
        scannedHeight: state.scannedHeight,
        head: state.head,
        lastSyncMs: state.lastSyncMs,
      };
    },
  };

  // OPTIONAL in the contract (ui/backend.js), present here so the Settings control and the
  // wrong-chain banner's action are exercised. A test deletes it to cover the other branch.
  syncDefs.rescan = async (options = {}) => {
    state.rescans.push(options || {});
    if (options && options.forChain) { state.notes = []; state.activity = []; }
    return {
      notes: state.notes.map((n) => ({ ...n })),
      activity: state.activity.map((a) => ({ ...a })),
      scannedHeight: 0,
      head: state.head,
      lastSyncMs: Date.now(),
    };
  };

  const assetsDefs = {
    list: () => state.assets.map((a) => ({ ...a })),
  };

  const FEE = 10000n;

  const sendDefs = {
    canProve: () => ({ ok: false, reason: 'test' }),
    estimate: (_req) => ({ fee: FEE.toString(), inputs: 1, change: '0', proofs: 1 }),
    // Optional in the contract (see ui/backend.js). Exact here because this fake knows its own
    // arithmetic: the whole balance less the fee, floored at zero.
    maxSendable: ({ asset = 0 } = {}) => {
      const entry = state.assets.find((a) => a.index === asset);
      const balance = BigInt((entry && entry.balance) || '0');
      const amount = balance > FEE ? balance - FEE : 0n;
      return { amount: amount.toString(), fee: FEE.toString() };
    },
    // `options.signal` is the session-linked AbortSignal (see ui/backend.js). This fake answers
    // immediately, so the only abort it can observe is one that happened before the call; it
    // rejects with an AbortError then, the way a real prover would mid-proof.
    send: async (_req, onPhase, options) => {
      const signal = options && options.signal;
      if (signal && signal.aborted) throw abortError();
      if (typeof onPhase === 'function') {
        for (const phase of ['selecting', 'witness', 'proving', 'submitting', 'confirming']) onPhase(phase);
      }
      return { hash: `0x${'ab'.repeat(32)}`, txKey: `tk-${'cd'.repeat(16)}` };
    },
  };

  const faucetDefs = {
    request: () => ({ hash: `0x${'11'.repeat(32)}` }),
  };

  // OPTIONAL in the contract (ui/backend.js) — a whole group most shells do not have. Present here
  // so the Withdraw flow can be driven; a test deletes `backend.bridge` (or overrides
  // `canWithdraw`) to cover the shells that cannot withdraw at all.
  const BURN_FEE = 10000000n; // gas::BRIDGE_BURN_FEE, 0.01 RAND
  const bridgeDefs = {
    state: () => ({ enabled: state.bridgeEnabled, chains: state.bridgeChains.slice() }),
    canWithdraw: () => (state.bridgeEnabled
      ? { ok: true }
      : { ok: false, reason: 'This chain has no bridge, so there is nothing to withdraw to.' }),
    estimate: ({ asset, amount, relayerFee = '0' } = {}) => {
      if (Number(asset) < 1) throw new Error('RAND is not a bridged asset, so it cannot be withdrawn.');
      const units = BigInt(amount || '0');
      const relayer = BigInt(relayerFee || '0');
      if (units <= 0n) throw new Error('A withdrawal of zero moves nothing.');
      if (relayer > units) throw new Error('The relayer fee is more than the amount being withdrawn.');
      return {
        fee: BURN_FEE.toString(),
        relayerFee: relayer.toString(),
        receive: (units - relayer).toString(),
        change: '0',
        feeChange: '0',
        proofs: 2,
      };
    },
    // Reports every phase the contract declares, in order, so a screen that labels one of them
    // wrong fails a test rather than a user. The real native backend reports a subset (it cannot
    // see inside `prove_burn`); what the UI must handle is the whole vocabulary.
    withdraw: async (_req, onPhase, options) => {
      const signal = options && options.signal;
      if (signal && signal.aborted) throw abortError();
      if (typeof onPhase === 'function') {
        for (const phase of ['selecting', 'witness', 'proving-asset', 'proving', 'submitting', 'confirming']) {
          onPhase(phase);
        }
      }
      return { hash: `0x${'be'.repeat(32)}` };
    },
  };

  const rpcDefs = {
    // The two methods the settings screen's "Test connection" uses; anything else echoes, as
    // before, so a test can assert on a call without this fake pretending to be a whole node.
    call: (method, params) => {
      if (method === 'rand_status') return { height: state.head, peers: 8, syncing: false };
      if (method === 'rand_chainId') return state.settings.chainId;
      return { method, params: params ?? null };
    },
  };

  const settingsDefs = {
    get: () => ({ ...state.settings }),
    set: (patch) => {
      Object.assign(state.settings, patch);
      return { ...state.settings };
    },
  };

  const platformDefs = {
    name: 'fake',
    // Optional in the contract (see ui/backend.js); present here so the About section's "with a
    // version" branch is exercised. A test deletes it to cover the other branch.
    version: '1.5.0-dev',
    openExternal: (_url) => {},
    copy: (text) => { state.clipboard = String(text ?? ''); },
    // Also optional in the contract. A clipboard that remembers what `copy` put in it is exactly
    // as much of one as the screens need.
    paste: () => state.clipboard || '',
  };

  const backend = {
    wallet: buildGroup('wallet', walletDefs, overrides.wallet, calls),
    sync: buildGroup('sync', syncDefs, overrides.sync, calls),
    assets: buildGroup('assets', assetsDefs, overrides.assets, calls),
    send: buildGroup('send', sendDefs, overrides.send, calls),
    faucet: buildGroup('faucet', faucetDefs, overrides.faucet, calls),
    bridge: buildGroup('bridge', bridgeDefs, overrides.bridge, calls),
    rpc: buildGroup('rpc', rpcDefs, overrides.rpc, calls),
    settings: buildGroup('settings', settingsDefs, overrides.settings, calls),
    platform: buildGroup('platform', platformDefs, overrides.platform, calls),
    calls,
  };

  return backend;
}

/** In-memory fake backend: starts with no wallet. `fakeBackend(overrides)` deep-merges per-group overrides. */
export function fakeBackend(overrides = {}) {
  return createBackend({}, overrides);
}

/**
 * A fake backend that already has a wallet and is unlocked, with one activity item of each of the
 * contract's four kinds (`in`, `out`, `faucet`, `pending` — see ui/backend.js) and the two notes
 * the two `in` items reference by `index`.
 *
 * The `faucet` item deliberately carries none of the optional `address`/`block`/`fee`/`txKey`
 * fields, so a screen that renders those rows unconditionally fails a test rather than a user.
 *
 * `activity[].time` and `notes[].time` are unix seconds (the chain's convention — see
 * `groupByDay` in lib/assets.js, whose own test fixes this contract), not milliseconds; every
 * other `*Ms` field in this file (`lastSyncMs`, `Date.now()`) stays milliseconds, as named.
 */
export function unlockedBackend(overrides = {}) {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const initial = {
    wallet: { address: fixedAddress(), pk: fixedPk(), password: 'unlocked-password-1' },
    unlocked: true,
    activity: [
      {
        kind: 'in', asset: 0, amount: '1000000000', time: nowSec - 3600, hash: `0x${'aa'.repeat(32)}`,
        index: 3, address: 'rand1' + 's'.repeat(40), block: 1402914,
      },
      {
        kind: 'out', asset: 0, amount: '500000000', time: nowSec - 1800, hash: `0x${'bb'.repeat(32)}`,
        address: 'rand1' + 'p'.repeat(40), block: 1402918, fee: '2100000', txKey: `tk-${'cd'.repeat(16)}`,
      },
      {
        kind: 'in', asset: 1, amount: '20000000', time: nowSec - 600, hash: `0x${'cc'.repeat(32)}`,
        index: 7, address: 'rand1' + 'w'.repeat(40), block: 1402918,
      },
      { kind: 'faucet', asset: 0, amount: '10000000000', time: nowSec - 7200, hash: `0x${'ff'.repeat(32)}` },
    ],
    notes: [
      { index: 3, asset: 0, amount: '1000000000', blockHeight: 1402914, spent: false, commitment: `0x${'a1'.repeat(32)}`, time: nowSec - 3600 },
      { index: 7, asset: 1, amount: '20000000', blockHeight: 1402918, spent: false, commitment: `0x${'c3'.repeat(32)}`, time: nowSec - 600 },
    ],
  };
  return createBackend(initial, overrides);
}
