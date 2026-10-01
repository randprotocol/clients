// The lock gate: shown whenever a wallet exists on the device but is not unlocked (see
// resolveRoute in ../app.js). The typed password never touches ctx.state — it is read straight
// off the input and handed to backend.wallet.unlock.
import { h, raw, on } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';
import { markInvalid, markValid } from '../lib/forms.js';
import { markSvg } from '../lib/entropy.js';

/** A passkey prompt is open. The screen can mount twice in a row (a route resolved, then
 *  re-entered), and a second fingerprint prompt stacked on the first is a bug the user sees: the
 *  automatic ask waits a tick, asks only from the screen still on show, and never while another
 *  ask is open. */
let promptOpen = false;

registerScreen('lock', {
  render() {
    return h`
      <div class="onboard">
        <span class="mark-lg bare">${raw(markSvg())}</span>
        <div class="stack tight">
          <h1 class="title">Welcome back</h1>
          <p class="subtitle" data-role="lock-subtitle">Enter your password to unlock Rand Wallet.</p>
        </div>
        <div class="stack onboard-actions" data-role="passkey-slot" hidden>
          <button class="btn btn-primary block" type="button" data-action="passkey">Unlock</button>
          <span class="hint" data-role="passkey-note"></span>
        </div>
        <form novalidate class="stack onboard-actions">
          <label class="field">
            <span class="label">Password</span>
            <input name="password" type="password" autocomplete="current-password" aria-describedby="lock-password-hint">
            <span class="hint" id="lock-password-hint">Set on this device when this wallet was created.</span>
            <span class="error" id="lock-password-error">Incorrect password.</span>
          </label>
          <button class="btn btn-primary block" type="submit">Unlock</button>
        </form>
        <div data-role="damaged-slot"></div>
        <button class="btn btn-ghost sm" type="button" data-action="wipe">Forgot? Wipe and restore</button>
      </div>`;
  },
  after(ctx, root) {
    const form = root.querySelector('form');
    const input = form.querySelector('input[name=password]');
    const wrap = input.closest('.field');
    const wipeBtn = root.querySelector('[data-action="wipe"]');

    const errorEl = root.querySelector('#lock-password-error');
    const damagedSlot = root.querySelector('[data-role="damaged-slot"]');

    /**
     * Not every failed unlock is a wrong password. A vault that is structurally broken, or one
     * written by a newer build, can never be opened by *any* password — so telling the user
     * "Incorrect password" leaves them typing into a box that cannot work while the backend's
     * backoff grows. Those two say what happened and point at the one way out, which is the
     * wipe-and-restore this screen already offers. See ui/backend.js.
     */
    function showDamaged(err) {
      damagedSlot.innerHTML = h`
        <div class="banner negative">
          <span class="ic">${raw(icons.warning())}</span>
          <span>
            <span class="banner-title">This wallet cannot be opened</span>
            ${(err && err.message) || 'The stored wallet data could not be read.'}
            Your funds are on chain: wipe this device and restore with your recovery key.
          </span>
        </div>`;
      wipeBtn.classList.add('btn-primary');
      wipeBtn.textContent = 'Wipe and restore from your recovery key';
    }

    async function onSubmit(evt) {
      evt.preventDefault();
      try {
        // Through the shell, not backend.wallet.unlock directly: unlocking is a new wallet
        // session, and the shell is what ends the old one (see ctx.unlockWallet in ../app.js).
        const password = input.value;
        await ctx.unlockWallet(password);
        markValid(wrap, input, 'lock-password-hint');
        input.value = '';
        // Touch ID as the default (the owner's ask): right after a password unlock, on a device that
        // can do it, offer it once — the password just typed is the one it seals. "Not now" is
        // remembered on this device, and Settings → Security still turns it on later.
        if (await shouldOfferPasskey()) { offerPasskey(password); return; }
        ctx.go('#home');
      } catch (err) {
        input.value = '';
        // `recoverable` is the contract's flag for "no password will ever work here".
        if (err && err.recoverable === true) {
          markValid(wrap, input, 'lock-password-hint');
          showDamaged(err);
          if (ctx.isCurrent()) wipeBtn.focus();
          return;
        }
        errorEl.textContent = 'Incorrect password.';
        markInvalid(wrap, input, 'lock-password-error');
        input.focus();
      }
    }
    form.addEventListener('submit', onSubmit);

    const OFFER_KEY = 'rand-wallet.passkeyOfferDeclined';
    async function shouldOfferPasskey() {
      const pk = ctx.backend.wallet && ctx.backend.wallet.passkey;
      if (!pk) return false;
      try {
        if (globalThis.localStorage && globalThis.localStorage.getItem(OFFER_KEY)) return false;
      } catch { /* no storage: offer */ }
      try { return (await pk.available()) && !(await pk.enabled()); } catch { return false; }
    }
    function offerPasskey(password) {
      const pk = ctx.backend.wallet.passkey;
      const label = pk.label();
      const dialog = ctx.sheet(h`
        <h3 class="sheet-title">Unlock with ${label} next time?</h3>
        <p class="sheet-sub">Open Rand Wallet with ${label} instead of typing your password. Your password still works, and stays the way to restore access.</p>
        <p class="caption" data-role="offer-error"></p>
        <div class="sheet-foot">
          <button class="btn" type="button" data-role="not-now">Not now</button>
          <button class="btn btn-primary" type="button" data-role="turn-on">Turn on ${label}</button>
        </div>`);
      let done = false;
      const finish = () => { if (done) return; done = true; password = ''; ctx.closeSheet(); ctx.go('#home'); };
      on(dialog, '[data-role="not-now"]', 'click', () => {
        try { globalThis.localStorage && globalThis.localStorage.setItem(OFFER_KEY, '1'); } catch { /* asked again next time */ }
        finish();
      });
      on(dialog, '[data-role="turn-on"]', 'click', async (evt, btn) => {
        btn.disabled = true;
        try {
          await pk.enable(password);
          ctx.toast(`${label} is on`, { kind: 'positive' });
          finish();
        } catch (err) {
          btn.disabled = false;
          dialog.querySelector('[data-role="offer-error"]').textContent = `${label} could not be set up: ${(err && err.message) || err}. You can try again from Settings → Security.`;
        }
      });
    }

    // ---- unlock with a passkey (Touch ID) ----
    // Where the wallet has one set up it is the default: offered first, and asked for at once, so
    // opening the wallet is a fingerprint. The password below stays, for when the passkey cannot
    // answer — and for the day the password changed and the passkey's copy no longer opens the
    // vault, when the record is dropped and the user is told to turn it on again.
    const pkApi = ctx.backend.wallet && ctx.backend.wallet.passkey;
    const pkSlot = root.querySelector('[data-role="passkey-slot"]');
    const pkBtn = root.querySelector('[data-action="passkey"]');
    const pkNote = root.querySelector('[data-role="passkey-note"]');
    let pkBusy = false;
    async function unlockWithPasskey() {
      if (pkBusy || !pkApi || promptOpen) return;
      pkBusy = true;
      promptOpen = true;
      pkBtn.disabled = true;
      pkNote.textContent = '';
      try {
        const password = await pkApi.recoverPassword();
        try {
          await ctx.unlockWallet(password);
        } catch (err) {
          if (err && err.recoverable === true) { showDamaged(err); return; }
          // The password changed since the passkey sealed it: the copy is worthless now.
          await pkApi.disable();
          pkSlot.hidden = true;
          errorEl.textContent = `${pkApi.label()} no longer opens this wallet (its password changed). Unlock with the password, then turn ${pkApi.label()} on again in Settings.`;
          markInvalid(wrap, input, 'lock-password-error');
          input.focus();
          return;
        }
        ctx.go('#home');
      } catch (err) {
        pkNote.textContent = err && err.code === 'CANCELLED'
          ? `Cancelled. Press Unlock to try ${pkApi.label()} again, or use your password.`
          : `${(err && err.message) || 'The passkey did not answer.'} Use your password instead.`;
      } finally {
        pkBusy = false;
        promptOpen = false;
        pkBtn.disabled = false;
      }
    }
    pkBtn.addEventListener('click', () => { void unlockWithPasskey(); });
    if (pkApi) {
      void (async () => {
        let on = false;
        try { on = (await pkApi.enabled()) && (await pkApi.available()); } catch { on = false; }
        if (!on || !ctx.isCurrent()) return;
        const label = pkApi.label();
        pkBtn.textContent = `Unlock with ${label}`;
        root.querySelector('[data-role="lock-subtitle"]').textContent = `Use ${label}, or enter your password.`;
        form.querySelector('button[type=submit]').classList.remove('btn-primary');
        form.querySelector('button[type=submit]').textContent = 'Unlock with password';
        pkSlot.hidden = false;
        // Asked for at once where the browser lets a focused page do so; a browser that wants a
        // click first simply leaves the button.
        await new Promise((r) => setTimeout(r, 0));
        const focused = typeof document === 'undefined' || !document.hasFocus || document.hasFocus();
        if (focused && ctx.isCurrent() && !promptOpen) void unlockWithPasskey();
      })();
    }

    function onWipe(evt) {
      evt.preventDefault();
      const dialog = ctx.sheet(h`
        <h3 class="sheet-title">Wipe this wallet?</h3>
        <p class="sheet-sub">This removes the wallet from this device. You will need your recovery key to restore it.</p>
        <div class="sheet-foot">
          <button class="btn" type="button" data-role="cancel">Keep wallet</button>
          <button class="btn danger" type="button" data-role="confirm">Wipe wallet</button>
        </div>`);
      on(dialog, '[data-role="cancel"]', 'click', () => ctx.closeSheet());
      on(dialog, '[data-role="confirm"]', 'click', async () => {
        // ctx.wipeWallet() ends the wallet session: it aborts anything in flight, empties
        // ctx.state and closes this very sheet, so nothing from the wiped wallet can outlive it.
        await ctx.wipeWallet();
        ctx.closeSheet(); // idempotent — endSession() has usually closed it already
        ctx.go('#welcome');
      });
      // No explicit unsubscribe: `dialog` is removed from the DOM on close (by closeSheet or the
      // scrim/Escape handlers) and, being unreferenced from then on, is free to be collected along
      // with its listeners.
    }
    wipeBtn.addEventListener('click', onWipe);

    return () => { wipeBtn.removeEventListener('click', onWipe); };
  },
});
