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
 * lastSyncMs, recovered?, behind?, wrongChain?, otherTab?}`.
 *  - `recovered?` — OPTIONAL, and `true` at most once. The backend found its local note store
 *    unusable (a cursor that was not a block height — `NaN`, `null`, a string) and reset it for a
 *    full rescan, keeping the notes it already had. Nothing was lost that the chain cannot supply
 *    again, but the wallet is re-reading from the start, so the UI says so quietly (home shows an
 *    informational banner) rather than silently looking slow. A backend that cannot detect this
 *    simply never sets it.
 *  - `wrongChain?` — OPTIONAL, `{expected: {chainId, genesis}, got: {chainId, genesis}}`. The node
 *    is not on the chain this wallet's notes came from, so **nothing was read and nothing was
 *    merged** — a note store is a cache of one chain's tree, and merging another chain's into it
 *    invents history. The rest of the reply is the cached data, unchanged. Home shows a blocking
 *    banner offering the two real ways out: change the node in Settings, or `sync.rescan({forChain:
 *    true})`. Every field of it is node-controlled text and is escaped like any other.
 *  - `behind?` — OPTIONAL, `{tip, wallet}`. The node's tip is *below* what this wallet has already
 *    read, on the same chain: a lagging replica, or one restored from a snapshot. Not an error and
 *    not a reason to move any cursor — the reply is the cached data and scanning resumes by itself
 *    once the node catches up. Home says so quietly.
 *  - `otherTab?` — OPTIONAL, `true`. Another tab of the same wallet is scanning and this one chose
 *    to wait rather than race it; the wait ran out, so this is the cached data. The scanning tab's
 *    result arrives through `sync.onChanged?` — a backend that sets this should offer that too,
 *    or the banner promises a refresh nothing will deliver.
 *  - `bridgeUnknown?` — OPTIONAL, `true`. The bridge's state could not be read this scan, so the
 *    bridge-deposit cursor deliberately did not move (advancing it would skip blocks that were
 *    never examined). Nothing is wrong with the data; the next scan tries again.
 *  - `identityUnknown?` — OPTIONAL, `true`. **Blocking**, like `wrongChain`: the node would not
 *    say which chain it is on (neither a chain id nor a genesis hash), and this wallet has none
 *    recorded yet — so nothing was read and nothing merged. A wallet that adopted an unnamed chain
 *    could never afterwards notice it had been moved to another one, which is the whole of the
 *    wrong-chain protection. The UI says so and offers Settings.
 *  - `behind.walletAhead?` — OPTIONAL, on the `behind` object, and **emphasis only**: another node
 *    has reported the same thing this session, or the gap is large. Which side is wrong is not
 *    knowable from a wallet, so the UI always offers both ways out (try another node, rescan) and
 *    assigns no blame; this flag only decides which button is primary.
 * `options` is OPTIONAL and today carries one OPTIONAL field:
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
 *    `'selecting' | 'witness' | 'proving' | 'submitting' | 'confirming'`. **The phase is how the UI
 *    decides what a failure means** (see the rejection fields below), so a backend must report
 *    `'submitting'` before it hands the transaction to the node, not after.
 *  - `options` is OPTIONAL and today carries one OPTIONAL field:
 *    - `signal?` — an `AbortSignal`. It aborts when the wallet session ends (a lock, a wipe, an
 *      unlock, a new wallet, the UI being torn down) and when the user cancels, which the UI only
 *      offers before `'submitting'`. A backend that honours it should stop and reject with an
 *      `AbortError` (`err.name === 'AbortError'`); one that ignores it is still correct, and the
 *      UI simply keeps waiting. A backend must never abandon a transfer it has already submitted.
 *  - `txKey` is the per-transaction key. A secret, exactly like an activity item's: it must never
 *    reach a URL, storage, the console, `ctx.state` or a DOM attribute.
 *  - **On rejection**, two OPTIONAL fields on the error change what the user is told, because a
 *    failure after the transaction left this device may mean it *landed*:
 *    - `definite?` — `true` when the backend knows the transfer did not happen: the node answered
 *      and refused it (a JSON-RPC error reply to the submit), or nothing was ever broadcast. The
 *      UI then says "not sent" and offers a retry. Without it, a failure at `'submitting'` or
 *      `'confirming'` is treated as an **unknown outcome**: the UI refuses to offer a resend and
 *      sends the user to Activity first, because sending twice would pay twice.
 *    - `hash?` — the transaction hash, when the backend got far enough to have one before failing.
 *      Node-controlled, so the UI validates it before it reaches a URL.
 *
 * `send.maxSendable?({asset, to?})` → `{amount, fee}` — OPTIONAL. The largest amount that can
 * actually be sent, and the fee that would be paid, both units strings. A backend that knows how
 * it selects notes can answer this exactly; the UI's "Max" button uses it when it is there. Where
 * it is missing the UI falls back to estimating a one-unit transfer to learn the fee and
 * subtracting that from the balance, which is why `send.estimate` must answer for a one-unit
 * request even when the balance could not cover a real one. `amount` may be `'0'`.
 *
 * ---- what a failed unlock can mean ----
 *
 * `wallet.unlock(password)` rejects three different ways, and the lock screen tells them apart by
 * `err.code` (or `err.name`), never by matching the message:
 *  - no code — **wrong password**. Always exactly `'wrong password'`, one shape whatever was
 *    wrong, and the only one that counts as an attempt against the backend's backoff.
 *  - `code: 'VAULT_DAMAGED'` (`VaultDamagedError`) — the stored record is not a usable vault at
 *    all. No password can ever open it, so it is **not** counted as an attempt (otherwise the
 *    backoff grows for someone who can do nothing about it) and the UI offers wipe-and-restore
 *    instead of another password box.
 *  - `code: 'VAULT_VERSION'` (`VaultVersionError`) — a vault written by a newer build of this
 *    wallet. Also not counted, also recoverable by restoring from the recovery key.
 * Both carry `recoverable: true`. `wallet.verifyPassword` answers `false` for a wrong password but
 * **rejects** with these two, for the same reason.
 *
 * `wallet.verifyPassword(password)` → boolean. Re-authentication *without* unlocking: the screens
 * put the viewing key and the spend-key export behind it. `wallet.unlock()` cannot be used for
 * this — the shell treats every `unlock` as a new wallet session and tears the current one down
 * (see ui/app.js) — so a shell implements this as "does this password decrypt the vault?" and
 * changes no state at all. It returns `false` for a wrong password rather than throwing.
 * **It must cost exactly what `unlock` costs**: the same KDF, with the same parameters, over the
 * real vault. A cheaper check — a stored hash, a fast comparison, an early exit — turns this into
 * an oracle that tests passwords far faster than unlocking ever could, which is the whole of the
 * wallet's at-rest security. Backends apply the same attempt throttling and backoff they apply to
 * `unlock`; the UI deliberately implements no lockout of its own.
 *
 * `rpc.call(method, params?)` is the raw JSON-RPC escape hatch. The settings screen uses exactly
 * two methods, and treats every field of either answer as untrusted text:
 *  - `rand_status`   → `{height, …}` — `height` the node's current block height.
 *  - `rand_chainId`  → the chain's own id (a number or a string).
 *
 * ---- send and faucet are gated on a verified chain ----
 *
 * A backend must not act on the notes until it has established, **against the node it is pointed
 * at right now**, that the chain matches the one those notes came from. Three states, per RPC URL,
 * for the session: *unknown* (nothing checked yet — right after a URL change, or a fresh session
 * before its first scan), *ok*, *wrong*. While unknown, `send.estimate`, `send.maxSendable`,
 * `send.send` and `faucet.request` run the cheap identity check themselves (two RPC calls, never a
 * scan) and proceed only on *ok*. On *wrong* they reject with the definite refusal above; on a
 * check that could not complete they reject with `retryable: true` and 'Could not verify this
 * node's chain — check your connection and try again.'
 * A shell that structurally cannot prove a transfer answers that first (`send.canProve`), because
 * that answer can never be wrong and does not need the network. The desktop backend, which can
 * send, inherits the gate by reusing the same engine.
 *
 * `sync.onChanged?(cb)` → an unsubscribe function. OPTIONAL, and **synchronous** — like
 * `wallet.onLocked`, it registers rather than does, so the shell forwards it unwrapped. Fires when
 * *another tab* of the same wallet finished a scan or reset the store, with `{reason: 'scan' |
 * 'reset'}`. A screen uses it to refresh from `sync.cached()` — never to start a scan of its own.
 * It is what makes the `otherTab` banner's "this will refresh when that finishes" true.
 *
 * ---- acting on a wallet whose node is on another chain ----
 *
 * While the last scan reported `wrongChain`, `send.estimate`, `send.maxSendable`, `send.send` and
 * `faucet.request` **reject** with `definite: true` and a message written for the user ('This node
 * is on a different chain — switch node or rescan.'). Mixing one chain's notes with another
 * chain's fee, anchor or faucet is not a transfer anyone can make sense of. The refusal is cleared
 * by a scan that does not report `wrongChain`, by `sync.rescan`, and by changing the RPC URL (then
 * re-evaluated on the next scan).
 *
 * `sync.rescan?(options?)` → the same shape as `sync.scan`. OPTIONAL. Forgets how far the wallet
 * has read and reads it again — **without touching the keys**: the vault, the address and the
 * settings all survive, so this is a cache reset, not a wipe. `options.forChain === true` also
 * drops the notes and history, which is what a `wrongChain` answer needs (they describe a chain
 * this wallet is no longer pointed at). `options.signal` and `options.onProgress` behave as
 * `sync.scan`'s. Settings offers it behind a confirmation; the `wrongChain` banner calls it with
 * `forChain: true`. Where it is missing, neither control is rendered.
 *
 * ---- what a failed unlock costs, across tabs ----
 *
 * The backoff counter is *shared*: it is one number in the wallet's own storage, so a second tab
 * does not get a fresh budget, and each tab pays the delay the shared count has earned. Where the
 * shell's storage offers a conditional write the increment uses it, so two tabs failing at the
 * same instant still count as two. What it is not is a global rate limit across processes: N tabs
 * can each have one attempt in flight, so the *rate* scales with open tabs even though the delay
 * does not reset. The at-rest security is the KDF; this is there to make bulk guessing tedious.
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
 *  - `wallet.noteActivity?()` — **the shell calls this on user input** (a pointer, a key, a scroll
 *    or a touch on the app container, throttled to at most once every 5 s). Backends use it, and
 *    only it, to restart their idle timer; **nothing else restarts it**. Deliberately not "any
 *    backend call": a screen that re-scans on a timer, or any background refresh, would otherwise
 *    keep an abandoned, unlocked wallet unlocked indefinitely. It must be cheap, synchronous and
 *    fire-and-forget — the shell ignores whatever it returns and never waits on it.
 *    A backend may still postpone a lock it has decided on while a *user-initiated* operation is
 *    in flight (a transfer being proved), so a proof is never cut in half; a scan does not count.
 *  - `dispose?()` — OPTIONAL, on the **backend itself**, not a group. Releases whatever it holds
 *    outside its own object (a BroadcastChannel, a port, a watcher). The shell calls it from
 *    `destroy()`, last, after the wallet session has ended; it must be idempotent and must not
 *    throw. A disposed backend is not required to keep working.
 *  - `wallet.onLocked?(cb)` → an unsubscribe function. For a backend that can lock the wallet **on
 *    its own** — every real shell does, on an idle timer built from `settings.autoLockMin`. The
 *    shell subscribes at mount and, when `cb` fires, ends the wallet session and routes to
 *    `#lock`, exactly as it does for a lock the user asked for. Without it a backend-initiated
 *    lock would leave the previous wallet's screen on display, with its data on it, until
 *    something happened to re-render.
 *    `cb` is called with no arguments the UI reads (a backend may pass a `{reason}` object for a
 *    log). It is **not** called for a lock the shell itself asked for: the shell already knows.
 *    Unsubscribed on `destroy()`.
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
