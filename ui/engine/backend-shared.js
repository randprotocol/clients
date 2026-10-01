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
//   canProve()   -> Promise<{ok, reason?}>   whether THIS DEVICE can prove. Called first, before
//                    any network access, because "this shell cannot prove at all" can never be
//                    wrong and costs nothing to say. Where it says no, this file asks a prover the
//                    user paired as their own (delegated proving, `prover` group below) and, if one
//                    answers, `send.canProve` is `{ok: true, via: 'prover'}` — the node is still
//                    never asked.
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
//                    usually has no reason to report). `via` is `'prover'` when the proof will be
//                    made by a paired prover (then `sendTransfer` already carries the engine's
//                    `prove` hook, and a shell whose device cannot prove runs the transfer exactly
//                    as one that can — `ui/engine/execute.js`), `undefined` for the device.
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
import { encryptSecret, decryptSecret, checkVault, isVaultRecordError, sealWithPasskey, openWithPasskey } from './crypto.js';
import { makeRpc, isAllowedRpcMethod, rpcUrlList } from './rpc.js';
import { makeWallet, coreApi, emptyNoteStore, activity as activityRows, toUnits, isSpendable, abortError, HEIGHT_SPAN, envelopeBytesOf } from './wallet.js';
import { LEGACY_ENVELOPE_CHAIN_IDS } from '../lib/memo.js';
import { listContacts, addContact, removeContact, nameOf as contactNameOf, addressOf as contactAddressOf, CONTACTS_KEY } from '../lib/contacts.js';
import { checkFee, checkTokens, checkSubmitted, checkBridgeState, checkLimits, checkProgramCells, MAX_TOKEN_PAGE, NodeReplyError } from './validate.js';
import {
  PENDING_PROOF_KEY, checkProverUrl, makeProverClient, readInfo, remoteProve, startRemoteProof, pollRemoteProof,
  pendingProof, cancelPendingProof,
} from './prover.js';
import { runPhased } from './execute.js';
import { normalizeInvokeRequest, invokeEffects, invokeError } from './invoke.js';

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
  // Address-book entries, `{entries: {name: address}}` (ui/lib/contacts.js, spec 2026-09-26
  // §3.3). Public facts only — an address is shared to be paid — and cleared with everything
  // else by a wipe.
  contacts: CONTACTS_KEY,
  failures: 'unlockFailures',
  unlocked: UNLOCKED_SESSION_KEY,
  // Delegated proving (plan 2026-09-28, ruling R2): the pairing, as a second vault record
  // (`encryptSecret(password, JSON {token, kemEk, url, fingerprint})`) beside the spend key's.
  // Never in `settings`: a token is a bearer credential for a machine that receives the spend key,
  // and the key and URL decide where the spend key is SEALED — so they are under the password
  // too, and `settings.prover` is display only (a tampered plaintext copy cannot redirect a job).
  // Decrypted on unlock into the session record (`prover`), where the spend key already is.
  proverToken: 'proverToken',
  // The passkey unlock record ("Unlock with Touch ID"): `{credentialId, salt, v, iv, ct}`, the
  // password sealed under the passkey's PRF output (engine/crypto.js `sealWithPasskey`).
  passkey: 'passkeyUnlock',
  // SESSION, not persistent (ruling R1): the one remote proof in flight, `{job, pending, url, name,
  // startedAt, kind, to?, memo?}` — `pending` is the core's, and carries no spend key. It is what
  // a popup closed mid-proof resumes from; it is cleared on lock like the spend key.
  pendingProof: PENDING_PROOF_KEY,
  // The one-time notice before the first send through the RandProtocol prover (the default, wallet
  // 0.6.8): `{pk}` of the wallet that read it. A wipe clears it with everything else, and a record
  // naming another wallet's key counts for nothing.
  proverNotice: 'proverNotice',
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
 * `rpcUrls` is the **default endpoint set**: today exactly one, `https://rpc.randprotocol.org` —
 * the core's own `default_rpc_url`, the mobile apps' default, and the one public endpoint that
 * exists (live since 2026-09-21, CORS-open, chain 14). The three-host set this used to ship
 * (rpc1/rpc2/rpc3) never resolved — NXDOMAIN — so a fresh wallet's first scan probed three dead
 * hosts and reported "No answer". When more than one public endpoint exists the list grows again
 * in a release, and the failover in engine/rpc.js makes standing them up one at a time
 * uneventful. A future core that reports `default_rpc_urls` overrides it, exactly as
 * `default_chain_id` overrides `chainId`.
 */
const FALLBACK = Object.freeze({
  rpcUrls: Object.freeze([
    'https://rpc.randprotocol.org',
  ]),
  explorerUrl: 'https://randscan.org',
  chainId: 20,
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
 * and the one that disagreed would cost the user a ~100-second, ~6.2 GB proof for a transaction
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
    // The memo sealed with the note (spec 2026-09-26 §2.3), only when there is one: a note from
    // before the memo, or one sent without, has no field at all.
    ...memoField(n.memo),
  };
}

/** `{memo}` for a non-empty string, `{}` otherwise. The text is the sender's, and screens render
 *  it as a text node only. */
function memoField(memo) {
  return typeof memo === 'string' && memo !== '' ? { memo } : {};
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
    const item = { kind: 'in', asset: Number(row.asset) || 0, amount: String(row.amount), time: at(row.height), index: Number(row.index), ...memoField(row.memo) };
    if (hash) item.hash = hash;
    if (row.height) item.block = Number(row.height);
    return item;
  }
  if (row.kind === 'sent') {
    const item = { kind: 'out', asset: Number(row.asset) || 0, amount: String(row.amount), time: at(row.height), ...memoField(row.memo) };
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
    ...memoField(sub.memo),
  };
  if (sub.hash) base.hash = sub.hash;
  if (sub.height) base.block = Number(sub.height);
  if (sub.fee) base.fee = String(sub.fee);
  if (!settled) base.status = 'pending';
  return base;
}

