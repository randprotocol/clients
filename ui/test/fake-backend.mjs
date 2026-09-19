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
  return { rpcUrl: 'http://127.0.0.1:8899', theme: 'system', autoLockMin: 15, explorerUrl: 'https://explorer.rand.example', chainId: 'rand-testnet-8' };
}

function defaultAssets() {
  return [
    { index: 0, id: 'rand', symbol: 'RAND', decimals: 9, balance: '3500000000', pending: '0' },
    { index: 1, id: 'wrapped-eth', symbol: 'wETH', decimals: 9, balance: '120000000', pending: '0' },
  ];
}

function requirePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LEN} characters`);
  }
}

/** Wraps every function in `defs` (merged with `overridesGroup`) so calls are recorded on `calls`. */
function buildGroup(groupName, defs, overridesGroup, calls) {
  const merged = { ...defs, ...(overridesGroup || {}) };
  const out = {};
  for (const [key, val] of Object.entries(merged)) {
    if (typeof val === 'function') {
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
    scannedHeight: 1000,
    head: 1000,
    lastSyncMs: Date.now(),
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
    cached: () => ({
      notes: state.notes,
      activity: state.activity,
      scannedHeight: state.scannedHeight,
      head: state.head,
      lastSyncMs: state.lastSyncMs,
    }),
    scan: (onProgress) => {
      if (typeof onProgress === 'function') onProgress(1);
      return {
        notes: state.notes,
        activity: state.activity,
        scannedHeight: state.scannedHeight,
        head: state.head,
        lastSyncMs: state.lastSyncMs,
      };
    },
  };

  const assetsDefs = {
    list: () => state.assets.map((a) => ({ ...a })),
  };

  const sendDefs = {
    canProve: () => ({ ok: false, reason: 'test' }),
    estimate: (_req) => ({ fee: '10000', inputs: 1, change: '0', proofs: 1 }),
    send: (_req, onPhase) => {
      if (typeof onPhase === 'function') {
        for (const phase of ['selecting', 'witness', 'proving', 'submitting', 'confirming']) onPhase(phase);
      }
      return { hash: `0x${'ab'.repeat(32)}`, txKey: `tk-${'cd'.repeat(16)}` };
    },
  };

  const faucetDefs = {
    request: () => ({ hash: `0x${'11'.repeat(32)}` }),
  };

  const rpcDefs = {
    call: (method, params) => ({ method, params: params ?? null }),
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
    openExternal: (_url) => {},
    copy: (_text) => {},
  };

  const backend = {
    wallet: buildGroup('wallet', walletDefs, overrides.wallet, calls),
    sync: buildGroup('sync', syncDefs, overrides.sync, calls),
    assets: buildGroup('assets', assetsDefs, overrides.assets, calls),
    send: buildGroup('send', sendDefs, overrides.send, calls),
    faucet: buildGroup('faucet', faucetDefs, overrides.faucet, calls),
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

/** A fake backend that already has a wallet and is unlocked, with three activity items. */
export function unlockedBackend(overrides = {}) {
  const now = Date.now();
  const initial = {
    wallet: { address: fixedAddress(), pk: fixedPk(), password: 'unlocked-password-1' },
    unlocked: true,
    activity: [
      { kind: 'in', asset: 0, amount: '1000000000', time: now - 3600_000, hash: `0x${'aa'.repeat(32)}`, index: 3 },
      { kind: 'out', asset: 0, amount: '500000000', time: now - 1800_000, hash: `0x${'bb'.repeat(32)}` },
      { kind: 'in', asset: 1, amount: '20000000', time: now - 600_000, hash: `0x${'cc'.repeat(32)}`, index: 7 },
    ],
  };
  return createBackend(initial, overrides);
}
