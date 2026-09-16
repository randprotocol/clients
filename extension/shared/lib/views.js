// Every screen of the wallet, rendered from a hash route into one container. The popup
// (360×600) and the full-page app share this file; `mode` decides what opens in a tab: in the
// popup, Send, onboarding and Settings' exports hand off to app.html, because the popup closes
// when focus leaves it and a proof must not die with it.
import { ext, IS_FIREFOX } from './browser.js';
import { core } from './core.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import { formatUnits, parseUnits, shortAddress, shortHex, timeAgo, elapsed, escapeHtml as h, toBig } from './format.js';
import { encodeBytes, drawQr } from './qr.js';
import { getSettings, setSettings, getWallet, setWallet, getVault, setVault, getNoteStore, setNoteStore, emptyNoteStore, getUnlocked, setUnlocked, lock, touchUnlock, wipeAll } from './store.js';
import { scan, send, faucet, activity, balanceOf } from './wallet.js';
import { makeRpc } from './rpc.js';

const BUNDLE_BASE = 1_000_000n;
const ICON = ext.runtime.getURL('icons/icon-128.png');

let root, mode, state = { busy: false, syncing: false, syncText: '', toast: null };

export async function mount(container, opts) {
  root = container;
  mode = opts.mode;
  await applyTheme();
  window.addEventListener('hashchange', render);
  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('input', onInput);
  await render();
}

async function applyTheme() {
  const { theme } = await getSettings();
  if (theme === 'dark' || theme === 'light') document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
}

// ---------------------------------------------------------------- routing

export function route() {
  const hsh = location.hash.replace(/^#/, '') || '';
  const [name, ...rest] = hsh.split('/');
  return { name, arg: rest.join('/') };
}
function go(to) { location.hash = to; }
function openApp(hash) {
  const url = ext.runtime.getURL(`app.html#${hash}`);
  if (mode === 'popup') { ext.tabs.create({ url }); window.close(); } else go(hash);
}

async function render() {
  const { name, arg } = route();
  const wallet = await getWallet();
  const unlocked = wallet ? await getUnlocked() : null;
  let html;
  if (!wallet) {
    html = name === 'create' ? await viewCreate() : name === 'import' ? viewImport() : viewWelcome();
  } else if (!unlocked && !['welcome', 'create', 'import'].includes(name)) {
    html = viewLock();
  } else {
    switch (name) {
      case 'send': html = await viewSend(); break;
      case 'proving': html = viewProving(); break;
      case 'sent': html = await viewSent(arg); break;
      case 'receive': html = await viewReceive(wallet); break;
      case 'settings': html = await viewSettings(wallet); break;
      case 'note': html = await viewNote(arg); break;
      case 'tx': html = await viewTx(arg); break;
      case 'viewing': html = await viewViewingKey(unlocked); break;
      case 'export': html = await viewExport(unlocked); break;
      case 'faucet': html = await viewFaucet(wallet); break;
      default: html = await viewHome(wallet);
    }
  }
  root.innerHTML = html;
  afterRender(name, wallet);
}

function afterRender(name, wallet) {
  if (name === 'receive' && wallet) {
    const c = root.querySelector('canvas[data-qr]');
    if (c) { try { drawQr(c, encodeBytes(new TextEncoder().encode(wallet.address)), 4); } catch (e) { c.replaceWith(Object.assign(document.createElement('p'), { className: 'error', textContent: 'QR: ' + e.message })); } }
  }
  const first = root.querySelector('[autofocus]');
  if (first) first.focus();
  if (name === 'proving') tickProving();
}

function topbar(title, back = 'home') {
  return `<div class="topbar"><button class="btn icon ghost" data-go="${back}" aria-label="Back">‹</button><h1>${h(title)}</h1><span class="spacer"></span></div>`;
}

function toast(text, ms = 1800) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

async function copy(text, label = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(label); }
  catch { toast('Copy failed: select the text and copy it'); }
}

// ---------------------------------------------------------------- onboarding

function viewWelcome() {
  return `<div class="screen"><div class="scroll"><div class="welcome">
    <img src="${ICON}" alt="">
    <h1>Rand Wallet</h1>
    <p>A shielded wallet for RAND. Your balance and your transfers are visible only to you — and to whoever you hand a viewing key.</p>
    <div class="stack">
      <button class="btn primary" data-app="create">Create a new wallet</button>
      <button class="btn" data-app="import">I already have a wallet</button>
    </div></div></div>
    <div class="footer-note">Testnet software. Not audited; not for real value.</div></div>`;
}

