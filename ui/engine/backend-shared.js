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
import { makeRpc, isAllowedRpcMethod, rpcUrlList } from './rpc.js';
import { makeWallet, coreApi, emptyNoteStore, activity as activityRows, toUnits, isSpendable, abortError, HEIGHT_SPAN } from './wallet.js';
import { checkFee, checkTokens, checkSubmitted, checkBridgeState, MAX_TOKEN_PAGE, NodeReplyError } from './validate.js';

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
  // The RPL token registry (`rand_getTokens`), cached so a reload starts with the names and
  // decimal counts it had rather than with `RPL#<index>`. A NEW key, not chain 13's `assets`:
  // that one held `rand_getAssets` rows, which carry no symbol and no decimals at all, and
  // reading one back as a token row would print every balance wrong.
  tokens: 'tokens',
  failures: 'unlockFailures',
  unlocked: UNLOCKED_SESSION_KEY,
});

const MIN_PASSWORD_LEN = 10;
/**
 * Used **only** where the core's `version` reply is unavailable (it failed, or a stub core in a
 * test does not implement it). Every one of these is normally read from the core, which is built
 * against exactly one chain and says which — in particular `chainId` is never a number this file
 * decides. `explorerUrl` is the one the pre-redesign extension shipped (its
 * `extension/shared/lib/store.js`, deleted in task 2.1); its `chainId` said 8, which is the stale
 * chain-8 default the rename left behind and is deliberately NOT copied here.
 *
 * `rpcUrls` is the **default endpoint set** (owner's decision, 2026-09-19): three hosts, so one
 * of them being down is not the wallet being down. The core's own `default_rpc_url` — one URL,
 * the retired single `rpc.` host — is deliberately not the source of this list: a future core
 * that reports `default_rpc_urls` overrides it, exactly as `default_chain_id` overrides
 * `chainId`. None of the three answers yet; that is infrastructure, not client logic, and the
 * failover in engine/rpc.js is what makes standing them up one at a time uneventful.
 */
const FALLBACK = Object.freeze({
  rpcUrls: Object.freeze([
    'https://rpc1.randprotocol.org',
    'https://rpc2.randprotocol.org',
    'https://rpc3.randprotocol.org',
  ]),
  explorerUrl: 'https://randscan.org',
  chainId: 14,
  decimals: 9,
  autoLockMin: 15,
  theme: 'system',
  // `gas::BRIDGE_BURN_FEE`, 0.01 RAND — the floor `plan_burn` and `prove_burn` both enforce.
  // Normally read from the core's `version` reply (`bridge_burn_fee`), like every other constant
  // here; this is only for a core that does not report it.
  bridgeBurnFee: '10000000',
});

/** Shown verbatim when `rand_getBridgeState` says this chain has no bridge at all. */
export const BRIDGE_DISABLED_TEXT = 'This chain has no bridge, so there is nothing to withdraw to.';

/** Asset 0 is RAND. `wallet-core`'s `RAND_NOT_BRIDGED`, in the user's words rather than the
 *  chain's — this one is refused before the core is ever asked. */
export const RAND_NOT_BRIDGED_TEXT = 'RAND is not a bridged asset, so it cannot be withdrawn.';

/** A chain sentence, dressed for a banner: the core writes lower-case fragments, the UI shows
 *  whole sentences. The words are the chain's; only the first letter and the full stop are ours. */
function sentence(text) {
  const s = String(text || '').trim();
  if (!s) return 'The chain refused this withdrawal.';
  return `${s[0].toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? '' : '.'}`;
}

