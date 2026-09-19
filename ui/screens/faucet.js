// Faucet: one button, `backend.faucet.request()`. Success → toast + home; failure → the node's
// message shown inline (escaped through h); the button is disabled for the duration of the
// request so a second tap cannot fire a second one while the first is still in flight.
import { h, raw } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';

registerScreen('faucet', {
  render() {
    return h`
      <div class="topbar"><button class="btn-icon icon-flip" type="button" data-go="home" aria-label="Back">${raw(icons.chevron())}</button><span class="topbar-title">Faucet</span><span class="spacer"></span></div>
      <div class="onboard">
        <span class="mark-lg">${raw(icons.droplet())}</span>
        <div class="stack tight">
          <h1 class="title">Get test RAND</h1>
          <p class="subtitle pitch">Request RAND from the faucet to try sending, receiving and proving on this network.</p>
        </div>
        <div class="onboard-actions">
          <button class="btn btn-primary block" type="button" data-role="request">Request RAND</button>
        </div>
        <div data-role="error-slot"></div>
      </div>`;
  },
  after(ctx, root) {
    const btn = root.querySelector('[data-role="request"]');
    const errorSlot = root.querySelector('[data-role="error-slot"]');

    function showError(message) {
      errorSlot.innerHTML = h`<div class="banner negative"><span class="ic">${raw(icons.warning())}</span><span><span class="banner-title">The faucet could not send RAND</span>${message}</span></div>`;
    }
    function clearError() {
      errorSlot.innerHTML = '';
    }

    async function onClick(evt) {
      evt.preventDefault();
      clearError();
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
      try {
        await ctx.backend.faucet.request();
        ctx.toast('RAND is on its way', { kind: 'positive' });
        ctx.go('#home');
      } catch (err) {
        showError((err && err.message) || 'The faucet is unavailable right now.');
        btn.disabled = false;
        btn.removeAttribute('aria-disabled');
      }
    }
    btn.addEventListener('click', onClick);

    return () => { btn.removeEventListener('click', onClick); };
  },
});
