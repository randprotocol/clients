// The withdraw approval window's logic (withdraw.html), with no DOM: read the parked burn request
// from the background, read it the way the wallet reads it, quote it with the wallet's own
// estimate, wait for the user, prove and submit, and tell the background how it ended.
// withdraw.js renders `state`; extension/test/withdraw-flow.test.mjs drives this directly. It is
// invoke-flow.js's twin for a bridge burn (randbridge.org asks, as durian.market asks to invoke),
// and keeps its rules: one answer to the site, in English, with a code.
//
// The order is the point:
//   1. `rand:withdrawRequest` — the request this window was opened for, by id. Nothing in the URL
//      is trusted beyond the id: the origin shown is the one the background recorded.
//   2. `normalizeWithdrawRequest` — the host's check is shallow (it does not lowercase hex and
//      does not look at `toChain` or `chainId`), so the wallet reads every field itself here and
//      refuses what it cannot read (`BAD_REQUEST`) or what is for another Rand chain
//      (`WRONG_CHAIN`) before anything is quoted. The burn arguments are the NORMALISED ones, so
//      what the user sees is what is proved.
//   3. `bridge.canWithdraw()` then `bridge.estimate()` — every refusal that needs no proof (no
//      route, bridge off, not enough zUSD or RAND, a selection that cannot be built). Each is
//      answered to the site AT ONCE, with the wallet's own sentence: the window does not sit on a
//      burn the chain would refuse, and the site is not left waiting for a click that cannot help.
//   4. Approve → `bridge.withdraw()`, its phases reported (`rand:withdrawProgress`) as they
//      happen, so a window closed mid-way is answered for correctly: not sent yet before the
//      submit, unknown once it may have reached the node. A remote proof stays in the wallet's
//      pending record when the window closes; the next burn is refused as `PROOF_PENDING`.
//   5. `rand:withdrawResult` — `{tx}` or `{code, message}` — exactly once.

import {
  plain, FALLBACK_CODE, NOT_OPENED, NO_LONGER_WAITING, NOT_APPROVED, NOT_COMPLETED, CANNOT_SEND_HERE, consentDeclined,
} from './invoke-flow.js';

/**
 * The chains whose `to` is a 20-byte address left-padded to 32 bytes: the upper twelve bytes must
 * be zero. A local copy of EVM_CHAINS in ui/screens/withdraw.js, which cannot be imported here: it
 * pulls in the DOM helpers and the screen registry, and this file must load under plain Node. The
 * chain's own rule (BridgeState::check_burn) is the source; the bridge still owns the check.
 */
const EVM_CHAINS = Object.freeze([2, 3, 4]);

const NO_BRIDGE = (t) => t('This Rand Wallet cannot withdraw to another chain.');
const WRONG_CHAIN_TEXT = (t) => t('This request is for a different Rand chain than this wallet is on.');
const BAD_REQUEST_TEXT = (t) => t('Rand Wallet could not read this withdrawal request.');

const coded = (text, code, t = plain) => Object.assign(new Error(text(t)), { code, siteMessage: text(plain) });

