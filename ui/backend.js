// The contract every shell (Tauri desktop, browser extension, local wasm web wallet) implements
// and every screen in ui/ talks to. Screens never touch browser-extension APIs, Tauri or
// IndexedDB directly — only this shape.
/**
 * Shapes the screens read out of the methods below. Amounts are decimal strings of *units* and
 * are only ever handled as BigInt (`formatUnits`), never `Number()`.
 *
 * `assets.list()` → `[{index, id, symbol, decimals, balance, pending, name?}]`, index 0 (RAND, the
 * native token) first; every other index is a registry ("RPL") asset, whose `symbol` may be no
 * more than `RPL#<index>`.
 *  - `name?` — OPTIONAL. A display name ("Wrapped Ether"). Screens fall back to `symbol`.
 *
 * `sync.cached()` / `sync.scan(onProgress)` → `{notes, activity, scannedHeight, head, lastSyncMs}`.
 * An **activity item** is `{kind, asset, amount, time, hash?, index?}` where `kind` is one of
 * `'in' | 'out' | 'faucet' | 'pending'`, `asset` is an asset index, `amount` is a units string and
 * `time` is a unix timestamp in **seconds** (`lastSyncMs` and every other `*Ms` field is
 * milliseconds, as named). These further fields are **OPTIONAL** — a backend may supply none of
 * them, and every screen renders each one only when it is present:
 *  - `address?` — the counterparty's shielded address (`rand1…`).
 *  - `block?`   — the block height the transaction landed in.
 *  - `fee?`     — the fee paid, a units string in the *native* asset (index 0).
 *  - `txKey?`   — the transaction key. A secret: it must never reach a URL, storage, the console,
 *                 `ctx.state` or a DOM attribute (see ui/screens/detail.js).
 *  - `status?`  — for `kind: 'pending'` only, where the transaction is in the pipeline
 *                 (`'pending' | 'proving' | 'submitting' | 'confirming'`).
 * A **note** is `{index, asset, amount, blockHeight, spent, commitment, time}`.
 *
 * `settings.get()` → `{rpcUrl, theme, autoLockMin, explorerUrl, chainId}`. `explorerUrl` may be
 * empty, in which case no explorer link is offered at all; `chainId` is the network's own id and
 * is the only source of any network label (no screen writes a chain number).
 */
export const BACKEND_SHAPE = {
  wallet: ['exists', 'create', 'import', 'unlock', 'lock', 'isUnlocked', 'info', 'parseAddress', 'viewingKey', 'exportSpendKey', 'wipe'],
  sync: ['scan', 'cached'],
  assets: ['list'],
  send: ['canProve', 'estimate', 'send'],
  faucet: ['request'],
  rpc: ['call'],
  settings: ['get', 'set'],
  platform: ['openExternal', 'copy'], // plus string field platform.name
};

/** Throws if `b` does not implement every group/method in BACKEND_SHAPE, or lacks platform.name. */
export function assertBackend(b) {
  if (!b || typeof b !== 'object') throw new Error('backend missing');
  for (const [group, methods] of Object.entries(BACKEND_SHAPE)) {
    const g = b[group];
    if (!g || typeof g !== 'object') throw new Error(`backend.${group} missing`);
    for (const fn of methods) {
      if (typeof g[fn] !== 'function') throw new Error(`backend.${group}.${fn} missing`);
    }
  }
  if (typeof b.platform.name !== 'string' || b.platform.name === '') {
    throw new Error('backend.platform.name missing');
  }
  return b;
}
