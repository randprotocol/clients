// Receive: the address, its fingerprint, and a QR of its `randpay:` link (spec 2026-09-26 §3.3).
// The address is reusable across assets — there is one shielded address per wallet, not one per
// asset — so this screen takes no route argument.
//
// The *complete* address is on screen, not only a shortened one: a shielded address is long
// (upwards of a thousand characters), and someone about to share theirs has to be able to read
// back what they are sharing. It lives in a `.address-box` — a fixed-height, scrollable, wrapping
// mono block with a fade at its bottom edge — so a long address cannot push the QR, the Copy
// button or the tab bar off a 360 px popup. Nobody reads a thousand characters, though, so beside
// it is the **fingerprint**: sixteen characters computed from the address by the core, which a
// payer's wallet shows on its confirmation line. Reading those out is how two people check that
// the address that arrived is the one that was sent.
//
// The QR encodes the `randpay:` link, never the raw address (a bare address is the link with no
// parameters), at error-correction level M, so any scanner routes it to a wallet and it survives a
// scuffed screen. The optional amount / asset / memo form rebuilds the link and the QR; the link
// is formatted by the core, which parses it back before returning it, so this screen cannot hand
// out a link another wallet would refuse. Everything the user types reaches the page as text only.
import { h, raw, on } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';
import { shortAddress, parseUnits } from '../lib/format.js';
import { encodeBytes, drawQr } from '../lib/qr.js';
import { markInvalid, markValid } from '../lib/forms.js';
import { isUnlisted } from '../lib/assets.js';
import { memoSupportedFor } from '../lib/memo.js';

// The sentence iOS (`ReceiveView`) and Android (`receive_qr_too_long`) show in place of a QR when
// the link is longer than a level-M QR code holds (version 40: 2 331 bytes).
export const QR_TOO_LONG = 'This link is too long for a QR code; share or copy it instead.';

export const MEMO_MAX_BYTES = 510;
const REBUILD_DEBOUNCE_MS = 150;
const utf8Length = (text) => new TextEncoder().encode(String(text ?? '')).length;

function topbarMarkup() {
  return h`<div class="topbar"><button class="btn-icon icon-flip" type="button" data-go="home" aria-label="Back">${raw(icons.chevron())}</button><span class="topbar-title">Receive</span><span class="spacer"></span></div>`;
}

function assetOptions(assets) {
  // RAND, then every listed token. An unlisted one's decimals are this wallet's guess, and a link
  // asking for an amount of it would mean whatever the payer's wallet guesses instead.
  return assets.filter((a) => !isUnlisted(a)).map((a) => h`<option value="${a.index}">${a.symbol}</option>`).join('');
}

