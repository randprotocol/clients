// Settings: Network, Appearance, Security, About.
//
// Two rules run through the whole screen:
//
//   * **Everything the node says is text.** A status field, a chain id, an error message — none of
//     it is markup, all of it goes through `h`, none of it is ever `raw()`ed.
//
//   * **A secret is re-authenticated, never re-unlocked.** `wallet.unlock()` would be the obvious
//     way to ask for the password again, and it is the wrong one: the shell treats every unlock as
//     a new wallet session and tears down the current one (see ui/app.js), so asking to look at
//     the viewing key would drop everything else on the way. `wallet.verifyPassword(password)`
//     answers the question and changes nothing. Once past it, the key lives in a closure and is
//     written to exactly one text node while it is revealed — never an attribute, `ctx.state`, the
//     URL or storage.
import { h, raw, on } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';
import { markInvalid, markValid } from '../lib/forms.js';

const THEMES = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];
const AUTO_LOCK = [
  { value: 1, label: '1 minute' },
  { value: 5, label: '5 minutes' },
  { value: 15, label: '15 minutes' },
  { value: 60, label: '1 hour' },
  { value: 0, label: 'Never' },
];
const HOLD_MS = 650;
const WIPE_WORD = 'WIPE';
const SPEND_KEY_WARNING = 'Anyone with this key can spend everything this wallet holds, now and in '
  + 'the future. It is not a backup to keep in a note-taking app or to paste into a chat — an '
  + 'explorer or a watcher only ever needs the viewing key.';

/**
 * Is `url` somewhere this wallet may talk to? https anywhere; plain http only to this machine,
 * because an RPC call carries the addresses the wallet cares about and a plaintext answer is
 * something a network can rewrite. Returns `{url}` (normalised, no trailing slash) or `{error}`.
 */
export function checkRpcUrl(text) {
  const value = String(text || '').trim().replace(/\/+$/, '');
  if (!value) return { error: 'Enter the address of a Rand node.' };
  let parsed;
  try { parsed = new URL(value); } catch { return { error: 'That is not a URL. It should look like https://rpc.example.' }; }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol === 'https:') return { url: value };
  if (parsed.protocol === 'http:' && local) return { url: value };
  if (parsed.protocol === 'http:') return { error: 'Use https — plain http is only allowed for a node on this machine.' };
  return { error: 'Use an https:// address.' };
}

function sectionMarkup(title, body) {
  return h`<h2 class="section-title">${title}</h2><div class="card stack">${raw(body)}</div>`;
}

function networkMarkup(settings) {
  return sectionMarkup('Network', h`
    <form data-role="network-form" class="stack" novalidate>
      <div class="field">
        <label class="label" for="settings-rpc">RPC URL</label>
        <input id="settings-rpc" name="rpcUrl" type="text" spellcheck="false" autocomplete="off" value="${settings.rpcUrl || ''}" aria-describedby="settings-rpc-hint">
        <span class="hint" id="settings-rpc-hint">The Rand node this wallet reads from and submits to.</span>
        <span class="error" id="settings-rpc-error"></span>
      </div>
      <div class="cluster">
        <button class="btn btn-primary" type="submit">Save</button>
        <button class="btn" type="button" data-role="test-connection">Test connection</button>
      </div>
      <div data-role="network-status"></div>
    </form>`);
}

function appearanceMarkup(settings) {
  const current = settings.theme || 'system';
  const segments = THEMES.map((t) => h`
    <button class="seg" type="button" role="radio" data-value="${t.value}" aria-checked="${t.value === current ? 'true' : 'false'}">${t.label}</button>`).join('');
  return sectionMarkup('Appearance', h`
    <div class="field">
      <span class="label" id="settings-theme-label">Theme</span>
      <div class="segmented" role="radiogroup" aria-labelledby="settings-theme-label" data-role="theme">${raw(segments)}</div>
    </div>`);
}

