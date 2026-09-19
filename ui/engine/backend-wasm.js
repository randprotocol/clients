// The Backend (ui/backend.js) for every shell whose chain crypto is the wasm core: the local web
// wallet (web/wallet) and, from task 2.1, the browser extension. It is the first real
// implementation of the contract — until now only ui/test/fake-backend.mjs existed.
//
//     makeWasmBackend({ core, storage, platform, fetch })
//
//   core      `{ call(method, params) -> Promise }` — the wasm core, however this shell reaches it
//             (a Web Worker in both browser shells, `initSync` directly under Node in a test).
//   storage   `{ get(key), set(key, value), remove(key), clear(), session: {get, set, remove} }`,
//             all async. The persistent half survives a reload; **`session` is memory only** and
//             is the one place the plaintext spend key is ever written.
//   platform  the `platform` group, passed through as given: `{name, openExternal, copy}` plus
//             whatever optional members this shell has (`version`, `paste`, `openFlowInTab`,
//             `ensureHostPermission`).
//   fetch     optional; defaults to the global. Only the JSON-RPC client uses it.
//
// ---- where the plaintext spend key can exist ----
//
//   1. inside the wasm core, for the duration of a call it is a parameter of;
//   2. in `storage.session` under `unlocked`, while the wallet is unlocked;
//   3. in a local variable of whichever method is using it, for that call.
//
// It is *never* in the persistent half of `storage`, in a URL, in an error message, in the
// console, or in anything handed to `fetch`. `ui/test/backend-wasm.test.mjs` records every
// argument every collaborator is given and scans all of them for it.
//
// ---- what this shell cannot do ----
//
// A bundle proof peaks at ~5.6 GB (`wallet-core`'s own PROVER_PEAK_MEMORY_BYTES) and wasm32 stops
// at 4 GiB, so `send.canProve()` is `{ok: false}` and `send.send()` rejects before anything is
// selected. Everything else — keys, addresses, scanning, the note store, assets, fee estimates,
// the faucet — is real.
import { encryptSecret, decryptSecret } from './crypto.js';
import { makeRpc, isAllowedRpcMethod } from './rpc.js';
import { makeWallet, coreApi, emptyNoteStore, activity as activityRows, toUnits, isSpendable } from './wallet.js';

// Storage keys. `unlocked` is the only session one.
const K = Object.freeze({
  settings: 'settings',
  wallet: 'wallet', // public facts only: {address, pk}
  vault: 'vault',
  notes: 'notes',
  assets: 'assets', // the registry, cached so a reload starts with the symbols it had
  failures: 'unlockFailures',
  unlocked: 'unlocked',
});

const MIN_PASSWORD_LEN = 10;
/** Kept in step with `extension/shared/lib/store.js`'s DEFAULTS; the core's own constants win. */
const FALLBACK = Object.freeze({
  rpcUrl: 'https://rpc.randprotocol.org',
  explorerUrl: 'https://randscan.org',
  chainId: 13,
  decimals: 9,
  autoLockMin: 15,
  theme: 'system',
});

/** Shown to the user verbatim, so it is written for them (ui/backend.js on `send.canProve`). */
export const CANNOT_PROVE_REASON = 'A transfer proof needs about 5.5 GB of memory and browsers '
  + 'give WebAssembly 4 GB. Send from the Rand Wallet desktop app — your keys import there.';

/** The same sentence ui/screens/asset.js shows on a registry asset; the ledger admits only
 *  asset-0 transfers. Duplicated as a string rather than imported, because engine/ must not
 *  depend on a screen. */
export const RPL_SEND_DISABLED_TEXT = 'RPL transfers are not available on this network.';

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
 *  - `txKey` — a per-transaction key is a secret, and this shell has no way to make one anyway
 *    (it cannot prove a transfer), so nothing writes one into the note store for it to surface.
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

