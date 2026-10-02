// The approval window: "<site> asks Rand Wallet to …". It renders lib/invoke-flow.js's state and
// nothing else decides anything here. Everything shown is built from DOM nodes and textContent: the
// site's title and origin are data, never markup, and the amounts are this wallet's own reading of
// the request (ui/engine/invoke.js's `invokeEffects`), not the site's summary.
//
// No app.js here, so the language is this page's own job (lib/window-locale.js): the backend's
// `settings.locale` is read first and nothing is rendered before the dictionary is in force. Every
// string shown goes through `t()`, built inside the functions that show it, never at module load.
import { ext } from './lib/browser.js';
import { extensionBackend } from './backend-extension.js';
import { makeInvokeFlow, proverNotice } from './lib/invoke-flow.js';
import { applyWindowLocale, sentenceWith } from './lib/window-locale.js';
import { markSvg } from './ui/lib/entropy.js';
import { formatUnits, shortHex, elapsed } from './ui/lib/format.js';
import { expectedMs, progressAt, remainingText, recordDuration } from './ui/lib/progress.js';
import { t } from './ui/i18n.js';

const id = new URLSearchParams(location.search).get('id') || '';
const backend = extensionBackend();

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

/** index → {symbol, decimals}, from the wallet's own asset list; RAND when it cannot be read. */
let assetInfo = new Map([[0, { symbol: 'RAND', decimals: 9 }]]);
async function loadAssets() {
  try {
    const list = await backend.assets.list();
    for (const a of list || []) {
      if (Number.isInteger(a.index)) assetInfo.set(a.index, { symbol: String(a.symbol || t('asset {index}', { index: a.index })), decimals: Number(a.decimals) || 0 });
    }
  } catch { /* amounts are shown with the asset's index instead */ }
}
// An amount is ASCII digits and the symbol in every language (ui/lib/format.js).
const amountText = ({ asset, amount }) => {
  const info = assetInfo.get(asset) || { symbol: t('asset {index}', { index: asset }), decimals: 0 };
  return `${formatUnits(amount, info.decimals, info.decimals)} ${info.symbol}`;
};

/** What the window says under "Sending…" for a phase of `program.invoke()`. */
function phaseText(phase) {
  switch (phase) {
    case 'selecting': return t('Checking the pool and your notes…');
    case 'witness': return t('Reading your notes’ place in the tree…');
    case 'proving': return t('Proving.') + ' ' + t('This takes a few minutes; keep this window open.');
    case 'submitting': return t('Sending…');
    case 'confirming': return t('Sent.') + ' ' + t('Waiting for the chain…');
    default: return t('Working…');
  }
}

// The proving ring: an estimate against this device's usual invoke (ui/lib/progress.js), filled
// towards 90% at the usual time; only "Sent" is done. Our own SVG, no user data in it.
const RING_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" aria-hidden="true"><circle class="ring-track" cx="60" cy="60" r="52"></circle><circle class="ring-bar" cx="60" cy="60" r="52"></circle></svg>';
let runStartedMs = 0;
let runTicker = null;
let recorded = false;
function progressRing() {
  const ring = el('div', 'ring');
  ring.setAttribute('role', 'progressbar');
  ring.append(new DOMParser().parseFromString(RING_SVG, 'image/svg+xml').documentElement);
  const label = el('div', 'ring-label');
  const pct = el('span', 'ring-pct');
  const left = el('span', 'ring-cap');
  const time = el('span', 'ring-cap mono');
  label.append(pct, left, time);
  ring.append(label);
  const paint = () => {
    const spent = Date.now() - runStartedMs;
    const expected = expectedMs('invoke');
    const p = progressAt(spent, expected);
    ring.style.setProperty('--pct', p.toFixed(3));
    ring.setAttribute('aria-valuetext', remainingText(spent, expected));
    pct.textContent = `${Math.round(p * 100)}%`;
    left.textContent = remainingText(spent, expected);
    time.textContent = elapsed(spent);
  };
  paint();
  if (runTicker) clearInterval(runTicker);
  runTicker = setInterval(paint, 1000);
  return ring;
}

const root = el('div', 'app');
document.body.append(root);
let closeTimer = null;

function hostOf(origin) {
  try { return new URL(origin).host; } catch { return origin || t('A site'); }
}

function kvRows(label, rows) {
  const out = [];
  rows.forEach((r, i) => {
    const kv = el('div', 'kv');
    kv.append(el('span', 'k', i === 0 ? label : ''), el('span', 'v amount', amountText(r)));
    out.push(kv);
  });
  return out;
}

/** The note under the quote: who makes the proof, and that it takes a while. */
function proverLine(state) {
  if (state.via !== 'prover') return t('Proving takes a few minutes.') + ' ' + t('Keep this window open until it says sent.');
  const who = state.prover === 'default'
    ? t('One of the RandProtocol provers makes the large proof; this browser makes the small ones.')
    : t('Your paired prover makes the large proof; this browser makes the small ones.');
  return who + ' ' + t('It takes a few minutes.');
}

