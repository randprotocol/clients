// Onboarding: welcome → create/import → backup. No wallet exists yet for welcome/create/import
// (resolveRoute only reaches these while `!exists`); by the time `backup` renders, the wallet
// does exist (wallet.create/import already ran), which is why backup is reachable through the
// normal "unlocked" routing branch.
import { h, raw, on } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';

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

function markInvalid(wrap, input, errorId) {
  wrap.classList.add('invalid');
  input.setAttribute('aria-invalid', 'true');
  input.setAttribute('aria-describedby', errorId);
}
function markValid(wrap, input) {
  wrap.classList.remove('invalid');
  input.removeAttribute('aria-invalid');
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
    <form novalidate class="stack loose">
      ${isImport ? raw(h`
      <label class="field">
        <span class="label">Recovery key</span>
        <textarea name="key" rows="3" spellcheck="false" autocomplete="off" placeholder="Paste your recovery phrase or spend key" aria-describedby="key-hint"></textarea>
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
    </form>`;
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
    if (input.value.length >= 10) markValid(pwWrap, pwField);
  });

  async function onSubmit(evt) {
    evt.preventDefault();
    let ok = true;
    if (keyField) {
      if (!keyField.value.trim()) { markInvalid(keyWrap, keyField, 'key-error'); ok = false; }
      else markValid(keyWrap, keyField);
    }
    if (pwField.value.length < 10) { markInvalid(pwWrap, pwField, 'password-error'); ok = false; }
    else markValid(pwWrap, pwField);
    if (confirmField.value !== pwField.value || confirmField.value === '') {
      markInvalid(confirmWrap, confirmField, 'confirm-error'); ok = false;
    } else markValid(confirmWrap, confirmField);
    if (!ok) return;

    try {
      if (isImport) await ctx.backend.wallet.import(keyField.value.trim(), pwField.value);
      else await ctx.backend.wallet.create(pwField.value);
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
      <div class="banner">
        <span class="ic">${raw(icons.shield())}</span>
        <span><span class="banner-title">Shown once, kept on this device</span>Your recovery key is never sent anywhere and will not be shown again after this step.</span>
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
      </form>`;
  },
  async after(ctx, root) {
    let key = null;
    try {
      key = await ctx.backend.wallet.exportSpendKey();
    } catch {
      ctx.toast('Could not load your recovery key.', { kind: 'negative' });
    }

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
      markValid(wrap, input);
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
