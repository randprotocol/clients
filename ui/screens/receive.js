// Receive: address + QR. The address is reusable across assets — there is one shielded address
// per wallet, not one per asset — so this screen takes no route argument.
//
// The *complete* address is on screen, not only a shortened one: a shielded address is long
// (upwards of a thousand characters), and someone about to share theirs has to be able to read
// back what they are sharing. It lives in a `.address-box` — a fixed-height, scrollable, wrapping
// mono block with a fade at its bottom edge — so a long address cannot push the QR, the Copy
// button or the tab bar off a 360 px popup.
import { h, raw, on } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';
import { shortAddress } from '../lib/format.js';
import { encodeBytes, drawQr } from '../lib/qr.js';

function topbarMarkup() {
  return h`<div class="topbar"><button class="btn-icon icon-flip" type="button" data-go="home" aria-label="Back">${raw(icons.chevron())}</button><span class="topbar-title">Receive</span><span class="spacer"></span></div>`;
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
    root.innerHTML = h`
      <h1 class="sr-only">Receive</h1>
      ${raw(topbarMarkup())}
      <div class="card">
        <div class="stack">
          <div class="qr"><canvas data-role="qr" aria-label="QR code of your address"></canvas></div>
          <div class="cluster">
            <button class="chip action" type="button" data-role="copy-chip" aria-label="Copy address"><span class="mono">${shortAddress(address)}</span>${raw(icons.copy())}</button>
          </div>
          <div class="address-box">
            <span class="mono" data-role="full-address">${address}</span>
          </div>
          <button class="btn block" type="button" data-role="copy-block" aria-label="Copy address">${raw(icons.copy())}Copy address</button>
          <p class="caption">This address is reusable — share it to receive any asset. It never expires.</p>
        </div>
      </div>`;

    // linkedom's <canvas> has no 2D context — feature-detect and skip drawing rather than throw
    // (amendment 8); a real browser always has getContext, so this only ever skips under tests.
    const canvas = root.querySelector('[data-role="qr"]');
    if (canvas && typeof canvas.getContext === 'function') {
      try {
        const qr = encodeBytes(new TextEncoder().encode(address));
        drawQr(canvas, qr, 6);
      } catch { /* address too long for a QR code at this size — leave the card blank rather than throw */ }
    }

    async function copyAddress() {
      await ctx.backend.platform.copy(address);
      if (!ctx.isCurrent()) return;
      ctx.toast('Address copied', { kind: 'positive' });
    }
    const offChip = on(root, '[data-role="copy-chip"]', 'click', (evt) => { evt.preventDefault(); copyAddress(); });
    const offBlock = on(root, '[data-role="copy-block"]', 'click', (evt) => { evt.preventDefault(); copyAddress(); });

    return () => { offChip(); offBlock(); };
  },
});