let draft = null; // a freshly generated key, until the user confirms it is saved
async function viewCreate() {
  if (!draft) {
    try { draft = await core.keygen(); } catch (e) { return errorScreen('The wallet core failed to load: ' + e.message); }
  }
  return `<div class="screen">${topbar('New wallet', 'welcome')}<div class="scroll"><div class="stack">
    <div class="callout danger"><b>Write this spend key down.</b> It is the only copy. Anyone who has it can spend your notes; if you lose it, no one can recover them.</div>
    <div class="field"><label>Spend key</label><div class="keybox" id="sk">${h(draft.spend_key)}</div>
      <button class="btn small" data-copy="${h(draft.spend_key)}" data-copy-label="Spend key copied">Copy spend key</button></div>
    <div class="field"><label>Your address</label><div class="keybox">${h(draft.address)}</div></div>
    <form data-form="create" class="stack">
      <div class="field"><label>Password for this browser</label><input class="input" type="password" name="pw" minlength="8" required autocomplete="new-password" placeholder="at least 8 characters"></div>
      <div class="field"><label>Repeat password</label><input class="input" type="password" name="pw2" minlength="8" required autocomplete="new-password"></div>
      <p class="hint">The password encrypts the spend key on this device only. It does not recover the key.</p>
      <label class="check"><input type="checkbox" name="saved" required> I have written down the spend key and understand it cannot be recovered.</label>
      <p class="error" data-err></p>
      <button class="btn primary" type="submit">Create wallet</button>
    </form></div></div></div>`;
}

function viewImport() {
  return `<div class="screen">${topbar('Import wallet', 'welcome')}<div class="scroll">
    <form data-form="import" class="stack">
      <div class="field"><label>Spend key or wallet.key.json</label><textarea class="input" name="input" required autofocus placeholder="64 hex characters, or paste the contents of wallet.key.json"></textarea></div>
      <div class="field"><label>Password for this browser</label><input class="input" type="password" name="pw" minlength="8" required autocomplete="new-password"></div>
      <div class="field"><label>Repeat password</label><input class="input" type="password" name="pw2" minlength="8" required autocomplete="new-password"></div>
      <p class="error" data-err></p>
      <button class="btn primary" type="submit">Import</button>
    </form></div></div>`;
}

function viewLock() {
  return `<div class="screen"><div class="scroll"><div class="welcome">
    <img src="${ICON}" alt=""><h1>Rand Wallet</h1><p>Enter your password to unlock.</p>
    <form data-form="unlock" class="stack">
      <input class="input" type="password" name="pw" required autofocus autocomplete="current-password" placeholder="Password">
      <p class="error" data-err></p>
      <button class="btn primary" type="submit">Unlock</button>
      <button class="btn ghost small" type="button" data-action="forget" style="margin:8px auto 0">Forget this wallet on this device</button>
    </form></div></div></div>`;
}

async function finishOnboarding(info, pw) {
  const vault = await encryptSecret(pw, info.spend_key);
  await setVault(vault);
  await setWallet({ address: info.address, pk: info.pk, created_ms: Date.now() });
  await setNoteStore(emptyNoteStore());
  await setUnlocked(info.spend_key, info.viewing_key);
  draft = null;
}

// ---------------------------------------------------------------- home

