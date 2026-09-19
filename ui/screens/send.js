// The send flow: `#send` and `#send/<index>`.
//
// One screen with internal steps — asset → details → review → proving — because the whole flow is
// one decision and Back should undo a *step*, not drop the user out of it. The steps are painted
// into one container; only `#sent` is a route of its own (./send/sent.js), because a submitted
// transfer is a thing the user may want to come back to.
//
// Three rules the flow exists to keep:
//
//   * **Only RAND (asset 0) can be transferred on this network.** The picker still lists every
//     asset the backend reports — hiding them would just make the wallet look broken — but a
//     registry (RPL) asset is `aria-disabled` and carries the one shared sentence explaining why
//     (owned by screens/asset.js), and `#send/<n>=1` never renders the form.
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
import { h, raw, on } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';
import { wrongChainBannerMarkup, canRescan, confirmRescan } from '../lib/chain-banner.js';
import { parseUnits, formatUnits, elapsed } from '../lib/format.js';
import { markInvalid, markValid } from '../lib/forms.js';
import { explorerLink } from '../lib/explorer.js';
import {
  PHASE_LABELS, CANCELLABLE, ADDRESS_DEBOUNCE_MS, SELF_SEND_QUESTION,
  explainProvingError, outcomeOf, safeHash, draftFor, currentSend, startSend,
  unknownOutcome, plainUnits, checkAmount,
} from './send/state.js';
import {
  shellMarkup, assetStepMarkup, rplOnlyMarkup, noRandMarkup, detailsStepMarkup,
  reviewStepMarkup, provingStepMarkup, failedStepMarkup, unknownOutcomeStepMarkup,
} from './send/markup.js';
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
    try {
      const [list, info, prove, cfg, sync] = await Promise.all([
        ctx.backend.assets.list(), ctx.backend.wallet.info(), ctx.backend.send.canProve(),
        ctx.backend.settings.get(), ctx.backend.sync.cached(),
      ]);
      assets = list;
      ownAddress = (info && info.address) || '';
      if (prove) canProve = prove;
      if (cfg) settings = cfg;
      if (sync) cached = sync;
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
    if (cached.wrongChain) {
      root.querySelector('[data-role="step"]').innerHTML = wrongChainBannerMarkup(cached.wrongChain, { canRescan: canRescan(ctx) });
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
    const rand = assets.find((a) => a.index === 0) || null;
    const requested = explicit ? Number(arg) : (assets.length === 1 ? assets[0].index : null);
    const steps = requested === null ? ['asset', 'details', 'review'] : ['details', 'review'];

    function endOfTheRoad(markup) {
      indicatorEl.textContent = '';
      stepEl.innerHTML = markup;
    }

    // Registry assets cannot be transferred at all: this is the end of the road, not a step.
    if (requested !== null && requested !== 0) {
      endOfTheRoad(rplOnlyMarkup(assets.find((a) => a.index === requested), { hasRand: !!rand }));
      return;
    }
    // …and neither is a wallet that simply has no RAND. An asset is never invented to have
    // something to render a form against: a fabricated zero balance lets someone fill in an
    // amount and only discover at the last step that there was nothing to send.
    if (!rand) {
      endOfTheRoad(noRandMarkup());
      return;
    }

    const asset = rand;
    const draft = draftFor(ctx, asset.index);

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

    // ---- steps ----
    function goStep(next, { focus = true } = {}) {
      stopScreenTicker();
      // Review is only ever reachable with an estimate behind it; anything else (a cancel that
      // landed after the draft was spent, say) falls back to the form rather than inventing a fee.
      if (next === 'review' && (!draft.estimate || reviewUnits <= 0n)) next = 'details';
      step = next;
      const unknown = unknownOutcome(ctx);
      // The review is the only step that can start a send, so it is the only one that carries the
      // gate — but every step carries the warning, including the very first.
      unknownConfirmed = false;
      if (next === 'asset') stepEl.innerHTML = assetStepMarkup(assets, unknown);
      else if (next === 'details') {
        stepEl.innerHTML = detailsStepMarkup(asset, draft, {
          canPaste: typeof ctx.backend.platform.paste === 'function',
          unknown,
        });
      } else if (next === 'review') {
        stepEl.innerHTML = reviewStepMarkup({ asset, to: draft.to, units: reviewUnits, estimate: draft.estimate, canProve, unknown });
      } else if (next === 'proving') paintProving();
      else if (next === 'failed') stepEl.innerHTML = failedStepMarkup(explainProvingError(attached && attached.error));
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
      screenTicker = setInterval(() => {
        if (!live() || store.done) { stopScreenTicker(); return; }
        elapsedEl.textContent = elapsed(Date.now() - store.startedMs);
      }, 1000);
    }

    function paintPhase(store) {
      const label = PHASE_LABELS[store.phase] || 'Working';
      const phaseEl = stepEl.querySelector('[data-role="phase"]');
      const ring = stepEl.querySelector('[data-role="ring"]');
      if (phaseEl) phaseEl.textContent = label;
      if (ring) ring.setAttribute('aria-label', label);
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
          // Cancelled, by the user or by the session ending: back to review, nothing lost.
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
    const running = currentSend(ctx);
    if (running) {
      attach(running);
    } else {
      goStep(step, { focus: false });
    }

    // ---- handlers ----
    const offAsset = on(root, '[data-asset]', 'click', (evt, btn) => {
      evt.preventDefault();
      if (btn.getAttribute('aria-disabled') === 'true') return; // listed, explained, not offered
      if (Number(btn.dataset.asset) !== 0) return;
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
      validateAddress(input, { silent: true });
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
      clearTimeout(debounceTimer);
      // Debounced: a shielded address is pasted, not typed, but a backend that does real bech32
      // work should not be asked on every keystroke either.
      debounceTimer = setTimeout(() => { if (live()) validateAddress(input, { silent: true }); }, ADDRESS_DEBOUNCE_MS);
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
          // A backend that knows how it selects notes can answer this exactly.
          const answer = await ctx.backend.send.maxSendable({ asset: asset.index, to });
          max = BigInt((answer && answer.amount) || '0');
          fee = BigInt((answer && answer.fee) || '0');
        } else {
          // Otherwise: ask what a *one-unit* transfer costs. Asking for the whole balance would be
          // asking for a transfer that cannot be built, which a strict backend rightly refuses.
          estimate = await ctx.backend.send.estimate({ asset: asset.index, to, amount: '1' });
          fee = BigInt((estimate && estimate.fee) || '0');
          max = balance > fee ? balance - fee : 0n;
        }
      } catch (err) {
        if (!live()) return;
        showFormBanner((err && err.message) || 'The fee could not be worked out.');
        return;
      }
      if (!live()) return;

      if (max <= 0n) {
        // Writing "0" into the field and saying nothing is how a user concludes the wallet is
        // broken. Say what is actually wrong, and leave what they typed alone.
        setFieldError(amountInput, `Your balance doesn’t cover the network fee (${formatUnits(fee, 9, asset.decimals)} ${asset.symbol}).`);
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
      showFormBanner('');

      // Everything that can be decided here is decided here: the backend is not a validator.
      const feeSoFar = (draft.estimate && draft.estimate.fee) || draft.knownFee || null;
      const checked = checkAmount(amountInput.value, asset, feeSoFar === null ? null : BigInt(feeSoFar));
      const to = await validateAddress(toInput);
      if (!live()) return;
      if (checked.error) { setFieldError(amountInput, checked.error); return; }
      setFieldError(amountInput, null);
      if (!to) return;

      draft.to = to;
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
      const withFee = checkAmount(amountInput.value, asset, BigInt(estimate.fee || '0'));
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

    const offProve = on(root, '[data-action="prove"]', 'click', (evt) => {
      evt.preventDefault();
      // Everything that decides whether a transfer may start is re-checked here, from this flow's
      // own state, at the moment of the click. Not from the DOM: `evt.target` is whatever was
      // actually clicked (the button's icon, for one, which has no `disabled` at all), and a
      // `disabled` attribute is a rendering, not a rule.
      if (currentSend(ctx)) return; // one transfer at a time
      if (unknownOutcome(ctx) && !unknownConfirmed) return; // the last one's fate is still unknown
      const store = startSend(ctx, {
        asset: asset.index,
        to: draft.to,
        amount: reviewUnits.toString(),
      }, asset);
      attach(store);
    });

    const offCancel = on(root, '[data-role="cancel"]', 'click', (evt) => {
      evt.preventDefault();
      const store = currentSend(ctx);
      if (!store || !store.controller || !CANCELLABLE.includes(store.phase)) return;
      store.cancelling = true;
      try { store.controller.abort(); } catch { /* already aborted */ }
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
      stopScreenTicker();
      if (attached) attached.listeners.delete(onStoreChange);
      backBtn.removeEventListener('click', onBack);
      offAsset(); offPaste(); offInput(); offAmountInput(); offMax(); offExpand();
      offEdit(); offRetry(); offSubmit(); offProve(); offCancel();
      offGate(); offCheckActivity(); offExplorerUnknown();
    };
  },
});
