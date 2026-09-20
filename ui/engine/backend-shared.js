// The behavior shared by every Backend (ui/backend.js) built on the wallet-core engine
// (ui/engine/wallet.js) — session lifecycle, storage, chain-identity verification, scan/rescan and
// the unlock-attempt throttle. None of this ~1100 lines is specific to wasm. `makeWasmBackend`
// (backend-wasm.js) and, from task 3.2, a native backend are both thin wrappers around this file
// that differ in exactly two things: whether a bundle proof can be produced at all, and how a send
// that CAN be proved is actually carried out. Everything else here — including the "one verified
// client per operation" invariant `requireVerifiedChain()` enforces — lives once, so task 1.6's
// five rounds of adversarial node-trust hardening protect every shell identically instead of
// drifting between copies.
//
//     makeSharedBackend({ core, storage, platform, fetch, locks, broadcast, canProve, executeSend })
//
//   core       `{ call(method, params) -> Promise }` — the wallet core, however this shell reaches
//              it (a Web Worker in both browser shells, a Tauri command to the native crate on the
//              desktop, `initSync` directly under Node in a test). This file never asks which.
//   storage    `{ get(key), set(key, value), remove(key), clear(), session: {get, set, remove},
//               compareAndSet?(key, expectedRev, value) }`, all async. The persistent half survives
//              a reload; **`session` is memory only** and is the one place the plaintext spend key
//              is ever written. `compareAndSet` is OPTIONAL: where a shell's storage can write
//              conditionally on a revision (web/wallet/idb.js does it in one IndexedDB
//              transaction) the note store uses it so two tabs cannot overwrite each other; where
//              it is missing, a plain `set`.
//   platform   the `platform` group, passed through as given: `{name, openExternal, copy}` plus
//              whatever optional members this shell has (`version`, `paste`, `openFlowInTab`,
//              `ensureHostPermission`).
//   fetch      optional; defaults to the global. Only the JSON-RPC client uses it.
//   locks      optional; defaults to `navigator.locks`. Used with `ifAvailable` so only one tab
//              scans at a time. `null` turns it off.
//   broadcast  optional; defaults to `new BroadcastChannel('rand-wallet')`. How the scanning tab
//              tells the others it has finished. `null` turns it off.
//   canProve()   -> Promise<{ok, reason?}>   `send.canProve` verbatim (ui/backend.js). Called
//                    first, before any network access, because "this shell cannot prove at all"
//                    can never be wrong and costs nothing to say.
//   executeSend(ctx) -> Promise<{hash, txKey}>   Called only after `canProve()` answered
//                    `ok: true` AND `requireVerifiedChain()` succeeded — i.e. with a client already
//                    proved to be on the wallet's chain. An implementation must reuse `ctx.client`
//                    for the whole operation and must never resolve a fresh one: that is the entire
//                    point of the invariant this file enforces (see `requireVerifiedChain` below).
//                    `ctx` is:
//                      { req, onPhase, options, client, url, identity, reason,
//                        sendTransfer, requireUnlocked, bundleFee }
//                    `req`, `onPhase`, `options` are `send.send`'s own three arguments, passed
//                    through unchanged; `client`, `url`, `identity` are exactly
//                    `requireVerifiedChain()`'s return value; `reason` is whatever `canProve()`
//                    returned alongside `ok: true` (normally `undefined` — a shell that can prove
//                    usually has no reason to report).
//
//                    The last three are what a shell that can ACTUALLY send needs, and they are
//                    handed over rather than rebuilt because there must be exactly one of each:
//                      sendTransfer(spendKey, opts)  this backend's own `engine.send`
//                                         (`makeWallet`, wallet.js) — the same instance every scan
//                                         and rescan runs through, over the same note store —
//                                         wrapped down to the one capability `executeSend` uses,
//                                         rather than handing out the whole `engine` (which also
//                                         has `chainIdentity`, `chainVerdict`, `loadStore`, `scan`
//                                         and `rescan`, several of which resolve or touch RPC
//                                         clients on their own). `engine.send()` is already the
//                                         whole transfer (select, witness, prove, submit, confirm,
//                                         re-scan); an `executeSend` calls it through this and does
//                                         not reimplement it. A second `makeWallet` over the same
//                                         storage would be a second writer of the note store.
//                      requireUnlocked()  -> `{spend_key, viewing_key}`, or throws "the wallet is
//                                         locked". The plaintext spend key lives in
//                                         `storage.session` and nowhere else, and this is the one
//                                         way to read it; a proof needs it, so an `executeSend`
//                                         that proves must ask for it here rather than hold one.
//                      bundleFee(client)  -> BigInt, the fee `send.estimate` would quote: the
//                                         node's own minimum bundle fee, from the client that was
//                                         verified, falling back to the core's constant. Pass
//                                         `ctx.client`, never a fresh one.
//
// Returns the full `Backend` contract (ui/backend.js): `{ wallet, sync, assets, send, faucet, rpc,
// settings, platform, dispose }`. Every member is implemented here except `send.canProve` (which
// *is* the `canProve` parameter) and the inside of `send.send` past the chain gate (which calls
// `executeSend`) — those two are the only places a caller's choices show through.
import { encryptSecret, decryptSecret, checkVault, isVaultRecordError } from './crypto.js';
import { makeRpc, isAllowedRpcMethod } from './rpc.js';
import { makeWallet, coreApi, emptyNoteStore, activity as activityRows, toUnits, isSpendable, abortError, BUNDLE_INPUTS, HEIGHT_SPAN } from './wallet.js';
import { checkFee, checkAssets, checkSubmitted, checkBridgeState } from './validate.js';

/**
 * The one key under `storage.session` — the unlocked wallet session, and the only place the
 * plaintext spend key is ever written.
 *
 * Exported because a shell may have to recognise this key in storage it does not own: the browser
 * extension's auto-lock is a `chrome.alarms` alarm whose background script deletes exactly this
 * key, and the open popup learns that the wallet locked by watching `storage.onChanged` for it
 * (`extension/shared/lib/idle-lock.js`). Exporting it is how those two stay one fact rather than
 * two strings that drift. Nothing about *where* storage lives belongs in this file: it is handed
 * a `storage` and never asks what is behind it.
 */
export const UNLOCKED_SESSION_KEY = 'unlocked';

// Storage keys. `unlocked` is the only session one.
const K = Object.freeze({
  settings: 'settings',
  wallet: 'wallet', // public facts only: {address, pk}
  vault: 'vault',
  notes: 'notes',
  assets: 'assets', // the registry, cached so a reload starts with the symbols it had
  failures: 'unlockFailures',
  unlocked: UNLOCKED_SESSION_KEY,
});

const MIN_PASSWORD_LEN = 10;
/**
 * Used **only** where the core's `version` reply is unavailable (it failed, or a stub core in a
 * test does not implement it). Every one of these is normally read from the core, which is built
 * against exactly one chain and says which — in particular `chainId` is never a number this file
 * decides. `rpcUrl` and `explorerUrl` are the ones the pre-redesign extension shipped (its
 * `extension/shared/lib/store.js`, deleted in task 2.1); its `chainId` said 8, which is the stale
 * chain-8 default the rename left behind and is deliberately NOT copied here.
 */
const FALLBACK = Object.freeze({
  rpcUrl: 'https://rpc.randprotocol.org',
  explorerUrl: 'https://randscan.org',
  chainId: 13,
  decimals: 9,
  autoLockMin: 15,
  theme: 'system',
  // `gas::BRIDGE_BURN_FEE`, 0.01 RAND — the floor `plan_burn` and `prove_burn` both enforce.
  // Normally read from the core's `version` reply (`bridge_burn_fee`), like every other constant
  // here; this is only for a core that does not report it.
  bridgeBurnFee: '10000000',
});