async function viewHome(wallet) {
  const store = await getNoteStore();
  const settings = await getSettings();
  const bal = balanceOf(store);
  const pendingSum = store.notes.filter((n) => n.pending != null && !n.spent).reduce((a, n) => a + toBig(n.amount), 0n);
  const rows = activity(store).slice(0, 30);
  const sync = state.syncing ? `<span class="dot busy"></span> ${h(state.syncText || 'Syncing…')}`
    : store.last_sync_ms ? `<span class="dot"></span> Synced ${h(timeAgo(store.last_sync_ms))} · height ${store.head || 0}` : `<span class="dot off"></span> Not synced yet`;
  return `<div class="screen">
    <div class="brand"><img src="${ICON}" alt=""><span>Rand Wallet</span><span class="net">chain ${settings.chainId}</span>
      <button class="btn icon ghost" data-go="settings" aria-label="Settings" title="Settings">⚙</button></div>
    <div class="scroll">
      <div class="balance-card">
        <div class="label">Balance</div>
        <div class="amount">${h(formatUnits(bal, 4))}<small>RAND</small></div>
        <div class="sync">${sync}${pendingSum > 0n ? ` · ${h(formatUnits(pendingSum, 4))} pending` : ''}</div>
      </div>
      <div style="text-align:center"><button class="address-chip" data-copy="${h(wallet.address)}" data-copy-label="Address copied" title="Copy address">${h(shortAddress(wallet.address))} ⧉</button></div>
      <div class="actions">
        <button class="action" data-go="receive"><span class="ic">↓</span>Receive</button>
        <button class="action" data-app="send"><span class="ic">↑</span>Send</button>
        <button class="action" data-go="faucet"><span class="ic">✦</span>Faucet</button>
      </div>
      <div class="row" style="align-items:center;justify-content:space-between">
        <div class="section-title">Activity</div>
        <button class="btn ghost small" data-action="sync" ${state.syncing ? 'disabled' : ''}>${state.syncing ? 'Syncing…' : 'Refresh'}</button>
      </div>
      ${state.error ? `<p class="error">${h(state.error)}</p>` : ''}
      <div class="list">${rows.length ? rows.map(activityRow).join('') : `<div class="empty">No activity yet. Ask the faucet for testnet RAND, or receive a payment.</div>`}</div>
    </div></div>`;
}

function activityRow(r) {
  if (r.kind === 'received') {
    const st = r.pending ? 'pending spend' : r.spent ? 'spent' : 'unspent';
    return `<button class="item" data-go="note/${r.index}"><span class="ic in">↓</span><span class="main"><span class="title">Received</span><span class="sub">from ${h(shortHex(r.from))} · leaf ${r.index} · ${h(st)}</span></span><span class="amt in num">+${h(formatUnits(r.amount, 4))}</span></button>`;
  }
  if (r.kind === 'sent') {
    return `<div class="item"><span class="ic out">↑</span><span class="main"><span class="title">Sent</span><span class="sub">to ${h(shortHex(r.to_pk))} · height ${r.height}</span></span><span class="amt num">−${h(formatUnits(r.amount, 4))}</span></div>`;
  }
  if (r.kind === 'faucet') {
    return `<button class="item" data-go="tx/${h(r.hash)}"><span class="ic ${r.status === 'committed' ? 'in' : 'pend'}">✦</span><span class="main"><span class="title">Faucet</span><span class="sub">${h(r.status)} · ${h(shortHex(r.hash))}</span></span><span class="amt in num">+${h(formatUnits(r.amount, 4))}</span></button>`;
  }
  return `<button class="item" data-go="tx/${h(r.hash)}"><span class="ic ${r.status === 'pending' ? 'pend' : 'out'}">↑</span><span class="main"><span class="title">Sent${r.status === 'pending' ? ' (pending)' : r.status === 'expired' ? ' (expired)' : ''}</span><span class="sub">${h(shortHex(r.hash))} · ${h(timeAgo(r.created_ms))}</span></span><span class="amt num">−${h(formatUnits(r.amount, 4))}</span></button>`;
}

async function viewNote(indexStr) {
  const store = await getNoteStore();
  const n = store.notes.find((x) => String(x.index) === indexStr);
  if (!n) return errorScreen('Unknown note');
  const settings = await getSettings();
  return `<div class="screen">${topbar('Received note')}<div class="scroll"><div class="card">
    <div class="kv"><span class="k">Amount</span><span class="v num">${h(formatUnits(n.amount))} RAND</span></div>
    <div class="kv"><span class="k">Status</span><span class="v">${n.pending != null ? 'held by a pending spend' : n.spent ? 'spent' : 'unspent'}</span></div>
    <div class="kv"><span class="k">From (pk)</span><span class="v mono">${h(n.from)}</span></div>
    <div class="kv"><span class="k">Leaf</span><span class="v">#${n.index} · height ${n.height}</span></div>
    <div class="kv"><span class="k">Commitment</span><span class="v mono">${h(n.cm)}</span></div>
    ${n.asset ? `<div class="kv"><span class="k">Asset</span><span class="v">bridged asset ${n.asset}</span></div>` : ''}
  </div>
  <div class="stack" style="margin-top:12px">
    <a class="btn" href="${h(settings.explorerUrl)}/notes/${h(n.cm)}" target="_blank" rel="noopener">View leaf on RandScan ↗</a>
  </div></div></div>`;
}

