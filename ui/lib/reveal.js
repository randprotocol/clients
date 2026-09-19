// One implementation of "show me the secret" for the three screens that have one: the transaction
// key on a transaction's detail and on a send receipt, and the viewing / spend keys in settings.
// Before this existed the gesture, the masking and the copy handling were written out three times,
// which is three chances to forget the one rule that matters.
//
// The rule: **the secret is never written anywhere but one text node, and only while it is on
// screen.** Not into an attribute (an attribute is readable by anything holding the document, and
// survives serialisation), not into `ctx.state`, not into the URL, not into storage. The caller
// keeps it in a closure and hands it over through `getSecret()`; this module reads it at the
// moment it paints and clears the node again on the way out.
//
// Two ways to reveal, because "press and hold" is not available to everyone: a pointer/keyboard
// hold (the `.hold-btn` gesture the design system already has) and a plain button that shows the
// secret for a fixed number of seconds. Both end in the same `reveal()`. Whichever is used, the
// secret is hidden again when the window loses focus or the tab is backgrounded — a key left
// sitting on a screen nobody is looking at is the failure mode this guards against.
//
// Importable under plain Node: nothing here runs at module scope.

export const HOLD_MS = 650;
export const SHOW_MS = 10_000;
/** How long after a copy the caller is asked to forget the secret (`dropOnHide` callers only). */
export const COPY_DROP_MS = 60_000;

const DEFAULT_SELECTORS = {
  mask: '[data-role="mask"]',
  hold: '[data-role="hold"]',
  timed: '[data-role="timed"]',
  copy: '[data-role="copy"]',
};

/**
 * Wires up a secret-reveal block inside `root`.
 *
 * `getSecret()` returns the secret or a falsy value if it is gone — every path re-reads it, so a
 * caller that drops its own copy immediately stops being able to reveal anything.
 *
 * Options:
 *  - `masked`      the placeholder shown while hidden (dots, or a shortened form).
 *  - `copy`        `async (secret) => void` — usually `backend.platform.copy`.
 *  - `onCopied`    called after a successful copy (a toast).
 *  - `onDrop`      called when the secret should be forgotten entirely. Only ever called when
 *                  `dropOnHide` is set, or `copyDropMs` has elapsed after a copy.
 *  - `dropOnHide`  true → losing focus / backgrounding / teardown forgets the secret, not just
 *                  hides it. The settings screen sets this; a receipt does not, because the user
 *                  has switched windows precisely to paste the thing somewhere.
 *  - `selectors`   overrides for the four `[data-role]` hooks, for screens whose markup predates
 *                  this helper.
 *  - `labels`      `{reveal, hide}` for the timed button's accessible name.
 *
 * Returns `{ hide, isRevealed, destroy }`; `destroy()` is what a screen's cleanup calls.
 */