/** The same sentence ui/screens/asset.js shows on a registry asset; the ledger admits only
 *  asset-0 transfers, on every shell regardless of whether it can prove. Duplicated as a string
 *  rather than imported, because engine/ must not depend on a screen. */
export const RPL_SEND_DISABLED_TEXT = 'RPL transfers are not available on this network.';

/** Shown verbatim when `rand_getBridgeState` says this chain has no bridge at all. */
export const BRIDGE_DISABLED_TEXT = 'This chain has no bridge, so there is nothing to withdraw to.';

/** Asset 0 is RAND. `wallet-core`'s `RAND_NOT_BRIDGED`, in the user's words rather than the
 *  chain's — this one is refused before the core is ever asked. */
export const RAND_NOT_BRIDGED_TEXT = 'RAND is not a bridged asset, so it cannot be withdrawn.';

/**
 * The two facts only the chain knows, checked before a burn is proved: **the bridge is enabled**,
 * and **this asset is in the registry**. Returns `{ok: true}` or `{ok: false, reason}`.
 *
 * A direct port of the fullnode client's own `burn_is_possible`
 * (`core/vendor/fullnode/crates/randprotocol-client/src/wallet.rs`, 18 lines), which `submit_burn`
 * calls before proving for exactly this reason. `wallet-core` deliberately does not do it —
 * it performs no I/O at all — so unless it happens here it does not happen anywhere, and a typo
 * costs the user **two proofs, about three and a half minutes**, for a transaction the chain
 * refuses as `Bridge(Disabled)` / `Bridge(UnknownAsset)`.
 *
 * Deliberately NOT the rest of `BridgeState::check_burn` — the destination must be the asset's own
 * chain, the recipient must be shaped for it — which is the bridge's own policy and stays stated in
 * one place (upstream's comment says so, and `wallet-core` repeats the decision). The screen does
 * screen `to`'s shape for friendliness; that is a courtesy, not a second copy of the rule.
 *
 * `state` is `checkBridgeState`'s output, i.e. `{enabled, chains, assets}`.
 */
export function burnIsPossible(state, asset) {
  if (!state || state.enabled !== true) return { ok: false, reason: BRIDGE_DISABLED_TEXT };
  const rows = Array.isArray(state.assets) ? state.assets : [];
  const index = Number(asset);
  if (rows.some((r) => Number(r && r.index) === index)) return { ok: true };
  const known = rows.map((r) => Number(r && r.index)).filter((i) => Number.isFinite(i));
  const where = known.length === 0 ? ' (the registry is empty)' : ` (registered: ${known.join(', ')})`;
  return {
    ok: false,
    reason: `Asset ${index} is not in this chain's registry, so no note of it was ever deposited${where}.`,
  };
}

/**
 * How long the *next* attempt waits, given how many have already failed.
 *
 * `0, 0, 0.5s, 1s, 2s, 4s …` capped at 30 s. Applied **before** the attempt, not after: a delay
 * that only followed a failure would cost an attacker nothing at all — they would simply not wait
 * for it. The count is persisted, so a reload does not reset it either, and a success clears it.
 */
export function unlockDelayMs(failures) {
  const n = Number(failures) || 0;
  if (n < 2) return 0;
  return Math.min(500 * 2 ** (n - 2), 30_000);
}

const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/**
 * The BroadcastChannel the scanning tab announces itself on, or `null` where there is none.
 *
 * **`unref()` matters.** Node has a real `BroadcastChannel`, and a ref'd one keeps the event loop
 * alive for ever — a test process in which every test passed would simply never exit, which is
 * exactly what it did. Node's has `unref()`; the browser's does not need one and does not have it.
 */
function defaultChannel() {
  if (typeof BroadcastChannel !== 'function') return null;
  let channel;
  try { channel = new BroadcastChannel('rand-wallet'); } catch { return null; }
  if (typeof channel.unref === 'function') channel.unref();
  return channel;
}

function lockedError() {
  return new Error('the wallet is locked');
}

/** A note as ui/ reads it (see ui/backend.js), from the core's OwnedNote. */
function uiNote(n, blockTimes) {
  const ms = blockTimes[n.height];
  return {
    index: Number(n.index),
    asset: Number(n.asset) || 0,
    amount: String(n.amount),
    blockHeight: Number(n.height) || 0,
    spent: !!n.spent,
    commitment: n.cm,
    time: Number.isFinite(ms) ? Math.floor(ms / 1000) : 0,
  };
}

/**
 * One activity item as ui/ reads it, from one row of the engine's `activity()`.
 *
 * Two fields the contract allows are deliberately never set here:
 *  - `txKey` — a per-transaction key is a secret, and it is `executeSend`'s job (given to it in
 *    its return value) to surface one, never this shared shaping function's.
 *  - `address` for a received note — the core gives the sender's `from` field as a public key,
 *    not an address, and inventing a `rand1…` from it in JavaScript would be chain crypto outside
 *    the core. The row simply shows the asset instead.
 */
function uiActivity(row, st) {
  const at = (height) => {
    const ms = st.block_times[height];
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
  };
  if (row.kind === 'received') {
    const hash = st.note_tx[row.note && row.note.cm];
    const item = { kind: 'in', asset: Number(row.asset) || 0, amount: String(row.amount), time: at(row.height), index: Number(row.index) };
    if (hash) item.hash = hash;
    if (row.height) item.block = Number(row.height);
    return item;
  }
  if (row.kind === 'sent') {
    const item = { kind: 'out', asset: Number(row.asset) || 0, amount: String(row.amount), time: at(row.height) };
    if (row.height) item.block = Number(row.height);
    return item;
  }
  // A submission this wallet made: the faucet, or (on a shell that can prove) a transfer.
  const sub = row.sub || {};
  const time = Math.floor((Number(sub.created_ms) || Date.now()) / 1000);
  const settled = sub.status === 'committed';
  const base = {
    kind: settled ? (row.kind === 'faucet' ? 'faucet' : 'out') : 'pending',
    asset: Number(sub.asset) || 0,
    amount: String(sub.amount ?? '0'),
    time,
  };
  if (sub.hash) base.hash = sub.hash;
  if (sub.height) base.block = Number(sub.height);
  if (sub.fee) base.fee = String(sub.fee);
  if (!settled) base.status = 'pending';
  return base;
}

