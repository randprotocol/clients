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
import { wireSecretReveal } from '../lib/reveal.js';

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
const WIPE_WORD = 'WIPE';
// What each key slot shows when no key is open: the button that asks for the password again.
const VIEWING_KEY_BUTTON = '<button class="btn block" type="button" data-role="show-viewing-key">'
  + `${icons.eye()}Show viewing key</button>`;
const SPEND_KEY_BUTTON = '<button class="btn block" type="button" data-role="export-spend-key">'
  + `${icons.shield()}Export spend key</button>`;
const SPEND_KEY_WARNING = 'Anyone with this key can spend everything this wallet holds, now and in '
  + 'the future. It is not a backup to keep in a note-taking app or to paste into a chat — an '
  + 'explorer or a watcher only ever needs the viewing key.';

/**
 * Is `url` somewhere this wallet may talk to? https anywhere; plain http only to this machine,
 * because an RPC call carries the addresses the wallet cares about and a plaintext answer is
 * something a network can rewrite. Returns `{url}` (normalised, no trailing slash) or `{error}`.
 *
 * **Empty is a valid answer** (task 5.0): this one field is an *override* of the default endpoint
 * set, so clearing it is how a user goes back to the defaults. Without that, the first URL anyone
 * ever saved would be the only node their wallet could use for the rest of its life — a one-way
 * door, and the failover the defaults exist for would be unreachable.
 */
export function checkRpcUrl(text) {
  const value = String(text || '').trim().replace(/\/+$/, '');
  if (!value) return { url: '', cleared: true };
  let parsed;
  try { parsed = new URL(value); } catch { return { error: 'That is not a URL. It should look like https://rpc.example.' }; }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol === 'https:') return { url: value };
  if (parsed.protocol === 'http:' && local) return { url: value };
  if (parsed.protocol === 'http:') return { error: 'Use https — plain http is only allowed for a node on this machine.' };
  return { error: 'Use an https:// address.' };
}

/**
 * Thousands separators for a decimal string, done on the string. A block height is not bounded by
 * `Number.MAX_SAFE_INTEGER`, and `Number('9007199254740993123').toLocaleString('en-US')` answers
 * `9,007,199,254,740,993,000` — a wallet does not silently round the chain's own numbers. Anything
 * that is not a run of digits (the node said something else) is passed straight through.
 */