function render(state) {
  root.replaceChildren();
  const box = el('div', 'onboard');
  const mark = el('span', 'mark-lg bare');
  mark.append(new DOMParser().parseFromString(markSvg(), 'image/svg+xml').documentElement);
  const head = el('div', 'stack tight');
  const title = el('h1', 'title');
  const sub = el('p', 'subtitle');
  head.append(title, sub);
  box.append(mark, head);
  const host = hostOf(state.origin);

  if (state.step === 'loading') {
    title.textContent = t('Reading the request…');
    sub.textContent = t('Checking it against the chain before anything is proved.');
  } else if (state.step === 'review') {
    const q = state.quote;
    // The site's own title for what it asks (its summary), as given; the wallet's question otherwise.
    title.textContent = q.title || t('Approve this request?');
    sub.append(sentenceWith(t('{host} asks Rand Wallet to send this transaction.'), 'host', el('strong', null, host)));
    const card = el('div', 'card');
    const spend = q.spend.length ? q.spend : [{ asset: 0, amount: '0' }];
    card.append(...kvRows(t('You pay'), spend));
    card.append(...kvRows(t('Network fee'), [{ asset: 0, amount: q.fee }]));
    if (q.receive.length) card.append(...kvRows(t('You receive'), q.receive));
    const prog = el('div', 'kv');
    prog.append(el('span', 'k', t('Program')), el('span', 'v mono', shortHex(q.program, 10)));
    card.append(prog);
    const note = el('p', 'caption', proverLine(state));
    const actions = el('div', 'onboard-actions');
    if (state.notice) {
      // The RandProtocol prover's one-time notice in Approve's place: read it, or leave for your
      // own prover (Settings in the wallet) — and the request stays waiting meanwhile.
      const warn = el('p', 'caption', proverNotice(state.provers, t));
      const ok = el('button', 'btn btn-primary block', t('I understand — continue'));
      ok.type = 'button';
      ok.addEventListener('click', () => { void flow.acknowledge(); });
      const own = el('button', 'btn block', t('Use my own prover'));
      own.type = 'button';
      own.addEventListener('click', () => { ext.tabs.create({ url: ext.runtime.getURL('app.html#settings') }); });
      const no = el('button', 'btn block', t('Reject'));
      no.type = 'button';
      no.addEventListener('click', () => { void flow.reject().then(() => window.close()); });
      actions.append(ok, own, no);
      box.append(card, warn, actions);
      queueMicrotask(() => ok.focus());
      root.append(box);
      return;
    }
    const yes = el('button', 'btn btn-primary block', t('Approve'));
    yes.type = 'button';
    const no = el('button', 'btn block', t('Reject'));
    no.type = 'button';
    yes.addEventListener('click', () => { backend.wallet.noteActivity?.(); void flow.approve(); });
    no.addEventListener('click', () => { void flow.reject().then(() => window.close()); });
    actions.append(yes, no);
    box.append(card, note, actions);
    queueMicrotask(() => yes.focus());
  } else if (state.step === 'running') {
    if (!runStartedMs) runStartedMs = Date.now();
    title.textContent = t('Sending…');
    let text = phaseText(state.phase);
    const d = state.detail;
    if (state.phase === 'proving' && d) {
      if (d.authorising) text = t('Authorising on this device…');
      else if (d.position) text = t('Waiting in {prover}’s queue (position {position})…', { prover: d.prover || t('the prover'), position: d.position });
      else if (d.prover) text = t('{prover} is proving.', { prover: d.prover }) + ' ' + t('This takes a few minutes; keep this window open.');
    }
    sub.textContent = text;
    box.append(progressRing());
  } else if (state.step === 'done') {
    if (runTicker) { clearInterval(runTicker); runTicker = null; }
    if (runStartedMs && !recorded) { recorded = true; recordDuration('invoke', Date.now() - runStartedMs); }
    title.textContent = t('Sent');
    sub.textContent = t('{host} has the transaction {tx}.', { host, tx: shortHex(state.tx, 10) }) + ' ' + t('Your wallet picks up what it pays you on its next sync.');
    const actions = el('div', 'onboard-actions');
    const close = el('button', 'btn btn-primary block', t('Close'));
    close.type = 'button';
    close.addEventListener('click', () => window.close());
    actions.append(close);
    box.append(actions);
    if (!closeTimer) closeTimer = setTimeout(() => window.close(), 4000);
  } else {
    if (runTicker) { clearInterval(runTicker); runTicker = null; }
    const e = state.error || {};
    title.textContent = e.code === 'USER_REJECTED' ? t('Not approved') : t('Not sent');
    sub.textContent = e.message || t('Rand Wallet could not complete the request.');
    const actions = el('div', 'onboard-actions');
    const close = el('button', 'btn block', t('Close'));
    close.type = 'button';
    close.addEventListener('click', () => window.close());
    actions.append(close);
    box.append(actions);
  }
  root.append(box);
}

const flow = makeInvokeFlow({
  id,
  send: (msg) => ext.runtime.sendMessage(msg),
  backend,
  onChange: render,
  t,
});

/** The wallet's language setting; nothing when the settings cannot be read (the device's language then). */
async function localeSetting() {
  try { return (await backend.settings.get()).locale; } catch { return undefined; }
}

(async () => {
  await applyWindowLocale(await localeSetting());
  document.title = t('Approve in Rand Wallet');
  render(flow.state);
  await loadAssets();
  await flow.start();
})();
