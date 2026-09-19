// Receive: address + QR. The address is reusable across assets — there is one shielded address
// per wallet, not one per asset — so this screen takes no route argument.
import { h, raw, on } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';
import { shortAddress } from '../lib/format.js';
import { encodeBytes, drawQr } from '../lib/qr.js';

registerScreen('receive', {
  render() {
    return h`
      <div class="topbar"><button class="btn-icon icon-flip" type="button" data-go="home" aria-label="Back">${raw(icons.chevron())}</button><span class="topbar-title">Receive</span><span class="spacer"></span></div>
      <div class="skeleton block"></div>`;
  },
  async after(ctx, root) {
    let alive = true;
    let info;
    try {
      info = await ctx.backend.wallet.info();
    } catch (err) {
      if (!alive) return () => { alive = false; };
      root.innerHTML = h`<div class="banner negative"><span class="ic">${raw(icons.warning())}</span><span><span class="banner-title">Could not load your address</span>${err && err.message ? err.message : 'Something went wrong.'}</span></div>`;
      return () => { alive = false; };
    }
    if (!alive) return () => { alive = false; };

    root.innerHTML = h`
      <h1 class="sr-only">Receive</h1>
      <div class="topbar"><button class="btn-icon icon-flip" type="button" data-go="home" aria-label="Back">${raw(icons.chevron())}</button><span class="topbar-title">Receive</span><span class="spacer"></span></div>
      <div class="card">
        <div class="stack">
          <div class="qr"><canvas data-role="qr" aria-label="QR code of your address"></canvas></div>
          <div class="cluster">
            <button class="chip" type="button" data-role="copy-chip" aria-label="Copy address"><span class="mono">${shortAddress(info.address)}</span>${raw(icons.copy())}</button>
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
        const qr = encodeBytes(new TextEncoder().encode(info.address));
        drawQr(canvas, qr, 6);
      } catch { /* address too long for a QR code at this size — leave the card blank rather than throw */ }
    }

    async function copyAddress() {
      await ctx.backend.platform.copy(info.address);
      ctx.toast('Address copied', { kind: 'positive' });
    }
    const offChip = on(root, '[data-role="copy-chip"]', 'click', (evt) => { evt.preventDefault(); copyAddress(); });
    const offBlock = on(root, '[data-role="copy-block"]', 'click', (evt) => { evt.preventDefault(); copyAddress(); });

    return () => { alive = false; offChip(); offBlock(); };
  },
});
