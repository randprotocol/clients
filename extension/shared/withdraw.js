// The withdraw approval window: "<site> asks Rand Wallet to withdraw". It renders
// lib/withdraw-flow.js's state and nothing else decides anything here. It is invoke.js's twin for a
// bridge burn, and it keeps invoke.js's rules: everything shown is built from DOM nodes and
// textContent (the site's origin is data, never markup), and every figure is this wallet's own
// reading of the request — the normalised burn and the wallet's own estimate — not the site's.
//
// What this window does NOT do is the withdraw screen's last step. Typing the destination's last
// four characters is how a person who is composing a withdrawal proves they read the address they
// typed; here the site composed it, and the person's act is Approve over a screen that shows the
// whole destination, the public-chain warning and the exact amounts. The destination is therefore
// shown in full, never shortened, and the leaves-the-pool sentence is the withdraw screen's own
// (`leavesPoolWarning`, imported, not copied).
//
// No app.js here, so the language is this page's own job (lib/window-locale.js). Every string
// shown goes through `t()`, built inside the functions that show it, never at module load.
import { ext } from './lib/browser.js';
import { extensionBackend } from './backend-extension.js';
import { makeWithdrawFlow } from './lib/withdraw-flow.js';
import { proverNotice } from './lib/invoke-flow.js';
import { applyWindowLocale, sentenceWith } from './lib/window-locale.js';
import { markSvg } from './ui/lib/entropy.js';
import { formatUnits, shortHex, elapsed } from './ui/lib/format.js';
import { expectedMs, progressAt, remainingText, recordDuration } from './ui/lib/progress.js';
import { explorerLink } from './ui/lib/explorer.js';
import { feeDecimals, feeSymbol } from './ui/lib/assets.js';
import { receiveLabel } from './lib/withdraw-label.js';
import { phaseLabel } from './ui/screens/send/state.js';
import { leavesPoolWarning, PHASE_LABELS, EVM_CHAINS, chainName } from './ui/screens/withdraw.js';
import { t } from './ui/i18n.js';

const id = new URLSearchParams(location.search).get('id') || '';
const backend = extensionBackend();

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

/** The wallet's own asset list (RAND and the RPL tokens) and its explorer; empty until read. */
let assets = [];
let explorerUrl = '';
async function loadContext() {
  try { assets = (await backend.assets.list()) || []; } catch { /* amounts fall back to the index */ }
  try { explorerUrl = (await backend.settings.get()).explorerUrl || ''; } catch { /* no link then */ }
}
const assetOf = (index) => assets.find((a) => a.index === index) || null;
// An amount is ASCII digits and the symbol in every language (ui/lib/format.js).
function amountText(index, units) {
  const a = assetOf(index);
  if (!a) return `${units} ${t('asset {index}', { index })}`;
  return `${formatUnits(units, 9, Number(a.decimals) || 0)} ${a.symbol}`;
}

/** The destination as the chain will read it: an EVM address is `0x` + the last 40 hex, in full. */
function destinationText(request) {
  return EVM_CHAINS.includes(request.toChain) ? `0x${request.to.slice(24)}` : request.to;
}

/** The route line: who makes the large proof. */
function routeLine(state) {
  if (state.via !== 'prover') return t('Proof on this device');
  if (state.prover === 'default') return t('Proof by the RandProtocol provers');
  return t('Proof by {prover}', { prover: state.prover || t('the prover') });
}

// The proving ring: an estimate against this device's usual burn (ui/lib/progress.js), filled
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
    const expected = expectedMs('withdraw');
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

/** A whole sentence as one row: the wallet's reading of the burn, label and figure in one string. */
function line(text, className = 'v') {
  const row = el('div', 'kv');
  row.append(el('span', className, text));
  return row;
}