export function groupDigits(text) {
  const s = String(text ?? '');
  if (!/^\d+$/.test(s)) return s;
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function sectionMarkup(title, body) {
  return h`<h2 class="section-title">${title}</h2><div class="card stack">${raw(body)}</div>`;
}

function networkMarkup(settings) {
  // The defaults are a SET (task 5.0) and the wallet moves between them on its own when one is
  // unreachable, so the hint names them rather than pretending there is one node. Every one of
  // these strings comes from the backend's settings, so it is interpolated, never `raw()`ed.
  const defaults = Array.isArray(settings.rpcUrls) ? settings.rpcUrls.filter((u) => typeof u === 'string' && u) : [];
  const hint = settings.rpcUrl
    ? 'The Rand node this wallet reads from and submits to. Clear this field to go back to the default nodes.'
    : defaults.length > 0
      ? `Using the default nodes (${defaults.join(', ')}), whichever answers. Enter one to use it instead.`
      : 'The Rand node this wallet reads from and submits to.';
  return sectionMarkup('Network', h`
    <form data-role="network-form" class="stack" novalidate>
      <div class="field">
        <label class="label" for="settings-rpc">RPC URL</label>
        <input id="settings-rpc" name="rpcUrl" type="text" spellcheck="false" autocomplete="off" value="${settings.rpcUrl || ''}" placeholder="${defaults[0] || ''}" aria-describedby="settings-rpc-hint">
        <span class="hint" id="settings-rpc-hint">${hint}</span>
        <span class="error" id="settings-rpc-error"></span>
      </div>
      <div class="cluster">
        <button class="btn btn-primary" type="submit">Save</button>
        <button class="btn" type="button" data-role="test-connection">Test connection</button>
      </div>
      <div data-role="network-status"></div>
    </form>
    <div data-role="rescan-slot"></div>`);
}

// Offered only where the backend has `sync.rescan` (optional in the contract). It is the
// non-destructive way out of a wallet that has read the wrong chain, or has simply got itself
// into a state a fresh read would fix — the alternative used to be a wipe, which loses the keys.
const RESCAN_CONTROL = '<div class="stack tight">'
  + '<p class="caption">Re-read this node from the start. Your keys, your password and your settings are not touched. '
  + 'A light wallet can only report what its node serves it, so if a balance looks wrong, switch node and rescan.</p>'
  + '<button class="btn block" type="button" data-role="rescan">Rescan wallet</button>'
  + '</div>';

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
      <div data-role="viewing-key-slot">${raw(VIEWING_KEY_BUTTON)}</div>
    </div>
    <div class="card stack">
      <div class="card-head"><h3>Spend key</h3></div>
      <p class="caption">The spend key <em>is</em> the wallet. Export it to move to another device, or to send from the desktop app, which can prove a transfer natively.</p>
      <div data-role="spend-key-slot">${raw(SPEND_KEY_BUTTON)}</div>
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
      <div class="stack" data-role="body"><div class="skeleton block"></div></div>`;
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

    const rescanSlot = body.querySelector('[data-role="rescan-slot"]');
    if (rescanSlot && typeof ctx.backend.sync.rescan === 'function') rescanSlot.innerHTML = RESCAN_CONTROL;

    const statusEl = body.querySelector('[data-role="network-status"]');
    const rpcInput = body.querySelector('input[name=rpcUrl]');
    const rpcField = rpcInput.closest('.field');
    const rpcError = body.querySelector('#settings-rpc-error');
    const wipeInput = body.querySelector('input[name=wipe]');
    const wipeBtn = body.querySelector('[data-role="wipe"]');

    // Secrets live here and nowhere else. They are dropped when the panel showing them is closed,
    // when the window stops being looked at, a minute after a copy, and on cleanup — after which
    // seeing one again costs the password again.
    let viewingKey = null;
    let spendKey = null;

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

    /** Every string in here is node-controlled, so it is interpolated, never `raw()`ed.
     *  `kind` is one of 'info' (nothing is known yet), 'positive', 'warn', 'negative'. */
    function showStatus(kind, title, detail) {
      const cls = kind === 'warn' ? 'banner warn'
        : kind === 'negative' ? 'banner negative'
        : kind === 'positive' ? 'banner positive'
        : 'banner';
      const icon = kind === 'positive' ? icons.check() : kind === 'info' ? icons.info() : icons.warning();
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
      // the submit handler, before anything is written. Clearing the field asks for no new host
      // at all: it goes back to the default endpoints, which the manifests already declare.
      if (!checked.cleared && typeof platform.ensureHostPermission === 'function') {
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
      const back = Array.isArray(settings.rpcUrls) ? settings.rpcUrls.filter((u) => typeof u === 'string' && u) : [];
      showStatus(
        'positive',
        'Saved',
        checked.cleared
          ? back.length > 0
            ? `New transfers and scans use the default nodes (${back.join(', ')}).`
            : 'New transfers and scans use the default nodes.'
          : 'New transfers and scans use this node.',
      );
    });

    const offTest = on(body, '[data-role="test-connection"]', 'click', async (evt, btn) => {
      evt.preventDefault();
      const checked = checkRpcUrl(rpcInput.value);
      if (checked.error) { setRpcError(checked.error); return; }
      setRpcError(null);
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      // Neutral: nothing is known yet, and a green banner that says "Connecting" reads as a
      // result. The real answer replaces it.
      showStatus('info', 'Connecting…', 'Asking the node for its height and chain id.');
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
      // Grouped as a string, never through Number(): a chain's height is not bounded by 2^53, and
      // `Number('9007199254740993123').toLocaleString()` quietly invents digits.
      const heightText = groupDigits(height);
      const theirs = String(chainId ?? '');
      const ours = String(settings.chainId ?? '');
      if (ours && theirs && theirs !== ours) {
        showStatus('warn', 'A different chain',
          `That node reports chain ${theirs}; this wallet is set up for chain ${ours}. Its notes and addresses will not match. Height ${heightText}.`);
        return;
      }
      showStatus('positive', 'Connected', `Chain ${theirs || 'unknown'} · height ${heightText}.`);
    });

    const offRescan = on(body, '[data-role="rescan"]', 'click', (evt) => {
      evt.preventDefault();
      const dialog = ctx.sheet(h`
        <h3 class="sheet-title">Rescan this wallet?</h3>
        <p class="sheet-sub">The wallet forgets how far it has read and reads this node again from the start. It can take a while on a long chain. Your keys, your password and your settings are not touched, and nothing on chain changes.</p>
        <div class="sheet-foot">
          <button class="btn" type="button" data-role="cancel">Cancel</button>
          <button class="btn btn-primary" type="button" data-role="confirm">Rescan</button>
        </div>`);
      on(dialog, '[data-role="cancel"]', 'click', () => ctx.closeSheet());
      on(dialog, '[data-role="confirm"]', 'click', async () => {
        ctx.closeSheet();
        if (!live()) return;
        showStatus('info', 'Rescanning…', 'Reading this node from the start. You can leave this screen.');
        try {
          // Not `forChain`: this is "read it again", not "this is a different chain" — the notes
          // are kept and the scan re-establishes them.
          await ctx.backend.sync.rescan({ signal: ctx.session.signal });
        } catch (err) {
          if (!live()) return;
          showStatus('negative', 'The rescan did not finish', (err && err.message) || 'Something went wrong.');
          return;
        }
        if (!live()) return;
        showStatus('positive', 'Rescanned', 'This wallet has re-read the chain from the start.');
      });
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
     * Asks for the password in a sheet and calls `onOk()` once `wallet.verifyPassword` says yes.
     * Never `wallet.unlock`: that would end the wallet session (and with it everything else on
     * screen). The check costs what unlocking costs by contract, so the submit is disabled while
     * one is in flight and a second submit is dropped rather than queued — parallel attempts would
     * be a way to spend the backend's throttling budget faster. No client-side lockout: counting
     * attempts is the backend's job, and a UI that thinks it is doing it is only lying.
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
            <button class="btn btn-primary" type="submit" data-role="reauth-submit">Continue</button>
          </div>
        </form>`);
      const input = dialog.querySelector('input[name=password]');
      const wrap = input.closest('.field');
      const submitBtn = dialog.querySelector('[data-role="reauth-submit"]');
      let checking = false;
      on(dialog, '[data-role="cancel"]', 'click', () => ctx.closeSheet());
      on(dialog, 'form', 'submit', async (evt) => {
        evt.preventDefault();
        if (checking) return;
        checking = true;
        submitBtn.disabled = true;
        submitBtn.setAttribute('aria-busy', 'true');
        let ok = false;
        try { ok = await ctx.backend.wallet.verifyPassword(input.value); } catch { ok = false; }
        checking = false;
        if (!live()) return;
        submitBtn.disabled = false;
        submitBtn.removeAttribute('aria-busy');
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

    // ---- the two key panels ----
    // Both go through lib/reveal.js: one implementation of the gesture, the masking, the copy and
    // the auto-hide, and `dropOnHide` on top — in settings a key that stops being looked at is
    // forgotten outright, and getting it back costs the password again.
    let openPanel = null; // { slot, reveal, collapsed } — one key is unlocked at a time, at most
    let closingPanel = false; // `reveal.destroy()` calls back into onDrop; do not recurse

    /**
     * Forgets the key and puts the password gate back. Called for every reason a key stops being
     * available — Done, a blur, a backgrounded tab, a minute after a copy, teardown — so the screen
     * can never be left showing Hold / Show / Copy controls that are silently inert.
     */
    function closePanel({ collapse = true, notify = false } = {}) {
      if (closingPanel) return;
      closingPanel = true;
      const panel = openPanel;
      openPanel = null;
      viewingKey = null;
      spendKey = null;
      if (panel) {
        panel.reveal.destroy();
        if (collapse && panel.slot.isConnected !== false) panel.slot.innerHTML = panel.collapsed;
      }
      closingPanel = false;
      if (panel && notify && live()) {
        ctx.toast('Key hidden — enter your password to view it again.', { kind: 'positive' });
      }
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
            <button class="btn block" type="button" data-role="timed"${raw(disabled ? ' disabled' : '')}></button>
            <button class="btn block" type="button" data-role="copy"${raw(disabled ? ' disabled' : '')}>${raw(icons.copy())}Copy ${label}</button>
            <button class="btn btn-ghost block" type="button" data-role="done">Done — hide this key</button>
          </div>
        </div>`;
    }

    /** Paints a revealed-key panel into `slot` and wires it; `collapsed` is the markup to put back
     *  when it is closed (the button that asks for the password again). */
    function openKeyPanel(slot, { label, extra, disabled, getSecret, collapsed }) {
      closePanel();
      slot.innerHTML = keyPanelMarkup({ label, extra, disabled });
      const reveal = wireSecretReveal(slot, {
        getSecret,
        copy: (secret) => ctx.backend.platform.copy(secret),
        onCopied: () => { if (live()) ctx.toast('Copied', { kind: 'positive' }); },
        dropOnHide: true,
        // Not just "null the variable": the panel goes too, so what is on screen is the password
        // gate rather than three buttons that would quietly do nothing.
        onDrop: () => closePanel({ notify: true }),
        labels: { reveal: `Show ${label} for 10 seconds`, hide: `Hide ${label}` },
      });
      openPanel = { slot, reveal, collapsed };
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
        // After openKeyPanel, never before: opening a panel closes any other one, and closing a
        // panel forgets both keys.
        openKeyPanel(body.querySelector('[data-role="viewing-key-slot"]'), {
          label: 'viewing key',
          getSecret: () => viewingKey,
          collapsed: VIEWING_KEY_BUTTON,
        });
        viewingKey = key;
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
        openKeyPanel(body.querySelector('[data-role="spend-key-slot"]'), {
          label: 'spend key',
          getSecret: () => spendKey,
          collapsed: SPEND_KEY_BUTTON,
          // Nothing is revealed *or copied* until the sentence has been read and agreed to.
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
        spendKey = key;
      });
    });

    // The consent box gates *every* way the key can leave the screen — revealing it and copying
    // it are the same disclosure, and only one of them used to be behind the sentence.
    const offUnderstand = on(body, 'input[name=understand]', 'change', (evt, box) => {
      const slot = body.querySelector('[data-role="spend-key-slot"]');
      if (!slot) return;
      for (const sel of ['[data-role="hold"]', '[data-role="timed"]', '[data-role="copy"]']) {
        const btn = slot.querySelector(sel);
        if (btn) btn.disabled = !box.checked;
      }
    });

    const offDone = on(body, '[data-role="done"]', 'click', (evt) => {
      evt.preventDefault();
      closePanel();
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
      closePanel({ collapse: false });
      for (const mask of body.querySelectorAll('[data-role="mask"]')) mask.textContent = '';
      offSaveNetwork(); offTest(); offRescan(); offTheme(); offAutoLock();
      offViewingKey(); offSpendKey(); offUnderstand(); offDone();
      offWipeInput(); offWipe(); offExternal();
    };
  },
});
