// The approval window: "<site> asks Rand Wallet to …". It renders lib/invoke-flow.js's state and
// nothing else decides anything here. Everything shown is built from DOM nodes and textContent: the
// site's title and origin are data, never markup, and the amounts are this wallet's own reading of
// the request (ui/engine/invoke.js's `invokeEffects`), not the site's summary.
import { ext } from './lib/browser.js';
import { extensionBackend } from './backend-extension.js';
import { makeInvokeFlow, proverNotice } from './lib/invoke-flow.js';
import { markSvg } from './ui/lib/entropy.js';
import { formatUnits, shortHex, elapsed } from './ui/lib/format.js';
import { expectedMs, progressAt, remainingText, recordDuration } from './ui/lib/progress.js';

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
      if (Number.isInteger(a.index)) assetInfo.set(a.index, { symbol: String(a.symbol || `asset ${a.index}`), decimals: Number(a.decimals) || 0 });
    }
  } catch { /* amounts are shown with the asset's index instead */ }
}
const amountText = ({ asset, amount }) => {
  const info = assetInfo.get(asset) || { symbol: `asset ${asset}`, decimals: 0 };
  return `${formatUnits(amount, info.decimals, info.decimals)} ${info.symbol}`;
};

const PHASE_TEXT = {
  selecting: 'Checking the pool and your notes…',
  witness: 'Reading your notes’ place in the tree…',
  proving: 'Proving. This takes a few minutes; keep this window open.',
  submitting: 'Sending…',
  confirming: 'Sent. Waiting for the chain…',
};

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
  try { return new URL(origin).host; } catch { return origin || 'A site'; }
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
    title.textContent = 'Reading the request…';
    sub.textContent = 'Checking it against the chain before anything is proved.';
  } else if (state.step === 'review') {
    const q = state.quote;
    title.textContent = q.title || 'Approve this request?';
    sub.append(el('strong', null, host), document.createTextNode(' asks Rand Wallet to send this transaction.'));
    const card = el('div', 'card');
    const spend = q.spend.length ? q.spend : [{ asset: 0, amount: '0' }];
    card.append(...kvRows('You pay', spend));
    card.append(...kvRows('Network fee', [{ asset: 0, amount: q.fee }]));
    if (q.receive.length) card.append(...kvRows('You receive', q.receive));
    const prog = el('div', 'kv');
    prog.append(el('span', 'k', 'Program'), el('span', 'v mono', shortHex(q.program, 10)));
    card.append(prog);
    const note = el('p', 'caption', state.via !== 'prover'
      ? 'Proving takes a few minutes. Keep this window open until it says sent.'
      : state.prover === 'default'
        ? 'One of the RandProtocol provers makes the large proof; this browser makes the small ones. It takes a few minutes.'
        : 'Your paired prover makes the large proof; this browser makes the small ones. It takes a few minutes.');
    const actions = el('div', 'onboard-actions');
    if (state.notice) {
      // The RandProtocol prover's one-time notice in Approve's place: read it, or leave for your
      // own prover (Settings in the wallet) — and the request stays waiting meanwhile.
      const warn = el('p', 'caption', proverNotice(state.provers));
      const ok = el('button', 'btn btn-primary block', 'I understand — continue');
      ok.type = 'button';
      ok.addEventListener('click', () => { void flow.acknowledge(); });
      const own = el('button', 'btn block', 'Use my own prover');
      own.type = 'button';
      own.addEventListener('click', () => { ext.tabs.create({ url: ext.runtime.getURL('app.html#settings') }); });
      const no = el('button', 'btn block', 'Reject');
      no.type = 'button';
      no.addEventListener('click', () => { void flow.reject().then(() => window.close()); });
      actions.append(ok, own, no);
      box.append(card, warn, actions);
      queueMicrotask(() => ok.focus());
      root.append(box);
      return;
    }
    const yes = el('button', 'btn btn-primary block', 'Approve');
    yes.type = 'button';
    const no = el('button', 'btn block', 'Reject');
    no.type = 'button';
    yes.addEventListener('click', () => { backend.wallet.noteActivity?.(); void flow.approve(); });
    no.addEventListener('click', () => { void flow.reject().then(() => window.close()); });
    actions.append(yes, no);
    box.append(card, note, actions);
    queueMicrotask(() => yes.focus());
  } else if (state.step === 'running') {
    if (!runStartedMs) runStartedMs = Date.now();
    title.textContent = 'Sending…';
    let text = PHASE_TEXT[state.phase] || 'Working…';
    const d = state.detail;
    if (state.phase === 'proving' && d) {
      if (d.authorising) text = 'Authorising on this device…';
      else if (d.position) text = `Waiting in ${d.prover || 'the prover'}’s queue (position ${d.position})…`;
      else if (d.prover) text = `${d.prover} is proving. This takes a few minutes; keep this window open.`;
    }
    sub.textContent = text;
    box.append(progressRing());
  } else if (state.step === 'done') {
    if (runTicker) { clearInterval(runTicker); runTicker = null; }
    if (runStartedMs && !recorded) { recorded = true; recordDuration('invoke', Date.now() - runStartedMs); }
    title.textContent = 'Sent';
    sub.textContent = `${host} has the transaction ${shortHex(state.tx, 10)}. Your wallet picks up what it pays you on its next sync.`;
    const actions = el('div', 'onboard-actions');
    const close = el('button', 'btn btn-primary block', 'Close');
    close.type = 'button';
    close.addEventListener('click', () => window.close());
    actions.append(close);
    box.append(actions);
    if (!closeTimer) closeTimer = setTimeout(() => window.close(), 4000);
  } else {
    if (runTicker) { clearInterval(runTicker); runTicker = null; }
    const e = state.error || {};
    title.textContent = e.code === 'USER_REJECTED' ? 'Not approved' : 'Not sent';
    sub.textContent = e.message || 'Rand Wallet could not complete the request.';
    const actions = el('div', 'onboard-actions');
    const close = el('button', 'btn block', 'Close');
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
});

render(flow.state);
void loadAssets().then(() => flow.start());