async function viewTx(hash) {
  const store = await getNoteStore();
  const s = store.submissions.find((x) => x.hash === hash);
  const settings = await getSettings();
  if (!s) return errorScreen('Unknown transaction');
  const isFaucet = s.kind === 'faucet';
  return `<div class="screen">${topbar(isFaucet ? 'Faucet' : 'Sent payment')}<div class="scroll"><div class="card">
    <div class="kv"><span class="k">Amount</span><span class="v num">${h(formatUnits(s.amount))} RAND</span></div>
    <div class="kv"><span class="k">Status</span><span class="v">${h(s.status)}${s.height ? ` · height ${s.height}` : ''}</span></div>
    ${isFaucet ? '' : `<div class="kv"><span class="k">Fee</span><span class="v num">${h(formatUnits(s.fee))} RAND</span></div>
    <div class="kv"><span class="k">To</span><span class="v mono">${h(shortAddress(s.to, 16, 8))}</span></div>`}
    <div class="kv"><span class="k">Hash</span><span class="v mono">${h(s.hash)}</span></div>
    <div class="kv"><span class="k">Submitted</span><span class="v">${h(timeAgo(s.created_ms))}</span></div>
  </div>
  <div class="stack" style="margin-top:12px">
    <a class="btn" href="${h(settings.explorerUrl)}/transactions/${h(s.hash)}" target="_blank" rel="noopener">View on RandScan ↗</a>
    ${isFaucet ? '' : `<div class="card"><b>Disclose this payment</b><p class="hint" style="margin:6px 0 10px">The transaction key opens exactly this payment's envelope — the amount and the recipient — and nothing else. Paste it on the transaction's RandScan page under "Open with a key".</p>
      <button class="btn" data-copy="${h(s.tx_key)}" data-copy-label="Transaction key copied">Copy transaction key</button></div>`}
  </div></div></div>`;
}

// ---------------------------------------------------------------- receive & faucet

async function viewReceive(wallet) {
  return `<div class="screen">${topbar('Receive')}<div class="scroll"><div class="stack">
    <div class="qr"><canvas data-qr></canvas></div>
    <p class="hint" style="text-align:center">A shielded address is long (about 1.7 KB) because it carries a post-quantum encryption key. It is public: anyone may pay it, and it reveals nothing about what you hold.</p>
    <div class="keybox">${h(wallet.address)}</div>
    <div class="row"><button class="btn primary" data-copy="${h(wallet.address)}" data-copy-label="Address copied">Copy address</button></div>
  </div></div></div>`;
}

async function viewFaucet(wallet) {
  const settings = await getSettings();
  return `<div class="screen">${topbar('Testnet faucet')}<div class="scroll"><div class="stack">
    <div class="callout info">The faucet asks the node at <span class="mono">${h(settings.rpcUrl)}</span> to mint 100 RAND into a note only this wallet can open. The amount is public in that one transaction, as any deposit is; what you do with it afterwards is not.</div>
    <p class="error" data-err></p>
    <p class="ok" data-ok></p>
    <button class="btn primary" data-action="faucet" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Waiting for the mint…' : 'Request 100 RAND'}</button>
    <p class="hint">Only chains whose genesis enables the faucet answer, and only validator nodes sign mints.</p>
  </div></div></div>`;
}

// ---------------------------------------------------------------- send

let sendDraft = { to: '', amount: '', fee: formatUnits(BUNDLE_BASE), review: false, err: '' };