const isUint = (n) => Number.isSafeInteger(n) && n >= 0;
const hex64 = (v) => {
  if (typeof v !== 'string') return null;
  const h = v.replace(/^0x/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(h) ? h : null;
};

/**
 * `(raw, walletChainId)` → `{asset, amount, toChain, token, to, relayerFee: '0', title}`, or throws
 * an Error with `code` `BAD_REQUEST` / `WRONG_CHAIN`. `relayerFee` is never the site's: the wallet
 * burns with "0", which is what `rand bridge-burn` implies and what the relayer's floor allows.
 */
export function normalizeWithdrawRequest(raw, walletChainId, t = plain) {
  const bad = () => coded(BAD_REQUEST_TEXT, 'BAD_REQUEST', t);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad();
  const { asset, amount, toChain, chainId } = raw;
  if (!isUint(asset) || !isUint(chainId)) throw bad();
  if (!Number.isInteger(toChain) || toChain < 1 || toChain > 255) throw bad();
  if (typeof amount !== 'string' || !/^[1-9][0-9]{0,29}$/.test(amount)) throw bad();
  const token = hex64(raw.token);
  const to = hex64(raw.to);
  if (!token || !to) throw bad();
  // The courtesy checks of ui/screens/withdraw.js `checkRecipient`, on the 32-byte form.
  if (EVM_CHAINS.includes(toChain) && !/^0{24}/.test(to)) throw bad();
  if (/^0+$/.test(to)) throw bad();
  let title = raw.title;
  if (title === undefined || title === null) title = '';
  if (typeof title !== 'string') throw bad();
  if (chainId !== Number(walletChainId)) throw coded(WRONG_CHAIN_TEXT, 'WRONG_CHAIN', t);
  return { asset, amount, toChain, token, to, relayerFee: '0', title: title.trim().slice(0, 80) };
}

/** The burn arguments `bridge.*` takes: the normalised request without the site's label. */
const burnOf = ({ asset, amount, relayerFee, toChain, token, to }) => ({ asset, amount, relayerFee, toChain, token, to });

/**
 * `makeWithdrawFlow({id, send, backend, onChange, t})` → `{state, start, acknowledge, approve, reject}`.
 *
 *   send(msg)  → the background's answer (`ext.runtime.sendMessage`).
 *   backend    a Backend with `settings`, `bridge`, and for the notice `prover` / `platform`.
 *   onChange(state) after every change.
 *   t          ui/i18n.js's `t`, from the window; English when absent.
 *
 * `state.step` is one of 'loading' | 'review' | 'running' | 'done' | 'failed'. In 'review' it
 * carries `origin`, `request` (normalised), `estimate`, `via`, `prover`, `provers`, `notice`; in
 * 'running', `phase` and `detail`; in 'done', `tx`; in 'failed', `error`.
 */
export function makeWithdrawFlow({ id, send, backend, onChange = () => {}, t = plain }) {
  const state = { step: 'loading', origin: '', request: null, estimate: null, via: null, prover: null, provers: 0, notice: false, phase: null, detail: null, tx: null, error: null };
  /** An earlier proof waiting in the wallet is `PROOF_PENDING`; otherwise the error's own code, or UNKNOWN. */
  const codeOf = (err) => {
    if (err && typeof err.code === 'string' && /^[A-Z_]{2,32}$/.test(err.code)) return err.code;
    return err && err.pending ? 'PROOF_PENDING' : FALLBACK_CODE;
  };
  const errorOf = (err) => ({ code: codeOf(err), message: String((err && err.message) || NOT_COMPLETED(t)).slice(0, 300) });
  const siteErrorOf = (err) => ({ code: codeOf(err), message: String((err && (err.siteMessage || err.message)) || NOT_COMPLETED(plain)).slice(0, 300) });
  const refusal = (text, code) => coded(text, code, t);
  let answered = false;
  const set = (patch) => { Object.assign(state, patch); onChange(state); };

  async function answer(body) {
    if (answered) return;
    answered = true;
    try { await send({ type: 'rand:withdrawResult', id, ...body }); } catch { /* the window closing answers too */ }
  }
  async function refuse(err) {
    set({ step: 'failed', error: errorOf(err) });
    await answer({ ok: false, error: siteErrorOf(err) });
  }

  async function start() {
    if (!id) { await refuse(refusal(NOT_OPENED, 'GONE')); return; }
    let parked;
    try {
      parked = await send({ type: 'rand:withdrawRequest', id });
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
    set({ origin: String(parked.result.origin || '') });
    const bridge = backend && backend.bridge;
    if (!bridge || typeof bridge.withdraw !== 'function') { await refuse(refusal(NO_BRIDGE, 'UNSUPPORTED')); return; }
    try {
      const settings = await backend.settings.get();
      const request = normalizeWithdrawRequest(parked.result.request, settings && settings.chainId, t);
      const can = await bridge.canWithdraw();
      if (!can || !can.ok) {
        throw can && can.reason ? Object.assign(new Error(can.reason), { code: can.code || 'UNAVAILABLE' }) : refusal(CANNOT_SEND_HERE, 'UNAVAILABLE');
      }
      const estimate = await bridge.estimate(burnOf(request));
      set({ step: 'review', request, estimate, via: can.via || null, prover: can.prover || null, provers: can.provers || 0, notice: can.notice === true });
    } catch (err) {
      await refuse(err);
    }
  }

  /**
   * "I understand — continue" on the RandProtocol prover's notice, exactly as invoke-flow's:
   * Firefox's consent is asked first and synchronously inside the click; declined, there is no
   * prover and the site is told PROVER_UNAVAILABLE. Then the notice is remembered for the wallet.
   */
  function acknowledge() {
    if (state.step !== 'review' || !state.notice) return Promise.resolve();
    const platform = backend && backend.platform;
    const consent = platform && typeof platform.requestDataCollectionConsent === 'function' ? platform.requestDataCollectionConsent() : null;
    return (async () => {
      if (consent) {
        let granted = false;
        try { granted = (await consent) === true; } catch { granted = false; }
        if (!granted) { await refuse(refusal(consentDeclined, 'PROVER_UNAVAILABLE')); return; }
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
      send({ type: 'rand:withdrawProgress', id, phase }).catch(() => {});
    };
    // Reported before the backend is called, so a window closed in the first second is
    // "interrupted, nothing sent", not "never approved".
    await send({ type: 'rand:withdrawProgress', id, phase: 'selecting' }).catch(() => {});
    try {
      const { hash } = await backend.bridge.withdraw(burnOf(state.request), onPhase);
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