registerScreen('receive', {
  render() {
    return h`${raw(topbarMarkup())}<div class="skeleton block"></div>`;
  },
  async after(ctx, root) {
    let info;
    try {
      info = await ctx.backend.wallet.info();
    } catch (err) {
      if (!ctx.isCurrent()) return;
      root.innerHTML = h`<div class="banner negative"><span class="ic">${raw(icons.warning())}</span><span><span class="banner-title">Could not load your address</span>${err && err.message ? err.message : 'Something went wrong.'}</span></div>`;
      return;
    }
    if (!ctx.isCurrent()) return;

    const address = info.address || '';
    const formats = ctx.backend.address && typeof ctx.backend.address.formatLink === 'function' ? ctx.backend.address : null;
    const canShare = typeof ctx.backend.platform.share === 'function';
    const share = canShare
      ? raw(h`<button class="btn block" type="button" data-role="share-link">${raw(icons.arrowUpRight())}Share payment link</button>`)
      : '';
    root.innerHTML = h`
      <h1 class="sr-only">Receive</h1>
      ${raw(topbarMarkup())}
      <div class="card">
        <div class="stack">
          <div class="qr"><canvas data-role="qr" data-ec-level="M" aria-label="QR code of your payment link"></canvas></div>
          <p class="caption" data-role="qr-too-long" hidden>${QR_TOO_LONG}</p>
          <div class="cluster">
            <button class="chip action" type="button" data-role="copy-chip" aria-label="Copy address"><span class="mono">${shortAddress(address)}</span>${raw(icons.copy())}</button>
          </div>
          <div class="address-box">
            <span class="mono" data-role="full-address">${address}</span>
          </div>
          <div class="kv" data-role="fingerprint-row" hidden>
            <span class="k">Fingerprint</span>
            <span class="v mono fingerprint" data-role="fingerprint"></span>
          </div>
          <button class="btn block" type="button" data-role="copy-block" aria-label="Copy address">${raw(icons.copy())}Copy address</button>
          <p class="caption">This address is reusable — share it to receive any asset. It never expires. Whoever pays you sees the fingerprint above on their confirmation; if it does not match, it is not your address.</p>
        </div>
      </div>
      <h2 class="section-title">Payment link</h2>
      <div class="card">
        <form class="stack" data-role="link-form" novalidate>
          <div class="address-box"><span class="mono" data-role="link"></span></div>
          <button class="btn btn-primary block" type="button" data-role="copy-link">${raw(icons.copy())}Copy payment link</button>
          ${share}
          <p class="caption">Optional: ask for an amount, and add a note the payer’s wallet fills in for them.</p>
          <div class="field">
            <label class="label" for="link-amount">Amount</label>
            <div class="cluster">
              <input id="link-amount" name="link-amount" type="text" inputmode="decimal" autocomplete="off" placeholder="The payer decides" aria-describedby="link-amount-hint">
              <select name="link-asset" aria-label="Asset" data-role="link-asset"></select>
            </div>
            <span class="hint" id="link-amount-hint">Leave empty to let the payer choose.</span>
            <span class="error" id="link-amount-error"></span>
          </div>
          <div class="field" data-role="link-memo-field">
            <div class="field-top">
              <label class="label" for="link-memo">Memo</label>
              <span class="caption" data-role="link-memo-count">0/${MEMO_MAX_BYTES} bytes</span>
            </div>
            <textarea id="link-memo" name="link-memo" rows="2" autocomplete="off" aria-describedby="link-memo-hint"></textarea>
            <span class="hint" id="link-memo-hint">Encrypted with the payment: only you, the payer and anyone they show it to can read it.</span>
            <span class="error" id="link-memo-error"></span>
          </div>
        </form>
      </div>`;

    const canvas = root.querySelector('[data-role="qr"]');
    const linkEl = root.querySelector('[data-role="link"]');
    const amountInput = root.querySelector('input[name=link-amount]');
    const assetSelect = root.querySelector('select[name=link-asset]');
    const memoInput = root.querySelector('textarea[name=link-memo]');
    const memoField = root.querySelector('[data-role="link-memo-field"]');
    const memoCount = root.querySelector('[data-role="link-memo-count"]');

    // The link in force: the last one the core formatted. A field the user is still getting wrong
    // leaves it — and the QR — at the last good form rather than blank.
    let link = `randpay:${address}`;
    let assets = [];
    let debounce = null;
    let generation = 0;

    const qrWrap = root.querySelector('.qr');
    const qrTooLong = root.querySelector('[data-role="qr-too-long"]');

    // The QR shows the link in `link` or nothing: a link longer than any QR code holds (a long
    // memo) takes the QR off the screen and says so, rather than leaving the previous link's QR
    // beside the new link and its Copy (final review, finding 1). Encoding is decided before any
    // drawing, so the rule holds even where there is no canvas to draw on.
    function canvasContext() {
      if (!canvas || typeof canvas.getContext !== 'function') return null;
      try { return canvas.getContext('2d') || null; } catch { return null; }
    }

    function paint() {
      linkEl.textContent = link;
      let qr = null;
      try {
        qr = encodeBytes(new TextEncoder().encode(link), 1, 'M');
      } catch {
        qr = null;
      }
      if (!qr) {
        const g = canvasContext();
        if (g) g.clearRect(0, 0, canvas.width, canvas.height);
        qrWrap.setAttribute('hidden', '');
        qrTooLong.removeAttribute('hidden');
        return;
      }
      qrTooLong.setAttribute('hidden', '');
      qrWrap.removeAttribute('hidden');
      // linkedom's <canvas> has no 2D context — feature-detect and skip drawing rather than throw
      // (amendment 8); a real browser always has one, so this only ever skips under tests.
      if (canvasContext()) drawQr(canvas, qr, 4);
    }

    function fieldError(input, message) {
      const wrap = input.closest('.field');
      const errorEl = wrap.querySelector('.error');
      errorEl.textContent = message || '';
      if (message) markInvalid(wrap, input, errorEl.id);
      else markValid(wrap, input, `${input.id}-hint`);
    }

    function selectedAsset() {
      const index = Number(assetSelect.value || 0);
      return assets.find((a) => a.index === index) || { index: 0, symbol: 'RAND', decimals: 9 };
    }

    async function rebuild() {
      const mine = ++generation;
      const asset = selectedAsset();
      const amountText = amountInput.value.trim();
      const memo = memoField.hidden ? '' : memoInput.value;
      let ok = true;
      if (amountText) {
        try {
          if (parseUnits(amountText, asset.decimals) <= 0n) throw new Error('zero');
          fieldError(amountInput, null);
        } catch (err) {
          ok = false;
          fieldError(amountInput, /decimal places/.test(String(err && err.message))
            ? `${asset.symbol} has ${asset.decimals} decimal places — that is more.`
            : 'Enter an amount greater than zero, for example 1.25.');
        }
      } else {
        fieldError(amountInput, null);
      }
      const bytes = utf8Length(memo);
      memoCount.textContent = `${bytes}/${MEMO_MAX_BYTES} bytes`;
      if (bytes > MEMO_MAX_BYTES) {
        ok = false;
        fieldError(memoInput, `The memo is ${bytes} bytes; the limit is ${MEMO_MAX_BYTES}.`);
      } else {
        fieldError(memoInput, null);
      }
      if (!ok || !formats) return;
      // RAND is the default and is left out; a token is named by its checksummed id where the
      // registry gave one (unambiguous across chains), else by its index.
      const assetParam = asset.index === 0 ? '' : (asset.idText || String(asset.index));
      let next;
      try {
        next = await formats.formatLink({ address, amount: amountText, asset: assetParam, memo });
      } catch (err) {
        if (!ctx.isCurrent() || mine !== generation) return;
        fieldError(amountInput, (err && err.message) || 'That link could not be built.');
        return;
      }
      if (!ctx.isCurrent() || mine !== generation) return;
      link = next;
      paint();
    }

    function scheduleRebuild() {
      clearTimeout(debounce);
      memoCount.textContent = `${utf8Length(memoInput.value)}/${MEMO_MAX_BYTES} bytes`;
      debounce = setTimeout(() => { if (ctx.isCurrent()) rebuild(); }, REBUILD_DEBOUNCE_MS);
    }

    paint();

    async function copy(text, message) {
      await ctx.backend.platform.copy(text);
      if (!ctx.isCurrent()) return;
      ctx.toast(message, { kind: 'positive' });
    }
    const offChip = on(root, '[data-role="copy-chip"]', 'click', (evt) => { evt.preventDefault(); copy(address, 'Address copied'); });
    const offBlock = on(root, '[data-role="copy-block"]', 'click', (evt) => { evt.preventDefault(); copy(address, 'Address copied'); });
    const offLink = on(root, '[data-role="copy-link"]', 'click', (evt) => { evt.preventDefault(); copy(link, 'Payment link copied'); });
    const offShare = on(root, '[data-role="share-link"]', 'click', async (evt) => {
      evt.preventDefault();
      try { await ctx.backend.platform.share({ title: 'Pay me on Rand', text: link }); } catch { /* the user closed the share sheet */ }
    });
    const offInput = on(root, 'input[name=link-amount], textarea[name=link-memo]', 'input', () => scheduleRebuild());
    const offAsset = on(root, 'select[name=link-asset]', 'change', () => scheduleRebuild());
    const offSubmit = on(root, '[data-role="link-form"]', 'submit', (evt) => { evt.preventDefault(); rebuild(); });

    // The rest is filled in as it arrives, each part on its own: none of it is needed to show the
    // address and the plain link, which are already on screen.
    const fills = [];
    if (formats) {
      fills.push(formats.formatLink({ address }).then((uri) => {
        if (!ctx.isCurrent() || generation !== 0) return;
        link = uri;
        paint();
      }).catch(() => { /* the plain `randpay:<address>` already on screen is the same link */ }));
    }
    if (ctx.backend.address && typeof ctx.backend.address.fingerprint === 'function') {
      fills.push(ctx.backend.address.fingerprint(address).then((fp) => {
        if (!ctx.isCurrent()) return;
        root.querySelector('[data-role="fingerprint"]').textContent = fp;
        root.querySelector('[data-role="fingerprint-row"]').removeAttribute('hidden');
      }).catch(() => { /* no fingerprint is better than a wrong one */ }));
    }
    fills.push(Promise.resolve(ctx.backend.assets.list()).then((list) => {
      if (!ctx.isCurrent()) return;
      assets = Array.isArray(list) ? list : [];
      const options = assetOptions(assets);
      if (options) assetSelect.innerHTML = options;
      if (assets.filter((a) => !isUnlisted(a)).length <= 1) assetSelect.setAttribute('hidden', '');
    }).catch(() => { assetSelect.setAttribute('hidden', ''); }));
    // A chain that carries no memo gets no memo field: a payer's wallet would only have to tell
    // them it cannot be sent. Only the 1860-byte envelope carries one (`memoSupportedFor`, the
    // send screen's and the apps' gate); any other size, or none, is a chain without memos.
    if (typeof ctx.backend.send.limits === 'function') {
      fills.push(Promise.resolve(ctx.backend.send.limits()).then((limits) => {
        if (!ctx.isCurrent()) return;
        if (!limits || !memoSupportedFor(limits.envelopeBytes)) memoField.hidden = true;
      }).catch(() => { /* unknown: leave the field; the payer's wallet has the last word */ }));
    }
    await Promise.all(fills);

    return () => {
      clearTimeout(debounce);
      offChip(); offBlock(); offLink(); offShare(); offInput(); offAsset(); offSubmit();
    };
  },
});
