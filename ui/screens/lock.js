// The lock gate: shown whenever a wallet exists on the device but is not unlocked (see
// resolveRoute in ../app.js). The typed password never touches ctx.state — it is read straight
// off the input and handed to backend.wallet.unlock.
import { h, raw, on } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';

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
        <button class="btn-ghost sm" type="button" data-action="wipe">Forgot? Wipe and restore</button>
      </div>`;
  },
  after(ctx, root) {
    const form = root.querySelector('form');
    const input = form.querySelector('input[name=password]');
    const wrap = input.closest('.field');
    const wipeBtn = root.querySelector('[data-action="wipe"]');

    async function onSubmit(evt) {
      evt.preventDefault();
      try {
        await ctx.backend.wallet.unlock(input.value);
        input.value = '';
        ctx.go('#home');
      } catch {
        wrap.classList.add('invalid');
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', 'lock-password-error');
        input.value = '';
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
        await ctx.backend.wallet.wipe();
        ctx.closeSheet();
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
