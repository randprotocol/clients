// The approval window's logic (invoke.html), with no DOM: read the parked request from the
// background, quote it, wait for the user, prove and submit, and tell the background how it ended.
// invoke.js renders `state`; extension/test/invoke-flow.test.mjs drives this directly.
//
// The order is the point:
//   1. `rand:invokeRequest` — the request this window was opened for, by id. Nothing in the URL is
//      trusted beyond the id: the origin shown is the one the background recorded from `sender`.
//   2. `program.canInvoke()` then `program.quote()` — every refusal that needs no proof. A refusal
//      here is answered to the site AT ONCE (a stale read is re-quoted by the site, and a window
//      that sat on it would only make the pool move further), and the window says why.
//   3. Approve → `program.invoke()`, its phases reported to the background as they happen
//      (`rand:invokeProgress`), so a window closed mid-way is answered for correctly: refused before
//      anything left the device, unknown once it may have reached the node.
//   4. `rand:invokeResult` — `{tx}` or `{code, message}` — exactly once.
//
// The text here is shown twice: in the window under "Not sent", in the wallet's language, and as
// the `message` beside the error code the site is answered with, in English (the code is the
// contract; a dapp's logs and its own UI expect the provider's English, as provider-host.js,
// content.js and inpage.js answer). Each of this file's refusals is therefore an Error whose
// `message` is translated through `t` and whose `siteMessage` is the same sentence untranslated
// (`refusal` below). `t` is passed in from ui/i18n.js by the window — this file imports nothing,
// so it stays loadable under plain Node for its test, where `t` defaults to English with its
// `{holes}` filled.

/** `t` when none is given: English, holes filled (ui/i18n.js's `fill`). */
const plain = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (hole, name) => (name in vars ? String(vars[name]) : hole)) : String(s));

/** Firefox did not let the wallet send its viewing key to the RandProtocol provers. */
export function consentDeclined(t = plain) {
  return [
    t('Firefox did not allow this wallet to send your viewing key to the RandProtocol provers, so this browser has no prover to make the proof.'),
    t('Nothing was sent.'),
    t('Pair your own prover in the wallet\'s Settings.'),
  ].join(' ');
}

/**
 * The RandProtocol provers' one-time notice, as the approval window shows it — named as every
 * surface names them (ui/screens/send/markup.js `poolPhrase`): `n` machines, each with its own key.
 */
export function proverNotice(n, t = plain) {
  const known = Number.isSafeInteger(n) && n > 0;
  const count = !known ? t('machines') : n === 1 ? t('{n} machine', { n }) : t('{n} machines', { n });
  return [
    t('This device cannot make the proof, so one of the RandProtocol provers ({count} run by the validators; each one that proves a send sees that wallet\'s viewing key) makes it.', { count }),
    t('The one that does receives this wallet\'s viewing key, so it can read your whole history — every payment received and sent, past and future.'),
    t('It cannot spend.'),
    t('You are asked once; to keep your history to yourself, pair your own prover in the wallet\'s Settings.'),
  ].join(' ');
}

/** What the site sees for an error with no code of its own. */
const FALLBACK_CODE = 'UNKNOWN';

// This file's own sentences, each a function of `t` so the window can show it translated and the
// site be answered with it in English (`text(plain)`).
const NOT_OPENED = (t) => t('This window was not opened by a site.');
const NO_LONGER_WAITING = (t) => t('That request is no longer waiting.');
const NO_PROGRAMS = (t) => t('This Rand Wallet cannot run programs.');
const CANNOT_SEND_HERE = (t) => t('Rand Wallet cannot send this here.');
const NOT_APPROVED = (t) => t('The request was not approved in Rand Wallet.');
const NOT_COMPLETED = (t) => t('Rand Wallet could not complete the request.');

/**
 * `makeInvokeFlow({id, send, backend, onChange, t})` → `{state, start, acknowledge, approve, reject}`.
 *
 *   send(msg)  → the background's answer (`ext.runtime.sendMessage`).
 *   backend    a Backend with the optional `program` group (ui/engine/backend-shared.js).
 *   onChange(state) after every change.
 *   t          ui/i18n.js's `t`, from the window; English when absent.
 *
 * `state.step` is one of 'loading' | 'review' | 'running' | 'done' | 'failed'. In 'review' it
 * carries `origin` and `quote` (`{title, spend, receive, fee, cells, tier}`); in 'running',
 * `phase` and `detail`; in 'done', `tx`; in 'failed', `error` and `sent` (whether the site has been
 * told).
 */