async function viewSend() {
  const store = await getNoteStore();
  const bal = balanceOf(store);
  const d = sendDraft;
  if (d.review) {
    const amt = parseUnits(d.amount), fee = parseUnits(d.fee);
    return `<div class="screen">${topbar('Review', 'send')}<div class="scroll"><div class="stack">
      <div class="card">
        <div class="kv"><span class="k">Send</span><span class="v num"><b>${h(formatUnits(amt))} RAND</b></span></div>
        <div class="kv"><span class="k">Fee</span><span class="v num">${h(formatUnits(fee))} RAND</span></div>
        <div class="kv"><span class="k">Total</span><span class="v num">${h(formatUnits(amt + fee))} RAND</span></div>
        <div class="kv"><span class="k">To</span><span class="v mono">${h(shortAddress(d.to, 18, 10))}</span></div>
      </div>
      <div class="callout">Proving takes a few minutes in the browser and runs in this tab. <b>Keep this tab open</b> until the transfer is submitted; the popup can be closed.</div>
      <div class="callout danger"><b>Known limitation.</b> A bundle proof needs about 5.6 GB of memory, and a browser's WebAssembly runtime is capped at 4 GB, so today the proof stops with an out-of-memory error before it finishes. Until the prover's memory use drops, send from the rand command-line wallet with the key file from Settings › Backup. Everything else here — receiving, scanning, the faucet, viewing keys — works.</div>
      <p class="error">${h(d.err)}</p>
      <button class="btn primary" data-action="confirm-send">Confirm and prove</button>
      <button class="btn ghost" data-action="edit-send">Edit</button>
    </div></div></div>`;
  }
  return `<div class="screen">${topbar('Send')}<div class="scroll">
    <form data-form="send" class="stack">
      <div class="field"><label>Recipient address</label><textarea class="input" name="to" required placeholder="rand1…" autofocus>${h(d.to)}</textarea><span class="hint" data-to-hint></span></div>
      <div class="field"><label>Amount (RAND)</label><div class="row"><input class="input num" name="amount" inputmode="decimal" required placeholder="0.0" value="${h(d.amount)}"><button class="btn small" type="button" data-action="max">Max</button></div>
        <span class="hint">Available: ${h(formatUnits(bal))} RAND</span></div>
      <div class="field"><label>Fee (RAND)</label><input class="input num" name="fee" inputmode="decimal" value="${h(d.fee)}"><span class="hint">Floor 0.001 RAND, paid to the block proposer.</span></div>
      <p class="error" data-err>${h(d.err)}</p>
      <button class="btn primary" type="submit">Review</button>
    </form></div></div>`;
}

let proving = null; // { started, phase, error, result }
function viewProving() {
  const p = proving || { phase: 'prove', started: Date.now() };
  const phases = { select: 'Selecting notes…', witness: 'Fetching the anchor and witnesses…', prove: 'Proving the bundle…', submit: 'Submitting…', wait: 'Waiting for the block…' };
  if (p.error) {
    return `<div class="screen">${topbar('Transfer failed', 'send')}<div class="scroll"><div class="prove">
      <div class="big-check" style="background:rgba(255,107,107,.16);color:var(--negative)">!</div>
      <h2>Not sent</h2><p class="error">${h(p.error)}</p>
      <div class="stack"><button class="btn primary" data-go="send">Try again</button><button class="btn ghost" data-go="home">Home</button></div></div></div></div>`;
  }
  return `<div class="screen">${topbar('Proving', 'home')}<div class="scroll"><div class="prove">
    <div class="spinner"></div>
    <h2>${h(phases[p.phase] || 'Working…')}</h2>
    <div class="elapsed" data-elapsed>${elapsed(Date.now() - p.started)}</div>
    <p class="hint">A shielded transfer is a zero-knowledge proof of a 2-in-2-out bundle. In a browser this takes several minutes of CPU. Keep this tab open; you can switch to other tabs.</p>
    <p class="hint">Your spend key never leaves this device.</p>
  </div></div></div>`;
}
function tickProving() {
  const el = root.querySelector('[data-elapsed]');
  if (!el || !proving || proving.error || proving.done) return;
  el.textContent = elapsed(Date.now() - proving.started);
  setTimeout(tickProving, 1000);
}

async function viewSent(hash) {
  const settings = await getSettings();
  const store = await getNoteStore();
  const s = store.submissions.find((x) => x.hash === hash);
  return `<div class="screen">${topbar('Sent', 'home')}<div class="scroll"><div class="prove">
    <div class="big-check">✓</div>
    <h2>${s?.status === 'committed' ? 'Transfer committed' : 'Transfer submitted'}</h2>
    <p class="hint">${s ? `${h(formatUnits(s.amount))} RAND to ${h(shortAddress(s.to, 12, 6))}${s.status === 'committed' ? '' : '. The node accepted it; it will be committed within a few blocks.'}` : ''}</p>
    <div class="keybox" style="text-align:left">${h(hash)}</div>
    <div class="stack" style="margin-top:14px">
      <a class="btn" href="${h(settings.explorerUrl)}/transactions/${h(hash)}" target="_blank" rel="noopener">View on RandScan ↗</a>
      ${s ? `<button class="btn" data-copy="${h(s.tx_key)}" data-copy-label="Transaction key copied">Copy transaction key</button>` : ''}
      <button class="btn primary" data-go="home">Done</button>
    </div>
    <p class="hint" style="margin-top:14px">The transaction key discloses this payment alone — amount and recipient — to whoever you give it to.</p>
  </div></div></div>`;
}