/**
 * **The four facts only the chain knows, checked before a burn is proved** — the bridge is on,
 * the index is registered, the named coin backs it, and that coin is holding enough of it, in
 * whole release units. Returns `{ok: true}` or `{ok: false, reason}`.
 *
 * This is **not** a JavaScript port of the rule. It is a thin adapter over `wallet-core`'s own
 * pure `burn_is_possible`, which chain 14 added for exactly this purpose: the function is
 * upstream's (`randprotocol_client::wallet`) word for word, it derives the release unit through
 * the chain's own `ledger::tokens::release_unit` rather than a second `10^(8-d)` written here, and
 * it reads a backing's `locked` with upstream's `amount_field` (a decimal string on chain 14, a
 * number on an older node). Chain 14's zUSD amendment added two of those four checks; re-porting
 * them would have meant two implementations of a rule whose whole job is to agree with the ledger,
 * and the one that disagreed would cost the user a ~100-second, ~5.7 GB proof for a transaction
 * the chain was always going to refuse.
 *
 * So what lives here is only the adaptation: `checkBridgeState`'s validated `{enabled, assets}`
 * (the rows whole, `decimals` and `locked` included — the core needs both), the burn's own five
 * parameters, and the core's sentence turned into one a banner can show. A state that could not be
 * read at all goes in as `{enabled: false, assets: []}`, so even "there is no bridge state" is
 * answered in the chain's words rather than in a second set of ours.
 *
 * Deliberately NOT the rest of `BridgeState::check_burn` — the recipient must be shaped for the
 * destination chain — which is the bridge's own policy and stays stated in one place (upstream's
 * comment says so, and `wallet-core` repeats the decision). `ui/screens/withdraw.js` screens `to`'s
 * shape for friendliness; that is a courtesy, not a second copy of the rule.
 *
 * `core` is a `coreApi()` (engine/wallet.js); `state` is `checkBridgeState`'s output.
 */
