// Private multisig signing (spec 2026-10-11-msauth-signing-design.md §4): `#signers` lists the
// signer profiles and adds one; `#signer/<id>` checks a proposal, shows exactly what the core
// checked, signs it after the fingerprint's last four characters and the password, and checks a
// share. Every value from a file, a paste, storage or the core reaches the page as text. The
// proposal lives in this screen's closure only and is dropped when it unmounts.
import { h, raw } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';
import { formatUnits, parseUnits } from '../lib/format.js';
import { t } from '../i18n.js';
import { isZero } from '../engine/signers.js';

export const MAX_FILE_BYTES = 1 << 20;
/** An output the signer must name a payee for: it leaves the account and moves something. Decided
 * here from the output itself, not from the core's own flag. */
export const needsPayee = (o) => o && o.to_account !== true && !isZero(o.amount);
export const isMatched = (o) => typeof o.matches === 'string' && o.matches.trim() !== '';
const nonRand = (o) => o != null && o.asset != null && Number.isInteger(Number(o.asset)) && Number(o.asset) !== 0;
/**
 * One intended payment as the core's `addr:AMOUNT`. AMOUNT is RAND in display units, the wallet's
 * decimal text, as the send screen takes it (checked by `parseUnits`, passed as typed and trimmed).
 * The amount is required unless `amountOptional` (a non-RAND paying output: the core refuses a pin
 * there, so that payee is the address alone). Throws an Error whose message is for the user.
 */
export function entryOf({ addr, amount }, amountOptional = false) {
  const a = String(addr || '').trim();
  const v = String(amount || '').trim();
  if (a === '') throw new Error(t('Enter the address of every payment.'));
  if (v === '') {
    if (amountOptional) return a;
    throw new Error(t('Enter the amount of every payment: it is what stops a split or an inflated payment.'));
  }
  let units;
  try { units = parseUnits(v); } catch { throw new Error(t('An amount is a number of RAND, such as 1.5.')); }
  if (units <= 0n) throw new Error(t('An amount is a number of RAND, such as 1.5.'));
  return `${a}:${v}`;
}
const unitsOf = (a) => { try { return formatUnits(BigInt(String(a).trim() || '0')); } catch { return String(a); } };

export function lastFourOf(fingerprint) {
  return String(fingerprint || '').replace(/-/g, '').slice(-4).toLowerCase();
}
export function confirmsFingerprint(fingerprint, typed) {
  const want = lastFourOf(fingerprint);
  return want.length === 4 && String(typed || '').replace(/[-\s]/g, '').toLowerCase() === want;
}
async function readPicked(input) {
  const file = input.files && input.files[0];
  if (!file) return null;
  if (file.size > MAX_FILE_BYTES) throw new Error(t('That file is larger than a proposal, a policy or a key file can be.'));
  return file.text();
}
const topbar = (title, back) => h`<div class="topbar"><button class="btn-icon icon-flip" type="button" data-go="${back}" aria-label="${t('Back')}">${raw(icons.chevron())}</button><span class="topbar-title">${title}</span><span class="spacer"></span></div>`;
function fileField(ctx, { role, label }) {
  const popup = ctx.mode === 'popup';
  const picker = popup ? '' : raw(h`<label class="btn sm" for="f-${role}">${t('Open file')}</label><input id="f-${role}" data-file="${role}" type="file" accept=".json,.txt,application/json,text/plain" hidden>`);
  return h`<div class="field"><div class="field-top"><label class="label" for="t-${role}">${label}</label><span class="cluster">${picker}</span></div><textarea id="t-${role}" data-role="${role}" rows="3" spellcheck="false" autocomplete="off"></textarea></div>`;
}
function sidebarOffer(ctx) {
  return ctx.mode === 'popup' && typeof ctx.backend.platform.openSidebar === 'function'
    ? h`<button class="btn block" type="button" data-role="to-sidebar">${t('Open in the side panel to choose files')}</button>` : '';
}
function wireFiles(ctx, root, onError) {
  for (const input of root.querySelectorAll('input[type=file][data-file]')) {
    input.addEventListener('change', async () => {
      try {
        const text = await readPicked(input);
        if (text != null && ctx.isCurrent()) root.querySelector(`textarea[data-role="${input.dataset.file}"]`).value = text;
      } catch (err) { onError(err.message); }
      input.value = '';
    });
  }
  const side = root.querySelector('[data-role="to-sidebar"]');
  if (side) side.addEventListener('click', () => { Promise.resolve(ctx.backend.platform.openSidebar()).catch(() => {}); });
}
function showError(el, message) {
  el.textContent = message || '';
  if (message) el.removeAttribute('hidden'); else el.setAttribute('hidden', '');
}