function kv(label, value, className = 'v') {
  const row = el('div', 'kv');
  row.append(el('span', 'k', label), el('span', className, value));
  return row;
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

  if (state.step === 'loading') {
    title.textContent = t('Reading the request…');
    sub.textContent = t('Checking it against the chain before anything is proved.');
  } else if (state.step === 'review') {
    const { request, estimate } = state;
    title.append(sentenceWith(t('{origin} asks Rand Wallet to withdraw'), 'origin', el('strong', null, state.origin || t('A site'))));
    const card = el('div', 'card');
    card.append(line(t('Burn {amount}', { amount: amountText(request.asset, request.amount) }), 'v amount'));
    // The coin that arrives, from the wallet's own table: never the burn asset's name.
    const got = receiveLabel({
      toChain: request.toChain, token: request.token, receive: estimate.receive || '0',
      assetDecimals: Number((assetOf(request.asset) || {}).decimals) || 0, t, fallbackChain: chainName, formatUnits, shortHex,
    });
    card.append(line(t('Receive {receive} on {chain}', { receive: got.receive, chain: got.chain }), 'v amount'));
    const dest = el('div', 'address-box');
    dest.append(el('span', 'mono', destinationText(request)));
    card.append(kv(t('To'), ''), dest);
    card.append(line(t('Fee {fee}', { fee: `${formatUnits(estimate.fee || '0', 9, feeDecimals(assets))} ${feeSymbol(assets)}` }), 'v amount'));
    if (BigInt(estimate.relayerFee || '0') > 0n) {
      card.append(kv(t('Relayer fee'), amountText(request.asset, estimate.relayerFee), 'v amount'));
    }
    const warn = el('div', 'banner warn');
    warn.append(el('span', null, leavesPoolWarning()));
    const route = el('p', 'caption', routeLine(state));
    const actions = el('div', 'onboard-actions');
    if (state.notice) {
      // The RandProtocol prover's one-time notice in Approve's place: read it, or cancel and
      // pair your own prover (Settings) — the request stays waiting meanwhile.
      const note = el('p', 'caption', proverNotice(state.provers, t));
      const ok = el('button', 'btn btn-primary block', t('I understand — continue'));
      ok.type = 'button';
      ok.addEventListener('click', () => { void flow.acknowledge(); });
      const no = el('button', 'btn block', t('Cancel'));
      no.type = 'button';
      no.addEventListener('click', () => { void flow.reject().then(() => window.close()); });
      actions.append(ok, no);
      box.append(card, warn, route, note, actions);
      queueMicrotask(() => ok.focus());
    } else {
      const no = el('button', 'btn block', t('Cancel'));
      no.type = 'button';
      const yes = el('button', 'btn btn-primary block', t('Approve'));
      yes.type = 'button';
      yes.addEventListener('click', () => { backend.wallet.noteActivity?.(); void flow.approve(); });
      no.addEventListener('click', () => { void flow.reject().then(() => window.close()); });
      actions.append(no, yes);
      box.append(card, warn, route, actions);
      queueMicrotask(() => yes.focus());
    }
  } else if (state.step === 'running') {
    if (!runStartedMs) runStartedMs = Date.now();
    title.textContent = t('Withdrawing…');
    sub.textContent = phaseLabel(state.phase, state.detail, PHASE_LABELS) + ' ' + t('Keep this window open until it says sent.');
    box.append(progressRing());
  } else if (state.step === 'done') {
    if (runTicker) { clearInterval(runTicker); runTicker = null; }
    if (runStartedMs && !recorded) { recorded = true; recordDuration('withdraw', Date.now() - runStartedMs); }
    title.textContent = t('Sent');
    sub.textContent = shortHex(state.tx, 10);
    const actions = el('div', 'onboard-actions');
    const link = explorerLink(explorerUrl, state.tx);
    if (link) {
      const a = el('a', 'btn block', link.label);
      a.href = link.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      actions.append(a);
    }
    const close = el('button', 'btn btn-primary block', t('Close'));
    close.type = 'button';
    close.addEventListener('click', () => window.close());
    actions.append(close);
    box.append(actions);
    // The window stays open when there is a link to follow.
    if (!closeTimer && !link) closeTimer = setTimeout(() => window.close(), 4000);
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

const flow = makeWithdrawFlow({
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
  document.title = t('Withdraw in Rand Wallet');
  render(flow.state);
  await loadContext();
  await flow.start();
})();