export async function burnIsPossible(core, state, asset, toChain, token, amount, relayerFee) {
  const bridge_state = {
    enabled: !!(state && state.enabled === true),
    assets: state && Array.isArray(state.assets) ? state.assets : [],
  };
  try {
    await core.burnIsPossible({
      bridge_state,
      asset: Number(asset),
      to_chain: Number(toChain),
      token: String(token || ''),
      amount: String(amount ?? '0'),
      relayer_fee: String(relayerFee ?? '0'),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: sentence(err && err.message) };
  }
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
  // A submission this wallet made: the faucet, a burn withdrawal, or (on a shell that can prove)
  // a transfer.
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
    const supplied = rpcUrlList(k.default_rpc_urls || []);
    return {
      // Never a hard-coded chain number: the core is built against one chain and says which.
      chainId: k.default_chain_id ?? FALLBACK.chainId,
      // The user's OVERRIDE, and empty until they set one — not "the node", which is `rpcUrls`.
      // A wallet that shipped one of the defaults in here could never be told to go back to the
      // set, because there would be no way to tell "the user chose this" from "this is the
      // default".
      rpcUrl: '',
      rpcUrls: supplied.length > 0 ? supplied : [...FALLBACK.rpcUrls],
      explorerUrl: k.explorer_url || FALLBACK.explorerUrl,
      theme: FALLBACK.theme,
      autoLockMin: FALLBACK.autoLockMin,
    };
  }

  /**
   * The endpoints in force: the user's one override if they set one, otherwise the default set.
   *
   * One user-editable field over a list is the owner's decision (2026-09-19) and it is also the
   * only shape the Settings screen has ever had. An override is exactly one node, on purpose:
   * someone who typed a URL meant *that* node, and silently topping their choice up with three
   * of ours would be a wallet talking to hosts the user never agreed to.
   */
  function endpointsFor(s) {
    const override = rpcUrlList(typeof s.rpcUrl === 'string' ? s.rpcUrl : '');
    if (override.length > 0) return override;
    const list = rpcUrlList(s.rpcUrls || []);
    return list.length > 0 ? list : [...FALLBACK.rpcUrls];
  }

  async function getSettings() {
    const stored = (await storage.get(K.settings)) || {};
    const base = await defaults();
    // `rpcUrls` is **always taken fresh**, never from storage, even if a value is sitting there
    // from an older build. It is not a user setting: it is what this wallet ships with, and the
    // three hosts are not live yet, so the set is likely to change before launch. Merging a
    // persisted copy back in would freeze whatever a wallet happened to save once and no release
    // could ever move it — the same staleness trap the retired-`rpcUrl` migration below exists to
    // undo, one level up. `setSettings` refuses to write it in the first place; this is the other
    // half, for storage that already has one.
    const merged = { ...base, ...stored, rpcUrls: base.rpcUrls };
    // Migration (task 5.0). `setSettings` writes the WHOLE settings object back, defaults
    // included, so anyone who ever changed their theme has the RETIRED single default URL sitting
    // in storage. Read as an override it would pin that wallet to a host that is being replaced,
    // for ever, and the endpoint set it should be moving to would be unreachable. It was never a
    // choice the user made, so it is not treated as one — and `settings.set({rpcUrl: …})` still
    // stores it if they really do type that host in.
    const k = await constants();
    const retired = rpcUrlList(k.default_rpc_url || 'https://rpc.randprotocol.org')[0];
    if (retired && rpcUrlList(merged.rpcUrl || '')[0] === retired) merged.rpcUrl = '';
    return merged;
  }

  async function setSettings(patch) {
    const previous = await getSettings();
    const next = { ...previous, ...(patch || {}) };
    // **`rpcUrls` is read-only, and that is enforced here rather than asked for in a comment.**
    // This function writes the whole merged object, so without this line the FIRST `settings.set`
    // a wallet ever makes — a theme change, an auto-lock change, anything at all — would freeze
    // the default endpoint set of that build into storage, where it would win every future merge
    // for ever. A screen that tried to write one simply cannot; `ui/backend.js`'s contract says
    // as much, and now the implementation says it too.
    const { rpcUrls: readOnly, ...persisted } = next;
    void readOnly;
    await storage.set(K.settings, persisted);
    // A new node is a new question — but only about *that* node: `chainState` is keyed by URL and
    // each entry stands on its own. `behindUrls` is deliberately NOT cleared here: "two different
    // nodes both say your wallet is ahead of them" is only ever learned by changing nodes, and
    // clearing the tally on that very action made the hint unreachable.
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'autoLockMin')) await rearmAutoLock();
    // Read back rather than returned from `next`, so a caller sees exactly what `settings.get()`
    // would now say — the fresh `rpcUrls`, and the retired-URL migration applied.
    return getSettings();
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
   *
   * **Several endpoints (task 5.0) change nothing here, by construction.** `rpcClient()` returns
   * a client pinned to one URL with no failover path in it (see engine/rpc.js), so the `url` this
   * function reads, records a verdict against, and hands back is the URL every later step of the
   * operation talks to — a dead endpoint mid-operation surfaces as an error the caller retries
   * from the top, and it is that *next* call which may land on a different host and verify it
   * from scratch. `chainState` stays keyed by URL and keeps meaning exactly what it meant: this
   * session's verdict on that one node.
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
  // **`rpcClient()` hands out a PINNED client — one object, one URL, for one operation.**
  //
  // Task 5.0 gave `makeRpc` a list of endpoints and per-request failover, and that is exactly the
  // shape of change that could have punched a hole in task 1.6's invariant: a client that
  // rerouted from a dead `rpc1` to `rpc2` halfway through a scan or a send would let the wallet
  // act on a node `requireVerifiedChain()` never asked anything. It cannot, because the two
  // responsibilities live in two different objects (see engine/rpc.js's header):
  //
  //   * the POOL (`rpcPool`) knows the whole list and does the failover. It is never handed to
  //     anything that scans, sends or mints.
  //   * `pool.acquire()` returns a PINNED client — one URL, frozen, with no failover code path in
  //     it at all — and that is what every caller of `rpcClient()` gets. `client.url` therefore
  //     still means what it has always meant, for the whole life of that object, and
  //     `requireVerifiedChain()`'s `chainState` lookup keys on a URL that cannot change
  //     underneath it.
  //
  // So failover happens BETWEEN operations: an operation whose endpoint dies fails, and the next
  // `rpcClient()` acquires a different one — which has to answer `rand_chainId` for the expected
  // chain before it is handed out at all, and is then put through the full
  // `chainIdentity`/`chainVerdict` gate like any other node.
  let rpcPool = null;
  let rpcPoolKey = '';

  /** The pool for the settings in force, rebuilt when the endpoint set or the chain changes. */
  async function rpcEndpointPool(settingsOverride) {
    const s = settingsOverride || (await getSettings());
    const urls = endpointsFor(s);
    const key = JSON.stringify([urls, s.chainId ?? null]);
    if (!rpcPool || rpcPoolKey !== key) {
      // `chainId` is what the pool's own cheap pre-use check holds an endpoint to. It is the
      // configured chain, never anything the node said — the same rule `chainVerdict` follows.
      rpcPool = makeRpc(urls, { fetch: fetchImpl, chainId: s.chainId });
      rpcPoolKey = key;
    }
    return rpcPool;
  }

  async function rpcClient(settingsOverride) {
    return (await rpcEndpointPool(settingsOverride)).acquire();
  }

  /**
   * The URL the next operation would start on, **without acquiring anything**.
   *
   * Used by the two places that want to compare URLs rather than talk to a node — `sync.cached()`
   * and the staleness check at the end of a scan. `rpcClient()` may probe an endpoint before
   * handing it out, and neither of those has any business putting a request on the wire.
   */
  async function currentRpcUrl(settingsOverride) {
    return (await rpcEndpointPool(settingsOverride)).url;
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
      rpcPool = null;
      rpcPoolKey = '';
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
        const known = verdictFor(await currentRpcUrl());
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
        // tip as B's. It re-scans instead. (`currentRpcUrl`, not `rpcClient()`: this compares two
        // strings and must not put a probe on the wire to do it.)
        if ((await currentRpcUrl()) !== url) out.staleNode = true;
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
        if ((await currentRpcUrl()) !== url) out.staleNode = true;
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

  /**
   * The whole RPL token registry, paged off `rand_getTokens` and validated page by page.
   *
   * **The cursor is the last row's index + 1, and nothing else.** `next_index` is the index the
   * next *registration* will hand out — the END of the registry — and the node sends that same
   * figure on every page (`tokens::next_index()`'s own doc comment, and the node's test asserting
   * `next_index: 3` for a registry whose highest index is 2). `docs/rpc.md` states the paging rule
   * as "a page shorter than `limit` is the last", so the end of the walk is the short page and
   * nothing else decides it. Taking `next_index` as a cursor made the second request jump past
   * every row still unread: a 1 500-token registry came back with its first 1 000 and no error,
   * and each dropped token then rendered through the `unlisted` fallback — nine decimals instead
   * of its own eight, so every balance of it printed ten times too large, with no backings and a
   * Withdraw flow that dead-ends.
   *
   * Two bounds, because the length of this loop is otherwise a remote server's choice: at most
   * `MAX_TOKEN_PAGES` requests, and every page must move the cursor forward or the walk ends.
   */
  const MAX_TOKEN_PAGES = 16;
  async function fetchTokenRegistry(client) {
    const tokens = [];
    const seen = new Set();
    // Set only when the walk ends by the node's own end rule (a short page): the one ending that
    // means "this is the whole registry". A validation break, a non-advancing page or the page
    // cap all mean "this is as far as we got".
    let complete = false;
    let from = 0;
    for (let page = 0; page < MAX_TOKEN_PAGES; page += 1) {
      let reply;
      try {
        reply = checkTokens(await client.getTokens(from, MAX_TOKEN_PAGE), { from });
      } catch (err) {
        // A page that is not an answer to the request — unordered, below the start it was asked
        // from, malformed — ends the walk: what was already collected was fully validated and is
        // kept FOR DISPLAY, and the cursor never moves past data that was not read. With NOTHING
        // collected there is no prefix to keep, so the failure propagates: caching an empty
        // registry then would turn "the node's answer was garbage" into "this chain has no
        // tokens". The prefix is deliberately not written over the cache either (see `complete`):
        // a transient bad page must not shrink a good registry the wallet already had.
        if (err instanceof NodeReplyError && tokens.length > 0) break;
        throw err;
      }
      for (const t of reply.tokens) {
        if (seen.has(t.index)) continue;
        seen.add(t.index);
        tokens.push(t);
      }
      // The node's own rule for where the registry ends. `next_index` is deliberately not read.
      if (reply.tokens.length < MAX_TOKEN_PAGE) { complete = true; break; }
      const next = reply.tokens[reply.tokens.length - 1].index + 1;
      if (next <= from) break; // a page that did not advance is not a page to follow
      from = next;
    }
    return { tokens, complete };
  }

  const assets = {
    /**
     * RAND (index 0) first, then every token the chain's registry lists **or** this wallet holds
     * a note of. See `ui/backend.js` for the exact row shape.
     *
     * Chain 14 is where this stopped being a guess. `rand_getTokens` carries a token's real
     * `name`, `symbol`, `decimals` and `id_text`, and — for a bridged one — **every backing coin**
     * that holds its value. Before it, the only registry was `rand_getAssets`, which has none of
     * those, so a token was `RPL#<index>` at nine decimals; a bridged token is eight decimals on
     * Rand, so that fallback now misprints every balance it is used for and is kept for exactly
     * one case: an index this wallet holds notes of that the node does not list. That row says so
     * (`unlisted: true`) rather than passing a guess off as the chain's word.
     *
     * `backings` replaces chain 13's single `chain`/`token` pair, because one token can be backed
     * by several coins on several chains (zUSD is seven) and a burn names the one it redeems. The
     * old shape kept whichever row was read last.
     *
     * The registry is cached, so a reload — or an offline start — opens on the names it had.
     *
     * **The registry is read through the chain gate**, like every other node read in this file
     * that shapes a transaction. It was not, and on chain 13 that was harmless, because a token's
     * `decimals` was the local constant `FALLBACK.decimals` and the reply carried nothing else a
     * transaction depended on. On chain 14 the node supplies `decimals`, and it is the number
     * `parseUnits(text, asset.decimals)` scales **every amount the user types** by, in the send
     * flow and the withdraw flow alike. A node that inflated it by one would have a user send, or
     * burn, ten times what they meant — and the burn pre-flight would not catch it, because
     * `burn_is_possible` checks the release unit against the **backing's source** decimals off the
     * verified bridge state and never looks at the token's Rand-side decimals.
     *
     * The gate sits inside the existing try/catch, so a node that cannot be verified — a wrong
     * chain, an unreachable one — degrades to exactly what being offline already did: the names
     * this wallet already had. Nothing from an unverified node is used, and nothing from one is
     * written to the cache. RAND's own row needs no node at all and is built either way.
     *
     * It costs no extra round trip in practice: `requireVerifiedChain()` caches its verdict per
     * URL for the session, so the two identity calls happen once however many screens call this.
     */
    async list() {
      const k = await constants();
      const st = await loadNotes();
      const decimals = Number(k.token_decimals) || FALLBACK.decimals;

      let registry = (await storage.get(K.tokens)) || [];
      try {
        const { client } = await requireVerifiedChain();
        const fresh = await fetchTokenRegistry(client);
        registry = fresh.tokens;
        // Only a COMPLETED walk is cached. A prefix (a bad page ended the walk early) is shown
        // for the session but never written: persisting it would shrink a good registry the
        // wallet already had down to what one corrupted reply let through.
        if (fresh.complete) await storage.set(K.tokens, fresh.tokens);
      } catch { /* unverifiable, offline, or a chain with no tokens: the cache still answers */ }

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
      // An index this wallet holds notes of that the registry does not list: a token registered
      // after the cache was written, a node serving a partial registry, or a chain that has moved
      // on. The notes are real either way, so the balance is shown — under a name the wallet made
      // up, and marked as such.
      for (const index of balances.keys()) if (index >= 1 && !byIndex.has(index)) byIndex.set(index, null);

      for (const index of [...byIndex.keys()].sort((a, b) => a - b)) {
        const row = byIndex.get(index);
        const balance = (balances.get(index) || 0n).toString();
        if (!row) {
          out.push({
            index, id: `rpl-${index}`, symbol: `RPL#${index}`,
            decimals: FALLBACK.decimals, balance, pending: '0', unlisted: true,
          });
          continue;
        }
        const asset = {
          index, id: row.id, symbol: row.symbol, decimals: row.decimals, balance, pending: '0',
        };
        if (row.name) asset.name = row.name;
        if (row.idText) asset.idText = row.idText;
        // Present only for a token something is actually backing. A native RPL token has none,
        // and RAND is this chain's own coin and is not in this list at all.
        if (row.backings && row.backings.length > 0) asset.backings = row.backings.map((b) => ({ ...b }));
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
     * A real estimate: the node's own minimum bundle fee, and the core's own plan over this
     * wallet's notes. A plan that cannot be built rejects with the core's message, which is
     * written for the user (it is what tells them to consolidate, or that they hold no RAND for
     * the fee).
     *
     * Chain 14 made this one call for RAND and for a token alike. `asset` goes through to
     * `plan_transfer` unchanged, and the two additive fields are the second group's: `feeInputs`
     * is how many RAND notes pay the fee (always 0 for RAND, whose fee comes out of `inputs`) and
     * `feeChange` is the RAND change that group leaves. `change` is in units of `asset`.
     */
    async estimate(req = {}) {
      const { client } = await requireVerifiedChain();
      const asset = Number(req.asset) || 0;
      const fee = await bundleFee(client);
      const st = await loadNotes();
      const plan = await c.planTransfer({
        notes: st.notes || [], asset, amount: toUnits(req.amount).toString(), fee: fee.toString(),
      });
      return {
        fee: String(plan.fee ?? fee),
        inputs: (plan.inputs || []).length,
        feeInputs: (plan.fee_inputs || []).length,
        change: String(plan.change ?? '0'),
        feeChange: String(plan.fee_change ?? '0'),
        // From the plan, never a constant: it is the chain's number of proofs. On chain 14 it is
        // 1 for a transfer of anything, and 1 for a burn.
        proofs: Number(plan.proofs) || 1,
      };
    },

    /**
     * The largest amount this wallet can actually send, from the core's own `max_sendable` — which
     * is held to agree with `plan_transfer` by a property test in the crate, rather than being a
     * second selection rule written here in JavaScript (it was, and "the largest N notes less the
     * fee" is only true of RAND).
     *
     * For a token the fee is RAND out of the other group, so it is **not** subtracted; `reason` is
     * set only when a zero answer is the RAND fee's fault, and a screen showing "you can send 0"
     * has the core's sentence to show with it.
     */
    async maxSendable({ asset = 0 } = {}) {
      const { client } = await requireVerifiedChain();
      const fee = await bundleFee(client);
      const st = await loadNotes();
      const max = await c.maxSendable({
        notes: st.notes || [], asset: Number(asset) || 0, fee: fee.toString(),
      });
      const out = { amount: String(max.amount ?? '0'), fee: String(max.fee ?? fee) };
      if (max.reason) out.reason = max.reason;
      return out;
    },

    /**
     * `(req, onPhase, options?)` — the contract's signature. `canProve()` answers first, and
     * always without touching the network: a shell that *structurally* cannot prove (wasm:
     * ~5.7 GB against a 4 GiB address space) should say so before asking anything of a node — that
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
   * Everything a withdrawal can be refused for **without proving anything**, in one place.
   *
   * `bridge.estimate` and `bridge.withdraw` both run it, and that is the point: they used to carry
   * two lists and `withdraw`'s was the shorter — a zero amount and a relayer fee larger than the
   * amount were refused when the user pressed Review and not when they pressed Withdraw, so a
   * flow that reached the button by any other route paid ~100 seconds and ~5.7 GB for a
   * transaction the chain always refuses. The order is the cheapest question first: the shape of
   * the request, then the one question that needs a node (`rand_getBridgeState`), then the four
   * only the chain can answer, which go to the core whole.
   *
   * `verified` is OPTIONAL and is `requireVerifiedChain()`'s return value. A caller that has
   * already taken one passes it in, so the bridge state is read from **the same client** the burn
   * itself will run on rather than from a second acquisition: one verified client per operation is
   * the invariant the whole of this file is built around, and "the gate's client for the proof,
   * some other client for the facts that decide whether to prove" would be a hole in it.
   *
   * Returns `{client, url, identity, state, asset, amount, relayerFee, toChain, token}` — the
   * verified client and the parsed request — or throws a `definite` error written for the user.
   */
  async function screenBurn(req = {}, verified) {
    const asset = Number(req.asset);
    if (!Number.isInteger(asset) || asset < 1) throw definite(RAND_NOT_BRIDGED_TEXT);
    const amount = toUnits(req.amount);
    const relayerFee = toUnits(req.relayerFee ?? '0');
    if (amount <= 0n) throw definite('A withdrawal of zero moves nothing.');
    // The chain's own rule (`relayer_fee <= amount`), and the one the user is most likely to trip.
    if (relayerFee > amount) throw definite('The relayer fee is more than the amount being withdrawn.');
    const toChain = Number(req.toChain);
    const token = String(req.token || '');
    const gate = verified || (await requireVerifiedChain());
    const state = checkBridgeState(await gate.client.bridgeState());
    const possible = await burnIsPossible(c, state, asset, toChain, token, amount, relayerFee);
    if (!possible.ok) throw definite(possible.reason);
    return { ...gate, state, asset, amount, relayerFee, toChain, token };
  }

  /**
   * OPTIONAL in the Backend contract (ui/backend.js): present only where a shell supplied an
   * `executeWithdraw`. Everything here is shell-independent; the one shell-specific thing — how a
   * burn that CAN be proved is actually carried out — is that parameter, exactly as `executeSend`
   * is for a transfer.
   *
   * The whole reason this group exists rather than the screen calling `rpc.call` itself: a burn
   * costs a bundle proof, about a minute and a half and ~5.7 GB, and there are four ways to spend
   * that on a transaction the chain will refuse outright — a disabled bridge, an unregistered
   * index, a coin that does not back the asset, and a coin that is not holding enough of it.
   * `wallet-core` cannot check any of them on its own (it does no I/O), so `screenBurn` puts the
   * whole question to its `burn_is_possible` with a fetched bridge state, before `executeWithdraw`
   * is called at all.
   */
  const bridge = {
    /**
     * `{enabled, chains, mintPaused}` — whether this chain has a bridge, the chains it can burn
     * to, and whether minting is paused (deposits refused; burns unaffected).
     *
     * `chains` is derived from the node's `emitters` map; there is no `chains` field on the wire.
     * See `checkBridgeState` (engine/validate.js) for the reply's real shape.
     */
    async state() {
      const { state } = await bridgeStateFull();
      return { enabled: state.enabled, chains: state.chains, mintPaused: state.mintPaused };
    },

    /**
     * Whether a withdrawal can be attempted **on this device, on this chain**, in that order.
     *
     * `canProve()` answers first and without touching the network — the same question, and the
     * same sentence, a transfer asks (`send.canProve`): a burn is a bundle proof, the same one a
     * transfer is, so a shell that cannot produce one cannot withdraw. Since `canProve()` is
     * unconditionally false on every wasm shell, so is this, and no node is ever asked there.
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
     * feeChange, proofs}`. The real coin selection, over this wallet's real notes, via the core's
     * own `plan_burn` — so a selection that cannot be built fails here, for nothing, instead of
     * after a proof.
     *
     * `fee` is the RAND fee; `relayerFee` is in units of the asset and is deducted **on the
     * destination chain**, out of `amount` — so `receive` is `amount - relayerFee` and the two
     * never add up to more than the burn.
     */
    async estimate(req = {}) {
      const { asset, amount, relayerFee } = await screenBurn(req);
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
        // On chain 14 a burn is one bundle and one proof; it was two.
        proofs: Number(plan.proofs) || 1,
      };
    },

    /**
     * `(req, onPhase, options?)` — `{asset, amount, relayerFee, toChain, token, to, fee?}` in,
     * `{hash}` out. Phases: `'selecting' | 'witness' | 'proving' | 'submitting' | 'confirming'`.
     *
     * The order of the gates is the point. `canProve()` first, because it needs no node and its
     * answer can never be wrong; then the verified-chain gate, which is every other operation's;
     * then `screenBurn` — the same list `estimate` runs, ending in the core's own
     * `burn_is_possible` off the client that gate proved. Only then is a proof started.
     */
    async withdraw(req = {}, onPhase, options = {}) {
      // A burn is user-initiated work that takes minutes; the idle timer must not cut it in half.
      const release = holdUnlock();
      try {
        const { ok, reason } = await canProve();
        if (!ok) throw definite(reason);
        // ONE verified client for the whole operation: taken here, handed to `screenBurn` so its
        // `rand_getBridgeState` is that node's answer, and threaded into `executeWithdraw`.
        const verified = await requireVerifiedChain();
        const { client, url, identity } = verified;
        const { asset, token } = await screenBurn(req, verified);
        const fee = req.fee === undefined || req.fee === null ? (await burnFee()).toString() : String(req.fee);
        return await executeWithdraw({
          req: { ...req, asset, token, fee }, onPhase, options, client, url, identity, reason,
          // `engine.burn` narrowed to the one capability, for the same reasons `sendTransfer` is
          // (see this file's header): one `makeWallet`, one writer of the note store. Nothing else
          // of the engine is handed over, and nothing that is not read is handed over either —
          // `bridgeState` and `burnFee` used to ride along here and neither was ever touched.
          sendBurn: (spendKey, opts) => engine.burn(spendKey, opts),
          requireUnlocked,
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
