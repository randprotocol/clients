// The lock gate: shown whenever a wallet exists on the device but is not unlocked (see
// resolveRoute in ../app.js). The typed password never touches ctx.state — it is read straight
// off the input and handed to backend.wallet.unlock.
import { h, raw, on } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';
import { markInvalid, markValid } from '../lib/forms.js';

registerScreen('lock', {
  render() {
    return h`
      <div class="onboard">
        <span class="mark-lg">${raw(icons.lock())}</span>
        <div class="stack tight">
          <h1 class="title">Welcome back</h1>
          <p class="subtitle">Enter your password to unlock Rand Wallet.</p>
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
        await ctx.unlockWallet(input.value);
        markValid(wrap, input, 'lock-password-hint');
        input.value = '';
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