registerScreen('signers', {
  render: () => h`<h1 class="sr-only">${t('Multisig signers')}</h1>${raw(topbar(t('Multisig signers'), 'settings'))}<div class="stack" data-role="body"><div class="skeleton block"></div></div>`,
  async after(ctx, root) {
    const group = ctx.backend.signers;
    const body = root.querySelector('[data-role="body"]');
    if (!group || typeof group.list !== 'function') {
      body.innerHTML = h`<div class="card"><div class="empty"><span class="empty-title">${t('Multisig signing is not available in this app.')}</span></div></div>`;
      return;
    }
    body.innerHTML = h`
      <div data-role="list"></div>
      <h2 class="section-title">${t('Add a signer')}</h2>
      <div class="card stack">
        ${raw(sidebarOffer(ctx))}
        <div class="field"><label class="label" for="signer-label">${t('Label')}</label><input id="signer-label" data-role="label" type="text" maxlength="64" autocomplete="off"></div>
        ${raw(fileField(ctx, { role: 'policy', label: t('Policy file') }))}
        ${raw(fileField(ctx, { role: 'key', label: t('Signer key file, or its 64-hex seed') }))}
        <p class="error field-error" data-role="error" role="alert" hidden></p>
        <button class="btn btn-primary block" type="button" data-role="preview">${t('Check')}</button>
        <div data-role="preview-out"></div>
      </div>
      <p class="caption">${t('A signer profile is kept in this wallet\'s encrypted vault. Every signature asks for your password again.')}</p>`;
    const errorEl = body.querySelector('[data-role="error"]');
    const out = body.querySelector('[data-role="preview-out"]');
    const field = (r) => body.querySelector(`[data-role="${r}"]`);
    wireFiles(ctx, body, (m) => showError(errorEl, m));
    for (const r of ['label', 'policy', 'key']) field(r).addEventListener('input', () => { out.textContent = ''; });

    async function paintList() {
      const listEl = body.querySelector('[data-role="list"]');
      let rows;
      try { rows = await group.list(); } catch (err) { if (ctx.isCurrent()) { listEl.textContent = ''; showError(errorEl, err.message); } return; }
      if (!ctx.isCurrent()) return;
      if (rows.length === 0) {
        listEl.innerHTML = h`<div class="card"><div class="empty"><span class="empty-title">${t('No signer profiles yet')}</span><span>${t('Add the policy file and your signer key to sign for a private multisig account.')}</span></div></div>`;
        return;
      }
      listEl.innerHTML = h`<div class="card flush"><ul class="list" role="list">${raw(rows.map((r) => h`<li><button class="row" type="button" data-go="signer/${r.id}"><span class="row-main"><span class="row-title"><span class="truncate" data-role="row-label"></span></span><span class="row-sub mono" data-role="row-fp"></span><span class="row-sub">${t('{threshold} of {count} · signer {index}', { threshold: String(r.threshold), count: String(r.signers), index: String(r.index) })}</span></span></button></li>`).join(''))}</ul></div>`;
      listEl.querySelectorAll('li').forEach((li, i) => {
        li.querySelector('[data-role="row-label"]').textContent = rows[i].label;
        li.querySelector('[data-role="row-fp"]').textContent = rows[i].fingerprint;
      });
    }

    field('preview').addEventListener('click', async () => {
      showError(errorEl, '');
      try {
        const p = await group.preview({ policy: field('policy').value, key: field('key').value });
        if (!ctx.isCurrent()) return;
        out.innerHTML = h`<div class="stack">
          <span class="label">${t('Account fingerprint — compare it with every other signer before you save')}</span>
          <span class="mono" data-role="pv-fp"></span><span class="mono row-sub" data-role="pv-address"></span>
          <span>${t('{threshold} of {count} · this key is signer {index}', { threshold: String(p.threshold), count: String(p.signers), index: String(p.index) })}</span>
          <div class="field"><label class="label" for="signer-password">${t('Password')}</label><input id="signer-password" data-role="add-password" type="password" autocomplete="current-password"></div>
          <button class="btn btn-primary block" type="button" data-role="save">${t('Save signer')}</button></div>`;
        out.querySelector('[data-role="pv-fp"]').textContent = p.fingerprint;
        out.querySelector('[data-role="pv-address"]').textContent = p.address;
        out.querySelector('[data-role="save"]').addEventListener('click', async () => {
          const pw = out.querySelector('[data-role="add-password"]');
          try {
            await group.add({ label: field('label').value, policy: field('policy').value, key: field('key').value, password: pw.value });
            for (const r of ['label', 'policy', 'key']) field(r).value = '';
            out.textContent = '';
            await paintList();
          } catch (err) { showError(errorEl, err.message); } finally { pw.value = ''; }
        });
      } catch (err) { showError(errorEl, err.message); }
    });
    await paintList();
  },
});