// ---------------------------------------------------------------- settings

async function viewSettings(wallet) {
  const s = await getSettings();
  const ver = await core.version().catch(() => ({}));
  return `<div class="screen">${topbar('Settings')}<div class="scroll"><div class="stack">
    <form data-form="network" class="card stack">
      <b>Network</b>
      <div class="field"><label>RPC URL</label><input class="input mono" name="rpcUrl" value="${h(s.rpcUrl)}" required></div>
      <div class="field"><label>Chain id</label><input class="input num" name="chainId" type="number" min="1" value="${h(s.chainId)}" required></div>
      <div class="row"><button class="btn small" type="submit">Save</button><button class="btn small" type="button" data-action="test-connection">Test connection</button></div>
      <p class="hint" data-net-status>${IS_FIREFOX ? 'Firefox' : 'Chrome'} asks for permission to reach a new host the first time you save it.</p>
    </form>
    <div class="card stack">
      <b>Viewing key</b>
      <p class="hint">Opens your whole history on RandScan — every note received or sent — without being able to spend. Hand it only to someone you want to see everything.</p>
      <button class="btn" data-go="viewing">Show viewing key</button>
    </div>
    <div class="card stack">
      <b>Backup</b>
      <p class="hint">The spend key is the wallet. Export it to move to another device or to the rand command-line wallet.</p>
      <button class="btn" data-app="export">Export spend key / key file</button>
    </div>
    <form data-form="prefs" class="card stack">
      <b>Preferences</b>
      <div class="field"><label>Auto-lock after (minutes, 0 = never)</label><input class="input num" name="autoLockMin" type="number" min="0" value="${h(s.autoLockMin)}"></div>
      <div class="field"><label>Theme</label><select class="input" name="theme">${['system', 'dark', 'light'].map((t) => `<option value="${t}" ${s.theme === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <button class="btn small" type="submit">Save</button>
    </form>
    <div class="card stack">
      <b>Maintenance</b>
      <button class="btn" data-action="rescan">Rescan from leaf 0</button>
      <button class="btn" data-action="lock">Lock now</button>
      <button class="btn danger" data-action="forget">Forget this wallet on this device</button>
    </div>
    <p class="hint" style="text-align:center">Rand Wallet ${h(ver.version || '')} · core for chain build ${h(ver.chain_build || '')} · <a href="${h(s.explorerUrl)}" target="_blank" rel="noopener">randscan.org</a></p>
  </div></div></div>`;
}

async function viewViewingKey(unlocked) {
  const s = await getSettings();
  return `<div class="screen">${topbar('Viewing key', 'settings')}<div class="scroll"><div class="stack">
    <div class="callout">A viewing key sees everything this wallet ever received or sent, past and future. It cannot spend. It is all-or-nothing: to disclose one payment, use that payment's transaction key instead.</div>
    <div class="keybox">${h(unlocked.viewing_key)}</div>
    <button class="btn primary" data-copy="${h(unlocked.viewing_key)}" data-copy-label="Viewing key copied">Copy viewing key</button>
    <a class="btn" href="${h(s.explorerUrl)}/viewing" target="_blank" rel="noopener">Open “My history” on RandScan ↗</a>
    <p class="hint">On RandScan, paste the key under “Scan with a viewing key”. Decryption runs in your browser there too; the key is never sent to the explorer.</p>
  </div></div></div>`;
}

async function viewExport(unlocked) {
  const info = await core.walletInfo(unlocked.spend_key);
  return `<div class="screen">${topbar('Export', 'settings')}<div class="scroll"><div class="stack">
    <div class="callout danger"><b>Anyone with the spend key can spend your notes.</b> Do not paste it into a website or a chat. RandScan only ever needs the viewing key.</div>
    <div class="field"><label>Spend key</label><div class="keybox">${h(info.spend_key)}</div><button class="btn" data-copy="${h(info.spend_key)}" data-copy-label="Spend key copied">Copy spend key</button></div>
    <div class="field"><label>wallet.key.json (for the rand CLI)</label><div class="keybox">${h(info.key_file)}</div><button class="btn" data-copy="${h(info.key_file)}" data-copy-label="Key file copied">Copy key file</button></div>
  </div></div></div>`;
}

function errorScreen(msg) {
  return `<div class="screen">${topbar('Error')}<div class="scroll"><p class="error">${h(msg)}</p><button class="btn" data-go="home">Home</button></div></div>`;
}

// ---------------------------------------------------------------- events

async function onClick(e) {
  const el = e.target.closest('[data-go],[data-app],[data-copy],[data-action]');
  if (!el) return;
  if (el.dataset.go !== undefined) { e.preventDefault(); go(el.dataset.go); return; }
  if (el.dataset.app !== undefined) { e.preventDefault(); openApp(el.dataset.app); return; }
  if (el.dataset.copy !== undefined) { e.preventDefault(); await touchUnlock(); copy(el.dataset.copy, el.dataset.copyLabel); return; }
  const a = el.dataset.action;
  try {
    if (a === 'sync') await doSync();
    else if (a === 'max') {
      const store = await getNoteStore();
      const fee = parseUnits(root.querySelector('[name=fee]')?.value || sendDraft.fee);
      const max = balanceOf(store) - fee;
      root.querySelector('[name=amount]').value = max > 0n ? formatUnits(max) : '0';
    }
    else if (a === 'edit-send') { sendDraft.review = false; sendDraft.err = ''; await render(); }
    else if (a === 'confirm-send') await doSend();
    else if (a === 'faucet') await doFaucet();
    else if (a === 'test-connection') await doTestConnection();
    else if (a === 'rescan') { const st = await getNoteStore(); await setNoteStore({ ...emptyNoteStore(), submissions: st.submissions }); toast('Store cleared; syncing'); go('home'); await doSync(); }
    else if (a === 'lock') { await lock(); go('home'); await render(); }
    else if (a === 'forget') {
      // Two taps, no modal dialog: the second tap within ten seconds does it.
      if (state.forgetArmed && Date.now() - state.forgetArmed < 10_000) { await wipeAll(); draft = null; state.forgetArmed = 0; go('welcome'); await render(); }
      else { state.forgetArmed = Date.now(); el.textContent = 'Tap again to forget — the notes are lost without the spend key'; el.classList.add('danger'); }
    }
  } catch (err) { state.error = err.message; await render(); }
}

async function onInput(e) {
  const el = e.target;
  if (el.name === 'to') {
    const hint = root.querySelector('[data-to-hint]');
    const v = el.value.trim();
    if (!v) { hint.textContent = ''; return; }
    const r = await core.parseAddress(v).catch(() => ({ valid: false, error: 'core unavailable' }));
    hint.textContent = r.valid ? `✓ valid address · pk ${shortHex(r.pk)}` : `✗ ${r.error}`;
    hint.className = r.valid ? 'ok' : 'error';
  }
}

async function onSubmit(e) {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form).entries());
  const err = form.querySelector('[data-err]');
  const setErr = (m) => { if (err) err.textContent = m; };
  try {
    switch (form.dataset.form) {
      case 'create': {
        if (f.pw !== f.pw2) return setErr('Passwords do not match');
        await finishOnboarding(draft, f.pw);
        go('home'); await render(); toast('Wallet created'); doSync().catch(() => {});
        break;
      }
      case 'import': {
        if (f.pw !== f.pw2) return setErr('Passwords do not match');
        const info = await core.importKey(f.input);
        await finishOnboarding(info, f.pw);
        go('home'); await render(); toast('Wallet imported'); doSync().catch(() => {});
        break;
      }
      case 'unlock': {
        const vault = await getVault();
        const sk = await decryptSecret(f.pw, vault);
        const info = await core.walletInfo(sk);
        await setUnlocked(sk, info.viewing_key);
        await render();
        doSync().catch(() => {});
        break;
      }
      case 'send': {
        const r = await core.parseAddress(f.to.trim());
        if (!r.valid) return setErr('Recipient: ' + r.error);
        let amt, fee;
        try { amt = parseUnits(f.amount); fee = parseUnits(f.fee); } catch (x) { return setErr('Amount: ' + x.message); }
        if (amt <= 0n) return setErr('Amount must be greater than zero');
        if (fee < BUNDLE_BASE) return setErr('Fee is below the floor of 0.001 RAND');
        const store = await getNoteStore();
        if (amt + fee > balanceOf(store)) return setErr('Amount plus fee exceeds your balance');
        sendDraft = { to: f.to.trim(), amount: f.amount, fee: f.fee, review: true, err: '' };
        await render();
        break;
      }
      case 'network': {
        const url = f.rpcUrl.trim().replace(/\/+$/, '');
        if (!/^https?:\/\//.test(url)) return setErr('RPC URL must start with http:// or https://');
        const granted = await ensureHostPermission(url);
        if (!granted) { root.querySelector('[data-net-status]').textContent = 'Permission to reach that host was not granted.'; return; }
        await setSettings({ rpcUrl: url, chainId: Number(f.chainId) });
        toast('Network saved');
        break;
      }
      case 'prefs': {
        await setSettings({ autoLockMin: Number(f.autoLockMin), theme: f.theme });
        await applyTheme(); await touchUnlock(); toast('Saved');
        break;
      }
    }
  } catch (x) { setErr(x.message); }
}

async function ensureHostPermission(url) {
  // Called first thing inside the user's click/submit: Firefox only honours a permission
  // request while it is still handling user input. A request for an origin already granted
  // resolves true without a prompt.
  let origin;
  try { origin = new URL(url).origin + '/*'; } catch { return false; }
  try { return await ext.permissions.request({ origins: [origin] }); }
  catch { return true; } // the pattern is not an optional permission here (e.g. the default host): just try
}

async function doSync() {
  const u = await getUnlocked();
  if (!u || state.syncing) return;
  state.syncing = true; state.error = null; state.syncText = 'Syncing…';
  await render();
  try {
    await scan(u.spend_key, { onProgress: (p) => { state.syncText = p.phase === 'notes' ? `Scanning leaves ${p.scanned}${p.total ? ' of ' + p.total : ''}…` : `Reading spends to ${p.scanned}…`; const el = root.querySelector('.sync'); if (el) el.innerHTML = `<span class="dot busy"></span> ${h(state.syncText)}`; } });
  } catch (e) { state.error = 'Sync failed: ' + e.message; }
  state.syncing = false;
  if (route().name === '' || route().name === 'home') await render();
}

async function doSend() {
  const u = await getUnlocked();
  if (!u) { go('home'); return render(); }
  const d = sendDraft;
  proving = { started: Date.now(), phase: 'select' };
  go('proving'); await render();
  try {
    const sub = await send(u.spend_key, { to: d.to, amountUnits: parseUnits(d.amount).toString(), feeUnits: parseUnits(d.fee).toString(), wait: true,
      onPhase: (ph) => { proving.phase = ph; if (route().name === 'proving') render(); } });
    proving.done = true;
    sendDraft = { to: '', amount: '', fee: formatUnits(BUNDLE_BASE), review: false, err: '' };
    go('sent/' + sub.hash);
  } catch (e) {
    proving.error = explainProvingError(e.message); proving.done = true;
    await render();
  }
}

/** The wasm core aborts with a bare `unreachable` (or the worker dies) when the prover runs out
 * of the 4 GB a browser gives WebAssembly; say what happened instead of echoing the runtime. */
function explainProvingError(msg) {
  if (/unreachable|out of memory|allocation|worker failed|memory access/i.test(msg || '')) {
    return 'The proof ran out of memory: a bundle proof needs about 5.6 GB and the browser gives WebAssembly at most 4 GB. Your notes are untouched. Send from the rand command-line wallet (export the key file under Settings › Backup) until the prover fits in a browser.';
  }
  return msg;
}

async function doFaucet() {
  const u = await getUnlocked(); const w = await getWallet();
  if (!u) return;
  state.busy = true; await render();
  try {
    const hash = await faucet(u.spend_key, w.address);
    state.busy = false; toast('Minted 100 RAND');
    go('tx/' + hash);
  } catch (e) { state.busy = false; await render(); root.querySelector('[data-err]').textContent = e.message; }
}

async function doTestConnection() {
  const el = root.querySelector('[data-net-status]');
  const url = root.querySelector('[name=rpcUrl]').value.trim().replace(/\/+$/, '');
  el.textContent = 'Connecting…';
  try {
    if (!(await ensureHostPermission(url))) { el.textContent = 'Permission not granted.'; return; }
    const rpc = makeRpc(url);
    const [chain, st] = await Promise.all([rpc.chainId(), rpc.status()]);
    el.textContent = `Chain ${chain} · height ${st.height} · ${st.peer_count} peers · faucet ${st.faucet ? 'on' : 'off'} · ${st.syncing ? 'syncing' : 'synced'}`;
    el.className = 'ok';
  } catch (e) { el.textContent = e.message; el.className = 'error'; }
}
