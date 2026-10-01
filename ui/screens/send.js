// The send flow: `#send` and `#send/<index>`.
//
// One screen with internal steps — asset → details → review → proving — because the whole flow is
// one decision and Back should undo a *step*, not drop the user out of it. The steps are painted
// into one container; only `#sent` is a route of its own (./send/sent.js), because a submitted
// transfer is a thing the user may want to come back to.
//
// Three rules the flow exists to keep:
//
//   * **Chain 14 transfers any asset the registry lists — the fee is always RAND.** The picker
//     lists every asset the backend reports; the only ones not offered are assets the node's
//     registry does not list (`unlisted`), whose decimals are this wallet's guess, and those are
//     `aria-disabled` with the one shared explanation (owned by lib/assets.js). The fee is paid in
//     RAND out of the other half of the bundle, so it is denominated in RAND at the RAND row's own
//     decimals everywhere it is shown, a token's review has no Total (amount and fee are different
//     assets), and a wallet with no spendable RAND is refused — in the backend's own words —
//     before the review step is ever reached.
//
//   * **Leaving the screen must not cancel a proof.** A transfer proof takes ~100 s natively and a
//     desktop user will switch tabs, so the in-flight send lives on `ctx.state` — session-scoped,
//     exactly like the single in-flight scan on home — with a chip pinned in the nav that counts up
//     and leads back. Only a session ending (lock, wipe, unlock, new wallet, teardown) aborts it,
//     and only the user's own Cancel does, and only before the transaction has been submitted.
//
//   * **The transaction key never leaves a closure.** See ./send/state.js and ./send/sent.js.
//
// This file is the wiring; ./send/state.js is the behaviour, ./send/markup.js the markup.
import { expectedMs, progressAt, remainingText } from '../lib/progress.js';
import { h, raw, on } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';
import { wrongChainBannerMarkup, identityUnknownBannerMarkup, canRescan, confirmRescan } from '../lib/chain-banner.js';
import { parseUnits, formatUnits, elapsed, shortAddress } from '../lib/format.js';
import { markInvalid, markValid } from '../lib/forms.js';
import { explorerLink } from '../lib/explorer.js';
import { nativeAsset, isUnlisted, feeDecimals, feeSymbol } from '../lib/assets.js';
import {
  phaseLabel, provingBanner, CANCELLABLE, ADDRESS_DEBOUNCE_MS, SELF_SEND_QUESTION,
  explainProvingError, outcomeOf, safeHash, draftFor, currentSend, startSend, resumeSend, resumableFailure,
  unknownOutcome, plainUnits, checkAmount,
  MEMO_MAX_BYTES, NOT_A_RECIPIENT, utf8Length, recipientKind, confirmationLine, memoLine,
  memoSupportedFor,
} from './send/state.js';
import {
  shellMarkup, assetStepMarkup, unsendableMarkup, noRandMarkup, detailsStepMarkup,
  reviewStepMarkup, provingStepMarkup, failedStepMarkup, unknownOutcomeStepMarkup,
  noMemoNoticeMarkup, contactPickerMarkup, scanSheetMarkup, proverDeclinedMarkup, PROVER_CONSENT_DECLINED,
} from './send/markup.js';
import { canScanQr, scanQr, NO_CAMERA_TEXT } from '../lib/scan-qr.js';
import { displayMemo } from '../lib/memo.js';
import './send/sent.js'; // registers `#sent`

// Re-exported from here because this is where it was asked for, and where it reads: the send
// screen is what shows it.
export { explainProvingError };

