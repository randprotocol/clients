// Auto-lock for a browser extension, as an alarm rather than a timer.
//
// `makeWasmBackend` (ui/engine/backend-wasm.js) locks an idle wallet with a `setTimeout`. That is
// right for a shell whose JavaScript context outlives the wallet session — the web wallet's tab,
// the desktop window — and **wrong for a popup**, whose context is destroyed the instant it loses
// focus: a timer armed while the popup was open never fires, so the wallet would simply never
// lock. Moving the timer into the background script does not fix it either, because Chrome evicts
// an idle MV3 service worker after about thirty seconds, long before any real `autoLockMin`.
//
// The one mechanism that survives both is `chrome.alarms`, which both manifests already ask for.
// So this file does two things to the backend `makeWasmBackend` returned, without that file
// learning anything about browsers:
//
//   1. **it arms the alarm** wherever the engine would have re-armed its timer — real user input
//      (`wallet.noteActivity`), a fresh session (`unlock`/`create`/`import`), a new interval saved
//      in Settings — and clears it wherever the engine would have cleared it (`lock`, `wipe`);
//   2. **it reports the lock**, by replacing `wallet.onLocked`. The alarm fires in the background
//      script, which deletes the unlocked session from `storage.session`; `storage.session` is a
//      browser-level store, not page memory, so an open popup or app tab sees that as a
//      `storage.onChanged` event and routes itself to the lock screen.
//
// The engine's own timer is left running underneath: in a long-lived app tab it is a second, more
// precise path to the same lock, and it cannot double-report one, because both paths end at the
// same deleted key and only one `storage.onChanged` event ever follows it.
//
// Nothing here imports anything. `ext` and the session key are both injected, which is what lets
// `extension/test/idle-lock.test.mjs` drive the whole of it under Node.

/** The alarm's name. `background.js` spells the same word; they are checked against each other. */
export const AUTOLOCK_ALARM = 'autolock';

/**
 * How long after this page asked for a lock a `storage.onChanged` removing the session is still
 * assumed to be that lock, rather than the alarm's.
 *
 * A window rather than a flag that waits to be cleared: a `lock()` that fails *after* deleting the
 * key, or a browser that never delivers the event, would otherwise leave the suppression armed for
 * ever and swallow the next real auto-lock — a wallet that silently stops locking itself is the
 * one failure this whole file exists to prevent. Two seconds is far longer than the event takes
 * and far shorter than any interval a user can choose.
 */
const SELF_LOCK_WINDOW_MS = 2000;

/**
 * `wireIdleLock(backend, ext, {sessionKey}) -> dispose()`
 *
 * Mutates `backend` in place — it must be called **before** the backend is handed to `mount()`,
 * which snapshots every group it is given. `dispose()` stops watching storage and forgets the
 * subscribers; it is idempotent and never throws.
 *
 *   sessionKey        the `storage.session` key holding the unlocked wallet. Required, and never
 *                     defaulted: `backend-extension.js` takes it from `backend-wasm.js`'s own
 *                     `UNLOCKED_SESSION_KEY` export, so this file cannot guess it wrong.
 *   alarmName         optional; the alarm to arm. Defaults to `AUTOLOCK_ALARM`.
 *   selfLockWindowMs  optional; see above.
 *   now               optional; injected only so a test can move the clock.
 */
