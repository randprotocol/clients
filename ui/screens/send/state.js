// Send flow — the parts that have nothing to do with the DOM: the phase vocabulary, the draft,
// the one in-flight transfer, the transaction-key handoff and the amount rules.
//
// Split out of screens/send.js (which was past 800 lines) so the screen itself is the wiring and
// this is the behaviour; importable under plain Node, since none of it touches `document`.
import { formatUnits, parseUnits, elapsed } from '../../lib/format.js';
import { TX_HASH_RE } from '../../lib/explorer.js';

export const PHASE_LABELS = {
  selecting: 'Selecting notes',
  witness: 'Building the witness',
  proving: 'Proving the bundle',
  submitting: 'Submitting to the node',
  confirming: 'Waiting for the block',
};
// Cancel is offered up to, but not including, the moment the transaction leaves this device: once
// the node has it, "cancel" would be a lie.
export const CANCELLABLE = ['selecting', 'witness', 'proving'];
// …and for the same reason, a failure from `'submitting'` onwards does not mean "not sent". The
// transaction may be in a mempool, in a block, or nowhere; this wallet cannot tell, and the one
// thing it must not do is invite the user to send it again.
export const AFTER_BROADCAST = ['submitting', 'confirming'];
export const ADDRESS_DEBOUNCE_MS = 150;
export const SELF_SEND_QUESTION = 'Send to yourself? This consolidates your notes.';
export const UNKNOWN_NOTICE = 'Your last transfer’s outcome is unknown — check Activity first.';
export const UNKNOWN_CONFIRM = 'I checked — it did not go through';

/** "1 proof · about 2 minutes on this computer" — from the estimate, not from a constant. Roughly
 *  two minutes of native proving per proof; a withdrawal needs two, a transfer one. */
export function proveCost(proofs) {
  const n = Number.isFinite(Number(proofs)) && Number(proofs) >= 1 ? Math.floor(Number(proofs)) : 1;
  return `${n} ${n === 1 ? 'proof' : 'proofs'} · about ${n * 2} minutes on this computer`;
}

/**
 * What a rejection means, which depends entirely on how far the transfer had got.
 *
 *  - `'cancelled'` — the user asked, or the wallet session ended. Nothing happened.
 *  - `'not-sent'`  — it failed before anything was broadcast, or the backend says it *knows* the
 *                    transfer did not happen (`err.definite`). Safe to try again.
 *  - `'unknown'`   — it failed at or after `'submitting'`. It may be on chain. Not safe to retry.
 */
export function outcomeOf(store) {
  if (!store || !store.error) return 'ok';
  if (store.cancelling || isAbortError(store.error)) return 'cancelled';
  if (store.error.definite === true) return 'not-sent';
  return AFTER_BROADCAST.includes(store.phase) ? 'unknown' : 'not-sent';
}

/** A hash from a rejection is node-controlled text: only 32 bytes of hex ever gets further. */
export function safeHash(hash) {
  return TX_HASH_RE.test(String(hash || '')) ? String(hash) : null;
}

/**
 * What to tell the user when a proof failed. The wasm core aborts with a bare `unreachable` (or
 * its worker simply dies) when the prover runs past the 4 GiB a browser gives WebAssembly, and
 * echoing that at someone is useless. Anything this does not recognise is the node's or the
 * prover's own words, passed through unchanged — and shown escaped, like every other string this
 * wallet did not write.
 *
 * Moved here from the old extension UI's views.js.
 */
export function explainProvingError(msg) {
  const text = String((msg && msg.message) || msg || '').trim();
  if (/unreachable|out of memory|alloc|worker failed|memory access/i.test(text)) {
    return 'This device ran out of memory while proving. A transfer proof needs about 5.6 GB and a '
      + 'browser gives WebAssembly at most 4 GB. Your notes are untouched — send from the desktop '
      + 'app, which proves natively.';
  }
  return text || 'The transfer could not be proved.';
}

/** An error that means "this was cancelled", not "it failed" — see ui/backend.js. */
export function isAbortError(err) {
  return !!err && (err.name === 'AbortError' || err.code === 'ABORT_ERR' || err.code === 20);
}

