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

/** What the site sees for an error with no code of its own. */
const FALLBACK_CODE = 'UNKNOWN';

function errorOf(err) {
  const code = err && typeof err.code === 'string' && /^[A-Z_]{2,32}$/.test(err.code) ? err.code : FALLBACK_CODE;
  const message = (err && err.message) || 'Rand Wallet could not complete the request.';
  return { code, message: String(message).slice(0, 300) };
}

/**
 * `makeInvokeFlow({id, send, backend, onChange})` → `{state, start, approve, reject}`.
 *
 *   send(msg)  → the background's answer (`ext.runtime.sendMessage`).
 *   backend    a Backend with the optional `program` group (ui/engine/backend-shared.js).
 *   onChange(state) after every change.
 *
 * `state.step` is one of 'loading' | 'review' | 'running' | 'done' | 'failed'. In 'review' it
 * carries `origin` and `quote` (`{title, spend, receive, fee, cells, tier}`); in 'running',
 * `phase` and `detail`; in 'done', `tx`; in 'failed', `error` and `sent` (whether the site has been
 * told).
 */
export function makeInvokeFlow({ id, send, backend, onChange = () => {} }) {
  const state = { step: 'loading', origin: '', quote: null, phase: null, detail: null, tx: null, error: null };
  let request = null;
  let answered = false;
  const set = (patch) => { Object.assign(state, patch); onChange(state); };

  async function answer(body) {
    if (answered) return;
    answered = true;
    try { await send({ type: 'rand:invokeResult', id, ...body }); } catch { /* the window closing answers too */ }
  }
  async function refuse(err) {
    const error = errorOf(err);
    set({ step: 'failed', error });
    await answer({ ok: false, error });
  }

  async function start() {
    if (!id) { await refuse(Object.assign(new Error('This window was not opened by a site.'), { code: 'GONE' })); return; }
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
      set({ step: 'failed', error: (parked && parked.error) || { code: 'GONE', message: 'That request is no longer waiting.' } });
      return;
    }
    request = parked.result.request;
    set({ origin: String(parked.result.origin || '') });
    const program = backend && backend.program;
    if (!program) { await refuse(Object.assign(new Error('This Rand Wallet cannot run programs.'), { code: 'UNSUPPORTED' })); return; }
    try {
      const can = await program.canInvoke();
      if (!can || !can.ok) throw Object.assign(new Error((can && can.reason) || 'Rand Wallet cannot send this here.'), { code: (can && can.code) || 'PROVER_UNAVAILABLE' });
      const quote = await program.quote(request);
      set({ step: 'review', quote, via: can.via || null });
    } catch (err) {
      await refuse(err);
    }
  }

  async function approve() {
    if (state.step !== 'review') return;
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
    await refuse(Object.assign(new Error('The request was not approved in Rand Wallet.'), { code: 'USER_REJECTED' }));
  }

  return { state, start, approve, reject };
}