export function makeInvokeFlow({ id, send, backend, onChange = () => {}, t = plain }) {
  const state = { step: 'loading', origin: '', quote: null, phase: null, detail: null, tx: null, error: null };
  const codeOf = (err) => (err && typeof err.code === 'string' && /^[A-Z_]{2,32}$/.test(err.code) ? err.code : FALLBACK_CODE);
  /** What the window shows: the error's own message, translated when it is one of this file's. */
  const errorOf = (err) => {
    const message = (err && err.message) || NOT_COMPLETED(t);
    return { code: codeOf(err), message: String(message).slice(0, 300) };
  };
  /** What the site is answered with: the same, in English. */
  const siteErrorOf = (err) => {
    const message = (err && (err.siteMessage || err.message)) || NOT_COMPLETED(plain);
    return { code: codeOf(err), message: String(message).slice(0, 300) };
  };
  /** One of this file's refusals: `text(t)` for the window, `text(plain)` for the site. */
  const refusal = (text, code) => Object.assign(new Error(text(t)), { code, siteMessage: text(plain) });
  let request = null;
  let answered = false;
  const set = (patch) => { Object.assign(state, patch); onChange(state); };

  async function answer(body) {
    if (answered) return;
    answered = true;
    try { await send({ type: 'rand:invokeResult', id, ...body }); } catch { /* the window closing answers too */ }
  }
  async function refuse(err) {
    set({ step: 'failed', error: errorOf(err) });
    await answer({ ok: false, error: siteErrorOf(err) });
  }

  async function start() {
    if (!id) { await refuse(refusal(NOT_OPENED, 'GONE')); return; }
    let parked;
    try {
      parked = await send({ type: 'rand:invokeRequest', id });
    } catch (err) {
      set({ step: 'failed', error: errorOf(err) });
      return;
    }
    if (!parked || !parked.ok) {
      // The request is gone (answered, or the background restarted): there is nobody to tell.
      answered = true;
      set({ step: 'failed', error: (parked && parked.error) || { code: 'GONE', message: NO_LONGER_WAITING(t) } });
      return;
    }
    request = parked.result.request;
    set({ origin: String(parked.result.origin || '') });
    const program = backend && backend.program;
    if (!program) { await refuse(refusal(NO_PROGRAMS, 'UNSUPPORTED')); return; }
    try {
      const can = await program.canInvoke();
      if (!can || !can.ok) {
        const code = (can && can.code) || 'PROVER_UNAVAILABLE';
        throw can && can.reason ? Object.assign(new Error(can.reason), { code }) : refusal(CANNOT_SEND_HERE, code);
      }
      const quote = await program.quote(request);
      // The RandProtocol prover's one-time notice, when it is still to be read: the window shows it
      // in Approve's place, and `acknowledge` (from its own click) reads it.
      set({ step: 'review', quote, via: can.via || null, prover: can.prover || null, provers: can.provers || 0, notice: can.notice === true });
    } catch (err) {
      await refuse(err);
    }
  }

  /**
   * "I understand — continue" on the RandProtocol prover's notice. Firefox's data-collection
   * consent is asked FIRST and synchronously, inside the click that called this (Firefox grants
   * nothing outside the user's gesture); declined, there is no prover and the site is told
   * PROVER_UNAVAILABLE. Then the notice is remembered for this wallet and Approve is offered.
   */
  function acknowledge() {
    if (state.step !== 'review' || !state.notice) return Promise.resolve();
    const platform = backend && backend.platform;
    const consent = platform && typeof platform.requestDataCollectionConsent === 'function' ? platform.requestDataCollectionConsent() : null;
    return (async () => {
      if (consent) {
        let granted = false;
        try { granted = (await consent) === true; } catch { granted = false; }
        if (!granted) {
          await refuse(refusal(consentDeclined, 'PROVER_UNAVAILABLE'));
          return;
        }
      }
      try {
        await backend.prover.acknowledgeDefault();
      } catch (err) {
        await refuse(err);
        return;
      }
      set({ notice: false });
    })();
  }

  async function approve() {
    if (state.step !== 'review' || state.notice) return;
    set({ step: 'running', phase: 'selecting', detail: null });
    const onPhase = (phase, detail) => {
      set({ phase, detail: detail || null });
      send({ type: 'rand:invokeProgress', id, phase }).catch(() => {});
    };
    // The first phase is reported before the backend is called, so a window closed in the first
    // second is "interrupted, nothing sent", not "never approved".
    await send({ type: 'rand:invokeProgress', id, phase: 'selecting' }).catch(() => {});
    try {
      const { hash } = await backend.program.invoke(request, onPhase);
      const tx = String(hash).replace(/^0x/, '').toLowerCase();
      set({ step: 'done', tx });
      await answer({ ok: true, result: { tx } });
    } catch (err) {
      await refuse(err);
    }
  }

  async function reject() {
    if (state.step !== 'review' && state.step !== 'loading') return;
    await refuse(refusal(NOT_APPROVED, 'USER_REJECTED'));
  }

  return { state, start, acknowledge, approve, reject };
}