// ======================================================================== the send screen ======
registerScreen('send', {
  tab: 'home',
  render: () => shellMarkup(),
  async after(ctx, root, arg) {
    const mySession = ctx.session.id;
    const live = () => ctx.isCurrent() && ctx.session.id === mySession;

    let assets;
    let ownAddress = '';
    let settings = {};
    let cached = {};
    let canProve = { ok: false, reason: 'Proving is not available here.' };
    // Whether this chain carries a memo: only when its limits report the one envelope size that
    // has a memo field, 1860 bytes (spec 2026-09-26 §2.4; fullnode's `EnvelopeFormat::for_chain`).
    // Any other size, a chain that reports none, a node that cannot say, and a backend without
    // `send.limits` all get no memo field — sealing a memo the chain cannot carry is refused by
    // the core anyway, after the user has written it.
    let memoSupported = false;
    // A remote proof left pending (a popup closed mid-proof — ui/backend.js `send.pending?`): OPTIONAL
    // in the contract, and a failure to read it is the same as there being none.
    let pendingJob = null;
    try {
      const [list, info, prove, cfg, sync, limits, pending] = await Promise.all([
        ctx.backend.assets.list(), ctx.backend.wallet.info(), ctx.backend.send.canProve(),
        ctx.backend.settings.get(), ctx.backend.sync.cached(),
        typeof ctx.backend.send.limits === 'function'
          ? Promise.resolve(ctx.backend.send.limits()).catch(() => null)
          : null,
        typeof ctx.backend.send.pending === 'function'
          ? Promise.resolve(ctx.backend.send.pending()).catch(() => null)
          : null,
      ]);
      pendingJob = pending && typeof pending === 'object' ? pending : null;
      assets = list;
      ownAddress = (info && info.address) || '';
      if (prove) canProve = prove;
      if (cfg) settings = cfg;
      if (sync) cached = sync;
      memoSupported = !!limits && memoSupportedFor(limits.envelopeBytes);
    } catch (err) {
      if (!live()) return;
      root.querySelector('[data-role="step"]').innerHTML = h`
        <div class="banner negative"><span class="ic">${raw(icons.warning())}</span><span><span class="banner-title">Could not start a send</span>${(err && err.message) || 'Something went wrong.'}</span></div>`;
      return;
    }
    if (!live()) return;

    // These notes were read from a different chain than the node is on, so there is no honest
    // transfer to build: the backend refuses (definitely) and this says why before the user has
    // typed an address. The same banner as home and activity — one implementation, three screens.
    if (cached.wrongChain || cached.identityUnknown) {
      root.querySelector('[data-role="step"]').innerHTML = cached.wrongChain
        ? wrongChainBannerMarkup(cached.wrongChain, { canRescan: canRescan(ctx) })
        : identityUnknownBannerMarkup();
      const offChainRescan = on(root, '[data-action="rescan-chain"]', 'click', async (evt) => {
        evt.preventDefault();
        const fresh = await confirmRescan(ctx, { forChain: true });
        if (!fresh || !live()) return;
        if (!fresh.wrongChain) ctx.go('#send');
      });
      return () => { offChainRescan(); };
    }

    const stepEl = root.querySelector('[data-role="step"]');
    const indicatorEl = root.querySelector('[data-role="step-indicator"]');
    const backBtn = root.querySelector('[data-role="back"]');

    // An explicit `#send/<index>` names the asset and so skips the picker; so does a wallet with
    // only one asset to choose between. Otherwise the picker is a step of its own.
    const explicit = arg !== undefined && arg !== '' && /^\d+$/.test(String(arg));
    // `#send?uri=<encoded randpay: link>` (task 14): a deep link names a recipient instead of an
    // asset — a Tauri `randpay:` open, the web wallet's registered protocol handler, a receive
    // screen's own share link. It is decoded here and nowhere else parses it: the string is handed
    // to the recipient field exactly as a pasted or scanned link is (below), so it is resolved by
    // the same `takeRecipient` → `core.call('uri_parse')` path every recipient goes through.
    const linkMatch = typeof arg === 'string' ? /^uri=(.*)$/.exec(arg) : null;
    let linkArg = null;
    if (linkMatch) {
      try { linkArg = decodeURIComponent(linkMatch[1]); } catch { linkArg = linkMatch[1]; }
    }
    const rand = nativeAsset(assets);
    const requested = explicit ? Number(arg) : (assets.length === 1 ? assets[0].index : null);
    const steps = requested === null ? ['asset', 'details', 'review'] : ['details', 'review'];

    function endOfTheRoad(markup) {
      indicatorEl.textContent = '';
      stepEl.innerHTML = markup;
    }

    // An asset the node's registry does not list cannot be sent at all: its decimals are this
    // wallet's guess, and nothing typed against them means what the user meant. This is the end
    // of the road, not a step.
    const requestedAsset = requested === null ? null : assets.find((a) => a.index === requested) || null;
    if (requestedAsset && isUnlisted(requestedAsset)) {
      endOfTheRoad(unsendableMarkup(requestedAsset, { hasRand: !!rand }));
      return;
    }
    // …and neither is a wallet that simply has no RAND: whatever asset moves, the fee is paid in
    // RAND, so with no RAND at all there is no transfer to build. An asset is never invented to
    // have something to render a form against: a fabricated zero balance lets someone fill in an
    // amount and only discover at the last step that there was nothing to send.
    if (!rand) {
      endOfTheRoad(noRandMarkup());
      return;
    }
    // A `#send/<index>` naming an asset this wallet does not hold.
    if (requested !== null && requested !== 0 && !requestedAsset) {
      endOfTheRoad(unsendableMarkup(null, { hasRand: true }));
      return;
    }

    // The asset this flow is moving: the explicit route's, the one a half-finished draft was
    // typed against, or RAND until the picker says otherwise.
    const leftDraft = ctx.state.sendDraft;
    let asset = requestedAsset
      || (leftDraft && assets.find((a) => a.index === leftDraft.assetIndex && !isUnlisted(a)))
      || rand;
    let draft = draftFor(ctx, asset.index);

    // A fresh link always wins over whatever the recipient field already held — a `#send?uri=`
    // navigation is the user acting on this link now, exactly as a paste replaces a half-typed
    // field. `draft.link` is dropped with it; `takeRecipient` (below, once the field is on the
    // page) is what re-parses it.
    if (linkArg !== null && draft.to !== linkArg) {
      draft.to = linkArg;
      draft.link = null;
      draft.selfConfirmed = false;
    }

    const platform = ctx.backend.platform;
    const formats = ctx.backend.address && typeof ctx.backend.address.parseLink === 'function' ? ctx.backend.address : null;
    const book = ctx.backend.contacts && typeof ctx.backend.contacts.list === 'function' ? ctx.backend.contacts : null;
    const canScan = typeof platform.scanQr === 'function' || canScanQr();
    let scanning = null; // the browser camera's AbortController while its sheet is open

    // Coming back to a flow already under way resumes it rather than asking which asset again.
    let step = requested === null && !draft.to && !draft.amount ? 'asset' : 'details';
    let reviewUnits = 0n;
    try { reviewUnits = draft.amount ? parseUnits(draft.amount, asset.decimals) : 0n; } catch { reviewUnits = 0n; }
    let debounceTimer = null;
    let screenTicker = null;
    let attached = null;          // the store this render is listening to
    // The unknown-outcome confirmation, held here rather than read back off the checkbox: the DOM
    // is what the user sees, not what the wallet decides on. Cleared by every re-render of a step.
    let unknownConfirmed = false;

    function focusStepTitle() {
      const title = stepEl.querySelector('[data-role="step-title"]');
      if (title && typeof title.focus === 'function') title.focus();
    }

    function paintIndicator() {
      const i = steps.indexOf(step);
      indicatorEl.textContent = i === -1 ? '' : `Step ${i + 1} of ${steps.length}`;
    }

    function stopScreenTicker() {
      if (screenTicker !== null) { clearInterval(screenTicker); screenTicker = null; }
    }

    /** Shows `message` under `input`'s field, or clears it. The `field-error` class is added only
     *  while a message is actually showing, so the errors on the page are exactly the ones that
     *  apply. */
    function setFieldError(input, message) {
      const wrap = input.closest('.field');
      const errorEl = wrap.querySelector('.error');
      if (message) {
        errorEl.textContent = message;
        errorEl.classList.add('field-error');
        markInvalid(wrap, input, errorEl.id);
      } else {
        errorEl.textContent = '';
        errorEl.classList.remove('field-error');
        markValid(wrap, input, `${input.id}-hint`);
      }
    }

    function showFormBanner(message) {
      const slot = stepEl.querySelector('[data-role="form-banner"]');
      if (!slot) return;
      slot.innerHTML = message
        ? h`<div class="banner warn"><span class="ic">${raw(icons.warning())}</span><span>${message}</span></div>`
        : '';
    }

    // ---- the recipient, the link and the memo (spec 2026-09-26 §3) ----
    const field = (name) => stepEl.querySelector(`[name="${name}"]`);

    /** Everything on the details step that is user text or depends on the draft: written as
     *  properties and text nodes after the markup, never into it. */
    function paintDetailsExtras() {
      const memoEl = field('memo');
      if (memoEl) memoEl.value = draft.memo || '';
      paintMemoCount();
      paintLinkHint();
      paintMemoNotice();
    }

    function paintMemoCount() {
      const counter = stepEl.querySelector('[data-role="memo-count"]');
      if (counter) counter.textContent = `${utf8Length(draft.memo)}/${MEMO_MAX_BYTES} bytes`;
    }

    function paintLinkHint() {
      const hint = stepEl.querySelector('[data-role="to-link"]');
      if (!hint) return;
      hint.textContent = draft.link ? `Payment link · fingerprint ${draft.link.fingerprint}` : '';
    }

    /** A memo this chain cannot carry (a link brought one): the notice, and the way to drop it. */
    function paintMemoNotice() {
      const slot = stepEl.querySelector('[data-role="memo-notice"]');
      if (!slot) return;
      slot.innerHTML = !memoSupported && draft.memo ? noMemoNoticeMarkup() : '';
    }

    /** The asset a link names, in the forms the core's `PaymentUri::parse` accepts: absent is
     *  RAND (the link's own default), digits are a registry index by value (`0`, `00` are RAND,
     *  as the CLI reads them), 64 hex digits an asset id, an `rpl1…` a token id (both
     *  case-insensitive). `null` if this wallet holds no such asset — or holds it unlisted, whose
     *  decimals are this wallet's guess and so cannot be sent (iOS and Android: RAND only, and
     *  the same reading of `0`/`00`). */
    function linkAsset(param) {
      const text = param === null || param === undefined ? '' : String(param).trim();
      let found = null;
      if (text === '') found = assets.find((a) => a.index === 0);
      else if (/^\d+$/.test(text)) found = assets.find((a) => a.index === Number(text));
      else if (/^[0-9a-f]{64}$/i.test(text)) found = assets.find((a) => typeof a.id === 'string' && a.id.toLowerCase() === text.toLowerCase());
      else found = assets.find((a) => typeof a.idText === 'string' && a.idText.toLowerCase() === text.toLowerCase());
      return found && !isUnlisted(found) ? found : null;
    }

    /** The held asset a link asks for when it is not the one this draft is moving, or `null`. */
    function otherAssetFor(link) {
      if (!link || link.asset === null || link.asset === undefined) return null;
      const wanted = linkAsset(link.asset);
      return wanted && wanted.index !== asset.index ? wanted : null;
    }

    /**
     * A link naming another asset this wallet holds (final review, finding 5): the flow moves to
     * that asset's draft, carrying the link — recipient, amount and memo — rather than stopping at
     * "you are sending RAND" (and a switch by hand starting a fresh draft that had lost the link).
     * Nothing is sent: the details step is shown again, for the user to review the new asset.
     */
    function switchToLinkAsset(wanted, text, link) {
      asset = wanted;
      draft = draftFor(ctx, wanted.index);
      Object.assign(draft, {
        to: text, link, linkText: text, amount: '', memo: '', recipient: null,
        selfConfirmed: false, estimate: null, knownFee: null,
      });
      reviewUnits = 0n;
      goStep('details', { focus: false });
      // Written as a property as well as rendered: the link is user text with `&`s in it.
      const toEl = field('to');
      if (toEl) toEl.value = text;
      paintLinkHint();
      applyLink();
    }

    /**
     * Where the form and the link disagree — the CLI's merge rule: a value given both ways and
     * differing is refused, never guessed. `{to?, amount?, memo?}`, each the sentence for that
     * field, or `{}`. Only fields the link actually carries are compared.
     */
    function linkConflicts() {
      const link = draft.link;
      const out = {};
      if (!link) return out;
      if (link.asset !== null || link.amount !== null) {
        const wanted = linkAsset(link.asset);
        if (!wanted) out.to = `The link asks for an asset this wallet does not hold (${link.asset}).`;
        else if (wanted.index !== asset.index) out.to = `The link asks for ${wanted.symbol}; you are sending ${asset.symbol}.`;
      }
      const typed = String((field('amount') && field('amount').value) || '').trim();
      if (!out.to && link.amount !== null && typed) {
        let same = false;
        try { same = parseUnits(typed, asset.decimals) === parseUnits(link.amount, asset.decimals); } catch { same = false; }
        if (!same) out.amount = `The link asks for ${link.amount} ${asset.symbol}; you typed ${typed} ${asset.symbol}.`;
      }
      if (link.memo !== null && link.memo !== '' && draft.memo && draft.memo !== link.memo) {
        out.memo = `The link’s memo is "${displayMemo(link.memo)}"; you typed "${displayMemo(draft.memo)}".`;
      }
      return out;
    }

    /** Puts each conflict on its own field. Returns true if there were any. */
    function showLinkConflicts() {
      const c = linkConflicts();
      if (c.to && field('to')) setFieldError(field('to'), c.to);
      if (c.amount && field('amount')) setFieldError(field('amount'), c.amount);
      if (c.memo) {
        if (field('memo')) setFieldError(field('memo'), c.memo);
        else showFormBanner(c.memo);
      }
      return !!(c.to || c.amount || c.memo);
    }

    /** A link fills what the form leaves empty — never what the user typed — then any
     *  disagreement is shown on its field. */
    function applyLink() {
      const link = draft.link;
      if (!link) return;
      const amountEl = field('amount');
      if (amountEl && !amountEl.value.trim() && link.amount !== null && !linkConflicts().to) {
        amountEl.value = link.amount;
        draft.amount = link.amount;
      }
      if (link.memo && !draft.memo) {
        draft.memo = link.memo;
        const memoEl = field('memo');
        if (memoEl) memoEl.value = link.memo;
      }
      paintMemoCount();
      paintMemoNotice();
      showLinkConflicts();
    }

    /** The recipient field's text, read as it is typed, pasted or scanned: a link is parsed and
     *  applied at once; an address is checked quietly; a name waits for Review. */
    async function takeRecipient(input) {
      const text = input.value.trim();
      draft.link = null;
      paintLinkHint();
      const kind = recipientKind(text);
      if (kind === 'link') {
        const parsed = await parseLinkOrExplain(input, text);
        if (!parsed || !live() || input.value.trim() !== text) return;
        const other = otherAssetFor(parsed);
        if (other) { switchToLinkAsset(other, text, parsed); return; }
        draft.link = parsed;
        draft.linkText = text;
        setFieldError(input, null);
        paintLinkHint();
        applyLink();
      } else if (kind === 'address') {
        validateAddress(input, { silent: true });
      } else {
        setFieldError(input, null);
      }
    }

    async function parseLinkOrExplain(input, text) {
      if (!formats) {
        setFieldError(input, 'Payment links cannot be read in this app; paste the address instead.');
        return null;
      }
      try {
        return await formats.parseLink(text);
      } catch (err) {
        if (live()) setFieldError(input, (err && err.message) || 'That payment link could not be read.');
        return null;
      }
    }

    async function fingerprintOf(address) {
      if (!ctx.backend.address || typeof ctx.backend.address.fingerprint !== 'function') return null;
      try { return await ctx.backend.address.fingerprint(address); } catch { return null; }
    }

    async function contactNameOf(address) {
      if (!book || typeof book.nameOf !== 'function') return null;
      try { return await book.nameOf(address); } catch { return null; }
    }

    /**
     * The recipient field resolved, in the CLI's order: a `rand1…` address, a `randpay:` link, a
     * contact name. `{address, name, fingerprint, link}` or `null` with the reason on the field.
     */
    async function resolveRecipient(input) {
      const text = input.value.trim();
      if (!text) { setFieldError(input, 'Enter the address you are sending to.'); return null; }
      const kind = recipientKind(text);
      let address;
      let name = null;
      let link = null;
      if (kind === 'address') {
        address = await validateAddress(input);
        if (!address) return null;
        name = await contactNameOf(address);
      } else if (kind === 'link') {
        // The link already read for this exact text, if there is one: it may carry the user's own
        // decision since (a memo this chain cannot carry, dropped with Clear).
        link = draft.link && draft.linkText === text ? draft.link : await parseLinkOrExplain(input, text);
        if (!link) return null;
        address = link.address;
        name = await contactNameOf(address);
      } else {
        // A name is looked up exactly as typed, never trimmed: contact names are saved exactly
        // as entered (CLI, iOS, Android and this UI alike — final review 2).
        const typed = input.value;
        address = book && typeof book.addressOf === 'function'
          ? await Promise.resolve(book.addressOf(typed)).catch(() => null)
          : null;
        if (!live()) return null;
        if (!address) { setFieldError(input, NOT_A_RECIPIENT); return null; }
        name = typed;
      }
      if (!live()) return null;
      const fingerprint = (link && link.fingerprint) || await fingerprintOf(address);
      if (!live()) return null;
      setFieldError(input, null);
      return { address, name, fingerprint, link };
    }

    // ---- steps ----
    function goStep(next, { focus = true } = {}) {
      stopScreenTicker();
      // Review is only ever reachable with an estimate behind it; anything else (a cancel that
      // landed after the draft was spent, say) falls back to the form rather than inventing a fee.
      if (next === 'review' && (!draft.estimate || reviewUnits <= 0n || !draft.recipient)) next = 'details';
      step = next;
      const unknown = unknownOutcome(ctx);
      // The review is the only step that can start a send, so it is the only one that carries the
      // gate — but every step carries the warning, including the very first.
      unknownConfirmed = false;
      if (next === 'asset') stepEl.innerHTML = assetStepMarkup(assets, unknown);
      else if (next === 'details') {
        stepEl.innerHTML = detailsStepMarkup(asset, draft, {
          canPaste: typeof platform.paste === 'function',
          canScan,
          canPickContact: !!book,
          memoSupported,
          unknown,
        });
        paintDetailsExtras();
      } else if (next === 'review') {
        stepEl.innerHTML = reviewStepMarkup({ asset, to: draft.recipient.address, units: reviewUnits, estimate: draft.estimate, canProve, unknown, assets });
        // The confirmation every surface shows before a send, written as text: the contact's
        // name, the memo and the link's fields are all somebody else's words. The recipient line
        // carries no memo; the memo is its own line below it, control and bidi characters shown
        // as U+FFFD, so nothing in it can pass for a second recipient line.
        stepEl.querySelector('[data-role="confirm-line"]').textContent = confirmationLine({
          name: draft.recipient.name,
          fingerprint: draft.recipient.fingerprint,
          amount: plainUnits(reviewUnits, asset.decimals),
          symbol: asset.symbol,
        });
        stepEl.querySelector('[data-role="confirm-memo"]').textContent = memoLine(memoSupported ? draft.memo : '');
      } else if (next === 'proving') paintProving();
      else if (next === 'failed') {
        const err = attached && attached.error;
        stepEl.innerHTML = failedStepMarkup(explainProvingError(err), { resumable: resumableFailure(err) });
      }
      else if (next === 'unknown') paintUnknown();
      paintIndicator();
      if (focus) focusStepTitle();
    }

    /** The screen a transfer whose fate we could not establish ends on. No prove, no retry, no
     *  edit: the only way on is to go and look at Activity. */
    function paintUnknown() {
      const err = (attached && attached.error) || null;
      const hash = safeHash(err && err.hash);
      stepEl.innerHTML = unknownOutcomeStepMarkup({
        message: (err && err.message) || '',
        hash,
        explorer: hash ? explorerLink(settings.explorerUrl, hash) : null,
      });
    }

    function paintProving() {
      const store = attached;
      if (!store) return;
      stepEl.innerHTML = provingStepMarkup(store);
      const elapsedEl = stepEl.querySelector('[data-role="elapsed"]');
      stopScreenTicker();
      // This render's own clock, cleared on cleanup, on completion and the moment this render
      // stops being the one on screen. The pinned chip has its own (see startSend).
      const ring = stepEl.querySelector('[data-role="ring"]');
      const pctEl = stepEl.querySelector('[data-role="pct"]');
      const leftEl = stepEl.querySelector('[data-role="left"]');
      const expected = expectedMs(store.kind || 'transfer');
      screenTicker = setInterval(() => {
        if (!live() || store.done) { stopScreenTicker(); return; }
        const spent = Date.now() - store.startedMs;
        const pct = progressAt(spent, expected);
        if (elapsedEl) elapsedEl.textContent = elapsed(spent);
        // An estimate, so assistive tech hears the time left, not a percentage it would trust.
        if (ring) { ring.style.setProperty('--pct', pct.toFixed(3)); ring.setAttribute('aria-valuetext', remainingText(spent, expected)); }
        if (pctEl) pctEl.textContent = `${Math.round(pct * 100)}%`;
        if (leftEl) leftEl.textContent = remainingText(spent, expected);
      }, 1000);
    }

    function paintPhase(store) {
      const label = phaseLabel(store.phase, store.detail);
      const phaseEl = stepEl.querySelector('[data-role="phase"]');
      const ring = stepEl.querySelector('[data-role="ring"]');
      if (phaseEl) phaseEl.textContent = label;
      if (ring) ring.setAttribute('aria-label', label);
      // Where the proof is being made can change under a phase (the prover names itself with its
      // first report), so the banner follows the store too. Text only.
      const banner = provingBanner(store);
      const bannerTitle = stepEl.querySelector('[data-role="proving-banner-title"]');
      const bannerText = stepEl.querySelector('[data-role="proving-banner"]');
      if (bannerTitle) bannerTitle.textContent = banner.title;
      if (bannerText) bannerText.textContent = banner.text;
      const actions = stepEl.querySelector('[data-role="prove-actions"]');
      if (actions) {
        const wanted = !!store.controller && CANCELLABLE.includes(store.phase) && !store.cancelling;
        const has = !!actions.querySelector('[data-role="cancel"]');
        if (wanted !== has) {
          actions.innerHTML = wanted ? h`<button class="btn block" type="button" data-role="cancel">Cancel</button>` : '';
        }
      }
    }

    // ---- attaching to an in-flight (or just-finished) send ----
    function onStoreChange(store) {
      if (!live()) return;
      if (!store.done) { if (step === 'proving') paintPhase(store); return; }
      stopScreenTicker();
      if (store.error) {
        const outcome = outcomeOf(store);
        if (outcome === 'cancelled') {
          // Cancelled, by the user or by the session ending: back to review, nothing lost. The
          // attempt is over, so it stops being "the one transfer in flight" — otherwise Prove
          // would find it and refuse to start the next one.
          if (ctx.state.send === store) ctx.state.send = null;
          if (attached === store) { store.listeners.delete(onStoreChange); attached = null; }
          if (ctx.session.id === mySession) goStep('review');
          return;
        }
        // The key distinction, and the reason this screen exists twice over: a failure before the
        // transaction was broadcast means nothing happened, and a failure after it may mean it
        // landed. Only the first of those is allowed to offer "try again".
        goStep(outcome === 'unknown' ? 'unknown' : 'failed');
        return;
      }
      // The hash and the transaction key were dealt with at settle time, in the store itself
      // (./send/state.js) — this only has to take the user there.
      if (!store.hash) {
        // The backend answered with something that is not a transaction hash. Nothing goes in a
        // URL on that basis; Activity is where the truth is.
        ctx.state.send = null;
        ctx.state.sendDraft = null;
        ctx.toast('The transfer was submitted, but the node did not return a usable hash.', { kind: 'negative' });
        ctx.go('#activity');
        return;
      }
      ctx.state.send = null;
      ctx.state.sendDraft = null; // this draft has been spent
      ctx.go(`#sent/${store.hash}`);
    }

    function attach(store) {
      attached = store;
      store.listeners.add(onStoreChange);
      if (store.done) { onStoreChange(store); return; }
      goStep('proving');
    }

    // A send already running (or finished while the user was elsewhere) always wins: whatever
    // route asked for this screen, there is one transfer at a time and this is it.
    let running = currentSend(ctx);
    // A remote transfer proof left pending is carried on — the same job, through the same store a
    // fresh send uses, so Cancel and the receipt work exactly as they do for one. A pending
    // WITHDRAWAL is the withdraw screen's to resume; the engine refuses a new transfer meanwhile
    // (with its own sentence), and this says so up front.
    if (!running && pendingJob && pendingJob.kind !== 'burn' && typeof ctx.backend.send.resume === 'function') {
      running = resumeSend(ctx, pendingJob);
    } else if (!running && pendingJob && pendingJob.kind === 'burn') {
      stepEl.insertAdjacentHTML('beforebegin', h`
        <div class="banner warn" data-role="pending-elsewhere">
          <span class="ic">${raw(icons.warning())}</span>
          <span><span class="banner-title">A withdrawal is still being proved</span>Its proof is pending on ${String(pendingJob.name || 'your prover')}. Open Withdraw to let it finish or cancel it; a new transfer waits until then.</span>
        </div>`);
    }
    if (running) {
      attach(running);
    } else {
      goStep(step, { focus: false });
      // The field already shows the link's raw text (draft.to, painted above); this is the async
      // half — the same one a paste or a scan triggers — that resolves it, fills the hint, and
      // auto-fills the amount/memo the link itself carries.
      if (linkArg !== null && step === 'details') {
        const linkInput = stepEl.querySelector('textarea[name=to]');
        if (linkInput) {
          linkInput.value = draft.to; // a property write, like a paste: the link has `&`s in it
          takeRecipient(linkInput);
        }
      }
    }

    // ---- handlers ----
    const offAsset = on(root, '[data-asset]', 'click', (evt, btn) => {
      evt.preventDefault();
      if (btn.getAttribute('aria-disabled') === 'true') return; // listed, explained, not offered
      const picked = assets.find((a) => a.index === Number(btn.dataset.asset));
      if (!picked || isUnlisted(picked)) return;
      if (picked !== asset) {
        asset = picked;
        draft = draftFor(ctx, asset.index);
        try { reviewUnits = draft.amount ? parseUnits(draft.amount, asset.decimals) : 0n; } catch { reviewUnits = 0n; }
      }
      goStep('details');
    });

    const offPaste = on(root, '[data-role="paste"]', 'click', async (evt) => {
      evt.preventDefault();
      const input = stepEl.querySelector('textarea[name=to]');
      if (!input || typeof ctx.backend.platform.paste !== 'function') return;
      let text = '';
      try { text = await ctx.backend.platform.paste(); } catch { text = ''; }
      if (!live() || !text) return;
      input.value = String(text).trim();
      draft.to = input.value;
      draft.selfConfirmed = false;
      await takeRecipient(input);
    });

    /** The browser camera, in a sheet with a Cancel; resolves to the code's text. */
    async function browserScan() {
      const dialog = ctx.sheet(scanSheetMarkup());
      scanning = typeof AbortController === 'function' ? new AbortController() : null;
      const mine = scanning;
      on(dialog, '[data-role="cancel-scan"]', 'click', () => { if (mine) mine.abort(); ctx.closeSheet(); });
      try {
        return await scanQr(dialog.querySelector('video'), { signal: mine ? mine.signal : undefined });
      } finally {
        if (scanning === mine) scanning = null;
        ctx.closeSheet();
      }
    }

    const offScan = on(root, '[data-role="scan"]', 'click', async (evt) => {
      evt.preventDefault();
      showFormBanner('');
      let text = '';
      try {
        text = typeof platform.scanQr === 'function' ? await platform.scanQr() : await browserScan();
      } catch (err) {
        if (!live() || (err && err.name === 'AbortError')) return;
        showFormBanner((err && err.message) || NO_CAMERA_TEXT);
        return;
      }
      const input = stepEl.querySelector('textarea[name=to]');
      if (!live() || !text || !input) return;
      input.value = String(text).trim();
      draft.to = input.value;
      draft.selfConfirmed = false;
      await takeRecipient(input);
    });

    const offPick = on(root, '[data-role="pick-contact"]', 'click', async (evt) => {
      evt.preventDefault();
      if (!book) return;
      let list = [];
      try { list = await book.list(); } catch { list = []; }
      if (!live()) return;
      const dialog = ctx.sheet(contactPickerMarkup(list.length));
      // Names and addresses go in as text; the attribute carries the name back to this handler.
      const rows = dialog.querySelectorAll('[data-pick-contact]');
      list.forEach((c, i) => {
        rows[i].setAttribute('data-pick-contact', c.name);
        rows[i].querySelector('[data-role="pick-name"]').textContent = c.name;
        rows[i].querySelector('[data-role="pick-address"]').textContent = shortAddress(c.address);
      });
      on(dialog, '[data-pick-contact]', 'click', (e, btn) => {
        e.preventDefault();
        const name = btn.getAttribute('data-pick-contact');
        ctx.closeSheet();
        const input = stepEl.querySelector('textarea[name=to]');
        if (!input || !live()) return;
        input.value = name;
        draft.to = name;
        draft.link = null;
        draft.selfConfirmed = false;
        paintLinkHint();
        setFieldError(input, null);
      });
      on(dialog, '[data-role="close-picker"]', 'click', () => ctx.closeSheet());
      on(dialog, '[data-role="manage-contacts"]', 'click', () => { ctx.closeSheet(); ctx.go('#contacts'); });
    });

    const offMemo = on(root, 'textarea[name=memo]', 'input', (evt, input) => {
      draft.memo = input.value;
      paintMemoCount();
      setFieldError(input, null);
    });

    const offClearMemo = on(root, '[data-role="clear-memo"]', 'click', (evt) => {
      evt.preventDefault();
      draft.memo = '';
      // The user has dropped the link's memo knowingly: it is not filled back in on Review.
      if (draft.link) draft.link = { ...draft.link, memo: null };
      const memoEl = field('memo');
      if (memoEl) memoEl.value = '';
      paintMemoCount();
      paintMemoNotice();
      showFormBanner('');
    });

    async function validateAddress(input, { silent = false } = {}) {
      const value = input.value.trim();
      if (!value) {
        if (!silent) setFieldError(input, 'Enter the address you are sending to.');
        return null;
      }
      let parsed;
      try {
        parsed = await ctx.backend.wallet.parseAddress(value);
      } catch (err) {
        if (!live()) return null;
        setFieldError(input, (err && err.message) || 'That address could not be checked.');
        return null;
      }
      if (!live()) return null;
      if (!parsed || !parsed.valid) {
        setFieldError(input, (parsed && parsed.reason) || 'That is not a valid address.');
        return null;
      }
      setFieldError(input, null);
      return value;
    }

    const offInput = on(root, 'textarea[name=to]', 'input', (evt, input) => {
      draft.to = input.value;
      draft.selfConfirmed = false;
      draft.link = null;
      paintLinkHint();
      clearTimeout(debounceTimer);
      // Debounced: a shielded address is pasted, not typed, but a backend that does real bech32
      // work should not be asked on every keystroke either.
      debounceTimer = setTimeout(() => { if (live()) takeRecipient(input); }, ADDRESS_DEBOUNCE_MS);
    });

    const offAmountInput = on(root, 'input[name=amount]', 'input', (evt, input) => {
      draft.amount = input.value;
    });

    const offMax = on(root, '[data-role="max"]', 'click', async (evt) => {
      evt.preventDefault();
      const amountInput = stepEl.querySelector('input[name=amount]');
      const toInput = stepEl.querySelector('textarea[name=to]');
      const balance = BigInt(asset.balance || '0');
      // The fee does not depend on who it goes to, so a blank recipient asks against the wallet's
      // own address rather than refusing to answer.
      const to = (toInput && toInput.value.trim()) || ownAddress;
      showFormBanner('');

      let max = null;
      let fee = null;
      let estimate = null;
      try {
        if (typeof ctx.backend.send.maxSendable === 'function') {
          // A backend that knows how it selects notes can answer this exactly — per asset: a
          // RAND transfer pays the fee out of the notes it sends, a token transfer pays it in
          // RAND out of the other half of the bundle, so the whole token balance is sendable.
          const answer = await ctx.backend.send.maxSendable({ asset: asset.index, to });
          if (!live()) return;
          if (answer && answer.reason && BigInt(answer.amount || '0') <= 0n) {
            // The backend knows why nothing is sendable (a token and no RAND for the fee, say):
            // its sentence, not a bare zero in the field.
            showFormBanner(answer.reason);
            return;
          }
          max = BigInt((answer && answer.amount) || '0');
          fee = BigInt((answer && answer.fee) || '0');
        } else {
          // Otherwise: ask what a *one-unit* transfer costs. Asking for the whole balance would be
          // asking for a transfer that cannot be built, which a strict backend rightly refuses.
          estimate = await ctx.backend.send.estimate({ asset: asset.index, to, amount: '1' });
          fee = BigInt((estimate && estimate.fee) || '0');
          // The fee is RAND: it comes off a RAND balance, never off the token's.
          max = asset.index === 0 ? (balance > fee ? balance - fee : 0n) : balance;
        }
      } catch (err) {
        if (!live()) return;
        showFormBanner((err && err.message) || 'The fee could not be worked out.');
        return;
      }
      if (!live()) return;

      if (max <= 0n) {
        // Writing "0" into the field and saying nothing is how a user concludes the wallet is
        // broken. Say what is actually wrong, and leave what they typed alone: nothing of the
        // asset at all is one thing to say; a balance the fee would not fit is another, and the
        // fee is RAND whatever is being sent, so it is denominated in RAND at the RAND row's own
        // decimals.
        if (balance <= 0n) {
          setFieldError(amountInput, `You hold no ${asset.symbol}.`);
          return;
        }
        setFieldError(amountInput, `Your balance doesn’t cover the network fee (${formatUnits(fee, 9, feeDecimals(assets))} ${feeSymbol(assets)}).`);
        return;
      }
      amountInput.value = plainUnits(max, asset.decimals);
      draft.amount = amountInput.value;
      // Only a real estimate is kept as one; `maxSendable`'s fee is remembered separately so the
      // local amount check can use it without pretending to be a full estimate.
      if (estimate) draft.estimate = estimate;
      draft.knownFee = fee.toString();
      setFieldError(amountInput, null);
    });

    const offExpand = on(root, '[data-role="expand-to"]', 'click', (evt, btn) => {
      evt.preventDefault();
      const box = stepEl.querySelector('[data-role="to-full"]');
      if (!box) return;
      const shown = !box.hasAttribute('hidden');
      if (shown) box.setAttribute('hidden', ''); else box.removeAttribute('hidden');
      btn.setAttribute('aria-expanded', String(!shown));
      btn.setAttribute('aria-label', shown ? 'Show the full address' : 'Hide the full address');
    });

    const offEdit = on(root, '[data-role="edit"]', 'click', (evt) => {
      evt.preventDefault();
      goStep('details');
    });

    const offRetry = on(root, '[data-role="retry"]', 'click', (evt) => {
      evt.preventDefault();
      ctx.state.send = null;
      attached = null;
      goStep('review');
    });

    // A paired prover that ran out of time left its job pending: Resume polls the SAME job again
    // (the engine's `send.resume`), Cancel cancels it there and forgets it.
    const offResumeProof = on(root, '[data-role="resume-proof"]', 'click', (evt) => {
      evt.preventDefault();
      if (typeof ctx.backend.send.resume !== 'function') return;
      const previous = attached;
      if (previous) previous.listeners.delete(onStoreChange);
      ctx.state.send = null;
      attached = null;
      attach(resumeSend(ctx, { name: (previous && previous.proverName) || '', startedAt: previous && previous.startedMs }));
    });

    const offCancelProof = on(root, '[data-role="cancel-proof"]', 'click', async (evt) => {
      evt.preventDefault();
      if (attached) attached.listeners.delete(onStoreChange);
      ctx.state.send = null;
      attached = null;
      if (typeof ctx.backend.send.cancelPending === 'function') {
        try { await ctx.backend.send.cancelPending(); } catch { /* best effort: it expires on the prover */ }
      }
      if (!live()) return;
      goStep(draft.recipient ? 'review' : steps[0]);
    });

    function confirmSelfSend() {
      const dialog = ctx.sheet(h`
        <h3 class="sheet-title">That is your own address</h3>
        <p class="sheet-sub">${SELF_SEND_QUESTION}</p>
        <div class="sheet-foot">
          <button class="btn" type="button" data-role="cancel">Change it</button>
          <button class="btn btn-primary" type="button" data-role="confirm">Send to myself</button>
        </div>`);
      on(dialog, '[data-role="cancel"]', 'click', () => ctx.closeSheet());
      on(dialog, '[data-role="confirm"]', 'click', () => {
        draft.selfConfirmed = true;
        ctx.closeSheet();
        const form = stepEl.querySelector('[data-role="send-form"]');
        if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
    }

    const offSubmit = on(root, '[data-role="send-form"]', 'submit', async (evt) => {
      evt.preventDefault();
      const toInput = stepEl.querySelector('textarea[name=to]');
      const amountInput = stepEl.querySelector('input[name=amount]');
      const memoInput = field('memo');
      showFormBanner('');
      if (memoInput) draft.memo = memoInput.value;

      // The recipient first: a link may carry the amount and the memo, and fills in what the form
      // left empty before either is checked.
      const recipient = await resolveRecipient(toInput);
      if (!live()) return;
      if (!recipient) return;
      if (recipient.link) {
        const other = otherAssetFor(recipient.link);
        if (other) { switchToLinkAsset(other, toInput.value.trim(), recipient.link); return; }
        draft.link = recipient.link;
        draft.linkText = toInput.value.trim();
        applyLink();
        if (showLinkConflicts()) return;
      }

      // Everything that can be decided here is decided here: the backend is not a validator. The
      // fee only counts against THIS asset's balance for RAND itself — a token transfer's fee is
      // RAND out of the other half of the bundle, and has no place in the token's arithmetic.
      const feeSoFar = asset.index === 0
        ? ((draft.estimate && draft.estimate.fee) || draft.knownFee || null)
        : null;
      const checked = checkAmount(amountInput.value, asset, feeSoFar === null ? null : BigInt(feeSoFar));
      if (checked.error) { setFieldError(amountInput, checked.error); return; }
      setFieldError(amountInput, null);

      // The memo: bytes, as the chain counts them, and only where the chain carries one.
      const memoBytes = utf8Length(draft.memo);
      if (memoBytes > MEMO_MAX_BYTES) {
        const message = `The memo is ${memoBytes} bytes; the limit is ${MEMO_MAX_BYTES}.`;
        if (memoInput) setFieldError(memoInput, message); else showFormBanner(message);
        return;
      }
      if (!memoSupported && draft.memo) { paintMemoNotice(); return; }

      const to = recipient.address;
      // As typed: a contact name is never trimmed (an address or link resolves trimmed anyway).
      draft.to = toInput.value;
      draft.recipient = { address: to, name: recipient.name, fingerprint: recipient.fingerprint };
      draft.amount = amountInput.value;

      if (to === ownAddress && !draft.selfConfirmed) { confirmSelfSend(); return; }

      let estimate;
      try {
        estimate = await ctx.backend.send.estimate({ asset: asset.index, to, amount: checked.units.toString() });
      } catch (err) {
        if (!live()) return;
        // A "this needs three notes" message is written for the user and tells them to consolidate
        // first, so it is shown exactly as the backend wrote it (escaped, like all such text).
        showFormBanner((err && err.message) || 'This transfer could not be prepared.');
        return;
      }
      if (!live()) return;

      // The one amount check that needs an answer from the backend: amount + fee against balance.
      // For a token there is nothing to add — the fee is RAND, and the estimate itself already
      // refused a wallet with no RAND to pay it (its sentence is in the banner, above the form).
      const withFee = checkAmount(amountInput.value, asset, asset.index === 0 ? BigInt(estimate.fee || '0') : null);
      if (withFee.error) { setFieldError(amountInput, withFee.error); return; }

      draft.estimate = estimate;
      draft.knownFee = String(estimate.fee || '0');
      reviewUnits = checked.units;
      goStep('review');
    });

    // The unknown-outcome gate: proving again is only live once the box is ticked. The flag is the
    // gate; the `disabled` attribute is only how it looks.
    const offGate = on(root, 'input[name="checked-activity"]', 'change', (evt, box) => {
      unknownConfirmed = !!box.checked;
      const prove = stepEl.querySelector('[data-action="prove"]');
      if (prove) prove.disabled = !unknownConfirmed;
    });

    const offCheckActivity = on(root, '[data-role="check-activity"]', 'click', (evt) => {
      evt.preventDefault();
      // This attempt is over either way; the warning it left behind is not.
      ctx.state.send = null;
      attached = null;
      // Re-scan before showing Activity, so what the user is sent to look at is current. Nothing
      // is wired to its result here: the shell counts every scan, and a scan that starts after the
      // failure and fulfils is what lifts the warning — whether this one, or the one home starts
      // when the user simply navigates there (see markUnknownOutcome).
      Promise.resolve(ctx.backend.sync.scan(() => {}, { signal: ctx.session.signal }))
        .catch(() => { /* the banner on Activity/home is where a scan failure belongs */ });
      ctx.go('#activity');
    });

    const offExplorerUnknown = on(root, '[data-role="explorer-unknown"]', 'click', (evt) => {
      evt.preventDefault();
      const hash = safeHash(attached && attached.error && attached.error.hash);
      const link = hash ? explorerLink(settings.explorerUrl, hash) : null;
      if (link) ctx.backend.platform.openExternal(link.url);
    });

    // The one-time notice about the RandProtocol prover: read, remembered for this wallet by the
    // engine, and the review shown again with the button that sends.
    let acknowledging = false;
    const offAcknowledgeProver = on(root, '[data-action="acknowledge-prover"]', 'click', async (evt) => {
      evt.preventDefault();
      if (acknowledging || !canProve.notice || !ctx.backend.prover || typeof ctx.backend.prover.acknowledgeDefault !== 'function') return;
      // Firefox: its consent to send the viewing key to the developer's service, asked HERE,
      // synchronously inside this click (Firefox grants nothing outside the user's gesture).
      const consent = typeof platform.requestDataCollectionConsent === 'function' ? platform.requestDataCollectionConsent() : null;
      acknowledging = true;
      if (consent) {
        let granted = false;
        try { granted = (await consent) === true; } catch { granted = false; }
        if (!live()) return;
        if (!granted) {
          // Declined: no prover here — nothing remembered, the way out is the user's own prover.
          acknowledging = false;
          canProve = { ok: false, reason: PROVER_CONSENT_DECLINED };
          const box = stepEl.querySelector('[data-role="prover-notice"]');
          const foot = box && box.parentElement;
          if (foot) {
            for (const el of foot.querySelectorAll('[data-role="prover-notice"], [data-action="acknowledge-prover"], [data-role="use-own-prover"]')) el.remove();
            foot.insertAdjacentHTML('beforeend', proverDeclinedMarkup());
          }
          return;
        }
      }
      try {
        await ctx.backend.prover.acknowledgeDefault();
      } catch (err) {
        acknowledging = false;
        if (!live()) return;
        const box = stepEl.querySelector('[data-role="prover-notice"]');
        if (box) box.insertAdjacentHTML('afterend', h`<p class="caption error">${(err && err.message) || 'Could not record that.'}</p>`);
        return;
      }
      acknowledging = false;
      if (!live()) return;
      const { notice, ...rest } = canProve;
      void notice;
      canProve = rest;
      if (step === 'review') goStep('review');
    });

    const offProve = on(root, '[data-action="prove"]', 'click', (evt) => {
      evt.preventDefault();
      // Everything that decides whether a transfer may start is re-checked here, from this flow's
      // own state, at the moment of the click. Not from the DOM: `evt.target` is whatever was
      // actually clicked (the button's icon, for one, which has no `disabled` at all), and a
      // `disabled` attribute is a rendering, not a rule.
      if (currentSend(ctx)) return; // one transfer at a time
      if (unknownOutcome(ctx) && !unknownConfirmed) return; // the last one's fate is still unknown
      if (!draft.recipient) return;
      const store = startSend(ctx, {
        asset: asset.index,
        to: draft.recipient.address,
        amount: reviewUnits.toString(),
        // What the confirmation line showed, and nothing a chain without memos could not carry.
        memo: memoSupported ? draft.memo : '',
      }, asset);
      attach(store);
    });

    const offCancel = on(root, '[data-role="cancel"]', 'click', (evt) => {
      evt.preventDefault();
      const store = currentSend(ctx);
      if (!store || !store.controller || !CANCELLABLE.includes(store.phase)) return;
      store.cancelling = true;
      try { store.controller.abort(); } catch { /* already aborted */ }
      // A proof on the paired prover is also cancelled there and forgotten (best effort — the
      // abort already asks the engine to), so it is not picked up again on the next mount.
      if ((store.proverName || store.resumed) && typeof ctx.backend.send.cancelPending === 'function') {
        Promise.resolve(ctx.backend.send.cancelPending()).catch(() => {});
      }
      paintPhase(store);
    });

    // The topbar's back button undoes a *step* while there is one to undo, and only leaves the
    // flow from its first step.
    const onBack = (evt) => {
      evt.preventDefault();
      const i = steps.indexOf(step);
      if (i > 0) goStep(steps[i - 1]);
      else ctx.go('#home');
    };
    backBtn.addEventListener('click', onBack);

    return () => {
      clearTimeout(debounceTimer);
      if (scanning) { try { scanning.abort(); } catch { /* already stopped */ } }
      offScan(); offPick(); offMemo(); offClearMemo();
      stopScreenTicker();
      if (attached) attached.listeners.delete(onStoreChange);
      backBtn.removeEventListener('click', onBack);
      offAsset(); offPaste(); offInput(); offAmountInput(); offMax(); offExpand();
      offEdit(); offRetry(); offResumeProof(); offCancelProof(); offSubmit(); offProve(); offAcknowledgeProver(); offCancel();
      offGate(); offCheckActivity(); offExplorerUnknown();
    };
  },
});