registerScreen('signer', {
  render: () => h`<h1 class="sr-only">${t('Sign a proposal')}</h1>${raw(topbar(t('Sign a proposal'), 'signers'))}<div class="stack" data-role="body"><div class="skeleton block"></div></div>`,
  async after(ctx, root, id) {
    const group = ctx.backend.signers;
    const body = root.querySelector('[data-role="body"]');
    let profile;
    try { profile = (await group.list()).find((p) => p.id === id); } catch (err) { if (ctx.isCurrent()) body.textContent = err.message; return; }
    if (!ctx.isCurrent()) return;
    if (!profile) { body.textContent = t('No such signer profile.'); return; }
    let proposal = null; // this screen's only copy; never stored
    let payees = []; // the `addr:amount` entries last sent to check
    let rows = [{ addr: '', amount: '' }]; // the intended payments being edited
    let lastSummary = null;
    const inHand = new Set();
    body.innerHTML = h`
      <div class="card stack"><span class="row-title" data-role="p-label"></span><span class="mono" data-role="p-fp"></span>
        <span>${t('{threshold} of {count} · signer {index}', { threshold: String(profile.threshold), count: String(profile.signers), index: String(profile.index) })}</span></div>
      <div class="card stack">${raw(sidebarOffer(ctx))}${raw(fileField(ctx, { role: 'proposal', label: t('Proposal (proposal.json)') }))}
        <p class="error field-error" data-role="error" role="alert" hidden></p>
        <button class="btn btn-primary block" type="button" data-role="check">${t('Check proposal')}</button></div>
      <div data-role="payments"></div>
      <div data-role="review"></div>
      <h2 class="section-title">${t('Check a share')}</h2>
      <div class="card stack"><textarea data-role="share-in" rows="2" spellcheck="false" autocomplete="off" placeholder="${t('index:hex')}"></textarea>
        <button class="btn block" type="button" data-role="verify">${t('Check share')}</button><p data-role="verify-out" role="status"></p></div>
      <div class="card stack"><div class="field"><label class="label" for="remove-password">${t('Password')}</label><input id="remove-password" data-role="remove-password" type="password" autocomplete="current-password"></div>
        <button class="btn block" type="button" data-role="remove">${t('Remove this signer')}</button></div>`;
    body.querySelector('[data-role="p-label"]').textContent = profile.label;
    body.querySelector('[data-role="p-fp"]').textContent = profile.fingerprint;
    const errorEl = body.querySelector('[data-role="error"]');
    const review = body.querySelector('[data-role="review"]');
    wireFiles(ctx, body, (m) => showError(errorEl, m));

    function paintPayments() {
      const box = body.querySelector('[data-role="payments"]');
      const paying = lastSummary && Array.isArray(lastSummary.outputs) ? lastSummary.outputs.filter(needsPayee) : null;
      if (paying && paying.length === 0) { box.textContent = ''; return; }
      const optional = !!(paying && paying.some(nonRand));
      box.innerHTML = h`<div class="card stack">
        <span class="label">${t('Intended payments')}</span>
        <span class="caption">${t('Enter every payment you mean to make: the address and the amount in RAND. A payment to the same address twice is entered once, with the total. An output that matches none of them cannot be signed.')}</span>
        ${raw(optional ? h`<span class="caption" data-role="nonrand-note">${t('Amounts cannot be checked for non-RAND payments: leave the amount empty for those.')}</span>` : '')}
        <div class="stack" data-role="rows">${raw(rows.map((_, i) => h`<div class="field cluster"><input data-role="payee" data-row="${i}" type="text" autocomplete="off" spellcheck="false" placeholder="rand1…" aria-label="${t('Payee address')}"><input data-role="payee-amount" data-row="${i}" type="text" inputmode="decimal" autocomplete="off" placeholder="0.0" aria-label="${t('Amount in RAND')}"><button class="btn sm" type="button" data-role="remove-payment" data-row="${i}">${t('Remove')}</button></div>`).join(''))}</div>
        <button class="btn sm" type="button" data-role="add-payment">${t('Add payment')}</button>
        <p class="error" data-role="payee-error" role="alert" hidden></p>
        <button class="btn block" type="button" data-role="check-payees">${t('Check payments')}</button></div>`;
      box.querySelectorAll('input[data-role="payee"]').forEach((n, i) => { n.value = rows[i].addr; n.addEventListener('input', () => { rows[i].addr = n.value; }); });
      box.querySelectorAll('input[data-role="payee-amount"]').forEach((n, i) => { n.value = rows[i].amount; n.addEventListener('input', () => { rows[i].amount = n.value; }); });
      box.querySelectorAll('[data-role="remove-payment"]').forEach((n, i) => n.addEventListener('click', () => { rows.splice(i, 1); paintPayments(); }));
      box.querySelector('[data-role="add-payment"]').addEventListener('click', () => { rows.push({ addr: '', amount: '' }); paintPayments(); });
      box.querySelector('[data-role="check-payees"]').addEventListener('click', () => {
        const errP = box.querySelector('[data-role="payee-error"]');
        try { payees = rows.map((row) => entryOf(row, optional)); } catch (err) { showError(errP, err.message); return; }
        showError(errP, '');
        runCheck();
      });
    }
    function paintRefusal(act, r) {
      act.innerHTML = h`<p class="error" data-role="refusal" role="alert"></p><button class="btn block" type="button" data-role="retry">${t('Retry')}</button>`;
      act.querySelector('[data-role="refusal"]').textContent = r.refusal.message;
      act.querySelector('[data-role="retry"]').addEventListener('click', runCheck);
    }
    function paintReview(r) {
      const s = r.summary;
      // A summary the core did not shape as expected is shown as its refusal and nothing else.
      if (!r.signable && (s === null || typeof s !== 'object' || !Array.isArray(s.lines) || !Array.isArray(s.outputs))) {
        review.innerHTML = '<div class="card stack" data-role="act"></div>';
        paintRefusal(review.querySelector('[data-role="act"]'), r);
        return;
      }
      review.innerHTML = h`<div class="card stack">
        <span class="label">${t('What this proposal does, as checked against your policy')}</span>
        <div class="stack mono" data-role="lines">${raw(s.lines.map(() => '<div data-role="line"></div>').join(''))}</div>
        <span>${t('Fee: {fee} RAND · expires at height {height}', { fee: unitsOf(s.fee), height: String(s.expires_at) })}</span>
        <span class="caption" data-role="matched">${t('{matched} of {total} payments matched.', { matched: String(s.outputs.filter((o) => needsPayee(o) && isMatched(o)).length), total: String(s.outputs.filter(needsPayee).length) })}</span>
        <div data-role="act"></div></div>`;
      review.querySelectorAll('[data-role="line"]').forEach((n, i) => { n.textContent = s.lines[i]; });
      const act = review.querySelector('[data-role="act"]');
      if (!r.signable) {
        paintRefusal(act, r);
        return;
      }
      act.innerHTML = h`
        <span>${t('{blocks} blocks left to prove it.', { blocks: String(r.blocksLeft) })}</span>
        <div class="field"><label class="label" for="sign-confirm">${t('Type the last four characters of the account fingerprint')}</label><input id="sign-confirm" data-role="confirm" type="text" autocomplete="off" spellcheck="false" maxlength="9"></div>
        <div class="field"><label class="label" for="sign-password">${t('Password')}</label><input id="sign-password" data-role="password" type="password" autocomplete="current-password"></div>
        <p class="error" data-role="sign-error" role="alert" hidden></p>
        <button class="btn btn-primary block" type="button" data-role="sign" disabled>${t('Sign')}</button><div data-role="share-out"></div>`;
      const confirm = act.querySelector('[data-role="confirm"]');
      const sign = act.querySelector('[data-role="sign"]');
      confirm.addEventListener('input', () => { sign.disabled = !confirmsFingerprint(s.policy_fingerprint, confirm.value); });
      sign.addEventListener('click', async () => {
        const pw = act.querySelector('[data-role="password"]');
        const errEl = act.querySelector('[data-role="sign-error"]');
        showError(errEl, '');
        try {
          const { share, index } = await group.sign(id, proposal, payees, pw.value);
          if (!ctx.isCurrent()) return;
          paintShare(act.querySelector('[data-role="share-out"]'), share, index);
        } catch (err) { showError(errEl, err.message); } finally { pw.value = ''; }
      });
    }
    function paintShare(el, share, index) {
      const p = ctx.backend.platform;
      el.innerHTML = h`<div class="stack"><label class="label" for="share-text">${t('Your share — send it to whoever proves the proposal')}</label>
        <textarea id="share-text" data-role="share" class="mono" rows="3" readonly></textarea>
        <span class="cluster"><button class="btn sm" type="button" data-role="copy">${t('Copy')}</button>
        ${raw(typeof p.saveText === 'function' ? h`<button class="btn sm" type="button" data-role="save-share">${t('Save as file')}</button>` : '')}
        ${raw(typeof p.share === 'function' ? h`<button class="btn sm" type="button" data-role="share-sheet">${t('Share')}</button>` : '')}</span><p data-role="share-note" role="status" hidden></p></div>`;
      el.querySelector('[data-role="share"]').value = share;
      const note = el.querySelector('[data-role="share-note"]');
      const run = (fn, okText) => async () => {
        note.removeAttribute('hidden');
        try { const r = await fn(); note.textContent = okText ? okText(r) : ''; } catch (err) { note.textContent = (err && err.message) || String(err); }
      };
      el.querySelector('[data-role="copy"]').addEventListener('click', run(() => p.copy(share)));
      el.querySelector('[data-role="save-share"]')?.addEventListener('click', run(() => p.saveText({ name: `share-${index}.txt`, text: `${share}\n` }), (path) => (path ? t('Saved to {path}', { path: String(path) }) : t('Saved.'))));
      el.querySelector('[data-role="share-sheet"]')?.addEventListener('click', run(() => p.share({ title: t('Multisig share'), text: share })));
    }
    async function runCheck() {
      showError(errorEl, '');
      const text = body.querySelector('textarea[data-role="proposal"]').value;
      if (text !== proposal) { payees = []; rows = [{ addr: '', amount: '' }]; lastSummary = null; } // a new proposal: its payments are asked again
      proposal = text;
      try {
        const r = await group.check(id, proposal, payees);
        if (!ctx.isCurrent()) return;
        lastSummary = r.summary && typeof r.summary === 'object' ? r.summary : null;
        paintPayments();
        paintReview(r);
      } catch (err) { review.textContent = ''; showError(errorEl, err.message); if (ctx.isCurrent()) paintPayments(); }
    }
    body.querySelector('[data-role="check"]').addEventListener('click', runCheck);
    body.querySelector('[data-role="verify"]').addEventListener('click', async () => {
      const outEl = body.querySelector('[data-role="verify-out"]');
      try {
        const { index } = await group.verifyShare(id, proposal ?? '', body.querySelector('[data-role="share-in"]').value);
        inHand.add(index);
        outEl.textContent = t('Signer {index}\'s share verifies. {have} of {threshold} in hand: signers {list}.', { index: String(index), have: String(inHand.size), threshold: String(profile.threshold), list: [...inHand].sort((a, b) => a - b).join(', ') });
      } catch (err) { outEl.textContent = err.message; }
    });
    body.querySelector('[data-role="remove"]').addEventListener('click', async () => {
      const pw = body.querySelector('[data-role="remove-password"]');
      try { await group.remove(id, pw.value); ctx.go('#signers'); } catch (err) { showError(errorEl, err.message); } finally { pw.value = ''; }
    });
    return () => { proposal = null; };
  },
});
