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
 * Screens treat returned objects as read-only; backends may return cached objects.
 *
 * `sync.cached()` / `sync.scan(onProgress, options?)` → `{notes, activity, scannedHeight, head,
 * lastSyncMs}`. `options` is OPTIONAL and today carries one OPTIONAL field:
 *  - `signal?` — an `AbortSignal` that aborts when the wallet session the scan was started under
 *    ends (a lock, a wipe, an unlock, a new wallet, or the UI being torn down). A backend that
 *    honours it should stop the work and reject with an `AbortError` (an error whose `name` is
 *    `'AbortError'`); the UI treats that as "no longer wanted", never as a node failure. A backend
 *    that ignores it is still correct — the UI discards the result either way.
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
 *
 * ---- sending (task 1.5) ----
 *
 * A **send request** is `{asset, to, amount}` — `asset` an asset index (only 0, the native token,
 * can be transferred on this network), `to` a `rand1…` address, `amount` a units string.
 *
 * `send.canProve()` → `{ok, reason?}`. `ok: false` means this shell cannot produce the transfer
 * proof at all (the wasm shells: the proof needs ~5.6 GB and wasm32 stops at 4 GiB); `reason` is
 * shown to the user verbatim, so it is written for them, not for a log.
 *
 * `send.estimate(req)` → `{fee, inputs, change, proofs}` — `fee` and `change` units strings in the
 * *native* asset, `proofs` the number of proofs the transfer needs (always 1 for a send; a
 * withdrawal is what makes it 2). A request that cannot be built — this chain spends exactly two
 * notes, so an amount that would need three — **rejects**, and its message is written for the user
 * (the UI shows it verbatim, escaped): it is what tells them to consolidate first.
 *
 * `send.send(req, onPhase, options?)` → `{hash, txKey}`.
 *  - `onPhase(phase)` is called as the transfer moves through
 *    `'selecting' | 'witness' | 'proving' | 'submitting' | 'confirming'`.
 *  - `options` is OPTIONAL and today carries one OPTIONAL field:
 *    - `signal?` — an `AbortSignal`. It aborts when the wallet session ends (a lock, a wipe, an
 *      unlock, a new wallet, the UI being torn down) and when the user cancels, which the UI only
 *      offers before `'submitting'`. A backend that honours it should stop and reject with an
 *      `AbortError` (`err.name === 'AbortError'`); one that ignores it is still correct, and the
 *      UI simply keeps waiting. A backend must never abandon a transfer it has already submitted.
 *  - `txKey` is the per-transaction key. A secret, exactly like an activity item's: it must never
 *    reach a URL, storage, the console, `ctx.state` or a DOM attribute.
 *
 * `wallet.verifyPassword(password)` → boolean. Re-authentication *without* unlocking: the screens
 * put the viewing key and the spend-key export behind it. `wallet.unlock()` cannot be used for
 * this — the shell treats every `unlock` as a new wallet session and tears the current one down
 * (see ui/app.js) — so a shell implements this as "does this password decrypt the vault?" and
 * changes no state at all. It returns `false` for a wrong password rather than throwing.
 *
 * `rpc.call(method, params?)` is the raw JSON-RPC escape hatch. The settings screen uses exactly
 * two methods, and treats every field of either answer as untrusted text:
 *  - `rand_status`   → `{height, …}` — `height` the node's current block height.
 *  - `rand_chainId`  → the chain's own id (a number or a string).
 *
 * ---- optional, per shell ----
 * These are NOT in BACKEND_SHAPE and are not required; screens feature-detect them.
 *  - `platform.version?` — a version string for the About section. Omitted → no version is shown.
 *  - `platform.ensureHostPermission?(url)` → boolean. Browser-extension shells must ask for
 *    permission to reach a new host, and Firefox only grants it while it is still handling the
 *    user's own click. The settings screen calls it inside the submit handler, before saving a new
 *    RPC URL, and abandons the save if it resolves false.
 *  - `platform.openFlowInTab?(flow)` — a popup shell escaping its 360×600 window for a long flow.
 *  - `platform.paste?()` → string. Reads the clipboard, for the send screen's Paste affordance
 *    (a shielded address is pasted, never typed). Optional because reading the clipboard needs a
 *    permission some shells will not have: where it is missing, no Paste button is offered at all
 *    rather than one that does nothing. May resolve to `''`.
 */
export const BACKEND_SHAPE = {
  wallet: ['exists', 'create', 'import', 'unlock', 'verifyPassword', 'lock', 'isUnlocked', 'info', 'parseAddress', 'viewingKey', 'exportSpendKey', 'wipe'],
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