export function makeWasmBackend({ core, storage, platform, fetch: fetchImpl } = {}) {
  if (!core || typeof core.call !== 'function') throw new Error('makeWasmBackend needs a core with call()');
  if (!storage || typeof storage.get !== 'function' || !storage.session) throw new Error('makeWasmBackend needs a storage');
  if (!platform || typeof platform.name !== 'string' || !platform.name) throw new Error('makeWasmBackend needs a platform with a name');

  const c = coreApi(core);

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
    const next = { ...(await getSettings()), ...(patch || {}) };
    await storage.set(K.settings, next);
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'autoLockMin')) await rearmAutoLock();
    return next;
  }

  // ------------------------------------------------------------------------------- the node ----
  let rpcCache = null;
  async function rpcClient(settingsOverride) {
    const s = settingsOverride || (await getSettings());
    if (!rpcCache || rpcCache.url !== s.rpcUrl) rpcCache = makeRpc(s.rpcUrl, { fetch: fetchImpl });
    return rpcCache;
  }

  // -------------------------------------------------------------------------- the note store ---
  const noteStore = {
    async getNoteStore() { return (await storage.get(K.notes)) || emptyNoteStore(); },
    async setNoteStore(s) { await storage.set(K.notes, s); },
  };
  const engine = makeWallet({ core, store: noteStore, rpc: rpcClient, settings: getSettings });

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
  // A timer in this module, rearmed by every backend call that happens while unlocked, because
  // "inactivity" means "the user is not using the wallet" and every screen reaches the wallet
  // through here. The shell observes it through `wallet.onLocked` (optional in the contract), so
  // a lock the *backend* decided on still routes the user to the lock screen.
  const lockedListeners = new Set();
  let autoLockTimer = null;

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
    await forgetSession();
    for (const fn of [...lockedListeners]) {
      try { fn({ reason: 'idle' }); } catch { /* a listener's failure is not the wallet's */ }
    }
  }

  async function forgetSession() {
    clearAutoLock();
    try { await storage.session.remove(K.unlocked); } catch { /* nothing to remove */ }
  }

  /** Called by every method that needs an unlocked wallet: using the wallet is not being idle. */
  function touch() {
    if (autoLockTimer !== null) rearmAutoLock();
  }

  // ------------------------------------------------------------------- unlock attempt throttle --
  async function failureCount() {
    const rec = await storage.get(K.failures);
    return Number(rec && rec.count) || 0;
  }
  async function throttle() {
    const n = await failureCount();
    await sleep(unlockDelayMs(n));
  }
  async function noteFailure() {
    const n = (await failureCount()) + 1;
    await storage.set(K.failures, { count: n, atMs: Date.now() });
  }
  async function clearFailures() {
    await storage.remove(K.failures);
  }

  /**
   * Runs the real KDF over the real vault. Resolves with the plaintext spend key, or `null` for a
   * wrong password — and *either way* costs one PBKDF2-SHA256 at 600 000 iterations plus one
   * AES-GCM open, because a cheaper negative answer is an oracle.
   */
  async function openVault(password) {
    const vault = await storage.get(K.vault);
    if (!vault) throw new Error('no wallet on this device');
    await throttle();
    try {
      const key = await decryptSecret(password, vault);
      await clearFailures();
      return key;
    } catch {
      await noteFailure();
      return null;
    }
  }

  /** Records a freshly created/imported/unlocked wallet. The vault is written first. */
  async function startSession(info) {
    await storage.session.set(K.unlocked, { spend_key: info.spend_key, viewing_key: info.viewing_key });
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
      touch();
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
      touch();
      return u.viewing_key;
    },

    async exportSpendKey() {
      const u = await requireUnlocked();
      touch();
      return u.spend_key;
    },

    async wipe() {
      clearAutoLock();
      rpcCache = null;
      constantsPromise = null;
      try { await storage.session.remove(K.unlocked); } catch { /* nothing to remove */ }
      await storage.clear();
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

  const sync = {
    async cached() {
      const st = await loadNotes();
      return shape(st);
    },

    async scan(onProgress, options = {}) {
      const { spend_key: key } = await requireUnlocked();
      touch();
      const signal = options && options.signal;
      const st = await engine.scan(key, {
        signal,
        onProgress: (p) => {
          if (typeof onProgress !== 'function') return;
          // The contract's progress shape is `{scanned, head}`; the engine reports the phase too,
          // which the UI ignores but a log would not.
          onProgress({ phase: p.phase, scanned: Number(p.scanned) || 0, head: Number(p.total) || 0 });
        },
      });
      touch();
      return shape(st);
    },
  };

  function shape(st) {
    return {
      notes: (st.notes || []).map((n) => uiNote(n, st.block_times || {})),
      activity: activityRows(st).map((row) => uiActivity(row, st)),
      scannedHeight: Math.max(0, (Number(st.scanned_height) || 0) - 1),
      head: Number(st.head) || 0,
      lastSyncMs: Number(st.last_sync_ms) || 0,
    };
  }

  const assets = {
    /**
     * RAND (index 0) first, then every registry index this wallet holds notes of *or* the node's
     * registry lists. The registry carries no symbol and no decimals (`rand_getAssets` is
     * `{index, chain, token, asset_id}`), so a registry asset is `RPL#<index>` at 9 decimals and
     * has no display name at all until a known-token table exists.
     */
    async list() {
      touch();
      const k = await constants();
      const st = await loadNotes();
      const decimals = Number(k.token_decimals) || FALLBACK.decimals;

      let registry = (await storage.get(K.assets)) || [];
      try {
        const client = await rpcClient();
        const fresh = await client.assets();
        if (Array.isArray(fresh)) {
          registry = fresh;
          await storage.set(K.assets, fresh);
        }
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
        out.push({
          index,
          id: typeof row.asset_id === 'string' && row.asset_id ? row.asset_id : `rpl-${index}`,
          symbol: `RPL#${index}`,
          decimals: FALLBACK.decimals,
          balance: (balances.get(index) || 0n).toString(),
          pending: '0',
        });
      }
      return out;
    },
  };

  async function bundleFee() {
    const client = await rpcClient();
    const answer = await client.estimateFee({ kind: 'bundle' });
    const fee = toUnits(answer);
    if (fee > 0n) return fee;
    const k = await constants();
    return toUnits(k.bundle_base_fee);
  }

  const send = {
    async canProve() {
      return { ok: false, reason: CANNOT_PROVE_REASON };
    },

    /**
     * A real estimate: the node's own minimum bundle fee, and the core's own coin selection over
     * this wallet's notes. A selection that cannot be built rejects with the core's message,
     * which is written for the user (it is what tells them to consolidate).
     */
    async estimate(req = {}) {
      touch();
      const asset = Number(req.asset) || 0;
      if (asset !== 0) throw new Error(RPL_SEND_DISABLED_TEXT);
      const fee = await bundleFee();
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

    /** The largest amount this wallet can actually send: a bundle spends at most two notes. */
    async maxSendable({ asset = 0 } = {}) {
      touch();
      const fee = await bundleFee();
      const index = Number(asset) || 0;
      if (index !== 0) return { amount: '0', fee: fee.toString() };
      const st = await loadNotes();
      const spendable = (st.notes || [])
        .filter((n) => isSpendable(n) && (Number(n.asset) || 0) === index)
        .map((n) => toUnits(n.amount))
        .sort((a, b) => (b > a ? 1 : b < a ? -1 : 0))
        .slice(0, 2);
      const have = spendable.reduce((a, b) => a + b, 0n);
      const amount = have > fee ? have - fee : 0n;
      return { amount: amount.toString(), fee: fee.toString() };
    },

    /**
     * Refused outright, and `definite: true` so the UI says "not sent" rather than treating the
     * outcome as unknown. Nothing is selected, no witness is fetched and **`prove_transfer` is
     * never called**: in wasm it would grind for minutes and then abort with an out-of-memory
     * trap, after the user had watched a progress bar for it.
     */
    async send() {
      const err = new Error(CANNOT_PROVE_REASON);
      err.definite = true;
      throw err;
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
      touch();
      const w = await storage.get(K.wallet);
      if (!w || !w.address) throw new Error('no wallet on this device');
      const client = await rpcClient();
      const hash = await client.mint(w.address);
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

  const rpc = {
    /** The raw escape hatch — but only into this chain's own namespaces. */
    async call(method, params = []) {
      if (!isAllowedRpcMethod(method)) throw new Error(`${method} is not allowed from this wallet`);
      touch();
      const client = await rpcClient();
      return client.rpc(method, Array.isArray(params) ? params : [params]);
    },
  };

  const settings = {
    async get() { return getSettings(); },
    async set(patch) { return setSettings(patch); },
  };

  return { wallet, sync, assets, send, faucet, rpc, settings, platform };
}