// ------------------------------------------------------------------- the transaction key ------
// Keyed by the wallet *session object* (frozen, unique per session per mount), so it cannot be
// read from another session, another mount or a reload, and is dropped with the session itself.
// Consumed on the first read: the key crosses from the send screen to the sent screen exactly once.
const RESULTS = new WeakMap();

export function stashResult(session, result) {
  RESULTS.set(session, result);
}

export function takeResult(session, hash) {
  const stored = RESULTS.get(session);
  if (!stored || stored.hash !== hash) return null;
  RESULTS.delete(session);
  return stored;
}

// ----------------------------------------------------------------------------- the draft ------
/** What the user has typed so far. Session-scoped (`ctx.state` is emptied when a wallet session
 *  ends) and deliberately kept across a navigation, so Retry — and coming back from anywhere —
 *  finds the form as it was left. Nothing secret is in it. */
export function draftFor(ctx, assetIndex) {
  let draft = ctx.state.sendDraft;
  if (!draft || draft.assetIndex !== assetIndex) {
    // `knownFee` is the fee last learned from the backend by any route (an estimate, or
    // `maxSendable`), so the local amount check can subtract it before asking anything again.
    draft = { assetIndex, to: '', amount: '', selfConfirmed: false, estimate: null, knownFee: null };
    ctx.state.sendDraft = draft;
  }
  return draft;
}

// ------------------------------------------------------------- the unknown-outcome record ------
/**
 * A transfer whose fate this wallet could not establish leaves a mark on the session. It is what
 * puts a standing warning above the form and the review, and what makes proving again take an
 * explicit "I checked" until the user has actually re-scanned. Nothing secret is in it.
 */
export function markUnknownOutcome(ctx, { hash = null } = {}) {
  ctx.state.sendUnknown = { hash: safeHash(hash), atMs: Date.now(), syncedSince: false };
  return ctx.state.sendUnknown;
}

export function unknownOutcome(ctx) {
  return ctx.state.sendUnknown || null;
}

/** Called when a scan started *after* the failure has finished: the user has now had a chance to
 *  see whether the transfer is there. The warning stays for the session; the extra confirm does
 *  not. */
export function noteSyncFinished(ctx) {
  const record = ctx.state.sendUnknown;
  if (record) record.syncedSince = true;
}

// ------------------------------------------------------------------- the in-flight send -------
/** The one in-flight (or just-finished) send for this mount, or `null`. */
export function currentSend(ctx) {
  const store = ctx.state.send;
  return store && store.sessionId === ctx.session.id ? store : null;
}

/** Forgets a finished send once its receipt has been shown, so a later `#send` is a fresh start. */
export function clearFinishedSend(ctx, hash) {
  const store = currentSend(ctx);
  if (store && store.done && (!hash || store.hash === hash)) ctx.state.send = null;
}

/**
 * Starts the transfer and records it on `ctx.state`, so it survives every navigation inside this
 * wallet session. Returns the store; the caller attaches to `store.promise` for the result.
 */
