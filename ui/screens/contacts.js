// Contacts: `#contacts` (spec 2026-09-26 §3.3). A list of saved names, a way to add one — pasted,
// scanned, or typed; an address or a `randpay:` link — and a way to remove one.
//
// Two rules this screen keeps:
//   * **The fingerprint is shown before anything is saved.** A name is a promise that "alice" is
//     this address; the user checks the 16 digits against what alice reads off her own receive
//     screen, and only then is the contact written. A pasted address a user cannot read back is
//     exactly what a clipboard-swapping attack relies on.
//   * **Everything the user or a link supplied is text.** A name, an address and a fingerprint
//     reach the page through `textContent` only — never through markup — so a contact called
//     `<img onerror=…>` is a contact with a strange name, nothing more.
//
// The rules on names are the CLI's and live in the backend (ui/lib/contacts.js); this screen shows
// the backend's sentence when it refuses.
import { h, raw, on } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';
import { shortAddress } from '../lib/format.js';
import { canScanQr, scanQr } from '../lib/scan-qr.js';

function topbarMarkup() {
  return h`<div class="topbar"><button class="btn-icon icon-flip" type="button" data-go="settings" aria-label="Back">${raw(icons.chevron())}</button><span class="topbar-title">Contacts</span><span class="spacer"></span></div>`;
}

function formMarkup({ canPaste, canScan }) {
  const paste = canPaste ? raw(h`<button class="btn sm" type="button" data-role="contact-paste">Paste</button>`) : '';
  const scan = canScan ? raw(h`<button class="btn sm" type="button" data-role="contact-scan">Scan</button>`) : '';
  return h`
    <h2 class="section-title">Add a contact</h2>
    <div class="card stack">
      <form class="stack" data-role="contact-form" novalidate>
        <div class="field">
          <label class="label" for="contact-name">Name</label>
          <input id="contact-name" name="contact-name" type="text" autocomplete="off" spellcheck="false" maxlength="128">
        </div>
        <div class="field">
          <div class="field-top">
            <label class="label" for="contact-address">Address or payment link</label>
            <span class="cluster">${paste}${scan}</span>
          </div>
          <textarea id="contact-address" name="contact-address" rows="2" spellcheck="false" autocomplete="off" placeholder="rand1… or randpay:…"></textarea>
        </div>
        <div data-role="contact-video-slot"></div>
        <p class="error field-error" data-role="contact-error" role="alert" hidden></p>
        <button class="btn btn-primary block" type="submit">Check fingerprint</button>
      </form>
      <div data-role="contact-confirm"></div>
    </div>`;
}