export function makeSharedBackend({
  core, storage, platform, fetch: fetchImpl, locks, broadcast, canProve, executeSend, executeWithdraw,
  proverOptions,
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
      // Read back by `proverSettingFor` (the RandProtocol prover by default where the build ships
      // one); the `prover` group writes it, `settings.set` cannot.
      prover: { mode: 'device' },
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

  /**
   * The RandProtocol provers every client ships (`version.trusted_prover_pool`, wallet 0.6.9;
   * audit v7 VK-9): `{name, members: [{name, url, fingerprint, link}]}` — each member with its OWN
   * key — or `null` when this build carries none. A member's link holds its public pairing token,
   * which every copy of the wallet ships: not this wallet's secret, but never handed to a screen.
   */
  async function builtInPool() {
    const t = (await constants()).trusted_prover_pool;
    if (!t || typeof t !== 'object' || !Array.isArray(t.members)) return null;
    const members = t.members
      .filter((m) => m && typeof m === 'object' && typeof m.link === 'string' && m.link && typeof m.url === 'string' && typeof m.fingerprint === 'string')
      .map((m) => ({ name: String(m.name || ''), url: m.url, fingerprint: m.fingerprint, link: m.link }));
    if (members.length === 0) return null;
    return { name: String(t.name || 'RandProtocol'), members };
  }

  /** What a screen may see of the pool: no links. */
  function poolForScreens(pool) {
    return { name: pool.name, members: pool.members.map(({ name, url, fingerprint }) => ({ name, url, fingerprint })) };
  }

  /**
   * `settings.prover` as read back, from what is stored (written by the `prover` group alone):
   *   * `{mode: 'remote', name, url, kemEk, fingerprint, own}` — a prover the user paired, which is
   *     preferred over the default;
   *   * `{mode: 'default', name, members: [{name, url, fingerprint}]}` — nothing chosen, and this
   *     build ships the RandProtocol provers: they make the proofs this device cannot (the default
   *     since wallet 0.6.8; a pool of members with their own keys since 0.6.9);
   *   * `{mode: 'device'}` — the user chose no prover (`prover.useNone`), or the build ships none.
   * A stored `{mode: 'device'}` is what every earlier build wrote back on any `settings.set`, never
   * a choice, so it reads as the default. Nothing else stored under it (a token, above all) is read.
   */
  async function proverSettingFor(p) {
    if (p && typeof p === 'object' && p.mode === 'remote') {
      const str = (v) => (typeof v === 'string' ? v : '');
      return {
        mode: 'remote', name: str(p.name), url: str(p.url), kemEk: str(p.kemEk),
        fingerprint: str(p.fingerprint), own: p.own === true,
      };
    }
    if (p && typeof p === 'object' && p.mode === 'none') return { mode: 'device' };
    const pool = await builtInPool();
    return pool ? { mode: 'default', ...poolForScreens(pool) } : { mode: 'device' };
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
    // `chainId` likewise: no screen sets it, it is the chain this build's core was made for, and
    // `setSettings` used to write it back with everything else — so every wallet that ever changed
    // its theme had chain 14 pinned in storage, and moving the core to chain 16 moved nobody.
    const merged = { ...base, ...stored, rpcUrls: base.rpcUrls, chainId: base.chainId, prover: await proverSettingFor(stored.prover) };
    // Migration (task 5.0). `setSettings` writes the WHOLE settings object back, defaults
    // included, so anyone who ever changed their theme while `rpc.randprotocol.org` was the
    // single default has it sitting in storage as `rpcUrl`. Read as an override it would pin
    // that wallet to the host it was stored against — fine today, when the default endpoint set
    // is that very host again (the filter is inert by design: dropping it lands on the same
    // URL), but the day the default moves on, these wallets must move with it rather than stay
    // pinned to a host they never chose. It was never a choice the user made, so it is not
    // treated as one — and a host the user typed deliberately is still stored and honoured.
    const k = await constants();
    const retired = rpcUrlList(k.default_rpc_url || 'https://rpc.randprotocol.org')[0];
    if (retired && rpcUrlList(merged.rpcUrl || '')[0] === retired && !merged.rpcUrls.includes(retired)) merged.rpcUrl = '';
    return merged;
  }

  async function setSettings(patch) {
    const previous = await getSettings();
    const next = { ...previous, ...(patch || {}) };
    // `prover` is written by the `prover` group only — pairing checks the prover's key and puts
    // its token in the vault; a screen writing `settings.prover` directly would do neither. What
    // is stored goes back exactly as it was (never the read-back form: a `default` written back
    // would pin a choice the user never made).
    const storedProver = ((await storage.get(K.settings)) || {}).prover;
    if (storedProver) next.prover = storedProver; else delete next.prover;
    // **`rpcUrls` is read-only, and that is enforced here rather than asked for in a comment.**
    // This function writes the whole merged object, so without this line the FIRST `settings.set`
    // a wallet ever makes — a theme change, an auto-lock change, anything at all — would freeze
    // the default endpoint set of that build into storage, where it would win every future merge
    // for ever. A screen that tried to write one simply cannot; `ui/backend.js`'s contract says
    // as much, and now the implementation says it too.
    const { rpcUrls: readOnly, chainId: fromCore, ...persisted } = next;
    void readOnly; void fromCore;
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
    // Ruling R1: a pending remote proof lives exactly as long as the unlocked session does.
    try { await storage.session.remove(K.pendingProof); } catch { /* nothing to remove */ }
  }

  /**
   * `{token, kemEk, url, fingerprint, own}` from a decrypted pairing record, or `undefined` when it
   * is not one (a pre-release record holding the bare token included: that pairing must be made
   * again). `own` is whether the pairing link said `own=1` — what decides whether this prover may
   * ever be sent a spend-key witness — and it is read from HERE, the sealed record, never from the
   * plaintext `settings.prover`. A record written before it was kept (Phase 1) reads `false`: such
   * a prover is sent viewing-key jobs only, which is every job on a split-authorisation chain.
   */
  function pairingOf(value) {
    let v = value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return undefined; } }
    if (!v || typeof v !== 'object') return undefined;
    const { token, kemEk, url, fingerprint } = v;
    if (![token, kemEk, url, fingerprint].every((x) => typeof x === 'string' && x)) return undefined;
    return { token, kemEk, url, fingerprint, own: v.own === true };
  }

  /**
   * The paired prover's vault record (`pairingOf`), opened with the password that just opened the
   * vault, or `undefined` when there is none. A record that will not open (damaged, or written under
   * a password since changed) costs the prover, never the unlock: the wallet opens, and a send
   * through the prover says to pair it again.
   */
  async function openProverPairing(password) {
    const rec = await storage.get(K.proverToken);
    if (!rec) return undefined;
    try { return pairingOf(await decryptSecret(password, rec)); } catch { return undefined; }
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

  /**
   * Records a freshly created/imported/unlocked wallet. The vault is written first. `pairing` is
   * the paired prover's `{token, kemEk, url, fingerprint}`, decrypted with the same password
   * (ruling R2), when there is one.
   */
  async function startSession(info, pairing) {
    const record = { spend_key: info.spend_key, viewing_key: info.viewing_key };
    const p = pairingOf(pairing);
    if (p) record.prover = p;
    await storage.session.set(K.unlocked, record);
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
      await startSession(info, await openProverPairing(password));
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

  // --------------------------------------------------------------- delegated proving ----------
  // Plans 2026-09-28 (Phase 1 and Phase 2). A shell that cannot prove on this device — every wasm
  // shell, and a desktop without the memory — may have its BUNDLE proof made by a paired prover.
  // On a split-authorisation chain (bundle guest v3: every chain since 17) the job the core seals
  // carries the viewing key and a salt, never the spend key: the prover can read this wallet's
  // history and cannot spend, so any paired prover may have it, and the spend authorisation — the
  // auth proof — is made on this device by the core's `prepare_*`. On an older chain the job
  // carries the spend key and goes only to a prover paired as the user's OWN. Which it is follows
  // the chain's guest and is the core's decision (`chain_guests`), and `finish_proof` checks
  // whatever comes back before anything is submitted.

  async function writeProverSetting(value) {
    const stored = (await storage.get(K.settings)) || {};
    if (value) stored.prover = value; else delete stored.prover;
    await storage.set(K.settings, stored);
  }

  /**
   * Whether the prover's reported key is the pairing's: its `kem_ek` must be the one the link
   * named, and the fingerprint is recomputed by the core from that key — the prover's own
   * `kem_fingerprint` is its word, not evidence.
   */
  async function sameProverKey(info, kemEk, fingerprint) {
    if (!info.kemEk || info.kemEk !== kemEk) return false;
    let fp;
    try { fp = await c.proverFingerprint(info.kemEk); } catch { return false; }
    return typeof fp === 'string' && fp === fingerprint;
  }

  function proverClientFor(url) {
    return makeProverClient({ fetch: fetchImpl, url });
  }

  const proverTiming = {
    ...(proverOptions && Number.isFinite(proverOptions.poll) ? { poll: proverOptions.poll } : {}),
    ...(proverOptions && Number.isFinite(proverOptions.maxWait) ? { maxWait: proverOptions.maxWait } : {}),
    ...(proverOptions && Number.isFinite(proverOptions.maxQueueWait) ? { maxQueueWait: proverOptions.maxQueueWait } : {}),
  };

  /**
   * OPTIONAL in the contract: the `prover` group. Pairing reads the link through the core
   * (`parse_prover_link` — the key, the URL, the token, `own`, the fingerprint), holds the URL to
   * the node's rule, asks the prover itself for its key and refuses a prover whose key is not the
   * one the link names; only then is anything stored — the token, key and URL together in the vault
   * (never in `settings`), and a display copy in `settings.prover`.
   */
  /**
   * What a prover learns from a viewing-key job — the core's sentence (`version`'s
   * `prover_history_warning`), so every shell says the same thing. `preview` returns it as
   * `warning` for a link that is not marked as the user's own, and a screen shows it before the
   * pairing is saved. (A prover of the user's own learns exactly as much; it is theirs.)
   */
  async function historyWarning() {
    const k = await constants();
    return String(k.prover_history_warning || 'This prover will be able to read this wallet\'s whole history. It cannot spend.');
  }

  /** `prover_info.fee` as a sentence when it is a fee, `null` when the prover charges nothing. */
  async function feeRefusal(fee) {
    if (fee === null || fee === undefined) return null;
    const amount = fee && typeof fee === 'object' && typeof fee.amount === 'string' ? fee.amount : '';
    if (/^0+$/.test(amount)) return null;
    let shown = '';
    if (/^[0-9]{1,20}$/.test(amount)) { try { shown = ` of ${await c.formatAmount(amount)} RAND`; } catch { shown = ''; } }
    return `it charges a fee${shown} per proof, which this version of the wallet does not pay`;
  }

  async function probeAt(p) {
    if (!p || typeof p.url !== 'string' || !p.url || (p.mode !== undefined && p.mode !== 'remote')) {
      return { ok: false, reason: 'No prover is paired.' };
    }
    let info;
    try {
      info = readInfo(await proverClientFor(p.url).info());
    } catch (err) {
      return { ok: false, reason: `the prover at ${p.url} did not answer (${(err && err.message) || err})` };
    }
    if (!(await sameProverKey(info, String(p.kemEk || '').toLowerCase(), p.fingerprint))) {
      return { ok: false, reason: 'the prover at that address now has a different key; pair it again' };
    }
    return { ok: true, queue: info.queue, witnessKinds: info.witnessKinds, fee: info.fee, hcBundles: info.hcBundles };
  }

  /**
   * The pool's members as pairings — `[{token, kemEk, url, fingerprint, own: false, name, member}]`
   * — each read through the core from the link the build ships and held to that member's pinned
   * fingerprint, its pinned URL, the URL rule and `own=0`: a member whose link fails any of it is
   * left out (the others keep working), and is never asked anything. In `memberOrder` (a fresh
   * random order per call unless `proverOptions.memberOrder` says otherwise — the test seam).
   * Rejects (definite) when no member is left.
   */
  async function poolPairings() {
    const fail = (message) => { const err = new Error(message); err.definite = true; return err; };
    const pool = await builtInPool();
    if (!pool) throw fail('This build ships no prover to use.');
    const out = [];
    for (const m of pool.members) {
      let parsed;
      try { parsed = await c.parseProverLink(m.link); } catch { continue; }
      if (!m.fingerprint || String(parsed.fingerprint) !== m.fingerprint) continue;
      if (parsed.own === true) continue;
      const checked = checkProverUrl(parsed.url);
      if (checked.error || checked.url !== checkProverUrl(m.url).url) continue;
      out.push({
        token: String(parsed.token), kemEk: String(parsed.kem_ek).toLowerCase(), url: checked.url,
        fingerprint: String(parsed.fingerprint), own: false, name: `${pool.name} (${m.name})`, member: m.name, pool: pool.name,
      });
    }
    if (out.length === 0) throw fail('None of the built-in RandProtocol prover links names the key this wallet pins for it; not using them.');
    return memberOrder(out);
  }

  /** A fresh random order (Fisher–Yates) — or the test seam's. */
  function memberOrder(members) {
    if (proverOptions && typeof proverOptions.memberOrder === 'function') return proverOptions.memberOrder(members.slice());
    const a = members.slice();
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /**
   * Whether one member can take a job NOW: `{ok: true, info}` or `{ok: false, busy?, reason}` —
   * not answering, another key than its pin, a fee, no viewing-key jobs, or a full queue
   * (`queue.depth >= queue.max`).
   */
  async function memberReady(m, { signal } = {}) {
    let info;
    try {
      info = readInfo(await proverClientFor(m.url).info(signal ? { signal } : undefined));
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      return { ok: false, reason: `${m.member} did not answer` };
    }
    if (!(await sameProverKey(info, m.kemEk, m.fingerprint))) return { ok: false, reason: `${m.member} answered with another key than the one this wallet pins` };
    const fee = await feeRefusal(info.fee);
    if (fee) return { ok: false, reason: `${m.member}: ${fee}` };
    if (!info.witnessKinds.includes('viewing_key')) return { ok: false, reason: `${m.member} does not take this wallet's jobs` };
    if (info.queue && info.queue.max > 0 && info.queue.depth >= info.queue.max) return { ok: false, busy: true, reason: `${m.member} is busy` };
    return { ok: true, info };
  }

  /** "Every member is busy" / "none can be reached", plainly, with the way out. */
  function poolUnavailable(poolName, results, lead = '') {
    const allBusy = results.length > 0 && results.every((r) => r.busy);
    const err = new Error(allBusy
      ? `${lead}The ${poolName} provers are all busy right now; try again in a minute, or pair your own prover in Settings.`
      : `${lead}The ${poolName} provers cannot be reached right now (${results.map((r) => r.reason).join('; ')}). Try again later, or pair your own prover in Settings.`);
    err.definite = true;
    if (allBusy) err.busy = true; else err.unreachable = true;
    return err;
  }

  /** Whether THIS wallet has read the one-time notice about the RandProtocol prover. */
  async function defaultNoticeRead() {
    const rec = await storage.get(K.proverNotice);
    const w = await storage.get(K.wallet);
    return !!(rec && w && typeof rec.pk === 'string' && rec.pk && rec.pk === w.pk);
  }

  const prover = {
    /**
     * What a link names, read through the core and held to the URL rule, WITHOUT saving it or
     * asking anybody: `{url, fingerprint, own, warning?}`. A screen calls it to learn the host it
     * must ask permission for, and to show the fingerprint, before `pair`. Never the token.
     */
    async preview(link) {
      const parsed = await c.parseProverLink(String(link || '').trim());
      const checked = checkProverUrl(parsed.url);
      if (checked.error) throw new Error(checked.error);
      const own = parsed.own === true;
      return { url: checked.url, fingerprint: String(parsed.fingerprint), own, ...(own ? {} : { warning: await historyWarning() }) };
    },

    async pair(link, password, { name } = {}) {
      // The password first, before any network: the token is sealed under it, and a token sealed
      // under a mistyped password would silently never open at the next unlock.
      const key = await openVault(password);
      if (!key) throw new Error('wrong password');
      const parsed = await c.parseProverLink(String(link || '').trim());
      const checked = checkProverUrl(parsed.url);
      if (checked.error) throw new Error(checked.error);
      let info;
      try {
        info = readInfo(await proverClientFor(checked.url).info());
      } catch (err) {
        throw new Error(`The prover at ${checked.url} did not answer: ${(err && err.message) || err}`);
      }
      const kemEk = String(parsed.kem_ek).toLowerCase();
      if (!(await sameProverKey(info, kemEk, parsed.fingerprint))) {
        throw new Error('The prover at that address has a different key from the one the link names. Do not pair it.');
      }
      // Everything that decides where a witness goes — and whether it may ever be a spend-key
      // one (`own`) — is sealed under the password together; `settings.prover` below is what a
      // screen shows, and nothing reads a seal target from it.
      const pairing = {
        token: String(parsed.token), kemEk, url: checked.url, fingerprint: String(parsed.fingerprint), own: parsed.own === true,
      };
      const vault = await encryptSecret(password, JSON.stringify(pairing));
      await storage.set(K.proverToken, vault);
      const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, 64) : new URL(checked.url).host;
      const setting = {
        mode: 'remote', name: label, url: checked.url, kemEk, fingerprint: parsed.fingerprint, own: parsed.own === true,
      };
      await writeProverSetting(setting);
      // Re-pairing replaces the pairing everywhere it lives: the vault above, and the unlocked
      // session, where a send reads it.
      const session = await unlockedSession();
      if (session) await storage.session.set(K.unlocked, { ...session, prover: pairing });
      return { ...setting };
    },

    /**
     * `{ok: true, queue, witnessKinds, fee, hcBundles}` from the paired prover, or `{ok: false,
     * reason}`. While unlocked it asks the vault's pairing (the one a send seals to); locked, the
     * display copy in `settings.prover`.
     */
    async probe() {
      const session = await unlockedSession();
      const paired = session && pairingOf(session.prover);
      if (paired) return probeAt(paired);
      const p = (await getSettings()).prover;
      if (p && p.mode === 'default') {
        // The RandProtocol provers, each by the key the build pins for it: the first that can
        // take a job answers for the pool, with its name.
        let members;
        try { members = await poolPairings(); } catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; }
        const results = [];
        for (const m of members) {
          const r = await memberReady(m);
          if (r.ok) return { ok: true, member: m.member, queue: r.info.queue, witnessKinds: r.info.witnessKinds, fee: r.info.fee, hcBundles: r.info.hcBundles };
          results.push(r);
        }
        const err = poolUnavailable(members[0].pool, results);
        return { ok: false, reason: err.message, ...(err.busy ? { busy: true } : {}) };
      }
      return probeAt(p);
    },

    /**
     * The RandProtocol provers every client ships (the core's `version.trusted_prover_pool`: the
     * validators' machines, each with its own key, viewing-key jobs only, no fee) — `{name,
     * members: [{name, url, fingerprint}], warning}` for a screen, or `null` when this build
     * carries none. Nothing is paired or asked by asking.
     */
    async trusted() {
      const pool = await builtInPool();
      if (!pool) return null;
      return { ...poolForScreens(pool), warning: await historyWarning() };
    },

    /**
     * The one-time notice before the first send through the RandProtocol provers:
     * `{name, members, warning, read}` — `read` is whether this wallet has acknowledged
     * it — or `null` when the build ships no such prover. The send and withdraw screens show it
     * when `canProve()` answers `notice: true`, with a way to pair the user's own prover instead.
     */
    async defaultNotice() {
      const pool = await builtInPool();
      if (!pool) return null;
      return { ...poolForScreens(pool), warning: await historyWarning(), read: await defaultNoticeRead() };
    },

    /** The user read the notice: remembered for this wallet (its `pk`), until a wipe. */
    async acknowledgeDefault() {
      const w = await storage.get(K.wallet);
      if (!w || typeof w.pk !== 'string' || !w.pk) throw new Error('no wallet on this device');
      await storage.set(K.proverNotice, { pk: w.pk });
    },

    /**
     * Back to the RandProtocol prover, the default: forgets a paired prover (as `forget`) and a
     * choice of none. Nothing is asked of anybody; the next send this device cannot prove goes to
     * it (after the one-time notice).
     */
    async useDefault() {
      await prover.forget();
    },

    /**
     * No prover at all: forgets a paired one and turns the default off, so proofs are made on this
     * device or not at all (a browser then cannot send; Settings turns one back on).
     */
    async useNone() {
      await prover.forget();
      await writeProverSetting({ mode: 'none' });
    },

    /**
     * Forget the pairing: `settings.prover`, the vault's pairing record and the session's copy.
     * The wallet falls back to the default — the RandProtocol prover, where the build ships one.
     */
    async forget() {
      await writeProverSetting(null);
      await storage.remove(K.proverToken);
      const session = await unlockedSession();
      if (session && 'prover' in session) {
        const { prover: gone, ...rest } = session;
        void gone;
        await storage.session.set(K.unlocked, rest);
      }
    },
  };

  /**
   * `send.canProve`'s answer and, when it is the prover, the pairing to use. The device first (its
   * answer needs nothing but this machine, and a proof made here tells nobody anything); then the
   * paired prover — the user's own or not — answering, charging nothing, and taking a job this
   * wallet can send it: a viewing-key job, or, for a prover paired as the user's own, a spend-key
   * one. Which of the two a given send needs is the chain's and is settled by the core when the
   * job is made (`proveHookFor`); this only rules out a prover that could take neither.
   */
  async function proveRoute() {
    const device = await canProve();
    if (device && device.ok) return { answer: device };
    const { prover: p } = await getSettings();
    if (p && p.mode === 'default') return defaultRoute(device);
    if (!p || p.mode !== 'remote') return { answer: device };
    const probe = await prover.probe();
    const kinds = probe.ok ? probe.witnessKinds : [];
    const why = !probe.ok ? probe.reason
      : (await feeRefusal(probe.fee))
        || (kinds.includes('viewing_key') || (p.own === true && kinds.includes('spend_key')) ? null : 'it does not take this wallet\'s jobs');
    if (why) {
      return { answer: { ok: false, reason: `${(device && device.reason) || 'This device cannot prove.'} Your paired prover is not available: ${why}.` } };
    }
    return { answer: { ok: true, via: 'prover' }, route: p };
  }

  /**
   * The default route: the RandProtocol provers make the proofs this device cannot, with nothing
   * paired (wallet 0.6.8; per-member keys since 0.6.9). The members are asked in a random order:
   * the first that answers with ITS pinned key, charges nothing, takes viewing-key jobs and has
   * room in its queue makes it `{ok: true, via: 'prover', prover: 'default', notice?: true}` —
   * `notice` until this wallet has read the one-time notice — and the route carries every member,
   * in that order, for the hook to fall through on a busy submit. When none can, a plain `{ok:
   * false, unreachable | busy, reason}` that names them and points to Settings.
   */
  async function defaultRoute(device) {
    const lead = device && device.reason ? `${device.reason} ` : '';
    let members;
    try { members = await poolPairings(); } catch (err) {
      return { answer: { ok: false, reason: `${lead}${(err && err.message) || err}` } };
    }
    // How many machines the pool has — what the notice names — whatever order (or subset) a job asks.
    const total = ((await builtInPool()) || { members }).members.length;
    const results = [];
    let first = -1;
    for (let i = 0; i < members.length; i += 1) {
      const r = await memberReady(members[i]);
      if (r.ok) { first = i; break; }
      results.push(r);
    }
    if (first < 0) {
      const err = poolUnavailable(members[0].pool, results, lead);
      return { answer: { ok: false, ...(err.busy ? { busy: true } : { unreachable: true }), provers: total, reason: err.message } };
    }
    // Firefox: the user's consent to send the viewing key to the developer's service is part of
    // the notice — until it is given, the notice stands (its button asks for it).
    const notice = !(await defaultNoticeRead()) || !(await dataCollectionConsented());
    // The member that answered first leads; the rest follow in their random order.
    const ordered = [members[first], ...members.filter((_, i) => i !== first)];
    return {
      answer: { ok: true, via: 'prover', prover: 'default', provers: total, ...(notice ? { notice: true } : {}) },
      route: { mode: 'default', name: members[0].pool, members: ordered },
    };
  }

  /**
   * Whether the browser lets this wallet send its viewing key to the RandProtocol prover: always,
   * except where the platform asks (Firefox's `financialAndPaymentInfo` data-collection permission,
   * `platform.hasDataCollectionConsent`); a check that fails is "no".
   */
  async function dataCollectionConsented() {
    if (!platform || typeof platform.hasDataCollectionConsent !== 'function') return true;
    try { return (await platform.hasDataCollectionConsent()) === true; } catch { return false; }
  }

  /** The refusal of a send through the default prover before its one-time notice was read. */
  function noticeFirst() {
    const err = new Error('Before the first send through the RandProtocol provers, read what they can see: the one that proves it gets this wallet\'s viewing key. Continue on the send screen, or pair your own prover in Settings.');
    err.definite = true;
    err.needsNotice = true;
    return err;
  }

  /**
   * The engine's `prove` hook for one send or withdrawal through `route`, or `undefined` for the
   * device; the RandProtocol provers have their own (`poolProveHook`). The seal target — the prover's key and URL — and the token come from the SESSION's
   * copy of the vault record, never from `route` (= `settings.prover`, plaintext, display only):
   * `route` contributes the name a screen shows and nothing else.
   */
  async function proveHookFor(route) {
    if (!route) return undefined;
    let session;
    try { session = await requireUnlocked(); } catch (err) { err.definite = true; throw err; }
    // The default route's pairing is the build's own link, read again here through the core and
    // held to the pin; a paired prover's comes from the session's copy of the vault record.
    // Never a job to the RandProtocol prover without the browser's consent where it asks for one.
    if (route.mode === 'default' && !(await dataCollectionConsented())) throw noticeFirst();
    if (route.mode === 'default') return poolProveHook(route);
    const pairing = pairingOf(session.prover);
    if (!pairing) {
      const err = new Error('Your prover\'s pairing could not be opened. Lock and unlock the wallet, or pair the prover again in Settings.');
      err.definite = true;
      throw err;
    }
    const { token, kemEk, url, fingerprint, own } = pairing;
    const refuse = (message) => { const err = new Error(message); err.definite = true; return err; };
    return async ({ kind, request, maxProofBytes, hcBundle, hcAuth, meta, onPhase, signal }) => {
      // What this chain's bundle guest takes, from the core, before anything is built: the viewing
      // key on a split-authorisation chain, the spend key on an older one. It also refuses, here,
      // a chain whose guests this build cannot prove for.
      let guests;
      try {
        guests = await c.chainGuests({ hc_bundle: hcBundle ?? null, hc_auth: hcAuth ?? null });
      } catch (err) { throw refuse((err && err.message) || 'This wallet cannot prove for this chain.'); }
      const wants = guests.witness_kind;
      // A spend-key witness goes to a prover paired as the user's own and to no other. The core
      // refuses it too; this says so before the prover is even asked.
      if (wants === 'spend_key' && own !== true) {
        throw refuse('On this chain a proof needs the spend key, which goes only to a prover paired as your own. Pair your own prover in Settings, or send from the desktop app.');
      }
      // The prover as it is NOW: still the key this wallet paired, taking this kind of job, and
      // charging nothing. Its fee is its own to change at any time, so it is read here, at the one
      // point a job is made, and handed to the core, which refuses any.
      const proverClient = proverClientFor(url);
      let info;
      try {
        info = readInfo(await proverClient.info({ signal }));
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        throw refuse(`Your prover did not answer: ${(err && err.message) || err}`);
      }
      if (!(await sameProverKey(info, String(kemEk).toLowerCase(), fingerprint))) {
        throw refuse('The prover at that address now has a different key. Pair it again in Settings.');
      }
      if (!info.witnessKinds.includes(wants)) {
        throw refuse(wants === 'viewing_key'
          ? 'Your prover does not take viewing-key jobs (it is older than this chain). Update it, or pair another.'
          : 'Your prover does not take spend-key jobs. Pair your own prover in Settings, or send from the desktop app.');
      }
      const params = {
        ...request,
        prover: { kem_ek: kemEk, token, own: own === true, fee: info.fee, ...(hcBundle ? { hc_bundle: hcBundle } : {}) },
        ...(maxProofBytes ? { max_proof_bytes: maxProofBytes } : {}),
      };
      // On a split-authorisation chain the core makes the auth proof inside `prepare_*`, from the
      // spend key, on this device: seconds natively, about half a minute in a browser. Reported as
      // its own step of 'prove', so the wait is not silent and says what is happening where.
      if (guests.split_authorisation && typeof onPhase === 'function') onPhase('prove', { prover: route.name, authorising: true });
      const prepared = kind === 'burn'
        ? await c.prepareBurn(params)
        : kind === 'invoke' ? await c.prepareInvoke(params) : await c.prepareTransfer(params);
      return remoteProve({
        client: proverClient, core, prepared, storage,
        meta: { kind, name: route.name, ...(meta || {}) },
        onPhase, signal, locks: locksApi, ...proverTiming,
      });
    };
  }

  /**
   * The `prove` hook through the RandProtocol provers. The members in the route's order: for each,
   * `prover_info` again (ITS pinned key, no fee, viewing-key jobs, room in the queue — a member that
   * fails is skipped), the job sealed by the core to THAT member's key (`prepare_*`, which makes the
   * auth proof here each time), and submitted to it — the transport retry per member; a member that
   * answers busy (-32005) or refuses, or cannot be reached at all, is skipped and the next one asked.
   * Once a member has named a job id, it is polled to the end — never another member mid-job. When
   * every member is busy or away: said plainly, with the way to pair your own; never a loop.
   */
  function poolProveHook(route) {
    const refuse = (message) => { const err = new Error(message); err.definite = true; return err; };
    return async ({ kind, request, maxProofBytes, hcBundle, hcAuth, meta, onPhase, signal }) => {
      let guests;
      try {
        guests = await c.chainGuests({ hc_bundle: hcBundle ?? null, hc_auth: hcAuth ?? null });
      } catch (err) { throw refuse((err && err.message) || 'This wallet cannot prove for this chain.'); }
      if (guests.witness_kind !== 'viewing_key') {
        throw refuse('On this chain a proof needs the spend key, which goes only to a prover paired as your own. Pair your own prover in Settings, or send from the desktop app.');
      }
      const results = [];
      for (const m of route.members) {
        const ready = await memberReady(m, { signal });
        if (!ready.ok) { results.push(ready); continue; }
        const params = {
          ...request,
          prover: { kem_ek: m.kemEk, token: m.token, own: false, fee: ready.info.fee, ...(hcBundle ? { hc_bundle: hcBundle } : {}) },
          ...(maxProofBytes ? { max_proof_bytes: maxProofBytes } : {}),
        };
        if (guests.split_authorisation && typeof onPhase === 'function') onPhase('prove', { prover: m.name, authorising: true });
        const prepared = kind === 'burn'
          ? await c.prepareBurn(params)
          : kind === 'invoke' ? await c.prepareInvoke(params) : await c.prepareTransfer(params);
        const client = proverClientFor(m.url);
        const announced = { prover: m.name };
        if (typeof onPhase === 'function') onPhase('prove', announced);
        let record;
        try {
          record = await startRemoteProof({ client, prepared, storage, meta: { kind, name: m.name, ...(meta || {}) }, signal });
        } catch (err) {
          if (err && err.name === 'AbortError') throw err;
          // Nothing was accepted: busy, a refusal, or no answer at all — the next member.
          results.push({ busy: !!(err && err.busy), reason: `${m.member}: ${(err && err.message) || err}` });
          continue;
        }
        return pollRemoteProof({
          client, core, record, storage, onPhase, signal, locks: locksApi, announced, ...proverTiming,
        });
      }
      throw poolUnavailable(route.name, results);
    };
  }

  const PENDING_REFUSAL = 'A proof is still pending — resume or cancel it.';

  async function refuseWhilePending() {
    if (await pendingProof(storage)) {
      const err = new Error(PENDING_REFUSAL);
      err.definite = true;
      err.pending = true;
      throw err;
    }
  }

  const send = {
    async canProve() {
      return (await proveRoute()).answer;
    },

    /**
     * OPTIONAL in the contract: `{job, name, kind, startedAt}` of the remote proof still in flight
     * (a popup closed mid-proof), or `null`. A screen that finds one offers `resume`.
     */
    async pending() {
      const rec = await pendingProof(storage);
      return rec ? { job: rec.job, name: rec.name, kind: rec.kind, startedAt: rec.startedAt } : null;
    },

    /**
     * OPTIONAL in the contract: `(onPhase, options?)` → `{hash, txKey?}`. Carries the pending remote
     * proof on from where it is — polls the SAME job, opens and checks the reply through the core,
     * submits once, waits and re-scans — with `send.send`'s phases and rejection fields. A transfer
     * resolves `{hash, txKey}`, a withdrawal `{hash}`. Exactly one window claims a finished job
     * (another resuming it rejects `definite: false`, "already submitted"); a popup closed after
     * its claim but before the submit loses that proof — nothing was sent, the user sends again,
     * and nothing is paid twice.
     */
    async resume(onPhase, options = {}) {
      const release = holdUnlock();
      try {
        const rec = await pendingProof(storage);
        if (!rec) {
          const err = new Error('No proof is pending.');
          err.definite = true;
          throw err;
        }
        return await runPhased(onPhase, async (report) => {
          const { spend_key: spendKey } = await requireUnlocked();
          const { client } = await requireVerifiedChain();
          const announced = { prover: rec.name };
          report('prove', announced);
          const res = await pollRemoteProof({
            client: proverClientFor(rec.url), core, record: rec, storage,
            onPhase: report, signal: options.signal, locks: locksApi, announced, ...proverTiming,
          });
          const opts = { onPhase: report, signal: options.signal, client, wait: true };
          if (rec.kind === 'burn') {
            const sub = await engine.completeBurn(spendKey, res, opts);
            return { hash: sub.hash };
          }
          if (rec.kind === 'invoke') {
            const sub = await engine.completeInvoke(spendKey, res, opts);
            return { hash: sub.hash };
          }
          const sub = await engine.completeSend(spendKey, res, { ...opts, to: rec.to, memo: rec.memo || '' });
          return { hash: sub.hash, txKey: sub.tx_key };
        });
      } finally {
        release();
      }
    },

    /** OPTIONAL in the contract: cancel the pending remote proof (best effort) and forget it. */
    async cancelPending() {
      return cancelPendingProof({ storage, fetch: fetchImpl });
    },

    /**
     * OPTIONAL in the contract: `{envelopeBytes}` — the chain's `envelope_bytes` from
     * `rand_getLimits` (spec 2026-09-26 §2.4), `null` where the chain carries no memo (or the
     * node predates the method). The send screen shows the memo field only when this is a number.
     * Asked of a verified client, like everything else that describes the chain.
     *
     * Fullnode issue #64: on a chain whose genesis sets no envelope size (`LEGACY_ENVELOPE_
     * CHAIN_IDS`, 14–17) the node's claim is not believed — the answer is `null` whatever it
     * said, so no memo field is offered and no memo is sent. The chain id is this build's, never
     * the node's: a node cannot move it, and the core seals legacy there regardless
     * (`wallet_core::envelope_format_on`).
     */
    async limits() {
      const { client } = await requireVerifiedChain();
      const { chainId } = await getSettings();
      const envelopeBytes = await envelopeBytesOf(client);
      return { envelopeBytes: LEGACY_ENVELOPE_CHAIN_IDS.includes(Number(chainId)) ? null : envelopeBytes };
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
     * `(req, onPhase, options?)` — the contract's signature. A pending remote proof refuses a
     * second send. Then `proveRoute()` answers, without touching the node: a shell that
     * *structurally* cannot prove (wasm: ~6.2 GB against a 4 GiB address space) and has no prover
     * of the user's own paired says so before asking anything of a node — that answer can never be
     * wrong, and it is what the user needs. Only once it says `ok: true` does this go on to prove
     * the chain (`requireVerifiedChain()`), and only then does `executeSend` run — with the client
     * that call verified, never a fresh one.
     */
    async send(req, onPhase, options = {}) {
      // Taken even by a shell that gives up at `canProve()`: it is the rule, not the special case
      // — a transfer is user-initiated work the idle timer must never cut in half, and a shell
      // whose `executeSend` runs a minutes-long proof needs exactly this hold.
      const release = holdUnlock();
      try {
        await refuseWhilePending();
        const { answer: { ok, reason, via, notice }, route } = await proveRoute();
        if (!ok) {
          const err = new Error(reason);
          err.definite = true;
          throw err;
        }
        if (notice) throw noticeFirst();
        const prove = await proveHookFor(route);
        const { client, url, identity } = await requireVerifiedChain();
        return await executeSend({
          req, onPhase, options, client, url, identity, reason, via,
          // Not a fresh engine, not a fresh session read and not a second fee helper: the ones
          // this backend already uses, so a send cannot diverge from what the rest of the file
          // sees. `sendTransfer` is `engine.send` narrowed to the one capability `executeSend`
          // uses — not the whole `engine` object, which also exposes `chainIdentity`,
          // `chainVerdict`, `loadStore`, `scan` and `rescan`. See the header on `executeSend` for
          // why each is here.
          // With a prover, the engine's one `prove` hook seals the job instead of proving here;
          // everything else about the transfer is unchanged.
          sendTransfer: (spendKey, opts) => engine.send(spendKey, prove ? { ...opts, prove } : opts),
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
   * flow that reached the button by any other route paid ~100 seconds and ~6.2 GB for a
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
    // v0.6.8 `bridge.fees`: the chain keeps a share of the burn, and the source contract releases
    // the rest — out of which the relayer is paid. The core's own rule (`bridge_fee_quote`).
    let bridgeFee = 0n;
    let release = amount;
    if (state.fees && /^(0x)?[0-9a-fA-F]{64}$/.test(token)) {
      const q = await c.call('bridge_fee_quote', {
        bridge_state: { fees: { burn_bps: state.fees.burnBps }, assets: state.assets },
        to_chain: toChain, token, amount: amount.toString(),
      });
      bridgeFee = toUnits(q.fee);
      release = toUnits(q.release);
    }
    if (relayerFee > release) throw definite('The relayer fee is more than what the bridge would release after its fee.');
    const possible = await burnIsPossible(c, state, asset, toChain, token, amount, relayerFee);
    if (!possible.ok) throw definite(possible.reason);
    return { ...gate, state, asset, amount, relayerFee, toChain, token, bridgeFee, release };
  }

  /**
   * OPTIONAL in the Backend contract (ui/backend.js): present only where a shell supplied an
   * `executeWithdraw`. Everything here is shell-independent; the one shell-specific thing — how a
   * burn that CAN be proved is actually carried out — is that parameter, exactly as `executeSend`
   * is for a transfer.
   *
   * The whole reason this group exists rather than the screen calling `rpc.call` itself: a burn
   * costs a bundle proof, about two minutes and ~6.2 GB, and there are four ways to spend
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
      const prove = (await proveRoute()).answer;
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
      // `via` exactly as `canProve` reports it: a burn through a paired prover is proved there,
      // and the withdraw screen says so the way the send screen does.
      return prove.via
        ? { ok: true, via: prove.via, ...(prove.prover ? { prover: prove.prover, provers: prove.provers } : {}), ...(prove.notice ? { notice: true } : {}) }
        : { ok: true };
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
      const { asset, amount, relayerFee, bridgeFee, release } = await screenBurn(req);
      const fee = req.fee === undefined || req.fee === null ? await burnFee() : toUnits(req.fee);
      const st = await loadNotes();
      const plan = await c.planBurn({
        notes: st.notes || [], asset, amount: amount.toString(), fee: fee.toString(),
      });
      return {
        fee: String(plan.fee),
        relayerFee: relayerFee.toString(),
        // v0.6.8: the chain's share of the burn (0 on a chain without `bridge.fees`), in units of
        // the asset; what arrives is what the bridge releases less the relayer's fee.
        bridgeFee: bridgeFee.toString(),
        receive: (release - relayerFee).toString(),
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
        await refuseWhilePending();
        const { answer: { ok, reason, via, notice }, route } = await proveRoute();
        if (!ok) throw definite(reason);
        if (notice) throw noticeFirst();
        const prove = await proveHookFor(route);
        // ONE verified client for the whole operation: taken here, handed to `screenBurn` so its
        // `rand_getBridgeState` is that node's answer, and threaded into `executeWithdraw`.
        const verified = await requireVerifiedChain();
        const { client, url, identity } = verified;
        const { asset, token } = await screenBurn(req, verified);
        const fee = req.fee === undefined || req.fee === null ? (await burnFee()).toString() : String(req.fee);
        return await executeWithdraw({
          req: { ...req, asset, token, fee }, onPhase, options, client, url, identity, reason, via,
          // `engine.burn` narrowed to the one capability, for the same reasons `sendTransfer` is
          // (see this file's header): one `makeWallet`, one writer of the note store. Nothing else
          // of the engine is handed over, and nothing that is not read is handed over either —
          // `bridgeState` and `burnFee` used to ride along here and neither was ever touched.
          sendBurn: (spendKey, opts) => engine.burn(spendKey, prove ? { ...opts, prove } : opts),
          requireUnlocked,
        });
      } finally {
        release();
      }
    },
  };

  // ----------------------------------------------------------------------- RPL-2 programs --
  /**
   * OPTIONAL in the Backend contract, like `bridge`: a site's `window.rand.invoke` (the browser
   * extension's approval window, extension/shared/invoke.js) and nothing else. Every rejection
   * carries a string `code` the site branches on (durian.market's `web/lib/rand/provider.ts`), and
   * `definite: true` wherever nothing was sent.
   *
   * The request is the site's, so it is held to its shape here (`normalizeInvokeRequest`) and
   * everything the window shows of it is this wallet's own reading (`invokeEffects`), never the
   * site's summary beyond its title.
   */
  const program = {
    /**
     * `{ok, reason?, code?, via?}` — whether this device can invoke on this chain, in the order a
     * send asks it: a proof route first (no node needed: the wasm shells have none without a paired
     * prover), then the chain's `program_state` section.
     */
    async canInvoke() {
      const prove = (await proveRoute()).answer;
      if (!prove || !prove.ok) {
        return { ok: false, code: 'PROVER_UNAVAILABLE', reason: (prove && prove.reason) || 'Proving is not available here.' };
      }
      const { client } = await requireVerifiedChain();
      const limits = checkLimits(await client.getLimits());
      if (!limits.programState) {
        return { ok: false, code: 'PROGRAMS_UNSUPPORTED', reason: 'This chain does not run programs yet.' };
      }
      // The RandProtocol prover's one-time notice (and Firefox's consent) comes before the first
      // invoke through it too: the window shows it in Approve's place.
      return prove.via
        ? { ok: true, via: prove.via, ...(prove.prover ? { prover: prove.prover, provers: prove.provers } : {}), ...(prove.notice ? { notice: true } : {}) }
        : { ok: true };
    },

    /**
     * Every cell of program `id`, in key order (`rand_getProgramCells`, page by page): `[{key,
     * value}]`, or `null` on a chain without program state. What the Swap screen prices from.
     */
    async cells(id) {
      const program = String(id || '').replace(/^0x/, '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(program)) throw invokeError('BAD_REQUEST', 'That is not a program id.');
      const { client } = await requireVerifiedChain();
      const out = [];
      let after = null;
      for (let page = 0; page < 64; page += 1) {
        const r = checkProgramCells(await client.getProgramCells(program, after ? { after, limit: 256 } : { limit: 256 }));
        if (r === null) return null;
        out.push(...r.cells);
        // A cursor that does not move would loop for ever.
        if (r.next === null || r.next === after) break;
        after = r.next;
      }
      return out;
    },

    /**
     * What the approval window shows: `{title, program, spend, receive, fee, cells, tier}` — the site's
     * title, and this wallet's reading of what leaves and what comes back, with the fee the chain
     * quotes for it. Everything that can refuse the invoke before a proof runs here
     * (`engine.quoteInvoke`), so a window never offers Approve for a request that cannot be sent.
     */
    async quote(raw) {
      const request = normalizeInvokeRequest(raw);
      const { spend_key: spendKey } = await requireUnlockedCoded();
      const { client } = await requireVerifiedChain();
      const q = await engine.quoteInvoke(spendKey, request, { client });
      const effects = invokeEffects(request, q.fee);
      return { title: request.title, program: request.program, ...effects, cells: q.cells, tier: q.dry.tier };
    },

    /**
     * `(raw, onPhase, options?)` → `{hash}` once the node has accepted the transaction (not after
     * it commits: the site follows the transaction itself, and the wallet's next scan finds the
     * payout notes). Phases as `send.send`'s.
     */
    async invoke(raw, onPhase, options = {}) {
      const request = normalizeInvokeRequest(raw);
      // Minutes of user-initiated work: the idle lock must not take the spend key half-way.
      const release = holdUnlock();
      try {
        await refuseWhilePending();
        const { answer: { ok, reason, notice }, route } = await proveRoute();
        if (!ok) throw invokeError('PROVER_UNAVAILABLE', reason);
        if (notice) throw invokeError('PROVER_NOTICE', noticeFirst().message);
        const prove = await proveHookFor(route);
        const { client, identity } = await requireVerifiedChain();
        return await runPhased(onPhase, async (report) => {
          const { spend_key: spendKey } = await requireUnlockedCoded();
          const sub = await engine.invoke(spendKey, {
            request, wait: false, onPhase: report, signal: options.signal, client, identity, prove,
          });
          return { hash: sub.hash };
        });
      } finally {
        release();
      }
    },
  };

  /** `requireUnlocked`, with the page-facing code on its refusal. */
  async function requireUnlockedCoded() {
    try {
      return await requireUnlocked();
    } catch (err) {
      if (err && !err.code) err.code = 'LOCKED';
      if (err) err.definite = true;
      throw err;
    }
  }

  // --------------------------------------------------------------- unlock with a passkey --
  /**
   * OPTIONAL in the contract, present only where the shell supplies `platform.passkey` (the
   * Chrome extension: a platform passkey with the WebAuthn PRF extension, Touch ID on a Mac).
   * The passkey seals the PASSWORD (engine/crypto.js), so unlocking with it is the ordinary
   * unlock — the screen recovers the password here and hands it to `ctx.unlockWallet`, the same
   * call a typed password goes through, attempt throttle and all.
   *
   *   available() → boolean      this device and browser can make such a passkey
   *   enabled()   → boolean      one is set up for this wallet
   *   label()     → string       what to call it ("Touch ID", "Windows Hello", …)
   *   enable(password)           checks the password, makes the passkey, stores the record
   *   recoverPassword()          the user's fingerprint → the password; `code` CANCELLED when
   *                              they dismiss the prompt, PASSKEY_FAILED when it does not open
   *   disable()                  forgets the record (the passkey itself stays in the OS keychain
   *                              until the user deletes it there; without the record it opens
   *                              nothing)
   */
  const pk = platform && platform.passkey;
  const passkey = pk && {
    async available() { try { return !!(await pk.available()); } catch { return false; } },
    async enabled() { return !!(await storage.get(K.passkey)); },
    label() { return (typeof pk.label === 'function' && pk.label()) || 'a passkey'; },
    async enable(password) {
      const key = await openVault(password);
      if (!key) throw new Error('wrong password');
      const made = await pk.register();
      const prf = made.prf || (await pk.prf({ credentialId: made.credentialId, salt: made.salt }));
      const sealed = await sealWithPasskey(prf, password);
      await storage.set(K.passkey, { credentialId: made.credentialId, salt: made.salt, ...sealed });
      return true;
    },
    async recoverPassword() {
      const rec = await storage.get(K.passkey);
      if (!rec) throw Object.assign(new Error('Touch ID is not set up for this wallet.'), { code: 'PASSKEY_FAILED' });
      let prf;
      try {
        prf = await pk.prf({ credentialId: rec.credentialId, salt: rec.salt });
      } catch (err) {
        const cancelled = err && (err.name === 'NotAllowedError' || err.name === 'AbortError');
        throw Object.assign(new Error(cancelled ? 'Unlock was cancelled.' : `The passkey did not answer: ${(err && err.message) || err}`), { code: cancelled ? 'CANCELLED' : 'PASSKEY_FAILED' });
      }
      try {
        return await openWithPasskey(prf, rec);
      } catch (err) {
        throw Object.assign(new Error((err && err.message) || 'The passkey did not open this wallet.'), { code: 'PASSKEY_FAILED' });
      }
    },
    async disable() { await storage.remove(K.passkey); },
  };

  const rpc = {
    /** The raw escape hatch — but only into this chain's own namespaces. */
    async call(method, params = []) {
      if (!isAllowedRpcMethod(method)) throw new Error(`${method} is not allowed from this wallet`);
      const client = await rpcClient();
      return client.rpc(method, Array.isArray(params) ? params : [params]);
    },
    /**
     * A single-URL reachability check, for the settings screen's Test and Save: answers the two
     * facts those need — the chain the node CLAIMS to be on and its height — or throws (the same
     * error taxonomy as a scan: timeout, connect, http, body). This is not the chain gate and
     * changes nothing it decides: nothing the node says here is trusted, every operation still
     * goes through `requireVerifiedChain()` against the URL actually in force. The chain-id
     * comparison is the caller's to make, against the configured chain, never against anything
     * the node said.
     */
    async probe(url) {
      const [u] = rpcUrlList(url);
      if (!u || !/^https?:\/\//i.test(u)) throw new Error('That is not an http(s) URL.');
      const client = makeRpc([u], { fetch: fetchImpl });
      const [chainId, status] = await Promise.all([client.chainId(), client.status()]);
      // Numbers about the chain are carried as TEXT wherever the node sent them that way, for the
      // same reason the rest of this file never lets one through Number(): past 2^53 the round
      // trip invents digits, and the settings screen prints exactly what this returns.
      const height = status && status.height;
      return {
        url: u,
        chainId: typeof chainId === 'string' && /^\d+$/.test(chainId) ? chainId : Number(chainId),
        height: typeof height === 'string'
          ? height
          : (Number.isSafeInteger(Number(height)) ? String(Number(height)) : 'unknown'),
      };
    },
  };

  /**
   * OPTIONAL in the contract: the address-sharing formats (spec 2026-09-26 §2), every one of them
   * the core's own code — the fingerprint and the `randpay:` link are never re-implemented in
   * JavaScript. Pure: no node, no key, no storage.
   */
  const address = {
    /** The grouped 16-digit fingerprint of `addr` (`XXXX-XXXX-XXXX-XXXX`). Rejects on a bad address. */
    async fingerprint(addr) {
      const res = await c.call('address_fingerprint', { address: String(addr || '') });
      return String(res && res.fingerprint);
    },
    /** `{address, amount, asset, memo, fingerprint}` of a `randpay:` link (absent fields `null`),
     *  or a rejection with the core's sentence. The fingerprint is recomputed from the address. */
    async parseLink(uri) {
      const res = await c.call('uri_parse', { uri: String(uri || '') });
      return {
        address: String(res.address),
        amount: res.amount ?? null,
        asset: res.asset ?? null,
        memo: res.memo ?? null,
        fingerprint: String(res.fingerprint),
      };
    },
    /** The `randpay:` link for `{address, amount?, asset?, memo?}`. An empty field is left out —
     *  a blank on the receive form means "the payer decides" — and the core parses the link back
     *  before returning it, so this never hands out one another wallet would refuse. */
    async formatLink({ address: addr, amount, asset, memo } = {}) {
      const params = { address: String(addr || '') };
      if (amount !== undefined && amount !== null && String(amount) !== '') params.amount = String(amount);
      if (asset !== undefined && asset !== null && String(asset) !== '') params.asset = String(asset);
      if (typeof memo === 'string' && memo !== '') params.memo = memo;
      const res = await c.call('uri_format', params);
      return String(res && res.uri);
    },
  };

  /**
   * OPTIONAL in the contract: the address book (ui/lib/contacts.js), in this backend's storage
   * under `contacts`, with the CLI's rules. An address is checked by the core before it is saved,
   * so a contact always names something a send can be addressed to.
   */
  const contacts = {
    async list() { return listContacts(storage); },
    async add(name, addr) {
      const text = String(addr || '').trim();
      const parsed = await c.parseAddress(text);
      if (!parsed || !parsed.valid) throw new Error((parsed && parsed.error) || 'not a shielded address');
      return addContact(storage, name, text);
    },
    async remove(name) { await removeContact(storage, name); },
    async nameOf(addr) { return contactNameOf(storage, addr); },
    async addressOf(name) { return contactAddressOf(storage, name); },
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

  const backend = { wallet, sync, assets, send, faucet, rpc, settings, platform, address, contacts, prover, dispose };
  // `bridge` is OPTIONAL in the contract and is not in BACKEND_SHAPE: a shell that supplied no
  // `executeWithdraw` simply does not have the group, and every screen feature-detects it
  // (`ctx.backend.bridge?.canWithdraw`). Both real shells do supply one — the wasm shell's always
  // refuses, which is honest rather than absent, and proves the shape out.
  if (typeof executeWithdraw === 'function') backend.bridge = bridge;
  // `program` (RPL-2 invoke) is OPTIONAL and not in BACKEND_SHAPE either; every shell that can prove
  // a bundle — on the device or through a paired prover — has it.
  backend.program = program;
  if (passkey) backend.wallet.passkey = passkey;
  return backend;
}