export function wireIdleLock(backend, ext, options = {}) {
  const {
    sessionKey,
    alarmName = AUTOLOCK_ALARM,
    selfLockWindowMs = SELF_LOCK_WINDOW_MS,
    now = Date.now,
  } = options;

  if (!backend || !backend.wallet || !backend.settings) throw new Error('wireIdleLock needs a backend');
  if (!ext || !ext.alarms || !ext.storage || !ext.storage.onChanged) throw new Error('wireIdleLock needs the extension API');
  if (typeof sessionKey !== 'string' || !sessionKey) {
    throw new Error("wireIdleLock needs the unlocked-session storage key (backend-wasm.js's UNLOCKED_SESSION_KEY)");
  }

  const wallet = backend.wallet;
  const lockedListeners = new Set();
  /** When this page last asked for a lock, or 0. See SELF_LOCK_WINDOW_MS. */
  let selfLockAt = 0;
  let disposed = false;

  // ------------------------------------------------------------------------------ the alarm ---
  // Every one of these swallows its own failure. An extension whose `alarms` API is unavailable
  // (a browser that never granted it, a torn-down context) still has a working wallet; what it
  // loses is the idle lock, and losing it must not also lose the unlock the user just did.
  async function clearAlarm() {
    try { await ext.alarms.clear(alarmName); } catch { /* nothing armed, or no alarms here */ }
  }

  /**
   * Arms the alarm for the wallet's current interval, or clears it.
   *
   * `alarms.create` with an existing name replaces that alarm, so this is also how it is pushed
   * further out. Three reasons there is nothing to arm: the wallet is locked (arming would lock a
   * locked wallet), the interval is 0 ("Never"), or the interval is not a number at all.
   */
  async function rearm() {
    try {
      if (!(await wallet.isUnlocked())) { await clearAlarm(); return; }
      const settings = await backend.settings.get();
      const minutes = Number(settings && settings.autoLockMin);
      if (!Number.isFinite(minutes) || minutes <= 0) { await clearAlarm(); return; }
      await ext.alarms.create(alarmName, { delayInMinutes: minutes });
    } catch { /* the alarm simply stays as it was */ }
  }

  // ----------------------------------------------------------------------- the wrapped methods -
  const original = {
    noteActivity: typeof wallet.noteActivity === 'function' ? wallet.noteActivity.bind(wallet) : null,
    unlock: wallet.unlock.bind(wallet),
    create: wallet.create.bind(wallet),
    import: wallet.import.bind(wallet),
    lock: wallet.lock.bind(wallet),
    wipe: wallet.wipe.bind(wallet),
    setSettings: backend.settings.set.bind(backend.settings),
  };

  /**
   * Cheap, synchronous and fire-and-forget, exactly as the contract requires (ui/backend.js): the
   * shell calls this on every throttled pointer, key, wheel and touch event, and must never wait
   * on it or see it reject.
   */
  wallet.noteActivity = function noteActivity() {
    if (original.noteActivity) {
      try { original.noteActivity(); } catch { /* the engine's timer is its own business */ }
    }
    void rearm();
  };

  for (const name of ['unlock', 'create', 'import']) {
    wallet[name] = async (...args) => {
      // Only on success: a wrong password must not start the clock on a session that never began.
      const answer = await original[name](...args);
      await rearm();
      return answer;
    };
  }

  for (const name of ['lock', 'wipe']) {
    wallet[name] = async (...args) => {
      // Marked *before* the call, because the engine deletes the key while it runs and the
      // browser may deliver the change event before this promise settles.
      selfLockAt = now();
      try {
        return await original[name](...args);
      } finally {
        // …and again after, so the window is measured from the end of the call, not its start —
        // but ONLY while the stamp is still pending. The usual case is that the browser delivers
        // the change *during* this call (the engine removes the key inside it), so the listener
        // has already consumed the stamp by the time we get here; re-stamping unconditionally
        // would open a second, unconsumed window with nothing left to spend it, and a lock
        // originating anywhere else inside it would be swallowed — leaving this page showing an
        // unlocked wallet whose key is gone. One lock, one suppression.
        if (selfLockAt) selfLockAt = now();
        await clearAlarm();
      }
    };
  }

  /**
   * A new interval takes effect now, not at the next keystroke. The engine re-arms its own timer
   * on this patch (`setSettings`), and the alarm has to follow it or Settings would say "1 minute"
   * while an alarm armed for fifteen was still the only thing that could fire.
   */
  backend.settings.set = async (patch) => {
    const answer = await original.setSettings(patch);
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'autoLockMin')) await rearm();
    return answer;
  };

  // ------------------------------------------------------------------------ reporting the lock -
  /**
   * OPTIONAL in the contract, and **replaced** rather than added to: the engine's own `onLocked`
   * is driven by the internal timer this design bypasses, so a subscriber attached to it would
   * hear nothing in a popup. Registration is synchronous — the shell forwards it unwrapped and
   * calls what it answers with.
   */
  wallet.onLocked = (cb) => {
    if (typeof cb !== 'function') return () => {};
    lockedListeners.add(cb);
    return () => lockedListeners.delete(cb);
  };

  /**
   * The unlocked session disappearing from `storage.session` **is** the lock — whoever did it.
   * Normally that is `background.js`, on the alarm, with no page of ours running at all; when a
   * page *is* open this is how it finds out.
   *
   * The one case that must not be reported is this page's own `lock()`/`wipe()`: the browser
   * tells every context about a write, including the one that made it, and the shell already ended
   * the session and routed to `#lock` before it even returned. Reporting it again would end a
   * second session — by then the *next* one, if the user unlocked quickly — which is precisely the
   * double-handling the contract's "not called for a lock the shell itself asked for" forbids.
   */
  function onStorageChanged(changes, areaName) {
    if (areaName !== 'session') return;
    const change = changes && changes[sessionKey];
    if (!change) return;
    // Present → absent, and nothing else: an unlock writes the key, and a clear of a key that was
    // not there reports no old value.
    if (change.newValue !== undefined) return;
    if (change.oldValue === undefined) return;
    if (selfLockAt && now() - selfLockAt <= selfLockWindowMs) {
      selfLockAt = 0; // spent: the next disappearance is somebody else's
      return;
    }
    for (const fn of [...lockedListeners]) {
      try { fn({ reason: 'idle' }); } catch { /* a listener's failure is not the wallet's */ }
    }
  }

  ext.storage.onChanged.addListener(onStorageChanged);

  return function disposeIdleLock() {
    if (disposed) return;
    disposed = true;
    try { ext.storage.onChanged.removeListener(onStorageChanged); } catch { /* already gone */ }
    lockedListeners.clear();
  };
}