export function wireSecretReveal(root, options = {}) {
  const {
    getSecret,
    masked = '•••• •••• •••• •••• •••• ••••',
    copy,
    onCopied,
    onDrop,
    dropOnHide = false,
    holdMs = HOLD_MS,
    showMs = SHOW_MS,
    copyDropMs = COPY_DROP_MS,
    labels = {},
  } = options;
  const sel = { ...DEFAULT_SELECTORS, ...(options.selectors || {}) };

  const mask = sel.mask ? root.querySelector(sel.mask) : null;
  const holdBtn = sel.hold ? root.querySelector(sel.hold) : null;
  const timedBtn = sel.timed ? root.querySelector(sel.timed) : null;
  const copyBtn = sel.copy ? root.querySelector(sel.copy) : null;

  let revealed = false;
  let holdTimer = null;
  let autoHideTimer = null;
  let dropTimer = null;
  let destroyed = false;

  function clearTimer(id) { if (id !== null) clearTimeout(id); return null; }

  function paintTimedLabel() {
    if (!timedBtn) return;
    const label = revealed ? (labels.hide || 'Hide') : (labels.reveal || `Show for ${Math.round(showMs / 1000)} seconds`);
    // The label is the button's text; `aria-label` is set too because some of these buttons carry
    // only an icon. Neither ever contains the secret.
    if (timedBtn.dataset.keepLabel !== 'true') timedBtn.textContent = label;
    timedBtn.setAttribute('aria-label', label);
    timedBtn.setAttribute('aria-pressed', String(revealed));
  }

  function reveal() {
    const secret = typeof getSecret === 'function' ? getSecret() : null;
    if (!secret || !mask || destroyed) return;
    revealed = true;
    mask.textContent = secret; // the one and only place it is ever written
    mask.classList.remove('masked');
    if (holdBtn) holdBtn.classList.remove('holding');
    autoHideTimer = clearTimer(autoHideTimer);
    if (showMs > 0) autoHideTimer = setTimeout(hide, showMs);
    paintTimedLabel();
  }

  /**
   * `drop` is the difference between "stop showing it" and "forget it". The ten-second auto-hide
   * and the Hide button only re-mask — the panel is still open and the caller still holds the
   * secret, so revealing again is free. Losing focus, backgrounding, the post-copy timer and
   * teardown are the ones that hand it back, and only for a caller that asked (`dropOnHide`).
   */
  function hide({ drop = false } = {}) {
    holdTimer = clearTimer(holdTimer);
    autoHideTimer = clearTimer(autoHideTimer);
    revealed = false;
    if (mask) {
      mask.textContent = masked;
      mask.classList.add('masked');
    }
    if (holdBtn) holdBtn.classList.remove('holding');
    paintTimedLabel();
    if (drop && typeof onDrop === 'function') onDrop();
  }

  // ---- press and hold ----
  function startHold(evt) {
    if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
    if (!holdBtn || holdBtn.disabled) return;
    if (typeof getSecret === 'function' && !getSecret()) return;
    holdBtn.classList.add('holding');
    holdTimer = clearTimer(holdTimer);
    holdTimer = setTimeout(reveal, holdMs);
  }
  function cancelHold() {
    if (holdBtn) holdBtn.classList.remove('holding');
    holdTimer = clearTimer(holdTimer);
  }
  function onHoldKeyDown(evt) {
    if (evt.key === 'Enter' || evt.key === ' ') startHold(evt);
  }

  // ---- the non-hold alternative ----
  function onTimedClick(evt) {
    if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
    if (timedBtn && timedBtn.disabled) return;
    if (revealed) hide(); else reveal();
  }

  // ---- copy ----
  async function onCopyClick(evt) {
    if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
    if (copyBtn && copyBtn.disabled) return;
    const secret = typeof getSecret === 'function' ? getSecret() : null;
    if (!secret || typeof copy !== 'function') return;
    await copy(secret);
    if (destroyed) return;
    if (typeof onCopied === 'function') onCopied();
    // A secret that has been copied has served its purpose; callers that asked to forget it do so
    // shortly afterwards rather than leaving it in a closure for the life of the screen.
    if (dropOnHide && typeof onDrop === 'function') {
      dropTimer = clearTimer(dropTimer);
      dropTimer = setTimeout(() => { hide({ drop: true }); }, copyDropMs);
    }
  }

  // ---- the window stopped being looked at ----
  // Backgrounded or blurred: a secret must not sit on a screen nobody is looking at. For a caller
  // with `dropOnHide` this also hands it back — the post-copy timer aside, this is the path that
  // makes settings ask for the password again.
  function onAway() { if (revealed) hide({ drop: dropOnHide }); }
  function onVisibility() { if (typeof document !== 'undefined' && document.hidden) onAway(); }

  if (holdBtn) {
    holdBtn.addEventListener('pointerdown', startHold);
    holdBtn.addEventListener('pointerup', cancelHold);
    holdBtn.addEventListener('pointerleave', cancelHold);
    holdBtn.addEventListener('pointercancel', cancelHold);
    holdBtn.addEventListener('keydown', onHoldKeyDown);
    holdBtn.addEventListener('keyup', cancelHold);
  }
  if (timedBtn) timedBtn.addEventListener('click', onTimedClick);
  if (copyBtn) copyBtn.addEventListener('click', onCopyClick);
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('blur', onAway);
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', onVisibility);
  }
  paintTimedLabel();

  return {
    hide,
    isRevealed: () => revealed,
    destroy() {
      destroyed = true;
      holdTimer = clearTimer(holdTimer);
      autoHideTimer = clearTimer(autoHideTimer);
      dropTimer = clearTimer(dropTimer);
      revealed = false;
      if (mask) { mask.textContent = ''; mask.classList.add('masked'); }
      if (holdBtn) {
        holdBtn.removeEventListener('pointerdown', startHold);
        holdBtn.removeEventListener('pointerup', cancelHold);
        holdBtn.removeEventListener('pointerleave', cancelHold);
        holdBtn.removeEventListener('pointercancel', cancelHold);
        holdBtn.removeEventListener('keydown', onHoldKeyDown);
        holdBtn.removeEventListener('keyup', cancelHold);
      }
      if (timedBtn) timedBtn.removeEventListener('click', onTimedClick);
      if (copyBtn) copyBtn.removeEventListener('click', onCopyClick);
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('blur', onAway);
      }
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      if (typeof onDrop === 'function') onDrop();
    },
  };
}
