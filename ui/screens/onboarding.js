// Onboarding: welcome → create/import → backup. No wallet exists yet for welcome/create/import
// (resolveRoute only reaches these while `!exists`); by the time `backup` renders, the wallet
// does exist (wallet.create/import already ran), which is why backup is reachable through the
// normal "unlocked" routing branch. resolveRoute also refuses to route back to welcome/create/
// import once a wallet exists, but the create/import submit handlers check again themselves
// (defence in depth — see wirePasswordForm) rather than trust that they were only ever reached
// while there is no wallet.
import { h, raw, on } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';
import { markInvalid, markValid } from '../lib/forms.js';

const STRENGTH_LABELS = ['Enter at least 10 characters', 'Weak', 'Fair', 'Good', 'Strong'];

/** A rough 0–4 estimate from length and character variety — good enough to nudge, not a policy. */
function scorePassword(pw) {
  if (!pw || pw.length < 10) return 0;
  let variety = 0;
  if (/[a-z]/.test(pw)) variety++;
  if (/[A-Z]/.test(pw)) variety++;
  if (/[0-9]/.test(pw)) variety++;
  if (/[^A-Za-z0-9]/.test(pw)) variety++;
  let score = 1;
  if (pw.length >= 14) score++;
  if (pw.length >= 20 || variety >= 3) score++;
  if (pw.length >= 24 && variety >= 2) score++;
  return Math.min(score, 4);
}

// ---------------------------------------------------------------------------------- welcome ---
registerScreen('welcome', {
  render() {
    return h`
      <div class="onboard">
        <span class="mark-lg"></span>
        <div class="stack tight">
          <h1 class="title">Rand Wallet</h1>
          <p class="subtitle pitch">A shielded wallet for the Rand network. Balances and history stay private — every send is proved on this device.</p>
        </div>
        <div class="onboard-actions">
          <button class="btn btn-primary block" type="button" data-go="create">Create a new wallet</button>
          <button class="btn block" type="button" data-go="import">I already have a wallet</button>
        </div>
        <p class="caption onboard-foot">${raw(icons.shield())}Your keys never leave this device.</p>
      </div>`;
  },
});

// ----------------------------------------------------------------------------- create/import ---
function passwordFormMarkup({ mode }) {
  const isImport = mode === 'import';
  return h`
    <div class="topbar">
      <button class="btn-icon icon-flip" type="button" data-go="welcome" aria-label="Back">${raw(icons.chevron())}</button>
      <span class="topbar-title">${isImport ? 'Import wallet' : 'Create wallet'}</span>
      <span class="spacer"></span>
    </div>
    <div class="onboard form">
      <form novalidate class="stack loose">
        ${isImport ? raw(h`
        <label class="field">
          <span class="label">Recovery key</span>
          <textarea name="key" rows="3" spellcheck="false" autocomplete="off" placeholder="Paste your recovery key" aria-describedby="key-hint"></textarea>
          <span class="hint" id="key-hint">The key you exported when this wallet was created.</span>
          <span class="error" id="key-error">Enter your recovery key.</span>
        </label>`) : ''}
        <label class="field">
          <span class="label">${isImport ? 'New password' : 'Password'}</span>
          <input name="password" type="password" autocomplete="new-password" minlength="10" aria-describedby="password-hint">
          <span class="strength" data-level="0">
            <span class="strength-track">
              <span class="strength-bar"></span><span class="strength-bar"></span><span class="strength-bar"></span><span class="strength-bar"></span>
            </span>
            <span class="strength-label">${STRENGTH_LABELS[0]}</span>
          </span>
          <span class="hint" id="password-hint">Unlocks this wallet on this device only — it is never sent anywhere.</span>
          <span class="error" id="password-error">Use at least 10 characters.</span>
        </label>
        <label class="field">
          <span class="label">Confirm password</span>
          <input name="confirm" type="password" autocomplete="new-password" aria-describedby="confirm-hint">
          <span class="hint" id="confirm-hint">Type it once more.</span>
          <span class="error" id="confirm-error">Passwords do not match.</span>
        </label>
        <button class="btn btn-primary block" type="submit">${isImport ? 'Import wallet' : 'Create wallet'}</button>
      </form>
    </div>`;
}