function securityMarkup(settings) {
  const options = AUTO_LOCK.map((o) => h`
    <option value="${o.value}"${raw(String(o.value) === String(settings.autoLockMin) ? ' selected' : '')}>${o.label}</option>`).join('');
  return h`
    <h2 class="section-title">Security</h2>
    <div class="card stack">
      <div class="field">
        <label class="label" for="settings-autolock">Lock automatically after</label>
        <select id="settings-autolock" name="autoLockMin" aria-describedby="settings-autolock-hint">${raw(options)}</select>
        <span class="hint" id="settings-autolock-hint">The wallet asks for your password again after this long without use.</span>
      </div>
    </div>
    <div class="card stack">
      <div class="card-head"><h3>Viewing key</h3></div>
      <p class="caption">A viewing key shows everything this wallet has ever received or sent, past and future. It cannot spend. It is all or nothing — to disclose one payment, use that payment's transaction key instead.</p>
      <div data-role="viewing-key-slot">
        <button class="btn block" type="button" data-role="show-viewing-key">${raw(icons.eye())}Show viewing key</button>
      </div>
    </div>
    <div class="card stack">
      <div class="card-head"><h3>Spend key</h3></div>
      <p class="caption">The spend key <em>is</em> the wallet. Export it to move to another device, or to send from the desktop app, which can prove a transfer natively.</p>
      <div data-role="spend-key-slot">
        <button class="btn block" type="button" data-role="export-spend-key">${raw(icons.shield())}Export spend key</button>
      </div>
    </div>
    <div class="card stack">
      <div class="card-head"><h3>Wipe this wallet</h3></div>
      <div class="banner negative">
        <span class="ic">${raw(icons.warning())}</span>
        <span><span class="banner-title">This cannot be undone here</span>The notes stay on chain, but without your recovery key they are gone for good.</span>
      </div>
      <div class="field">
        <label class="label" for="settings-wipe">Type ${WIPE_WORD} to confirm</label>
        <input id="settings-wipe" name="wipe" type="text" autocomplete="off" spellcheck="false" aria-describedby="settings-wipe-hint">
        <span class="hint" id="settings-wipe-hint">Exactly those four letters, in capitals.</span>
      </div>
      <button class="btn danger block" type="button" data-role="wipe" disabled>Wipe this wallet</button>
    </div>`;
}

function aboutMarkup(platform, settings) {
  const version = typeof platform.version === 'string' && platform.version
    ? raw(h`<div class="kv"><span class="k">Version</span><span class="v mono">${platform.version}</span></div>`)
    : '';
  // https only, and only a URL the user's own settings supplied.
  let explorer = '';
  try {
    const url = new URL(String(settings.explorerUrl || ''));
    if (url.protocol === 'https:') {
      explorer = raw(h`<button class="btn block" type="button" data-role="external" data-url="${url.href}">${url.hostname}</button>`);
    }
  } catch { explorer = ''; }
  return sectionMarkup('About', h`
    <div data-role="about" class="stack tight">
      <div class="kv"><span class="k">App</span><span class="v">Rand Wallet</span></div>
      <div class="kv"><span class="k">Running on</span><span class="v">${platform.name || 'this device'}</span></div>
      ${version}
      ${explorer}
    </div>`);
}