export function startSend(ctx, req, asset) {
  const session = ctx.session;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const store = {
    sessionId: session.id,
    phase: 'selecting',
    startedMs: Date.now(),
    listeners: new Set(),
    // `controller` is also how the UI knows whether cancelling is possible at all: without an
    // AbortController there is no signal to hand the backend, so no Cancel is offered.
    controller,
    cancelling: false,
    done: false,
    error: null,
    promise: null,
    ticker: null,
    req,
    symbol: asset.symbol,
    decimals: asset.decimals,
  };
  ctx.state.send = store;

  const fan = () => {
    for (const fn of [...store.listeners]) {
      try { fn(store); } catch (err) { console.error('rand-wallet: send listener failed', err); }
    }
  };
  store.fan = fan;

  // The chip's clock. Deliberately separate from the proving screen's own timer (which belongs to
  // that render and is cleared with it): this one has to keep counting while the user is looking
  // at something else entirely, which is the whole point of the chip.
  const paintChip = () => ctx.setPinnedChip({ text: `Proving… ${elapsed(Date.now() - store.startedMs)}`, go: 'send' });
  const stopTicker = () => {
    if (store.ticker !== null) { clearInterval(store.ticker); store.ticker = null; }
  };
  store.stopTicker = stopTicker;
  paintChip();
  store.ticker = setInterval(() => {
    if (store.done || ctx.session.id !== session.id) { stopTicker(); return; }
    paintChip();
  }, 1000);
  if (session.signal) {
    // A lock, a wipe, an unlock or a teardown: stop the proof and stop counting. `endSession()`
    // clears `ctx.state` and the pinned chip itself; this is the part it cannot know about.
    session.signal.addEventListener('abort', () => {
      stopTicker();
      if (controller) { try { controller.abort(); } catch { /* already aborted */ } }
    }, { once: true });
  }

  const onPhase = (phase) => {
    if (ctx.session.id !== session.id) return;
    if (!PHASE_LABELS[phase]) return; // a phase this build does not know: keep the last one
    store.phase = phase;
    fan();
  };

  const finish = () => {
    store.done = true;
    stopTicker();
  };

  // The settle handler runs whatever screen happens to be mounted — including none of this flow's
  // — so everything that must happen exactly once happens here, not in a screen's listener.
  const p = Promise.resolve(ctx.backend.send.send(req, onPhase, controller ? { signal: controller.signal } : undefined))
    .then(
      (result) => {
        const hash = safeHash(result && result.hash);
        store.hash = hash;
        // The transaction key is moved out of the promise chain *here*, at the instant it arrives,
        // into the session-keyed handoff. `ctx.state.send.promise` therefore fulfils to the hash
        // alone: nothing reachable from `ctx.state` — not a field, not a resolved value — ever
        // carries the key, whether or not a screen was mounted to catch it.
        if (hash) {
          stashResult(session, {
            hash,
            txKey: (result && result.txKey) || null,
            amount: req.amount,
            to: req.to,
            assetIndex: req.asset,
          });
        }
        finish();
        if (ctx.session.id === session.id) {
          // Not a navigation: the user may be in the middle of something else. A chip that says
          // the transfer landed, and leads to the receipt, is how they find out.
          if (hash) ctx.setPinnedChip({ text: 'Sent — view', go: `sent/${hash}`, kind: 'positive' });
          else ctx.setPinnedChip(null);
        }
        fan();
        return { hash };
      },
      (err) => {
        store.error = err;
        finish();
        if (ctx.session.id === session.id) {
          ctx.setPinnedChip(null);
          // Recorded here rather than in a screen, so a transfer that failed while the user was
          // elsewhere still leaves the warning behind it.
          if (outcomeOf(store) === 'unknown') markUnknownOutcome(ctx, { hash: err && err.hash });
        }
        fan();
        throw err;
      },
    );
  store.promise = p;
  // The failure is delivered through `store.error` and the listeners; this only marks the promise
  // handled so a screen that never attaches cannot produce an unhandled rejection.
  p.catch(() => {});
  return store;
}

// ---------------------------------------------------------------------------- amount maths ----
/** A units value as a plain decimal string suitable for an <input> — no thousands separators, so
 *  it round-trips through `parseUnits`. (`formatUnits` is for *display*, and groups digits.) */
export function plainUnits(units, decimals) {
  const base = 10n ** BigInt(decimals);
  const u = units < 0n ? 0n : units;
  const frac = (u % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${(u / base).toString()}.${frac}` : (u / base).toString();
}

/**
 * Everything that can be decided about an amount without asking the backend anything.
 * Returns `{units}` or `{error}`. `fee` is only supplied once an estimate is in hand.
 */
export function checkAmount(text, asset, fee = null) {
  const raw0 = String(text || '').trim();
  if (!raw0) return { error: 'Enter an amount to send.' };
  let units;
  try {
    units = parseUnits(raw0, asset.decimals);
  } catch (err) {
    const message = (err && err.message) || '';
    if (/decimal places/.test(message)) return { error: `${asset.symbol} has ${asset.decimals} decimal places — that is more.` };
    return { error: 'Enter the amount as a number, for example 1.25.' };
  }
  if (units <= 0n) return { error: 'Enter an amount greater than zero.' };
  const balance = BigInt(asset.balance || '0');
  if (units > balance) {
    return { error: `That is more than your balance of ${formatUnits(balance, 6, asset.decimals)} ${asset.symbol}.` };
  }
  if (fee !== null && units + fee > balance) {
    return { error: `The amount plus the ${formatUnits(fee, 9, asset.decimals)} ${asset.symbol} network fee is more than your balance.` };
  }
  return { units };
}