function wirePasswordForm(ctx, root, { mode }) {
  const isImport = mode === 'import';
  const form = root.querySelector('form');
  const pwField = form.querySelector('input[name=password]');
  const confirmField = form.querySelector('input[name=confirm]');
  const pwWrap = pwField.closest('.field');
  const confirmWrap = confirmField.closest('.field');
  const strengthEl = form.querySelector('.strength');
  const strengthLabel = strengthEl.querySelector('.strength-label');
  const keyField = isImport ? form.querySelector('textarea[name=key]') : null;
  const keyWrap = keyField ? keyField.closest('.field') : null;

  const offInput = on(form, 'input[name=password]', 'input', (_evt, input) => {
    const score = scorePassword(input.value);
    strengthEl.dataset.level = String(score);
    strengthLabel.textContent = STRENGTH_LABELS[score];
    if (input.value.length >= 10) markValid(pwWrap, pwField, 'password-hint');
  });

  async function onSubmit(evt) {
    evt.preventDefault();
    let ok = true;
    if (keyField) {
      if (!keyField.value.trim()) { markInvalid(keyWrap, keyField, 'key-error'); ok = false; }
      else markValid(keyWrap, keyField, 'key-hint');
    }
    if (pwField.value.length < 10) { markInvalid(pwWrap, pwField, 'password-error'); ok = false; }
    else markValid(pwWrap, pwField, 'password-hint');
    if (confirmField.value !== pwField.value || confirmField.value === '') {
      markInvalid(confirmWrap, confirmField, 'confirm-error'); ok = false;
    } else markValid(confirmWrap, confirmField, 'confirm-hint');
    if (!ok) return;

    // Defence in depth: resolveRoute already refuses to route here once a wallet exists, so this
    // should be unreachable in normal use — but this handler must never call wallet.create/import
    // a second time over an existing wallet (that overwrites, i.e. destroys, the current keys),
    // so it checks again itself rather than trust routing alone.
    if (await ctx.backend.wallet.exists()) {
      ctx.toast('A wallet already exists on this device.', { kind: 'negative' });
      ctx.go('#home');
      return;
    }

    try {
      // Through the shell, not backend.wallet.create/import directly: a new wallet is a new
      // session, and ctx.createWallet/importWallet start it *before* this returns, so #backup
      // below renders inside the new session (and can still read its own spend key).
      if (isImport) await ctx.importWallet(keyField.value.trim(), pwField.value);
      else await ctx.createWallet(pwField.value);
      pwField.value = '';
      confirmField.value = '';
      if (keyField) keyField.value = '';
      ctx.go('#backup');
    } catch (err) {
      const message = (err && err.message) || 'Could not create the wallet.';
      pwWrap.querySelector('.error').textContent = message;
      markInvalid(pwWrap, pwField, 'password-error');
      ctx.toast(message, { kind: 'negative' });
    }
  }
  form.addEventListener('submit', onSubmit);

  return () => { offInput(); };
}

registerScreen('create', {
  render: () => passwordFormMarkup({ mode: 'create' }),
  after: (ctx, root) => wirePasswordForm(ctx, root, { mode: 'create' }),
});

registerScreen('import', {
  render: () => passwordFormMarkup({ mode: 'import' }),
  after: (ctx, root) => wirePasswordForm(ctx, root, { mode: 'import' }),
});

// ----------------------------------------------------------------------------------- backup ---
registerScreen('backup', {
  nav: false, // a security gate — no tab bar/sidebar to tab away through mid-flow
  render() {
    return h`
      <div class="topbar"><span class="topbar-title">Back up your wallet</span></div>
      <div class="onboard form">
        <div class="stack loose">
          <div class="banner">
            <span class="ic">${raw(icons.shield())}</span>
            <span><span class="banner-title">Save your recovery key</span>This key is your wallet. Anyone who has it can spend your funds, and without it a lost device means lost funds. You can view it again in Settings with your password.</span>
          </div>
          <div class="hold-reveal">
            <span class="key-mask masked" data-role="key">•••• •••• •••• •••• •••• •••• •••• ••••</span>
            <button class="btn block hold-btn" type="button" data-role="hold">
              <span class="fill"></span>${raw(icons.eye())}Hold to reveal
            </button>
          </div>
          <form novalidate class="stack" data-role="check-form" hidden>
            <label class="field">
              <span class="label">Confirm you saved it</span>
              <input name="check" type="text" autocomplete="off" spellcheck="false" placeholder="First 4 characters" aria-describedby="check-hint">
              <span class="hint" id="check-hint">Enter the first 4 characters of your recovery key.</span>
              <span class="error" id="check-error">That does not match — reveal the key again and check.</span>
            </label>
            <button class="btn btn-primary block" type="submit">Continue</button>
          </form>
        </div>
      </div>`;
  },
  async after(ctx, root) {
    let key = null;
    try {
      key = await ctx.backend.wallet.exportSpendKey();
    } catch {
      if (ctx.isCurrent()) ctx.toast('Could not load your recovery key.', { kind: 'negative' });
    }
    // The user may have navigated away while the key was being exported. Drop it on the floor
    // rather than wiring up a screen that is no longer on display: `key` goes out of scope with
    // this function, so it is never written anywhere at all.
    if (!ctx.isCurrent()) { key = null; return; }

    const mask = root.querySelector('[data-role="key"]');
    const holdBtn = root.querySelector('[data-role="hold"]');
    const form = root.querySelector('[data-role="check-form"]');
    const input = form.querySelector('input[name=check]');
    const wrap = input.closest('.field');
    let holdTimer = null;
    let revealed = false;

    function reveal() {
      if (!key) return;
      revealed = true;
      mask.textContent = key; // the only place the key is ever written: this text node
      mask.classList.remove('masked');
      holdBtn.classList.remove('holding');
      form.hidden = false;
    }
    function startHold(evt) {
      evt.preventDefault();
      if (!key) return;
      holdBtn.classList.add('holding');
      clearTimeout(holdTimer);
      holdTimer = setTimeout(reveal, 650);
    }
    function cancelHold() {
      holdBtn.classList.remove('holding');
      clearTimeout(holdTimer);
    }
    holdBtn.addEventListener('pointerdown', startHold);
    holdBtn.addEventListener('pointerup', cancelHold);
    holdBtn.addEventListener('pointerleave', cancelHold);
    holdBtn.addEventListener('pointercancel', cancelHold);
    holdBtn.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') startHold(evt);
    });
    holdBtn.addEventListener('keyup', cancelHold);

    form.addEventListener('submit', (evt) => {
      evt.preventDefault();
      if (!revealed || !key || input.value.trim() !== key.slice(0, 4)) {
        markInvalid(wrap, input, 'check-error');
        return;
      }
      markValid(wrap, input, 'check-hint');
      cleanup();
      ctx.go('#home');
    });

    function cleanup() {
      key = null;
      mask.textContent = '';
      mask.classList.add('masked');
      clearTimeout(holdTimer);
    }
    return cleanup;
  },
});