registerScreen('contacts', {
  render() {
    return h`
      <h1 class="sr-only">Contacts</h1>
      ${raw(topbarMarkup())}
      <div class="stack" data-role="body"><div class="skeleton block"></div></div>`;
  },
  async after(ctx, root) {
    const book = ctx.backend.contacts;
    const body = root.querySelector('[data-role="body"]');
    if (!book || typeof book.list !== 'function') {
      body.innerHTML = h`<div class="card"><div class="empty"><span class="empty-title">Contacts are not available in this app.</span></div></div>`;
      return;
    }
    const platform = ctx.backend.platform;
    const canPaste = typeof platform.paste === 'function';
    const canScan = typeof platform.scanQr === 'function' || canScanQr();
    body.innerHTML = h`
      <div data-role="list"><div class="skeleton block"></div></div>
      ${raw(formMarkup({ canPaste, canScan }))}
      <p class="caption">Contacts are kept on this device only, beside your wallet. Removing the wallet removes them too.</p>`;

    const listEl = body.querySelector('[data-role="list"]');
    const form = body.querySelector('[data-role="contact-form"]');
    const nameInput = form.querySelector('input[name=contact-name]');
    const addressInput = form.querySelector('textarea[name=contact-address]');
    const errorEl = form.querySelector('[data-role="contact-error"]');
    const confirmEl = body.querySelector('[data-role="contact-confirm"]');
    // What the user is being asked to confirm: set by a check, consumed by Save, dropped by any
    // edit — so what is saved is always exactly what the fingerprint on screen described.
    let pending = null;
    let scanning = null;

    function showError(message) {
      errorEl.textContent = message || '';
      if (message) errorEl.removeAttribute('hidden'); else errorEl.setAttribute('hidden', '');
    }

    function dropPending() {
      pending = null;
      confirmEl.textContent = '';
    }

    async function paintList() {
      let list;
      try { list = await book.list(); } catch (err) {
        if (!ctx.isCurrent()) return;
        listEl.textContent = (err && err.message) || 'Could not read your contacts.';
        return;
      }
      if (!ctx.isCurrent()) return;
      if (list.length === 0) {
        listEl.innerHTML = h`<div class="card"><div class="empty"><span class="empty-title">No contacts yet</span><span>Save an address you pay often, and send to it by name.</span></div></div>`;
        return;
      }
      // The structure is markup; every value in it is written as text below.
      listEl.innerHTML = h`<div class="card flush"><ul class="list" role="list">${raw(list.map(() => h`
        <li>
          <div class="row">
            <span class="row-main">
              <span class="row-title"><span class="truncate" data-role="contact-name"></span></span>
              <span class="row-sub mono" data-role="contact-address"></span>
              <span class="row-sub mono" data-role="contact-fp"></span>
            </span>
            <span class="row-end"><button class="btn sm" type="button" data-remove="">Remove</button></span>
          </div>
        </li>`).join(''))}</ul></div>`;
      const items = listEl.querySelectorAll('li');
      list.forEach((c, i) => {
        const li = items[i];
        li.querySelector('[data-role="contact-name"]').textContent = c.name;
        li.querySelector('[data-role="contact-address"]').textContent = shortAddress(c.address);
        const remove = li.querySelector('[data-remove]');
        remove.setAttribute('data-remove', c.name);
        remove.setAttribute('aria-label', `Remove ${c.name}`);
      });
      // Fingerprints last, one core call each, so the names are on screen at once.
      const fps = await Promise.all(list.map((c) => (typeof ctx.backend.address?.fingerprint === 'function'
        ? ctx.backend.address.fingerprint(c.address).catch(() => '')
        : Promise.resolve(''))));
      if (!ctx.isCurrent()) return;
      const fpEls = listEl.querySelectorAll('[data-role="contact-fp"]');
      fps.forEach((fp, i) => { if (fpEls[i]) fpEls[i].textContent = fp ? `fingerprint ${fp}` : ''; });
    }

    /** The address a pasted or typed value names: itself, or a `randpay:` link's. */
    async function addressFrom(text) {
      if (/^randpay:/i.test(text)) {
        if (typeof ctx.backend.address?.parseLink !== 'function') throw new Error('Payment links cannot be read in this app.');
        const parsed = await ctx.backend.address.parseLink(text);
        return parsed.address;
      }
      return text;
    }

    const offCheck = on(root, '[data-role="contact-form"]', 'submit', async (evt) => {
      evt.preventDefault();
      dropPending();
      showError('');
      const name = nameInput.value.trim();
      const text = addressInput.value.trim();
      if (!name) { showError('Give the contact a name.'); return; }
      if (!text) { showError('Paste the address or payment link to save.'); return; }
      let address;
      let fingerprint;
      let taken = null;
      try {
        address = await addressFrom(text);
        fingerprint = typeof ctx.backend.address?.fingerprint === 'function'
          ? await ctx.backend.address.fingerprint(address)
          : null;
        taken = await book.nameOf(address);
      } catch (err) {
        if (!ctx.isCurrent()) return;
        showError((err && err.message) || 'That is not an address or a payment link.');
        return;
      }
      if (!ctx.isCurrent()) return;
      // The backend is where the rules live, but a name it is certain to refuse should not make
      // the user read a fingerprint first. The same sentence the backend would give.
      const lower = name.toLowerCase();
      if ([...name].length > 64 || lower.startsWith('rand1') || lower.startsWith('randpay:')) {
        showError('a contact name is 1-64 characters and cannot start with rand1 or randpay:');
        return;
      }
      if (taken) { showError(`this address is already saved as ${taken}`); return; }

      pending = { name, address };
      confirmEl.innerHTML = h`
        <div class="banner">
          <span class="ic">${raw(icons.shield())}</span>
          <span><span class="banner-title">Check before saving</span>Ask <span data-role="confirm-name"></span> to read out the fingerprint on their receive screen. It must match exactly.</span>
        </div>
        <div class="kv"><span class="k">Fingerprint</span><span class="v mono" data-role="contact-fingerprint"></span></div>
        <div class="address-box"><span class="mono" data-role="confirm-address"></span></div>
        <div class="cluster">
          <button class="btn btn-primary" type="button" data-role="save-contact">It matches — save</button>
          <button class="btn" type="button" data-role="cancel-contact">Cancel</button>
        </div>`;
      confirmEl.querySelector('[data-role="confirm-name"]').textContent = name;
      confirmEl.querySelector('[data-role="contact-fingerprint"]').textContent = fingerprint || 'unavailable in this app';
      confirmEl.querySelector('[data-role="confirm-address"]').textContent = address;
    });

    const offSave = on(root, '[data-role="save-contact"]', 'click', async (evt) => {
      evt.preventDefault();
      if (!pending) return;
      const { name, address } = pending;
      try {
        await book.add(name, address);
      } catch (err) {
        if (!ctx.isCurrent()) return;
        dropPending();
        showError((err && err.message) || 'The contact could not be saved.');
        return;
      }
      if (!ctx.isCurrent()) return;
      dropPending();
      nameInput.value = '';
      addressInput.value = '';
      ctx.toast('Contact saved', { kind: 'positive' });
      await paintList();
    });

    const offCancel = on(root, '[data-role="cancel-contact"]', 'click', (evt) => { evt.preventDefault(); dropPending(); });
    const offEdit = on(root, 'input[name=contact-name], textarea[name=contact-address]', 'input', () => dropPending());

    const offRemove = on(root, '[data-remove]', 'click', async (evt, btn) => {
      evt.preventDefault();
      const name = btn.getAttribute('data-remove');
      try { await book.remove(name); } catch (err) {
        if (ctx.isCurrent()) ctx.toast((err && err.message) || 'The contact could not be removed.', { kind: 'negative' });
        return;
      }
      if (!ctx.isCurrent()) return;
      await paintList();
    });

    const offPaste = on(root, '[data-role="contact-paste"]', 'click', async (evt) => {
      evt.preventDefault();
      let text = '';
      try { text = await platform.paste(); } catch { text = ''; }
      if (!ctx.isCurrent() || !text) return;
      addressInput.value = String(text).trim();
      dropPending();
    });

    const offScan = on(root, '[data-role="contact-scan"]', 'click', async (evt) => {
      evt.preventDefault();
      showError('');
      let text;
      try {
        if (typeof platform.scanQr === 'function') {
          text = await platform.scanQr();
        } else {
          const slot = body.querySelector('[data-role="contact-video-slot"]');
          slot.innerHTML = h`<video class="scan-video" data-role="scan-video" playsinline muted></video>`;
          scanning = typeof AbortController === 'function' ? new AbortController() : null;
          try {
            text = await scanQr(slot.querySelector('video'), { signal: scanning ? scanning.signal : undefined });
          } finally {
            scanning = null;
            slot.textContent = '';
          }
        }
      } catch (err) {
        if (!ctx.isCurrent() || (err && err.name === 'AbortError')) return;
        showError((err && err.message) || 'The code could not be read; paste the link instead.');
        return;
      }
      if (!ctx.isCurrent() || !text) return;
      addressInput.value = String(text).trim();
      dropPending();
    });

    await paintList();

    return () => {
      if (scanning) { try { scanning.abort(); } catch { /* already stopped */ } }
      offCheck(); offSave(); offCancel(); offEdit(); offRemove(); offPaste(); offScan();
    };
  },
});