registerScreen('settings', {
  render() {
    return h`
      <h1 class="sr-only">Settings</h1>
      <div class="topbar"><span class="topbar-title">Settings</span></div>
      <div data-role="body"><div class="skeleton block"></div></div>`;
  },
  async after(ctx, root) {
    const mySession = ctx.session.id;
    const live = () => ctx.isCurrent() && ctx.session.id === mySession;

    let settings;
    try {
      settings = await ctx.backend.settings.get();
    } catch (err) {
      if (!live()) return;
      root.querySelector('[data-role="body"]').innerHTML = h`
        <div class="banner negative"><span class="ic">${raw(icons.warning())}</span><span><span class="banner-title">Could not load your settings</span>${(err && err.message) || 'Something went wrong.'}</span></div>`;
      return;
    }
    if (!live()) return;

    const platform = ctx.backend.platform;
    const body = root.querySelector('[data-role="body"]');
    body.innerHTML = h`
      ${raw(networkMarkup(settings))}
      ${raw(appearanceMarkup(settings))}
      ${raw(securityMarkup(settings))}
      ${raw(aboutMarkup(platform, settings))}`;

    const statusEl = body.querySelector('[data-role="network-status"]');
    const rpcInput = body.querySelector('input[name=rpcUrl]');
    const rpcField = rpcInput.closest('.field');
    const rpcError = body.querySelector('#settings-rpc-error');
    const wipeInput = body.querySelector('input[name=wipe]');
    const wipeBtn = body.querySelector('[data-role="wipe"]');

    // Secrets live here and nowhere else, and are nulled on cleanup.
    let viewingKey = null;
    let spendKey = null;
    const holdTimers = new Map();

    function setRpcError(message) {
      if (message) {
        rpcError.textContent = message;
        rpcError.classList.add('field-error');
        markInvalid(rpcField, rpcInput, 'settings-rpc-error');
      } else {
        rpcError.textContent = '';
        rpcError.classList.remove('field-error');
        markValid(rpcField, rpcInput, 'settings-rpc-hint');
      }
    }

    /** Every string in here is node-controlled, so it is interpolated, never `raw()`ed. */
    function showStatus(kind, title, detail) {
      const cls = kind === 'warn' ? 'banner warn' : kind === 'negative' ? 'banner negative' : 'banner positive';
      const icon = kind === 'positive' ? icons.check() : kind === 'warn' ? icons.warning() : icons.warning();
      statusEl.innerHTML = h`
        <div class="${cls}">
          <span class="ic">${raw(icon)}</span>
          <span><span class="banner-title">${title}</span>${detail}</span>
        </div>`;
    }

    // ---- network ----
    const offSaveNetwork = on(body, '[data-role="network-form"]', 'submit', async (evt) => {
      evt.preventDefault();
      statusEl.innerHTML = '';
      const checked = checkRpcUrl(rpcInput.value);
      if (checked.error) { setRpcError(checked.error); return; }
      setRpcError(null);
      // Browser-extension shells have to ask for permission to reach a new host, and Firefox only
      // grants it while it is still handling the user's own click — so this is asked here, inside
      // the submit handler, before anything is written.
      if (typeof platform.ensureHostPermission === 'function') {
        let granted = false;
        try { granted = await platform.ensureHostPermission(checked.url); } catch { granted = false; }
        if (!live()) return;
        if (!granted) {
          showStatus('negative', 'Not saved', 'Permission to reach that host was not granted, so the node was left as it was.');
          return;
        }
      }
      try {
        await ctx.backend.settings.set({ rpcUrl: checked.url });
      } catch (err) {
        if (!live()) return;
        showStatus('negative', 'Not saved', (err && err.message) || 'The node could not be saved.');
        return;
      }
      if (!live()) return;
      settings = { ...settings, rpcUrl: checked.url };
      showStatus('positive', 'Saved', 'New transfers and scans use this node.');
    });

    const offTest = on(body, '[data-role="test-connection"]', 'click', async (evt, btn) => {
      evt.preventDefault();
      const checked = checkRpcUrl(rpcInput.value);
      if (checked.error) { setRpcError(checked.error); return; }
      setRpcError(null);
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      showStatus('positive', 'Connecting…', 'Asking the node for its height and chain id.');
      let status;
      let chainId;
      try {
        [status, chainId] = await Promise.all([
          ctx.backend.rpc.call('rand_status'),
          ctx.backend.rpc.call('rand_chainId'),
        ]);
      } catch (err) {
        if (!live()) return;
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        showStatus('negative', 'No answer', (err && err.message) || 'The node could not be reached.');
        return;
      }
      if (!live()) return;
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      const height = status && status.height !== undefined && status.height !== null ? String(status.height) : 'unknown';
      const heightText = /^\d+$/.test(height) ? Number(height).toLocaleString('en-US') : height;
      const theirs = String(chainId ?? '');
      const ours = String(settings.chainId ?? '');
      if (ours && theirs && theirs !== ours) {
        showStatus('warn', 'A different chain',
          `That node reports chain ${theirs}; this wallet is set up for chain ${ours}. Its notes and addresses will not match. Height ${heightText}.`);
        return;
      }
      showStatus('positive', 'Connected', `Chain ${theirs || 'unknown'} · height ${heightText}.`);
    });

    // ---- appearance ----
    const offTheme = on(body, '[data-role="theme"] .seg', 'click', async (evt, btn) => {
      evt.preventDefault();
      const value = btn.dataset.value;
      for (const seg of body.querySelectorAll('[data-role="theme"] .seg')) {
        seg.setAttribute('aria-checked', String(seg === btn));
      }
      document.documentElement.dataset.theme = value; // instantly, before anything is persisted
      try {
        await ctx.backend.settings.set({ theme: value });
      } catch {
        if (live()) ctx.toast('The theme could not be saved.', { kind: 'negative' });
        return;
      }
      if (!live()) return;
      settings = { ...settings, theme: value };
    });

    const offAutoLock = on(body, 'select[name=autoLockMin]', 'change', async (evt, select) => {
      const minutes = Number(select.value);
      try {
        await ctx.backend.settings.set({ autoLockMin: minutes });
      } catch {
        if (live()) ctx.toast('That could not be saved.', { kind: 'negative' });
        return;
      }
      if (!live()) return;
      settings = { ...settings, autoLockMin: minutes };
      ctx.toast('Saved', { kind: 'positive' });
    });

    // ---- re-authentication ----
    /**
     * Asks for the password in a sheet and resolves once `wallet.verifyPassword` says yes. Never
     * `wallet.unlock`: that would end the wallet session (and with it everything else on screen).
     */
    function askPassword(purpose, onOk) {
      const dialog = ctx.sheet(h`
        <h3 class="sheet-title">Enter your password</h3>
        <p class="sheet-sub">${purpose}</p>
        <form novalidate class="stack">
          <label class="field">
            <span class="label">Password</span>
            <input name="password" type="password" autocomplete="current-password" aria-describedby="reauth-hint">
            <span class="hint" id="reauth-hint">The password that unlocks this wallet on this device.</span>
            <span class="error" id="reauth-error">That is not the password for this wallet.</span>
          </label>
          <div class="sheet-foot">
            <button class="btn" type="button" data-role="cancel">Cancel</button>
            <button class="btn btn-primary" type="submit">Continue</button>
          </div>
        </form>`);
      const input = dialog.querySelector('input[name=password]');
      const wrap = input.closest('.field');
      on(dialog, '[data-role="cancel"]', 'click', () => ctx.closeSheet());
      on(dialog, 'form', 'submit', async (evt) => {
        evt.preventDefault();
        let ok = false;
        try { ok = await ctx.backend.wallet.verifyPassword(input.value); } catch { ok = false; }
        if (!live()) return;
        if (!ok) {
          markInvalid(wrap, input, 'reauth-error');
          dialog.querySelector('#reauth-error').classList.add('field-error');
          input.value = '';
          input.focus();
          return;
        }
        markValid(wrap, input, 'reauth-hint');
        input.value = '';
        ctx.closeSheet();
        onOk();
      });
    }

    // ---- hold to reveal, shared by the two key panels ----
    function wireHold(slot, getKey) {
      const mask = slot.querySelector('[data-role="mask"]');
      const holdBtn = slot.querySelector('[data-role="hold"]');
      if (!mask || !holdBtn) return;
      const reveal = () => {
        const key = getKey();
        if (!key) return;
        mask.textContent = key; // the only place a key is ever written
        mask.classList.remove('masked');
        holdBtn.classList.remove('holding');
      };
      const start = (evt) => {
        evt.preventDefault();
        if (holdBtn.disabled || !getKey()) return;
        holdBtn.classList.add('holding');
        clearTimeout(holdTimers.get(slot));
        holdTimers.set(slot, setTimeout(reveal, HOLD_MS));
      };
      const cancel = () => {
        holdBtn.classList.remove('holding');
        clearTimeout(holdTimers.get(slot));
      };
      holdBtn.addEventListener('pointerdown', start);
      holdBtn.addEventListener('pointerup', cancel);
      holdBtn.addEventListener('pointerleave', cancel);
      holdBtn.addEventListener('pointercancel', cancel);
      holdBtn.addEventListener('keydown', (evt) => { if (evt.key === 'Enter' || evt.key === ' ') start(evt); });
      holdBtn.addEventListener('keyup', cancel);
    }

    function keyPanelMarkup({ label, extra = '', disabled = false }) {
      return h`
        <div class="stack">
          ${raw(extra)}
          <div class="hold-reveal">
            <span class="key-mask masked" data-role="mask">•••• •••• •••• •••• •••• ••••</span>
            <button class="btn block hold-btn" type="button" data-role="hold"${raw(disabled ? ' disabled' : '')}>
              <span class="fill"></span>${raw(icons.eye())}Hold to reveal
            </button>
            <button class="btn block" type="button" data-role="copy">${raw(icons.copy())}Copy ${label}</button>
          </div>
        </div>`;
    }

    const offViewingKey = on(body, '[data-role="show-viewing-key"]', 'click', (evt) => {
      evt.preventDefault();
      askPassword('The viewing key discloses your whole history, so it is behind your password.', async () => {
        let key;
        try {
          key = await ctx.backend.wallet.viewingKey();
        } catch (err) {
          if (live()) ctx.toast((err && err.message) || 'The viewing key could not be read.', { kind: 'negative' });
          return;
        }
        if (!live()) { key = null; return; } // never written anywhere at all
        viewingKey = key;
        const slot = body.querySelector('[data-role="viewing-key-slot"]');
        slot.innerHTML = keyPanelMarkup({ label: 'viewing key' });
        wireHold(slot, () => viewingKey);
      });
    });

    const offSpendKey = on(body, '[data-role="export-spend-key"]', 'click', (evt) => {
      evt.preventDefault();
      askPassword('Exporting the spend key is behind your password.', async () => {
        let key;
        try {
          key = await ctx.backend.wallet.exportSpendKey();
        } catch (err) {
          if (live()) ctx.toast((err && err.message) || 'The spend key could not be read.', { kind: 'negative' });
          return;
        }
        if (!live()) { key = null; return; }
        spendKey = key;
        const slot = body.querySelector('[data-role="spend-key-slot"]');
        slot.innerHTML = keyPanelMarkup({
          label: 'spend key',
          disabled: true,
          extra: h`
            <div class="banner negative">
              <span class="ic">${raw(icons.warning())}</span>
              <span><span class="banner-title">This key can spend your funds</span>${SPEND_KEY_WARNING}</span>
            </div>
            <label class="check">
              <input type="checkbox" name="understand">
              <span>I understand anyone with this key can spend my funds</span>
            </label>`,
        });
        wireHold(slot, () => spendKey);
      });
    });

    const offUnderstand = on(body, 'input[name=understand]', 'change', (evt, box) => {
      const slot = body.querySelector('[data-role="spend-key-slot"]');
      const holdBtn = slot && slot.querySelector('[data-role="hold"]');
      if (holdBtn) holdBtn.disabled = !box.checked;
    });

    const offCopyKey = on(body, '[data-role="copy"]', 'click', async (evt, btn) => {
      evt.preventDefault();
      // Which key this button belongs to is decided by where it sits, and the value itself comes
      // from the closure — never from the DOM, which has never held it.
      const slot = btn.closest('[data-role="viewing-key-slot"], [data-role="spend-key-slot"]');
      const secret = slot && slot.getAttribute('data-role') === 'viewing-key-slot' ? viewingKey : spendKey;
      if (!secret) return;
      await ctx.backend.platform.copy(secret);
      if (!live()) return;
      ctx.toast('Copied', { kind: 'positive' });
    });

    // ---- wipe ----
    const offWipeInput = on(body, 'input[name=wipe]', 'input', () => {
      wipeBtn.disabled = wipeInput.value !== WIPE_WORD;
    });
    const offWipe = on(body, '[data-role="wipe"]', 'click', async (evt) => {
      evt.preventDefault();
      if (wipeInput.value !== WIPE_WORD) return;
      // ctx.wipeWallet() ends the wallet session: it aborts anything in flight, empties ctx.state
      // and closes any sheet, so nothing from the wiped wallet can outlive it.
      await ctx.wipeWallet();
      ctx.go('#welcome');
    });

    // ---- about ----
    const offExternal = on(body, '[data-role="external"]', 'click', (evt, btn) => {
      evt.preventDefault();
      const url = btn.dataset.url;
      if (url && url.startsWith('https:')) ctx.backend.platform.openExternal(url);
    });

    return () => {
      for (const timer of holdTimers.values()) clearTimeout(timer);
      holdTimers.clear();
      for (const mask of body.querySelectorAll('[data-role="mask"]')) mask.textContent = '';
      viewingKey = null;
      spendKey = null;
      offSaveNetwork(); offTest(); offTheme(); offAutoLock();
      offViewingKey(); offSpendKey(); offUnderstand(); offCopyKey();
      offWipeInput(); offWipe(); offExternal();
    };
  },
});