export function makeSharedBackend({
  core, storage, platform, fetch: fetchImpl, locks, broadcast, canProve, executeSend, executeWithdraw,
} = {}) {
  if (!core || typeof core.call !== 'function') throw new Error('makeSharedBackend needs a core with call()');
  if (!storage || typeof storage.get !== 'function' || !storage.session) throw new Error('makeSharedBackend needs a storage');
  if (!platform || typeof platform.name !== 'string' || !platform.name) throw new Error('makeSharedBackend needs a platform with a name');
  if (typeof canProve !== 'function') throw new Error('makeSharedBackend needs a canProve() function');
  if (typeof executeSend !== 'function') throw new Error('makeSharedBackend needs an executeSend() function');

  const c = coreApi(core);

  // Both optional and both feature-detected, so this file runs unchanged under Node: the Web Locks
  // API (one scanning tab) and a BroadcastChannel (telling the other tabs it finished). Passing
  // either explicitly is how the tests drive both paths without a browser; passing `null` turns
  // that half off.
  const locksApi = locks !== undefined ? locks : (typeof navigator !== 'undefined' && navigator.locks) || null;
  // The channel is lazy and re-openable: `wipe()` closes it, and a wallet created again in the
  // same page used to be left with no multi-tab coordination at all until a reload.
  const makeChannel = () => (broadcast !== undefined ? broadcast : defaultChannel());
  let channel = makeChannel();
  let channelListener = null;
  const changedListeners = new Set();

  /**
   * ONE long-lived listener per backend, rather than one per wait.
   *
   * `waitForOtherTab` used to install the only `message` listener and remove it again when it
   * resolved — so the "another tab is syncing, this will refresh when it finishes" banner was a
   * lie: nothing was listening by the time the other tab finished. Now every `scan-done` and
   * `store-reset` from another tab reaches `sync.onChanged` subscribers, whatever else is going on.
   */
  function listenOnChannel() {
    if (!channel || channelListener || typeof channel.addEventListener !== 'function') return;
    channelListener = (event) => {
      const data = event && event.data;
      if (!data || (data.type !== 'scan-done' && data.type !== 'store-reset')) return;
      for (const fn of [...changedListeners]) {
        try { fn({ reason: data.type === 'store-reset' ? 'reset' : 'scan' }); } catch { /* a listener's problem */ }
      }
    };
    channel.addEventListener('message', channelListener);
  }
  listenOnChannel();

  function ensureChannel() {
    if (!channel) { channel = makeChannel(); listenOnChannel(); }
    return channel;
  }

  function announce(type) {
    try { channel?.postMessage({ type }); } catch { /* a closed channel */ }
  }

  /** Closes the BroadcastChannel, if there is one and it can be closed. Idempotent. */
  function closeChannel() {
    const open = channel;
    if (open && channelListener && typeof open.removeEventListener === 'function') {
      try { open.removeEventListener('message', channelListener); } catch { /* going away anyway */ }
    }
    channelListener = null;
    channel = null;
    if (!open || typeof open.close !== 'function') return;
    try { open.close(); } catch { /* already closed */ }
  }

  // ---------------------------------------------------------------- the core's own constants ---
  let constantsPromise = null;
  function constants() {
    if (!constantsPromise) {
      constantsPromise = c.version().catch(() => ({}));
    }
    return constantsPromise;
  }

  // ------------------------------------------------------------------------------- settings ----
  async function defaults() {
    const k = await constants();
    return {
      // Never a hard-coded chain number: the core is built against one chain and says which.
      chainId: k.default_chain_id ?? FALLBACK.chainId,
      rpcUrl: k.default_rpc_url || FALLBACK.rpcUrl,
      explorerUrl: k.explorer_url || FALLBACK.explorerUrl,
      theme: FALLBACK.theme,
      autoLockMin: FALLBACK.autoLockMin,
    };
  }

  async function getSettings() {
    const stored = (await storage.get(K.settings)) || {};
    return { ...(await defaults()), ...stored };
  }

  async function setSettings(patch) {
    const previous = await getSettings();
    const next = { ...previous, ...(patch || {}) };
    await storage.set(K.settings, next);
    // A new node is a new question — but only about *that* node: `chainState` is keyed by URL and
    // each entry stands on its own. `behindUrls` is deliberately NOT cleared here: "two different
    // nodes both say your wallet is ahead of them" is only ever learned by changing nodes, and
    // clearing the tally on that very action made the hint unreachable.
    void next;
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'autoLockMin')) await rearmAutoLock();
    return next;
  }

  // --------------------------------------------------------------- the verified-chain gate ------
  // Three states, not two: **unknown**, ok, wrong — per RPC URL, for this session only.
  //
  // Two states was a hole. Right after a URL change, and in a fresh session before its first scan,
  // `wrongChain` was simply `null`, which read as "fine" — so `maxSendable` answered and
  // `faucet.request()` really minted against a node whose chain nobody had checked. Anything that
  // would act on the notes now proves the chain first (the cheap two-call identity check, not a
  // scan) and proceeds only on `ok`.
  //
  // A shell that cannot prove still needs this: it gates `estimate`, `maxSendable` and
  // `faucet.request` even though `send.send` itself refuses earlier, at `canProve()`.
  const chainState = new Map(); // rpcUrl -> {state: 'ok' | 'wrong' | 'anonymous', wrongChain?, identity?}
  /** RPC URLs that have reported this wallet as ahead of them, for the emphasis flag. */
  const behindUrls = new Set();

  const WRONG_CHAIN_REFUSAL = 'This node is on a different chain — switch node or rescan.';
  const UNVERIFIED_REFUSAL = 'Could not verify this node\'s chain — check your connection and try again.';

  function refusal(message, extra = {}) {
    const err = new Error(message);
    Object.assign(err, extra);
    return err;
  }

  /** The verdict for a URL, or `undefined` while it has never been established this session. */
  function verdictFor(url) {
    return chainState.get(url);
  }

  function recordVerdict(url, state, detail, identity) {
    const entry = { state };
    if (detail) entry.wrongChain = detail;
    if (identity) entry.identity = identity;
    chainState.set(url, entry);
  }

  /**
   * Proves the chain before acting on the notes, and **hands back the client it proved**.
   *
   * A verified chain is a property of ONE CLIENT OBJECT bound to ONE URL, and that is the whole
   * rule: resolve the client once, verify that client, do every part of the operation with that
   * client, record the verdict against that client's URL. The previous version verified one
   * client and let its caller fetch another — so a URL saved during the identity round trip took
   * the mint, and a fee for chain 14 was priced against notes from chain 13. The return value is
   * how that is now hard to get wrong: the gated operations — including `executeSend`, via the
   * `{client, url, identity}` this function hands `send.send` — have no other way to obtain a
   * client.
   *
   * Cheap: two RPC calls, cached per URL for the session — never a scan. Throws the definite
   * refusal for a known-wrong chain, and a retryable one when the node could not be reached.
   */
  async function requireVerifiedChain() {
    const client = await rpcClient();
    const url = client.url;
    const known = verdictFor(url);
    if (known && known.state === 'wrong') {
      throw refusal(WRONG_CHAIN_REFUSAL, { definite: true, wrongChain: known.wrongChain });
    }
    if (known && known.state === 'ok') return { client, url, identity: known.identity };
    // 'anonymous' is remembered for the UI, never as a pass: it re-checks every time.

    let identity;
    try {
      identity = await engine.chainIdentity(client);
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      throw refusal(UNVERIFIED_REFUSAL, { retryable: true });
    }
    if (!identity.reachable) throw refusal(UNVERIFIED_REFUSAL, { retryable: true });
    const st = await loadNotes();
    const settings = await getSettings();
    const verdict = engine.chainVerdict(st, identity, settings.chainId);
    if (verdict.kind === 'ok' || verdict.kind === 'adopt') {
      recordVerdict(url, 'ok', undefined, identity);
      return { client, url, identity };
    }
    if (verdict.kind === 'identityUnknown') {
      // Not "wrong", but certainly not proven: a node that will not name its chain cannot be the
      // one this wallet acts on.
      throw refusal(UNVERIFIED_REFUSAL, { retryable: true, identityUnknown: true });
    }
    const detail = { expected: verdict.expected, got: verdict.got };
    recordVerdict(url, 'wrong', detail);
    throw refusal(WRONG_CHAIN_REFUSAL, { definite: true, wrongChain: detail });
  }

  // ------------------------------------------------------------------------------- the node ----
  let rpcCache = null;
  async function rpcClient(settingsOverride) {
    const s = settingsOverride || (await getSettings());
    if (!rpcCache || rpcCache.url !== s.rpcUrl) rpcCache = makeRpc(s.rpcUrl, { fetch: fetchImpl });
    return rpcCache;
  }

  // -------------------------------------------------------------------------- the note store ---
  // `compareAndSet` is optional in the storage contract: where a shell's storage can do a
  // conditional write (web/wallet/idb.js, in one IndexedDB transaction) the engine uses it, so two
  // tabs scanning the same wallet cannot silently overwrite one another. Where it is missing the
  // engine falls back to a plain `set`, exactly as before.
  const noteStore = {
    async getNoteStore() { return (await storage.get(K.notes)) || emptyNoteStore(); },
    async setNoteStore(s) { await storage.set(K.notes, s); },
  };
  if (typeof storage.compareAndSet === 'function') {
    noteStore.compareAndSet = (value, expectedRev) => storage.compareAndSet(K.notes, expectedRev, value);
  }
  const engine = makeWallet({
    core, store: noteStore, rpc: rpcClient, settings: getSettings,
    onReset: () => announce('store-reset'),
  });

  async function loadNotes() { return engine.loadStore(); }

  // ------------------------------------------------------------------------- the unlock session -
  // `storage.session` is memory only. Nothing else holds the plaintext between calls.
  async function unlockedSession() {
    try { return (await storage.session.get(K.unlocked)) || null; } catch { return null; }
  }
  async function requireUnlocked() {
    const u = await unlockedSession();
    if (!u || !u.spend_key) throw lockedError();
    return u;
  }

  // ---------------------------------------------------------------------------- the auto-lock --
  // The idle timer measures **the user being away**, not the wallet being quiet.
  //
  // It used to be rearmed by every backend call, which is wrong in a way that quietly disables it:
  // a home screen that re-scans, a poll, anything on a timer keeps calling the backend, so an
  // unlocked wallet on an abandoned desk would never lock. Only `wallet.noteActivity()` — which
  // the shell calls on real user input (ui/app.js) — and a fresh unlock/create/import restart it.
  //
  // The one thing that may postpone a lock is a **user-initiated operation still running**.
  // Locking in the middle of a transfer would drop the spend key while the prover is using it;
  // `holdUnlock()` marks such a stretch and the lock waits for it to end. Scans deliberately do
  // not hold: a scan can be started by the app itself, and it is resumable.
  //
  // The shell observes the lock through `wallet.onLocked` (optional in the contract), so a lock
  // the *backend* decided on still routes the user to the lock screen.
  const lockedListeners = new Set();
  let autoLockTimer = null;
  let unlockHolds = 0;
  let lockDeferred = false;

  function clearAutoLock() {
    if (autoLockTimer !== null) { clearTimeout(autoLockTimer); autoLockTimer = null; }
  }

  async function rearmAutoLock() {
    clearAutoLock();
    const u = await unlockedSession();
    if (!u) return;
    const { autoLockMin } = await getSettings();
    const minutes = Number(autoLockMin);
    if (!Number.isFinite(minutes) || minutes <= 0) return; // 0 = never
    autoLockTimer = setTimeout(() => { autoLockNow(); }, minutes * 60_000);
    // Node keeps the process alive for a pending timer; a wallet's idle timer must not.
    if (autoLockTimer && typeof autoLockTimer.unref === 'function') autoLockTimer.unref();
  }

  async function autoLockNow() {
    clearAutoLock();
    if (unlockHolds > 0) { lockDeferred = true; return; } // finish what the user started first
    lockDeferred = false;
    await forgetSession();
    for (const fn of [...lockedListeners]) {
      try { fn({ reason: 'idle' }); } catch { /* a listener's failure is not the wallet's */ }
    }
  }

  /**
   * Marks a stretch the auto-lock must not interrupt. Returns the release function; a lock that
   * came due meanwhile happens the moment the last hold is released. Generic on purpose: in the
   * wasm shell it wraps a `send.send` that gives up immediately, but a shell whose `executeSend`
   * runs a minutes-long proof is exactly the case it exists for.
   */
  function holdUnlock() {
    unlockHolds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      unlockHolds -= 1;
      if (unlockHolds !== 0) return;
      if (lockDeferred) { autoLockNow(); return; }
      // No deferred lock left (the user was active during the hold, which cleared it): start the
      // idle clock again from *now*, not from whenever the operation began.
      Promise.resolve(rearmAutoLock()).catch(() => {});
    };
  }

  async function forgetSession() {
    clearAutoLock();
    lockDeferred = false;
    chainState.clear();
    behindUrls.clear();
    try { await storage.session.remove(K.unlocked); } catch { /* nothing to remove */ }
  }

  // ------------------------------------------------------------------- unlock attempt throttle --
  // **Every password attempt runs alone.** Read the count, wait, write count + 1, *then* run the
  // KDF. Without the queue, N simultaneous `unlock()` calls all read the same count, all wait the
  // same (zero, for the first two) and all run their KDF in parallel — so a scripted batch of
  // guesses paid one delay for the whole batch and the backoff bought nothing. Writing the
  // increment *before* the KDF is the other half: an attempt abandoned half-way (a reload, a
  // crash) still counts, so a reload cannot be used to skip the delay either.
  //
  // The chain is capped so a flood cannot build an unbounded list of pending promises; the cap is
  // generous enough that a human, or a UI with a couple of password prompts open, never meets it.
  const MAX_PENDING_ATTEMPTS = 8;
  let attemptChain = Promise.resolve();
  let pendingAttempts = 0;

  function enqueueAttempt(work) {
    if (pendingAttempts >= MAX_PENDING_ATTEMPTS) {
      return Promise.reject(new Error('too many attempts in progress'));
    }
    pendingAttempts += 1;
    // `then(work, work)` so one attempt's failure never strands the queue behind it.
    const run = attemptChain.then(work, work);
    attemptChain = run.then(() => {}, () => {});
    return run.finally(() => { pendingAttempts -= 1; });
  }

  /**
   * The persisted failure count, with the revision it was read at.
   *
   * It is shared by every tab of this wallet, which is the point — a second tab must not get a
   * fresh backoff budget. Where the storage can write conditionally the increment goes through
   * `compareAndSet`, so two tabs guessing at once cannot both read `n` and both write `n + 1`,
   * counting one attempt for two. (Each tab still runs its own serial queue and still pays the
   * delay the shared count earns; what this fixes is the count itself being lost.)
   */
  async function failureRecord() {
    const rec = await storage.get(K.failures);
    const n = Number(rec && rec.count);
    return { count: Number.isSafeInteger(n) && n >= 0 ? n : 0, rev: rec && rec.rev };
  }

  async function failureCount() {
    return (await failureRecord()).count;
  }

  /** Records one more failed attempt. Never lost to a race with another tab where storage allows. */
  async function bumpFailures(rec) {
    const stamp = (count) => ({ count, atMs: Date.now() });
    if (typeof storage.compareAndSet === 'function') {
      try {
        await storage.compareAndSet(K.failures, rec.rev, stamp(rec.count + 1));
        return;
      } catch (err) {
        if (!err || err.name !== 'StaleStoreError') throw err;
      }
      // Another tab counted first. Re-read and count on top of theirs, once.
      const fresh = await failureRecord();
      try {
        await storage.compareAndSet(K.failures, fresh.rev, stamp(fresh.count + 1));
        return;
      } catch (err) {
        if (!err || err.name !== 'StaleStoreError') throw err;
      }
    }
    await storage.set(K.failures, stamp(rec.count + 1));
  }
  async function clearFailures() {
    await storage.remove(K.failures);
  }

  /**
   * Runs the real KDF over the real vault. Resolves with the plaintext spend key, or `null` for a
   * wrong password — and *either way* costs one PBKDF2-SHA256 at 600 000 iterations plus one
   * AES-GCM open, because a cheaper negative answer is an oracle.
   *
   * Throws rather than answering `null` for the two failures that are not password failures: a
   * vault from a newer build, and a structurally damaged record. Those are checked **before** the
   * count is touched, so a user whose storage got corrupted is not also locked out by a backoff
   * that grows every time they try.
   */
  function openVault(password) {
    return enqueueAttempt(async () => {
      const vault = await storage.get(K.vault);
      if (!vault) throw new Error('no wallet on this device');
      checkVault(vault); // VaultVersionError / VaultDamagedError — not an attempt
      const rec = await failureRecord();
      await sleep(unlockDelayMs(rec.count));
      // Persisted before the KDF runs, not after it resolves.
      await bumpFailures(rec);
      let key;
      try {
        key = await decryptSecret(password, vault);
      } catch (err) {
        if (isVaultRecordError(err)) throw err; // cannot happen after checkVault, but do not count it
        return null;
      }
      await clearFailures();
      return key;
    });
  }

  /** Records a freshly created/imported/unlocked wallet. The vault is written first. */
  async function startSession(info) {
    await storage.session.set(K.unlocked, { spend_key: info.spend_key, viewing_key: info.viewing_key });
    // A wallet wiped and created again in the same page had no multi-tab coordination at all
    // until a reload, because `wipe()` closed the channel for good.
    ensureChannel();
    chainState.clear();
    behindUrls.clear();
    await rearmAutoLock();
  }

  function requirePassword(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
      throw new Error(`password must be at least ${MIN_PASSWORD_LEN} characters`);
    }
  }

  async function createFrom(info, password) {
    const vault = await encryptSecret(password, info.spend_key);
    await storage.set(K.vault, vault);
    await storage.set(K.wallet, { address: info.address, pk: info.pk, created_ms: Date.now() });
    await storage.set(K.notes, emptyNoteStore());
    await clearFailures();
    await startSession(info);
    return { address: info.address, pk: info.pk };
  }

  // ------------------------------------------------------------------------------- the groups --
  const wallet = {
    async exists() {
      return !!(await storage.get(K.vault));
    },

    async create(password) {
      requirePassword(password);
      if (await wallet.exists()) throw new Error('a wallet already exists on this device');
      const info = await c.keygen();
      return createFrom(info, password);
    },

    async import(secret, password) {
      requirePassword(password);
      if (await wallet.exists()) throw new Error('a wallet already exists on this device');
      const info = await c.importKey(String(secret || '').trim());
      return createFrom(info, password);
    },

    async unlock(password) {
      const key = await openVault(password);
      // One message, one shape, whatever was wrong with it.
      if (!key) throw new Error('wrong password');
      const info = await c.walletInfo(key);
      await storage.set(K.wallet, { ...((await storage.get(K.wallet)) || {}), address: info.address, pk: info.pk });
      await startSession(info);
      return { address: info.address, pk: info.pk };
    },

    /** Re-authentication, never unlocking: it answers the question and changes no state. */
    async verifyPassword(password) {
      const key = await openVault(password);
      return key !== null;
    },

    async lock() {
      await forgetSession();
    },

    async isUnlocked() {
      return !!(await unlockedSession());
    },

    async info() {
      const w = await storage.get(K.wallet);
      if (!w) throw new Error('no wallet on this device');
      return { address: w.address, pk: w.pk };
    },

    async parseAddress(address) {
      const answer = await c.parseAddress(String(address || ''));
      // The core says `error`; the contract's screens read `reason`.
      return answer && answer.valid
        ? { valid: true, pk: answer.pk }
        : { valid: false, reason: (answer && answer.error) || 'not a shielded address' };
    },

    async viewingKey() {
      const u = await requireUnlocked();
      return u.viewing_key;
    },

    async exportSpendKey() {
      const u = await requireUnlocked();
      return u.spend_key;
    },

    async wipe() {
      // `forgetSession` and not just `clearAutoLock`: a lock that was deferred behind a hold must
      // be forgotten too, or releasing that hold after the wipe fires `onLocked({reason:'idle'})`
      // at a shell that has already moved on to the welcome screen.
      await forgetSession();
      rpcCache = null;
      constantsPromise = null;
      closeChannel();
      await storage.clear();
    },

    /**
     * OPTIONAL in the contract: the shell calls this on real user input (a pointer, a key, a
     * scroll — see ui/app.js), and it is the **only** thing that restarts the idle timer. Backend
     * traffic deliberately does not: a screen that re-scans on a timer would otherwise keep an
     * abandoned, unlocked wallet unlocked for ever. Cheap and fire-and-forget by contract, so it
     * is safe to call on every event the shell throttles down to.
     */
    noteActivity() {
      // A lock that came due while a transfer was being proved is waiting for that transfer. If
      // the user is *here*, typing, that lock is stale the moment they touch the keyboard — and
      // without this it would fire the instant the send settled, however active they had been.
      // The timer is null while a lock is deferred, so this is also the only place that can say so.
      if (lockDeferred) lockDeferred = false;
      // Only while there is a timer to restart, or a deferral to re-arm after: this must not arm
      // one on a locked wallet, and must not cost a settings read per keystroke when it is off.
      if (autoLockTimer === null && unlockHolds === 0) return;
      // Fire and forget, and never a rejection: this is on the keystroke path, and an unhandled
      // rejection from a storage hiccup must not surface as an error to the user.
      Promise.resolve(rearmAutoLock()).catch(() => { /* the timer simply stays as it was */ });
    },

    /**
     * OPTIONAL in the contract: `onLocked(cb)` → unsubscribe. Called when the *backend* decided to
     * lock (the idle timer), so the shell can leave the screen it is on. A lock the shell asked
     * for does not fire it — the shell already knows.
     */
    onLocked(cb) {
      if (typeof cb !== 'function') return () => {};
      lockedListeners.add(cb);
      return () => lockedListeners.delete(cb);
    },
  };

  // ------------------------------------------------------------------- one scanning tab -------
  // Two tabs of the same wallet scanning at once is wasted work at best and a write race at worst
  // (the conditional note-store write catches the race; this avoids it). Where the Web Locks API
  // exists, whichever tab takes `rand-wallet-scan` does the scanning and announces it finished on
  // a BroadcastChannel; the others wait for that and then simply read what it wrote. Both are
  // feature-detected and both are injectable, so this is testable without a browser — and a shell
  // with neither (a Node test, an older browser, a service worker) scans exactly as it did before.
  // Long enough for another tab's scan of a few pages, short enough that nobody stares at a
  // spinner: past it this tab simply shows what is cached and says another tab is syncing, and the
  // broadcast still arrives later to refresh it.
  const OTHER_TAB_WAIT_MS = 8_000;
  const SCAN_LOCK = 'rand-wallet-scan';

  function scanListeners() {
    if (!channel || typeof channel.addEventListener !== 'function') return null;
    return channel;
  }

  /**
   * Resolves `true` when another tab says it finished scanning, `false` if the wait ran out.
   * Rejects (AbortError) if the session ends underneath it.
   */
  function waitForOtherTab(signal) {
    const bus = scanListeners();
    if (!bus) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      const done = (fn, arg) => {
        clearTimeout(timer);
        try { bus.removeEventListener('message', onMessage); } catch { /* a fake without removal */ }
        if (signal) signal.removeEventListener('abort', onAbort);
        fn(arg);
      };
      const onMessage = (event) => {
        const data = event && event.data;
        if (data && data.type === 'scan-done') done(resolve, true);
      };
      const onAbort = () => done(reject, abortError());
      const timer = setTimeout(() => done(resolve, false), OTHER_TAB_WAIT_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
      bus.addEventListener('message', onMessage);
      if (signal) {
        if (signal.aborted) { done(reject, abortError()); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  const sync = {
    async cached() {
      const st = await loadNotes();
      const out = shape(st);
      // The marker belongs to the wallet's state, not to whoever happened to call `scan`. Every
      // screen reads `cached()`, so every screen can show the blocking banner.
      try {
        const known = verdictFor((await rpcClient()).url);
        if (known && known.state === 'wrong') out.wrongChain = known.wrongChain;
        // Declared blocking in ui/backend.js, so it has to reach every screen, not only the one
        // that happened to scan.
        if (known && known.state === 'anonymous') out.identityUnknown = true;
      } catch { /* no usable RPC URL yet: nothing to say */ }
      return out;
    },

    /**
     * OPTIONAL in the contract: `onChanged(cb)` → unsubscribe. Fires when ANOTHER tab of this
     * wallet finished a scan or reset the store, so a screen can refresh from `cached()` without
     * starting a scan of its own. Synchronous registration, like `wallet.onLocked`.
     */
    onChanged(cb) {
      if (typeof cb !== 'function') return () => {};
      changedListeners.add(cb);
      return () => changedListeners.delete(cb);
    },

    async scan(onProgress, options = {}) {
      const { spend_key: key } = await requireUnlocked();
      const signal = options && options.signal;
      const runScan = async () => {
        // ONE client, captured BEFORE the scan and used for all of it. A scan runs on the wallet
        // SESSION's signal, so it keeps going while the user walks to Settings and saves a
        // different node — an ordinary journey. Resolving the client when the scan *returned*
        // recorded that new node as verified without ever asking it anything, and the next faucet
        // minted on it.
        const client = await rpcClient();
        const url = client.url;
        const st = await engine.scan(key, { signal, client, onProgress: (p) => report(p, onProgress) });
        const out = shape(st);
        // The verdict belongs to the node that earned it, and to no other. A clean scan's `st`
        // carries the identity `chainVerdict` just checked (adopted, matched, or partly adopted —
        // never anything a scan wouldn't have refused), so the verdict records it too: otherwise
        // `requireVerifiedChain()` hands back `identity: undefined` after every scan and callers
        // that want the verified identity (not just the client) get nothing until the next
        // from-scratch identity check.
        if (out.wrongChain) recordVerdict(url, 'wrong', out.wrongChain);
        else if (out.identityUnknown) recordVerdict(url, 'anonymous');
        else recordVerdict(url, 'ok', undefined, { chainId: st.chain_id, genesis: st.genesis });
        if (out.behind) {
          // The tally survives a URL change — that is the whole point of it. It is cleared by a
          // clean scan, by a rescan and when the wallet session ends.
          behindUrls.add(url);
          out.behind = withBehindHints(out.behind);
        } else if (!out.wrongChain && !out.identityUnknown) {
          behindUrls.clear();
        }
        // The result is a consistent scan of `url`, and still worth keeping — but if the wallet is
        // pointed somewhere else now, it is not that node's view, and the UI must not present A's
        // tip as B's. It re-scans instead.
        const current = await rpcClient();
        if (current.url !== url) out.staleNode = true;
        if (!out.wrongChain && !out.behind && !out.identityUnknown && !out.staleNode) announce('scan-done');
        return out;
      };

      if (!locksApi || typeof locksApi.request !== 'function') return runScan();

      let result = null;
      await locksApi.request(SCAN_LOCK, { ifAvailable: true }, async (lock) => {
        if (!lock) return; // another tab has it
        result = await runScan();
      });
      if (result) return result;

      // Another tab is scanning this same wallet. Wait for it to say it is done and read what it
      // wrote, rather than racing it to the node — but not for long: past the wait this tab shows
      // what is cached and says so, and the broadcast still arrives later to refresh it.
      const announced = await waitForOtherTab(signal);
      throwIfAborted(signal);
      const cached = shape(await loadNotes());
      if (!announced) cached.otherTab = true;
      return cached;
    },

    /**
     * OPTIONAL in the contract: forget what has been read and read it again, without touching the
     * keys. `{forChain: true}` also drops the notes, because they describe a chain this wallet is
     * no longer pointed at. The vault and the settings survive either way — this is a cache reset,
     * never a wipe.
     */
    async rescan(options = {}) {
      const { spend_key: key } = await requireUnlocked();
      const run = async () => {
        // Same rule as `scan`: one client, captured first, and the verdict recorded against it.
        const client = await rpcClient();
        const url = client.url;
        const st = await engine.rescan(key, {
          forChain: options.forChain === true,
          signal: options.signal,
          client,
          onProgress: (p) => report(p, options.onProgress),
        });
        const out = shape(st);
        chainState.clear();
        behindUrls.clear();
        // Same rule as `scan`: the identity `chainVerdict` just checked rides along with the
        // verdict, not just the state.
        if (out.wrongChain) recordVerdict(url, 'wrong', out.wrongChain);
        else if (out.identityUnknown) recordVerdict(url, 'anonymous');
        else recordVerdict(url, 'ok', undefined, { chainId: st.chain_id, genesis: st.genesis });
        const current = await rpcClient();
        if (current.url !== url) out.staleNode = true;
        // Same rule as `scan`'s broadcast: a result from a node the wallet has since left is not
        // worth telling other tabs to reload — they would read the SAME reset-but-stale state this
        // tab just painted around, not a fresh view of whatever node is current now.
        if (!out.staleNode) announce('scan-done');
        return out;
      };

      // Under the SAME lock a scan takes. A reset racing a scan used to lose the conditional
      // write, fall into the merge path, and quietly come back with the other tab's cursors —
      // the reset evaporated while Settings said "Rescanned".
      if (!locksApi || typeof locksApi.request !== 'function') return run();
      let result = null;
      let taken = false;
      await locksApi.request(SCAN_LOCK, { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        taken = true;
        result = await run();
      });
      if (taken) return result;
      // Another tab is mid-scan. Wait briefly for it, then try once more rather than resetting
      // underneath it.
      await waitForOtherTab(options.signal);
      throwIfAborted(options.signal);
      let second = null;
      await locksApi.request(SCAN_LOCK, { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        second = await run();
      });
      if (second) return second;
      const err = new Error('Another tab is syncing — try again in a moment.');
      err.retryable = true;
      throw err;
    },
  };

  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw abortError();
  }

  /**
   * `behind` says the node's tip is below what this wallet has read. Which side is wrong is not
   * knowable from here, so the UI never guesses: it offers both ways out every time (try another
   * node, or rescan). `walletAhead` is **emphasis only** — it decides which button is primary.
   *
   * The previous rule was unreachable on the only journey a user takes: it needed a gap larger
   * than one whole scan's reach (a single poisoned scan cannot produce one) or two URLs in a
   * tally that was cleared on every URL change, i.e. on exactly the action that would fill it.
   */
  function withBehindHints(behind) {
    const gap = Math.max(0, (Number(behind.wallet) || 0) - (Number(behind.tip) || 0));
    const ahead = behindUrls.size >= 2 || gap >= 10 * HEIGHT_SPAN;
    return ahead ? { ...behind, walletAhead: true } : behind;
  }

  /** The contract's progress shape is `{scanned, head}`; the engine reports a phase too. */
  function report(p, onProgress) {
    if (typeof onProgress !== 'function') return;
    onProgress({ phase: p.phase, scanned: Number(p.scanned) || 0, head: Number(p.total) || 0 });
  }

  function shape(st) {
    const out = {
      notes: (st.notes || []).map((n) => uiNote(n, st.block_times || {})),
      activity: activityRows(st).map((row) => uiActivity(row, st)),
      scannedHeight: Math.max(0, (Number(st.scanned_height) || 0) - 1),
      head: Number(st.head) || 0,
      lastSyncMs: Number(st.last_sync_ms) || 0,
    };
    // OPTIONAL in the contract, and set exactly once: the store's cursors were unusable and have
    // been reset for a full rescan (see makeWallet's loadStore). The UI says so, quietly.
    if (st.recovered) out.recovered = true;
    // This node is not on the chain this wallet's notes came from. Nothing was read or merged.
    if (st.wrongChain) out.wrongChain = st.wrongChain;
    // This node's tip is below what this wallet has already read. Also nothing read or merged.
    if (st.behind) out.behind = st.behind;
    // The bridge could not be asked, so the attest cursor stood still this scan.
    if (st.bridgeUnknown) out.bridgeUnknown = true;
    // Blocking: this node would not name its chain, so nothing was read and nothing merged.
    if (st.identityUnknown) out.identityUnknown = true;
    return out;
  }

  const assets = {
    /**
     * RAND (index 0) first, then every registry index this wallet holds notes of *or* the node's
     * registry lists. The registry carries no symbol and no decimals (`rand_getAssets` is
     * `{index, chain, token, asset_id}`), so a registry asset is `RPL#<index>` at 9 decimals and
     * has no display name at all until a known-token table exists.
     */
    async list() {
      const k = await constants();
      const st = await loadNotes();
      const decimals = Number(k.token_decimals) || FALLBACK.decimals;

      let registry = (await storage.get(K.assets)) || [];
      try {
        const client = await rpcClient();
        const fresh = checkAssets(await client.assets());
        registry = fresh;
        await storage.set(K.assets, fresh);
      } catch { /* offline, or a chain with no bridge: whatever was cached still answers */ }

      const balances = new Map();
      for (const n of st.notes || []) {
        if (!isSpendable(n)) continue;
        const index = Number(n.asset) || 0;
        balances.set(index, (balances.get(index) || 0n) + toUnits(n.amount));
      }

      // "Pending" is value on its way *in* that the tree has not shown yet — today, a faucet mint
      // that has not been committed. An outgoing submission is not pending balance; it is a
      // pending item in Activity.
      let pendingNative = 0n;
      for (const sub of st.submissions || []) {
        if (sub.kind === 'faucet' && sub.status === 'pending') pendingNative += toUnits(sub.amount);
      }

      const out = [{
        index: 0,
        id: 'rand',
        symbol: k.token_symbol || 'RAND',
        name: 'Rand',
        decimals,
        balance: (balances.get(0) || 0n).toString(),
        pending: pendingNative.toString(),
      }];

      const byIndex = new Map();
      for (const row of Array.isArray(registry) ? registry : []) {
        const index = Number(row && row.index);
        if (!Number.isInteger(index) || index < 1) continue;
        byIndex.set(index, row);
      }
      for (const index of balances.keys()) if (index >= 1 && !byIndex.has(index)) byIndex.set(index, { index });

      for (const index of [...byIndex.keys()].sort((a, b) => a - b)) {
        const row = byIndex.get(index);
        const asset = {
          index,
          id: typeof row.asset_id === 'string' && row.asset_id ? row.asset_id : `rpl-${index}`,
          symbol: `RPL#${index}`,
          decimals: FALLBACK.decimals,
          balance: (balances.get(index) || 0n).toString(),
          pending: '0',
        };
        // The asset's **origin chain**, and the token address on it, straight from the registry
        // row. They used to be dropped here. `chain` is what the Withdraw flow preselects as the
        // destination — a burn's destination must be the asset's own chain
        // (`BridgeState::check_burn`), so a wallet that discarded it would be asking the user to
        // re-enter a fact the node had already told it. Both are omitted, rather than guessed,
        // for an asset held in notes that the registry does not list.
        if (Number.isInteger(Number(row.chain))) asset.chain = Number(row.chain);
        if (typeof row.token === 'string' && row.token) asset.token = row.token;
        out.push(asset);
      }
      return out;
    },
  };

  /** The node's own minimum bundle fee — from the client the gate verified, never a fresh one. */
  async function bundleFee(client) {
    const answer = checkFee(await client.estimateFee({ kind: 'bundle' }));
    const fee = toUnits(answer);
    if (fee > 0n) return fee;
    const k = await constants();
    return toUnits(k.bundle_base_fee);
  }

  const send = {
    async canProve() {
      return canProve();
    },

    /**
     * A real estimate: the node's own minimum bundle fee, and the core's own coin selection over
     * this wallet's notes. A selection that cannot be built rejects with the core's message,
     * which is written for the user (it is what tells them to consolidate).
     */
    async estimate(req = {}) {
      const { client } = await requireVerifiedChain();
      const asset = Number(req.asset) || 0;
      if (asset !== 0) throw new Error(RPL_SEND_DISABLED_TEXT);
      const fee = await bundleFee(client);
      const st = await loadNotes();
      const need = toUnits(req.amount) + fee;
      const selection = await c.selectInputs(st.notes || [], need.toString(), 0);
      return {
        fee: fee.toString(),
        inputs: (selection.chosen || []).length,
        change: String(selection.change ?? '0'),
        proofs: 1, // a transfer is one bundle; a withdrawal is what makes it two
      };
    },

    /**
     * The largest amount this wallet can actually send: the fee taken off the largest notes one
     * bundle can spend. How many that is belongs to the chain, not to this file — it is read from
     * the core's `version` constants when the core reports it, and otherwise from the engine's one
     * named `BUNDLE_INPUTS`, which `core.integration.test.mjs` cross-checks against the real core's
     * `select_inputs` rather than taking on trust.
     */
    async maxSendable({ asset = 0 } = {}) {
      const { client } = await requireVerifiedChain();
      const fee = await bundleFee(client);
      const index = Number(asset) || 0;
      if (index !== 0) return { amount: '0', fee: fee.toString() };
      const k = await constants();
      const inputs = Number.isSafeInteger(k.bundle_inputs) && k.bundle_inputs > 0 ? k.bundle_inputs : BUNDLE_INPUTS;
      const st = await loadNotes();
      const spendable = (st.notes || [])
        .filter((n) => isSpendable(n) && (Number(n.asset) || 0) === index)
        .map((n) => toUnits(n.amount))
        .sort((a, b) => (b > a ? 1 : b < a ? -1 : 0))
        .slice(0, inputs);
      const have = spendable.reduce((a, b) => a + b, 0n);
      const amount = have > fee ? have - fee : 0n;
      return { amount: amount.toString(), fee: fee.toString() };
    },

    /**
     * `(req, onPhase, options?)` — the contract's signature. `canProve()` answers first, and
     * always without touching the network: a shell that *structurally* cannot prove (wasm:
     * ~5.6 GB against a 4 GiB address space) should say so before asking anything of a node — that
     * answer can never be wrong, and it is what the user needs. Only once `canProve()` says
     * `ok: true` does this go on to prove the chain (`requireVerifiedChain()`), and only then does
     * `executeSend` run — with the client that call verified, never a fresh one.
     */
    async send(req, onPhase, options = {}) {
      // Taken even by a shell that gives up at `canProve()`: it is the rule, not the special case
      // — a transfer is user-initiated work the idle timer must never cut in half, and a shell
      // whose `executeSend` runs a minutes-long proof needs exactly this hold.
      const release = holdUnlock();
      try {
        const { ok, reason } = await canProve();
        if (!ok) {
          const err = new Error(reason);
          err.definite = true;
          throw err;
        }
        const { client, url, identity } = await requireVerifiedChain();
        return await executeSend({
          req, onPhase, options, client, url, identity, reason,
          // Not a fresh engine, not a fresh session read and not a second fee helper: the ones
          // this backend already uses, so a send cannot diverge from what the rest of the file
          // sees. `sendTransfer` is `engine.send` narrowed to the one capability `executeSend`
          // uses — not the whole `engine` object, which also exposes `chainIdentity`,
          // `chainVerdict`, `loadStore`, `scan` and `rescan`. See the header on `executeSend` for
          // why each is here.
          sendTransfer: (spendKey, opts) => engine.send(spendKey, opts),
          requireUnlocked, bundleFee,
        });
      } finally {
        release();
      }
    },
  };

  const faucet = {
    /**
     * Mints to this wallet's own address and records the request, then returns. It deliberately
     * does not wait for the block: the UI's next scan is what turns the pending item into a note,
     * and a faucet button that blocks for up to three minutes is a faucet button people press
     * twice.
     */
    async request() {
      await requireUnlocked();
      const { client } = await requireVerifiedChain();
      const w = await storage.get(K.wallet);
      if (!w || !w.address) throw new Error('no wallet on this device');
      const hash = checkSubmitted('rand_mint', await client.mint(w.address));
      const st = await loadNotes();
      const k = await constants();
      st.submissions.unshift({
        hash, kind: 'faucet', asset: 0,
        amount: String(k.faucet_max_units || '100000000000'),
        status: 'pending', created_ms: Date.now(), time: st.head || 0,
      });
      await noteStore.setNoteStore(st);
      return { hash };
    },
  };

  // ------------------------------------------------------------------------------ the bridge --
  /** The chain's burn fee floor, from the core's own constants — never a number this file picks. */
  async function burnFee() {
    const k = await constants();
    const fee = toUnits(k.bridge_burn_fee || '0');
    return fee > 0n ? fee : toUnits(FALLBACK.bridgeBurnFee);
  }

  /** `rand_getBridgeState`, validated, off the client the chain gate proved. */
  async function bridgeStateFull() {
    const { client } = await requireVerifiedChain();
    return { client, state: checkBridgeState(await client.bridgeState()) };
  }

  function definite(message) {
    const err = new Error(message);
    err.definite = true;
    return err;
  }

  /**
   * OPTIONAL in the Backend contract (ui/backend.js): present only where a shell supplied an
   * `executeWithdraw`. Everything here is shell-independent; the one shell-specific thing — how a
   * burn that CAN be proved is actually carried out — is that parameter, exactly as `executeSend`
   * is for a transfer.
   *
   * The whole reason this group exists rather than the screen calling `rpc.call` itself: a burn
   * costs **two proofs, about three and a half minutes**, and there are two ways to spend that on
   * a transaction the chain will refuse outright — a disabled bridge and an unregistered asset.
   * `wallet-core` cannot check either (it does no I/O), so `withdraw` checks both, off the node,
   * before `executeWithdraw` is called at all (`burnIsPossible`, above).
   */
  const bridge = {
    /**
     * `{enabled, chains}` — the chains this bridge can burn to.
     *
     * `chains` is derived from the node's `emitters` map; there is no `chains` field on the wire.
     * See `checkBridgeState` (engine/validate.js) for the reply's real shape.
     */
    async state() {
      const { state } = await bridgeStateFull();
      return { enabled: state.enabled, chains: state.chains };
    },

    /**
     * Whether a withdrawal can be attempted **on this device, on this chain**, in that order.
     *
     * `canProve()` answers first and without touching the network — the same question, and the
     * same sentence, a transfer asks (`send.canProve`): a burn is two bundle proofs, so a shell
     * that cannot produce one certainly cannot produce two. Since `canProve()` is unconditionally
     * false on every wasm shell, so is this, and no node is ever asked there.
     */
    async canWithdraw() {
      const prove = await canProve();
      if (!prove || !prove.ok) {
        return { ok: false, reason: (prove && prove.reason) || 'Proving is not available here.' };
      }
      let state;
      try {
        ({ state } = await bridgeStateFull());
      } catch (err) {
        return { ok: false, reason: (err && err.message) || 'The bridge could not be asked.' };
      }
      if (!state.enabled) return { ok: false, reason: BRIDGE_DISABLED_TEXT };
      return { ok: true };
    },

    /**
     * What a withdrawal would cost and what would arrive: `{fee, relayerFee, receive, change,
     * proofs}`. The real coin selection, over this wallet's real notes, via the core's own
     * `plan_burn` — so a selection that cannot be built fails here, for nothing, instead of after
     * two proofs.
     *
     * `fee` is the RAND fee (a burn pays for both of its bundles); `relayerFee` is in units of the
     * asset and is deducted **on the destination chain**, out of `amount` — so `receive` is
     * `amount - relayerFee` and the two never add up to more than the burn.
     */
    async estimate(req = {}) {
      const asset = Number(req.asset);
      if (!Number.isInteger(asset) || asset < 1) throw new Error(RAND_NOT_BRIDGED_TEXT);
      const amount = toUnits(req.amount);
      const relayerFee = toUnits(req.relayerFee ?? '0');
      if (amount <= 0n) throw new Error('A withdrawal of zero moves nothing.');
      // Refused here, before `plan_burn` is asked anything: the chain's own rule
      // (`relayer_fee <= amount`), and the one the user is most likely to trip.
      if (relayerFee > amount) {
        throw new Error('The relayer fee is more than the amount being withdrawn.');
      }
      const { state } = await bridgeStateFull();
      const possible = burnIsPossible(state, asset);
      if (!possible.ok) throw definite(possible.reason);
      const fee = req.fee === undefined || req.fee === null ? await burnFee() : toUnits(req.fee);
      const st = await loadNotes();
      const plan = await c.planBurn({
        notes: st.notes || [], asset, amount: amount.toString(), fee: fee.toString(),
      });
      return {
        fee: String(plan.fee),
        relayerFee: relayerFee.toString(),
        receive: (amount - relayerFee).toString(),
        change: String(plan.change ?? '0'),
        feeChange: String(plan.fee_change ?? '0'),
        // From the plan, never hard-coded: it is the chain's number of proofs, not this file's.
        proofs: Number(plan.proofs) || 2,
      };
    },

    /**
     * `(req, onPhase, options?)` — `{asset, amount, relayerFee, toChain, to, fee?}` in, `{hash}`
     * out. Phases: `'selecting' | 'witness' | 'proving' | 'proving-asset' | 'submitting' |
     * 'confirming'`.
     *
     * The order of the gates is the point. `canProve()` first, because it needs no node and its
     * answer can never be wrong; then the verified-chain gate, which is every other operation's;
     * then the two bridge facts, off the client that gate proved. Only then is a proof started.
     */
    async withdraw(req = {}, onPhase, options = {}) {
      // A burn is user-initiated work that takes minutes; the idle timer must not cut it in half.
      const release = holdUnlock();
      try {
        const { ok, reason } = await canProve();
        if (!ok) throw definite(reason);
        const { client, url, identity } = await requireVerifiedChain();
        const asset = Number(req.asset);
        if (!Number.isInteger(asset) || asset < 1) throw definite(RAND_NOT_BRIDGED_TEXT);
        const state = checkBridgeState(await client.bridgeState());
        const possible = burnIsPossible(state, asset);
        if (!possible.ok) throw definite(possible.reason);
        const fee = req.fee === undefined || req.fee === null ? (await burnFee()).toString() : String(req.fee);
        return await executeWithdraw({
          req: { ...req, asset, fee }, onPhase, options, client, url, identity, reason, bridgeState: state,
          // `engine.burn` narrowed to the one capability, for the same reasons `sendTransfer` is
          // (see this file's header): one `makeWallet`, one writer of the note store.
          sendBurn: (spendKey, opts) => engine.burn(spendKey, opts),
          requireUnlocked, burnFee,
        });
      } finally {
        release();
      }
    },
  };

  const rpc = {
    /** The raw escape hatch — but only into this chain's own namespaces. */
    async call(method, params = []) {
      if (!isAllowedRpcMethod(method)) throw new Error(`${method} is not allowed from this wallet`);
      const client = await rpcClient();
      return client.rpc(method, Array.isArray(params) ? params : [params]);
    },
  };

  const settings = {
    async get() { return getSettings(); },
    async set(patch) { return setSettings(patch); },
  };

  /**
   * OPTIONAL in the contract, and on the **backend itself** rather than in a group: release what
   * this backend holds outside its own object — here the BroadcastChannel it listens on, and the
   * idle timer. The shell calls it from `destroy()`. Idempotent, and never throws.
   */
  function dispose() {
    clearAutoLock();
    lockedListeners.clear();
    changedListeners.clear();
    closeChannel();
  }

  const backend = { wallet, sync, assets, send, faucet, rpc, settings, platform, dispose };
  // `bridge` is OPTIONAL in the contract and is not in BACKEND_SHAPE: a shell that supplied no
  // `executeWithdraw` simply does not have the group, and every screen feature-detects it
  // (`ctx.backend.bridge?.canWithdraw`). Both real shells do supply one — the wasm shell's always
  // refuses, which is honest rather than absent, and proves the shape out.
  if (typeof executeWithdraw === 'function') backend.bridge = bridge;
  return backend;
}
