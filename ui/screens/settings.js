// Settings: Network, Prover (where the backend has the group, or the platform can host a prover),
// Appearance, Security, About.
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
import { t, LOCALES, AUTO_LOCALE, isLocale } from '../i18n.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';
import { markInvalid, markValid } from '../lib/forms.js';
import { wireSecretReveal } from '../lib/reveal.js';
import { urlRule } from '../lib/url-rule.js';
import { encodeBytes, drawQr } from '../lib/qr.js';

// Labels are functions, read at each render: the language can change while the screen is up.
const THEMES = [
  { value: 'system', label: () => t('System') },
  { value: 'dark', label: () => t('Dark') },
  { value: 'light', label: () => t('Light') },
];
const AUTO_LOCK = [
  { value: 1, label: () => t('1 minute') },
  { value: 5, label: () => t('5 minutes') },
  { value: 15, label: () => t('15 minutes') },
  { value: 60, label: () => t('1 hour') },
  { value: 0, label: () => t('Never') },
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
  const r = urlRule(text);
  if (r.empty) return { url: '', cleared: true };
  if (r.url) return { url: r.url };
  if (r.problem === 'not-url') return { error: 'That is not a URL. It should look like https://rpc.example.' };
  if (r.problem === 'plain-http') return { error: 'Use https — plain http is only allowed for a node on this machine.' };
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

// ---- the prover (delegated proving, spec 2026-09-28 §4.4, Phase 2) ----
// What a paired prover learns, since split authorisation (every chain since 17): the job carries
// the wallet's viewing key, never its spend key. The core's own sentence (`version`'s
// `prover_history_warning`; web/wallet's integration test holds the two equal), shown before a
// pairing is saved, as part of the form, above the password — not a dismissible notice.
export const PROVER_WARNING = 'This prover will be able to read this wallet\'s whole history — every payment '
  + 'received and sent, before and after today. It cannot spend. To keep your history private, run your own.';
/** What the RandProtocol prover (the default) sees, in one line, wherever it is offered or in use. */
export const PROVER_DEFAULT_NOTE = 'Each one that proves a send receives this wallet\'s viewing key, so it can read your whole history, past and future. None can spend.';

/** The pool's members as rows: name and the fingerprint the build pins for it. Text only. */
function poolMembersMarkup(members) {
  const list = Array.isArray(members) ? members : [];
  return list.map((m) => h`<div class="kv" data-role="prover-pool-member"><span class="k">${m.name || ''}</span><span class="v mono">${m.fingerprint || ''}</span></div>`).join('');
}
const machines = (members) => (Array.isArray(members) && members.length ? `${members.length} machines` : 'machines');
/** Under a pairing that is not the user's own: what that prover can do, in one line. */
export const PROVER_NOT_OWN_NOTE = 'Not marked as your own: it can read this wallet\'s whole history. It cannot spend.';

/**
 * Who makes this wallet's proofs: this device, the RandProtocol prover (the default, wallet 0.6.8),
 * or a prover the user paired. `trusted` is the engine's `prover.trusted()` (or null) and `choose`
 * whether the backend can switch between the default and none (`useDefault`/`useNone`). Every
 * field is text.
 */
function proverStateMarkup(prover, { trusted = null, choose = false } = {}) {
  if (prover && prover.mode === 'default') {
    const off = choose
      ? raw('<button class="btn block" type="button" data-role="use-no-prover">Use no prover</button>')
      : '';
    return h`
      <div class="kv"><span class="k">Proofs are made by</span><span class="v">This device, or where it cannot · ${prover.name || 'RandProtocol'} provers</span></div>
      ${raw(poolMembersMarkup(prover.members))}
      <p class="caption" data-role="prover-default-note">The RandProtocol provers: ${machines(prover.members)} run by the validators, each with its own key, used until you choose another. They charge nothing. ${PROVER_DEFAULT_NOTE}</p>
      <p class="caption" data-role="prover-probe">Asking the provers…</p>
      ${off}`;
  }
  if (prover && prover.mode === 'remote') {
    // "My own" only for a pairing whose link said so: a prover somebody else runs makes the
    // proofs too (the job carries the viewing key), and the line under it says what it sees.
    const own = prover.own === true;
    const who = own
      ? h`My own prover · ${prover.name || prover.url || ''}`
      : h`Paired prover · ${prover.name || prover.url || ''}`;
    const note = own ? '' : raw(h`<p class="caption" data-role="prover-not-own">${PROVER_NOT_OWN_NOTE}</p>`);
    const back = choose && trusted
      ? raw(h`<p class="caption">Forgetting it goes back to the ${trusted.name || 'RandProtocol'} provers.</p>`)
      : '';
    return h`
      <div class="kv"><span class="k">Proofs are made by</span><span class="v">${raw(who)}</span></div>
      <div class="kv"><span class="k">Fingerprint</span><span class="v mono">${prover.fingerprint || ''}</span></div>
      ${note}
      <p class="caption" data-role="prover-probe">Asking the prover…</p>
      ${back}
      <button class="btn block" type="button" data-role="forget-prover">Forget this prover</button>`;
  }
  // No prover: chosen (`useNone`), or a build that ships none. The way back to the default is
  // one button, with what that prover sees right beside it.
  const useIt = choose && trusted
    ? raw(h`
      <div class="stack tight" data-role="trusted-prover">
        <p class="caption">Or use the RandProtocol provers — ${machines(trusted.members)} run by the validators, each with its own key. They charge nothing. ${PROVER_DEFAULT_NOTE}</p>
        ${raw(poolMembersMarkup(trusted.members))}
        <button class="btn" type="button" data-role="use-trusted-prover">Use the RandProtocol provers</button>
      </div>`)
    : '';
  return h`
    <div class="kv"><span class="k">Proofs are made by</span><span class="v">This device</span></div>
    <p class="caption">Where this device cannot make a proof, pair a prover. Your spend key stays here either way; a prover you run yourself — the desktop app, or rand-prover on your own machine — also keeps your history to yourself.</p>
    ${useIt}`;
}

// Offered only where the backend has the (optional) `prover` group. The link is never put in
// markup (it carries the pairing token): the field starts empty and is emptied after a pairing.
function proverMarkup(settings, platform, host = '') {
  const scan = typeof platform.scanQr === 'function'
    ? raw('<button class="btn" type="button" data-role="scan-prover">Scan QR code</button>')
    : '';
  return sectionMarkup('Prover', h`
    <div data-role="prover-state" class="stack tight">${raw(proverStateMarkup(settings.prover))}</div>
    <h3 class="label">Pair your own prover</h3>
    <form data-role="prover-form" class="stack" novalidate>
      <div class="field">
        <label class="label" for="settings-prover-link">Pairing link</label>
        <input id="settings-prover-link" name="proverLink" type="text" spellcheck="false" autocomplete="off" placeholder="randprover:…" aria-describedby="settings-prover-link-hint">
        <span class="hint" id="settings-prover-link-hint">The randprover: link your prover shows. It carries a secret — paste it here and nowhere else.</span>
      </div>
      ${scan}
      <div class="banner warn" data-role="prover-warning">
        <span class="ic">${raw(icons.warning())}</span>
        <span><span class="banner-title">A prover sees your history</span>${PROVER_WARNING}</span>
      </div>
      <div class="field">
        <label class="label" for="settings-prover-password">Password</label>
        <input id="settings-prover-password" name="proverPassword" type="password" autocomplete="current-password" aria-describedby="settings-prover-password-hint">
        <span class="hint" id="settings-prover-password-hint">The password that unlocks this wallet — the pairing is sealed under it.</span>
      </div>
      <div class="cluster"><button class="btn btn-primary" type="submit" data-role="save-prover">Save</button></div>
      <div data-role="prover-status"></div>
    </form>
    ${raw(host)}`);
}

// ---- the prover host ("Prove for my other devices", spec 2026-09-28 §5) ----
// Only the desktop app has `platform.proverHost`: the fullnode's prover service run inside the app
// on 127.0.0.1. The link it shows carries the pairing token, so it is written only into the one
// text node and the QR while the prover is on, and taken off the page when it is turned off.
function proverHostMarkup() {
  return h`
    <div class="stack" data-role="prover-host">
      <label class="check">
        <input type="checkbox" name="proverHost">
        <span>Prove for my other devices</span>
      </label>
      <p class="caption">This computer makes the proofs for your browser extension or web wallet on this machine, one at a time. It listens on this computer only. A wallet you pair with it sends it its viewing key — enough to read that wallet's history, never to spend from it.</p>
      <p class="caption" data-role="prover-host-status">Off.</p>
      <div class="stack" data-role="prover-host-link" hidden>
        <div class="qr qr-large"><canvas data-role="prover-qr" data-ec-level="L" aria-label="QR code of the pairing link"></canvas></div>
        <p class="caption" data-role="prover-qr-too-long" hidden>This link is too long for a QR code — copy it instead.</p>
        <div class="address-box"><span class="mono" data-role="prover-host-link-text"></span></div>
        <p class="caption">Paste this link into Settings → Prover on the wallet that should use this computer. It carries a secret: share it with nothing else.</p>
        <div class="cluster">
          <button class="btn" type="button" data-role="copy-prover-link">${raw(icons.copy())}Copy link</button>
          <button class="btn" type="button" data-role="rotate-prover-link">Regenerate link</button>
        </div>
      </div>
    </div>`;
}

// Offered only where the backend has `sync.rescan` (optional in the contract). It is the
// non-destructive way out of a wallet that has read the wrong chain, or has simply got itself
// into a state a fresh read would fix — the alternative used to be a wipe, which loses the keys.
const RESCAN_CONTROL = '<div class="stack tight">'
  + '<p class="caption">Re-read this node from the start. Your keys, your password and your settings are not touched. '
  + 'A light wallet can only report what its node serves it, so if a balance looks wrong, switch node and rescan.</p>'
  + '<button class="btn block" type="button" data-role="rescan">Rescan wallet</button>'
  + '</div>';

// Offered only where the backend has the (optional) `contacts` group.
function contactsMarkup() {
  return sectionMarkup('Contacts', h`
    <p class="caption">Names for the addresses you pay often, kept on this device only. Send to a contact by name; its fingerprint is checked when you save it.</p>
    <button class="btn block" type="button" data-go="contacts">Manage contacts</button>`);
}

function appearanceMarkup(settings) {
  const current = settings.theme || 'system';
  const segments = THEMES.map((theme) => h`
    <button class="seg" type="button" role="radio" data-value="${theme.value}" aria-checked="${theme.value === current ? 'true' : 'false'}">${theme.label()}</button>`).join('');
  // The language: "follow the device" first, then every language under its own name, so a reader
  // who cannot read the one in force can still find theirs. The stored value is 'auto' or a code.
  const chosen = isLocale(settings.locale) ? settings.locale : AUTO_LOCALE;
  const languages = [
    h`<option value="${AUTO_LOCALE}"${raw(chosen === AUTO_LOCALE ? ' selected' : '')}>${t('Device language')}</option>`,
    ...LOCALES.map((l) => h`<option value="${l.code}" lang="${l.tag}"${raw(chosen === l.code ? ' selected' : '')}>${l.name}</option>`),
  ].join('');
  return sectionMarkup(t('Appearance'), h`
    <div class="field">
      <span class="label" id="settings-theme-label">${t('Theme')}</span>
      <div class="segmented" role="radiogroup" aria-labelledby="settings-theme-label" data-role="theme">${raw(segments)}</div>
    </div>
    <div class="field">
      <label class="label" for="settings-locale">${t('Language')}</label>
      <select id="settings-locale" name="locale">${raw(languages)}</select>
    </div>`);
}

function securityMarkup(settings) {
  const options = AUTO_LOCK.map((o) => h`
    <option value="${o.value}"${raw(String(o.value) === String(settings.autoLockMin) ? ' selected' : '')}>${o.label()}</option>`).join('');
  return h`
    <h2 class="section-title">Security</h2>
    <div class="card stack">
      <div class="field">
        <label class="label" for="settings-autolock">Lock automatically after</label>
        <select id="settings-autolock" name="autoLockMin" aria-describedby="settings-autolock-hint">${raw(options)}</select>
        <span class="hint" id="settings-autolock-hint">The wallet asks for your password again after this long without use.</span>
      </div>
    </div>
    <div class="card stack" data-role="passkey-card" hidden>
      <div class="card-head"><h3 data-role="passkey-title">Unlock with a passkey</h3></div>
      <p class="caption" data-role="passkey-caption"></p>
      <button class="btn block" type="button" data-role="passkey-toggle"></button>
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
    // Optional in the contract, feature-detected like `bridge`: a shell without it has no Prover
    // section at all.
    const proverGroup = ctx.backend.prover && typeof ctx.backend.prover.pair === 'function' ? ctx.backend.prover : null;
    // The desktop app's own prover service (spec §5); every other shell lacks it.
    const proverHost = platform.proverHost && typeof platform.proverHost.start === 'function' ? platform.proverHost : null;
    const body = root.querySelector('[data-role="body"]');
    body.innerHTML = h`
      ${raw(networkMarkup(settings))}
      ${raw(proverGroup ? proverMarkup(settings, platform, proverHost ? proverHostMarkup() : '')
    : proverHost ? sectionMarkup('Prover', proverHostMarkup()) : '')}
      ${raw(ctx.backend.contacts && typeof ctx.backend.contacts.list === 'function' ? contactsMarkup() : '')}
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
    function showStatus(kind, title, detail, target = statusEl) {
      const cls = kind === 'warn' ? 'banner warn'
        : kind === 'negative' ? 'banner negative'
        : kind === 'positive' ? 'banner positive'
        : 'banner';
      const icon = kind === 'positive' ? icons.check() : kind === 'info' ? icons.info() : icons.warning();
      target.innerHTML = h`
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
      // A node is verified before it is saved: a green "Saved" under an endpoint that does not
      // answer — or that answers for another chain — is how a wallet gets bricked with the
      // user's own blessing. Clearing the field needs no check: it goes back to the defaults.
      if (!checked.cleared) {
        let answer = null;
        try {
          answer = await ctx.backend.rpc.probe(checked.url);
        } catch (err) {
          if (!live()) return;
          showStatus('negative', 'Not saved', (err && err.message) || 'That node could not be reached.');
          return;
        }
        if (!live()) return;
        const theirs = String(answer.chainId ?? '');
        const ours = String(settings.chainId ?? '');
        if (ours && theirs && theirs !== ours) {
          showStatus('negative', 'Not saved', `That node is on chain ${theirs}; this wallet is set up for chain ${ours}. The node was left as it was.`);
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

      // An extension reaches nothing it has no permission for, and a typed URL is not yet
      // granted: without asking first, Test would report "No answer" for a node that is up,
      // behind a browser error rather than a node one. The click is the user gesture Firefox
      // grants on, exactly as at Save.
      if (!checked.cleared && typeof platform.ensureHostPermission === 'function') {
        let granted = false;
        try { granted = await platform.ensureHostPermission(checked.url); } catch { granted = false; }
        if (!live()) return;
        if (!granted) {
          btn.disabled = false;
          btn.removeAttribute('aria-busy');
          showStatus('negative', 'Not tested', 'Permission to reach that host was not granted.');
          return;
        }
      }

      // What is tested is what would be USED: the URL in the field, or — with the field empty —
      // the endpoint(s) already in force (a saved override, else the default set, whose first
      // answer is the one the result names). Testing anything else would tell the user nothing
      // about the change they are looking at.
      const candidates = checked.cleared
        ? (settings.rpcUrl ? [settings.rpcUrl] : (Array.isArray(settings.rpcUrls) ? settings.rpcUrls : []))
        : [checked.url];
      let answer = null;
      let lastErr = null;
      for (const url of candidates) {
        try {
          answer = await ctx.backend.rpc.probe(url);
          break;
        } catch (err) { lastErr = err; }
      }
      if (!live()) return;
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      if (!answer) {
        showStatus('negative', 'No answer', (lastErr && lastErr.message) || 'The node could not be reached.');
        return;
      }
      // Grouped as a string, never through Number(): a chain's height is not bounded by 2^53, and
      // `Number('9007199254740993123').toLocaleString()` quietly invents digits.
      const heightText = groupDigits(String(answer.height ?? 'unknown'));
      const theirs = String(answer.chainId ?? '');
      const ours = String(settings.chainId ?? '');
      const where = candidates.length > 1 ? `${answer.url} answered first — ` : '';
      if (ours && theirs && theirs !== ours) {
        showStatus('warn', 'A different chain',
          `${where}it reports chain ${theirs}; this wallet is set up for chain ${ours}. Its notes and addresses will not match. Height ${heightText}.`);
        return;
      }
      showStatus('positive', 'Connected', `${where}chain ${theirs || 'unknown'} · height ${heightText}.`);
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

    // ---- prover ----
    const proverStateEl = body.querySelector('[data-role="prover-state"]');
    const proverStatusEl = body.querySelector('[data-role="prover-status"]');
    const proverLinkInput = body.querySelector('input[name=proverLink]');
    const proverPasswordInput = body.querySelector('input[name=proverPassword]');
    let pairing = false; // one Save at a time: a second submit is dropped, not queued
    let probeRun = 0;    // only the latest probe may paint

    /** Asks the paired prover whether it answers, and writes the one line that says so. */
    async function probeProver() {
      const line = () => proverStateEl && proverStateEl.querySelector('[data-role="prover-probe"]');
      if (!proverGroup || !line() || typeof proverGroup.probe !== 'function') return;
      const mine = ++probeRun;
      let answer;
      try { answer = await proverGroup.probe(); } catch (err) { answer = { ok: false, reason: (err && err.message) || 'it did not answer' }; }
      if (!live() || mine !== probeRun || !line()) return;
      // Text only: the reason and the queue are the prover's words.
      if (answer && answer.ok) {
        const q = answer.queue || {};
        const depth = Number.isFinite(Number(q.depth)) ? Number(q.depth) : 0;
        const max = Number.isFinite(Number(q.max)) ? ` of ${Number(q.max)}` : '';
        line().textContent = `Answering · ${depth}${max} in its queue.`;
      } else {
        line().textContent = `Not answering: ${String((answer && answer.reason) || 'no reply').replace(/\.$/, '')}.`;
      }
    }

    // The default and none are one tap each where the backend can switch (`useDefault`/`useNone`).
    const canChoose = !!proverGroup && typeof proverGroup.useDefault === 'function' && typeof proverGroup.useNone === 'function';
    let trusted = null;
    function paintProverState() {
      if (!proverStateEl) return;
      proverStateEl.innerHTML = proverStateMarkup(settings.prover, { trusted, choose: canChoose });
      probeProver();
    }
    if (proverGroup) probeProver();
    // The prover the build ships the address of: asked once, then the state is painted with it.
    (async () => {
      if (!proverGroup || typeof proverGroup.trusted !== 'function') return;
      try { trusted = await proverGroup.trusted(); } catch { trusted = null; }
      if (!live() || !trusted) return;
      paintProverState();
    })();

    /** `settings.prover` as the engine now reads it (the default after a forget, say). */
    async function rereadProver(fallback) {
      try { const fresh = await ctx.backend.settings.get(); return fresh && fresh.prover ? fresh.prover : fallback; } catch { return fallback; }
    }

    const offSaveProver = on(body, '[data-role="prover-form"]', 'submit', async (evt) => {
      evt.preventDefault();
      if (!proverGroup || pairing) return;
      // Read once, here: the password lives in this handler's scope and in the field until the
      // field is emptied below — never on `ctx.state`, `settings` or an attribute.
      const link = String(proverLinkInput.value || '').trim();
      let password = proverPasswordInput.value;
      proverStatusEl.innerHTML = '';
      if (!link) {
        proverPasswordInput.value = '';
        password = '';
        showStatus('negative', 'Not paired', 'Paste the randprover: link your prover shows.', proverStatusEl);
        return;
      }
      if (!password) { showStatus('negative', 'Not paired', 'Enter this wallet\'s password — the pairing is sealed under it.', proverStatusEl); return; }
      pairing = true;
      const saveBtn = body.querySelector('[data-role="save-prover"]');
      if (saveBtn) { saveBtn.disabled = true; saveBtn.setAttribute('aria-busy', 'true'); }
      const done = () => {
        pairing = false;
        password = '';
        proverPasswordInput.value = '';
        if (saveBtn) { saveBtn.disabled = false; saveBtn.removeAttribute('aria-busy'); }
      };
      // The screen cannot read a randprover: link — the core does — so the engine is asked what it
      // names first: the host to ask permission for, and whether it is the user's own.
      let seen;
      try {
        seen = await proverGroup.preview(link);
      } catch (err) {
        done();
        if (!live()) return;
        showStatus('negative', 'Not paired', (err && err.message) || 'That is not a pairing link.', proverStatusEl);
        return;
      }
      if (!live()) { done(); return; }
      // The same rule as the node: an extension reaches no host it was not granted, and asks for
      // one only inside the user's click.
      if (typeof platform.ensureHostPermission === 'function') {
        let granted = false;
        try { granted = await platform.ensureHostPermission(seen.url); } catch { granted = false; }
        if (!live()) { done(); return; }
        if (!granted) {
          done();
          showStatus('negative', 'Not paired', 'Permission to reach that prover was not granted, so nothing was saved.', proverStatusEl);
          return;
        }
      }
      let paired;
      try {
        paired = await proverGroup.pair(link, password);
      } catch (err) {
        done();
        if (!live()) return;
        showStatus('negative', 'Not paired', (err && err.message) || 'The prover could not be paired.', proverStatusEl);
        return;
      }
      done();
      if (!live()) return;
      proverLinkInput.value = ''; // the token goes with it
      settings = { ...settings, prover: paired };
      paintProverState();
      // A prover that is not the user's own makes the proofs too; the engine's sentence (the
      // core's) says once more what it can then see, beside where the proofs now go.
      const where = `Proofs this device cannot make go to ${paired.name || seen.url}. Its fingerprint is ${paired.fingerprint || seen.fingerprint} — check that the prover shows the same.`;
      if (seen.warning) {
        showStatus('warn', 'Paired — this prover can read your history', `${where} ${seen.warning}`, proverStatusEl);
      } else {
        showStatus('positive', 'Paired', where, proverStatusEl);
      }
    });

    // Back to the default — the RandProtocol prover — in one tap: nothing is paired and nothing is
    // asked of anybody; the one-time notice still comes before the first send through it.
    const offUseTrusted = on(body, '[data-role="use-trusted-prover"]', 'click', async (evt) => {
      evt.preventDefault();
      if (!canChoose || !trusted || pairing) return;
      proverStatusEl.innerHTML = '';
      try {
        await proverGroup.useDefault();
      } catch (err) {
        if (!live()) return;
        showStatus('negative', 'Not changed', (err && err.message) || 'The prover could not be changed.', proverStatusEl);
        return;
      }
      if (!live()) return;
      settings = { ...settings, prover: await rereadProver({ mode: 'default', name: trusted.name, members: trusted.members }) };
      if (!live()) return;
      paintProverState();
      showStatus('warn', `Using the ${trusted.name || 'RandProtocol'} provers`,
        `Proofs this device cannot make go to one of them; each one that proves a send sees that wallet's viewing key. ${trusted.warning || PROVER_WARNING}`, proverStatusEl);
    });

    const offUseNone = on(body, '[data-role="use-no-prover"]', 'click', async (evt) => {
      evt.preventDefault();
      if (!canChoose || pairing) return;
      proverStatusEl.innerHTML = '';
      try {
        await proverGroup.useNone();
      } catch (err) {
        if (!live()) return;
        showStatus('negative', 'Not changed', (err && err.message) || 'The prover could not be changed.', proverStatusEl);
        return;
      }
      if (!live()) return;
      settings = { ...settings, prover: { mode: 'device' } };
      paintProverState();
      showStatus('positive', 'No prover', 'Proofs are made on this device only. Where it cannot make one, sending waits until you pair a prover or use the RandProtocol prover again.', proverStatusEl);
    });

    const offScanProver = on(body, '[data-role="scan-prover"]', 'click', async (evt) => {
      evt.preventDefault();
      if (typeof platform.scanQr !== 'function') return;
      let text = '';
      try { text = await platform.scanQr(); } catch (err) {
        if (!live() || (err && err.name === 'AbortError')) return;
        showStatus('negative', 'Nothing scanned', (err && err.message) || 'The camera could not read a code.', proverStatusEl);
        return;
      }
      if (!live() || !text) return;
      proverLinkInput.value = String(text).trim();
    });

    const offForgetProver = on(body, '[data-role="forget-prover"]', 'click', async (evt) => {
      evt.preventDefault();
      if (!proverGroup || typeof proverGroup.forget !== 'function') return;
      try {
        await proverGroup.forget();
      } catch (err) {
        if (!live()) return;
        showStatus('negative', 'Not forgotten', (err && err.message) || 'The pairing could not be removed.', proverStatusEl);
        return;
      }
      if (!live()) return;
      settings = { ...settings, prover: await rereadProver({ mode: 'device' }) };
      if (!live()) return;
      paintProverState();
      showStatus('positive', 'Forgotten', settings.prover.mode === 'default'
        ? `The prover's pairing is gone from this wallet. Proofs this device cannot make go to the ${settings.prover.name || 'RandProtocol'} provers again.`
        : 'Proofs are made on this device again. The prover\'s pairing is gone from this wallet.', proverStatusEl);
    });

    // ---- the prover host ----
    const hostBox = body.querySelector('input[name=proverHost]');
    const hostStatusEl = body.querySelector('[data-role="prover-host-status"]');
    const hostLinkWrap = body.querySelector('[data-role="prover-host-link"]');
    const hostLinkText = body.querySelector('[data-role="prover-host-link-text"]');
    const hostCanvas = body.querySelector('[data-role="prover-qr"]');
    let hostLink = ''; // the link on screen, for Copy; '' whenever the prover is off
    let hostBusy = false;

    /** The one status line. Every word of `status` is the app's, but it is still text. */
    function paintHostStatus(status, error) {
      if (!hostStatusEl) return;
      if (error) { hostStatusEl.textContent = String(error); return; }
      if (status && status.running) {
        const work = status.proving ? 'Proving a transfer now.' : 'Waiting for a proof to make.';
        hostStatusEl.textContent = `On · ${status.addr || ''} · fingerprint ${status.fingerprint || ''}. ${work}`;
      } else {
        const note = status && status.note ? ` ${status.note}` : '';
        hostStatusEl.textContent = `Off.${note}`;
      }
    }

    function hostCanvasContext() {
      if (!hostCanvas || typeof hostCanvas.getContext !== 'function') return null;
      try { return hostCanvas.getContext('2d') || null; } catch { return null; }
    }

    /** Shows `link` (text always, QR where it fits), or takes the link off the page when ''. */
    function paintHostLink(link) {
      hostLink = link || '';
      if (!hostLinkWrap) return;
      hostLinkText.textContent = hostLink;
      const g = hostCanvasContext();
      if (!hostLink) {
        if (g) g.clearRect(0, 0, hostCanvas.width, hostCanvas.height);
        hostLinkWrap.setAttribute('hidden', '');
        return;
      }
      hostLinkWrap.removeAttribute('hidden');
      let qr = null;
      // Level L: ~1 740 characters is a dense code already, and this one is read off a screen.
      try { qr = encodeBytes(new TextEncoder().encode(hostLink), 1, 'L'); } catch { qr = null; }
      const tooLong = body.querySelector('[data-role="prover-qr-too-long"]');
      const qrWrap = hostCanvas.closest('.qr');
      if (!qr) {
        qrWrap.setAttribute('hidden', '');
        if (tooLong) tooLong.removeAttribute('hidden');
        return;
      }
      qrWrap.removeAttribute('hidden');
      if (tooLong) tooLong.setAttribute('hidden', '');
      if (!g) return; // linkedom's canvas has no 2D context; a real webview always has one
      // As large as the section allows: a ~150-module code at the usual 220 px is unreadable.
      const width = (qrWrap.clientWidth || 320) * (globalThis.devicePixelRatio || 1);
      drawQr(hostCanvas, qr, Math.max(2, Math.floor(width / (qr.size + 8))));
    }

    async function showHostLink(fetchLink) {
      let link;
      try { link = await fetchLink(); } catch (err) {
        if (!live()) return;
        paintHostLink('');
        paintHostStatus(null, (err && err.message) || 'The pairing link could not be made.');
        return;
      }
      if (!live() || !hostBox || !hostBox.checked) return;
      paintHostLink(String(link || ''));
    }

    if (proverHost && hostBox) {
      (async () => {
        let status;
        try { status = await proverHost.status(); } catch (err) {
          if (live()) paintHostStatus(null, (err && err.message) || 'The prover could not be asked.');
          return;
        }
        if (!live()) return;
        hostBox.checked = Boolean(status && status.running);
        paintHostStatus(status);
        if (hostBox.checked) await showHostLink(() => proverHost.link());
      })();
    }

    const offHostToggle = on(body, 'input[name=proverHost]', 'change', async (evt, box) => {
      if (!proverHost || hostBusy) return;
      hostBusy = true;
      box.disabled = true;
      const on_ = box.checked;
      if (!on_) paintHostLink(''); // the link goes the moment the user says off
      hostStatusEl.textContent = on_ ? 'Starting…' : 'Stopping…';
      let status;
      try {
        status = on_ ? await proverHost.start() : await proverHost.stop();
      } catch (err) {
        hostBusy = false;
        box.disabled = false;
        if (!live()) return;
        box.checked = false;
        paintHostLink('');
        paintHostStatus(null, (err && err.message) || 'The prover did not start.');
        return;
      }
      hostBusy = false;
      box.disabled = false;
      if (!live()) return;
      box.checked = Boolean(status && status.running);
      paintHostStatus(status);
      if (box.checked) await showHostLink(() => proverHost.link());
    });

    const offCopyHostLink = on(body, '[data-role="copy-prover-link"]', 'click', async (evt) => {
      evt.preventDefault();
      if (!hostLink || typeof platform.copy !== 'function') return;
      try { await platform.copy(hostLink); } catch {
        if (live()) ctx.toast('The link could not be copied.', { kind: 'negative' });
        return;
      }
      if (live()) ctx.toast('Copied', { kind: 'positive' });
    });

    const offRotateHostLink = on(body, '[data-role="rotate-prover-link"]', 'click', async (evt) => {
      evt.preventDefault();
      if (!proverHost || typeof proverHost.rotate !== 'function' || hostBusy) return;
      hostBusy = true;
      await showHostLink(() => proverHost.rotate());
      hostBusy = false;
      if (live() && hostLink) ctx.toast('A new link: the old one no longer works.', { kind: 'positive' });
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

    // The language. `ctx.setLocale` persists it, loads the dictionary and re-renders this very
    // screen in the new language, so nothing here touches the DOM afterwards.
    const offLocale = on(body, 'select[name=locale]', 'change', async (evt, select) => {
      const value = select.value;
      try {
        await ctx.setLocale(value);
      } catch {
        if (live()) ctx.toast(t('The language could not be saved.'), { kind: 'negative' });
      }
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

    // ---- unlock with a passkey (Touch ID) ----
    // Shown only where the shell can make one (`wallet.passkey`, the Chrome extension) and the
    // device has a platform authenticator. Turning it on costs the password once — it is what the
    // passkey seals — and the passkey prompt itself; turning it off forgets the sealed copy.
    const pkApi = ctx.backend.wallet && ctx.backend.wallet.passkey;
    const pkCard = body.querySelector('[data-role="passkey-card"]');
    async function paintPasskey() {
      if (!pkApi || !pkCard) return;
      let available = false;
      let enabled = false;
      try { available = await pkApi.available(); enabled = await pkApi.enabled(); } catch { /* hidden */ }
      if (!live()) return;
      if (!available && !enabled) { pkCard.hidden = true; return; }
      const label = pkApi.label();
      pkCard.hidden = false;
      pkCard.querySelector('[data-role="passkey-title"]').textContent = `Unlock with ${label}`;
      pkCard.querySelector('[data-role="passkey-caption"]').textContent = enabled
        ? `On. Rand Wallet opens with ${label}; your password still works, and is needed if ${label} cannot answer.`
        : `Open the wallet with ${label} instead of typing your password. Your password still works, and stays the way to restore access.`;
      pkCard.querySelector('[data-role="passkey-toggle"]').textContent = enabled ? `Turn off ${label}` : `Turn on ${label}`;
      pkCard.dataset.enabled = enabled ? '1' : '';
    }
    function enablePasskey() {
      const label = pkApi.label();
      const dialog = ctx.sheet(h`
        <h3 class="sheet-title">Turn on ${label}</h3>
        <p class="sheet-sub">Enter your password once. ${label} will keep it sealed, and give it back to unlock this wallet.</p>
        <form novalidate class="stack">
          <label class="field">
            <span class="label">Password</span>
            <input name="password" type="password" autocomplete="current-password" aria-describedby="pk-hint">
            <span class="hint" id="pk-hint">The password that unlocks this wallet on this device.</span>
            <span class="error" id="pk-error">That is not the password for this wallet.</span>
          </label>
          <div class="sheet-foot">
            <button class="btn" type="button" data-role="cancel">Cancel</button>
            <button class="btn btn-primary" type="submit" data-role="pk-submit">Continue</button>
          </div>
        </form>`);
      const input = dialog.querySelector('input[name=password]');
      const wrap = input.closest('.field');
      const submitBtn = dialog.querySelector('[data-role="pk-submit"]');
      let busy = false;
      on(dialog, '[data-role="cancel"]', 'click', () => ctx.closeSheet());
      on(dialog, 'form', 'submit', async (evt) => {
        evt.preventDefault();
        if (busy) return;
        busy = true;
        submitBtn.disabled = true;
        const password = input.value;
        input.value = '';
        try {
          await pkApi.enable(password);
        } catch (err) {
          busy = false;
          submitBtn.disabled = false;
          if (!live()) return;
          const wrong = err && /wrong password/.test(String(err.message));
          dialog.querySelector('#pk-error').textContent = wrong
            ? 'That is not the password for this wallet.'
            : `${label} could not be set up: ${(err && err.message) || err}`;
          markInvalid(wrap, input, 'pk-error');
          input.focus();
          return;
        }
        ctx.closeSheet();
        if (!live()) return;
        ctx.toast(`${label} is on`, { kind: 'positive' });
        await paintPasskey();
      });
    }
    const offPasskey = on(body, '[data-role="passkey-toggle"]', 'click', async () => {
      if (!pkApi) return;
      if (pkCard.dataset.enabled) {
        await pkApi.disable();
        if (!live()) return;
        ctx.toast(`${pkApi.label()} is off`, { kind: 'positive' });
        await paintPasskey();
      } else {
        enablePasskey();
      }
    });
    void paintPasskey();

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
      if (proverLinkInput) proverLinkInput.value = '';
      if (proverPasswordInput) proverPasswordInput.value = '';
      offSaveNetwork(); offTest(); offRescan(); offTheme(); offAutoLock(); offPasskey();
      offSaveProver(); offScanProver(); offForgetProver(); offUseNone(); offUseTrusted();
      if (hostLinkText) hostLinkText.textContent = ''; // the pairing token leaves with the screen
      hostLink = '';
      offHostToggle(); offCopyHostLink(); offRotateHostLink();
      offViewingKey(); offSpendKey(); offUnderstand(); offDone();
      offWipeInput(); offWipe(); offExternal();
    };
  },
});
