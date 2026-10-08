// Send flow — the parts that have nothing to do with the DOM: the phase vocabulary, the draft,
// the one in-flight transfer, the transaction-key handoff and the amount rules.
//
// Split out of screens/send.js (which was past 800 lines) so the screen itself is the wiring and
// this is the behaviour; importable under plain Node, since none of it touches `document`.
import { recordDuration } from '../../lib/progress.js';
import { formatUnits, parseUnits, elapsed } from '../../lib/format.js';
import { TX_HASH_RE } from '../../lib/explorer.js';
import { displayMemo } from '../../lib/memo.js';
import { t } from '../../i18n.js';

// Every sentence here is a function (or built inside one), read at each render: the language can
// change while the wallet is up, so nothing is translated at import.
/** What `'proving'` says when this device makes the proof. */
export const DEVICE_PROVING_LABEL = 'Proving the bundle';
export const deviceProvingLabel = () => t('Proving the bundle');

/** What `'proving'` says while this device makes the auth proof, before a prover has the job. */
export const AUTHORISING_LABEL = 'Authorising the spend on this device…';
export const authorisingLabel = () => t('Authorising the spend on this device…');

/**
 * `'proving'`'s label from its `detail` (ui/backend.js, R3): on a paired prover, first that this
 * device is authorising the spend (the auth proof — made here, from the spend key, before the job
 * exists), then where the job waits in the prover's queue, then that the prover is working on it;
 * otherwise the device sentence. The prover's name is the user's own pairing label — shown as
 * text, never markup.
 */
export function provingLabel(detail = {}) {
  const d = detail || {};
  const name = typeof d.prover === 'string' && d.prover ? d.prover : '';
  if (d.authorising === true) return authorisingLabel();
  const position = Number(d.position);
  if (name && Number.isInteger(position) && position >= 1) return t('Waiting at position {position} on {name}', { position, name });
  if (name) return t('Proving on {name}…', { name });
  return deviceProvingLabel();
}

export const PHASE_LABELS = {
  selecting: () => t('Selecting notes'),
  witness: () => t('Building the witness'),
  proving: provingLabel,
  submitting: () => t('Submitting to the node'),
  confirming: () => t('Waiting for the block'),
};

/** The label for `phase` with its `detail`, for any table shaped like `PHASE_LABELS`. */
export function phaseLabel(phase, detail, labels = PHASE_LABELS) {
  const label = labels[phase];
  if (typeof label === 'function') return label(detail || {});
  return label || t('Working');
}

/**
 * The proving step's banner, `{title, text}`, from the store: a proof made by the paired prover
 * survives this window closing (the wallet resumes it until it locks); one made here does not.
 */
export function provingBanner(store, deviceText = t('The proof runs on this device. You can look at other screens — it keeps going — but closing the wallet stops it.')) {
  const name = store && typeof store.proverName === 'string' ? store.proverName : '';
  // A prover was chosen at review (`canProve.via`) but has not taken the job yet: the notes and
  // the witness are still being made here, so the window still matters — but "the proof runs on
  // this device" would be untrue.
  if (!name && store && store.viaProver === true) {
    return {
      title: t('A prover will make the proof'),
      text: t('This device gets the transfer ready, then hands the proof to a prover. Keep the wallet open until the prover has it; you can look at other screens.'),
    };
  }
  if (!name) return { title: t('Keep this window open'), text: deviceText };
  return {
    title: t('A prover is making the proof'),
    text: t('This device authorises the spend; the proof itself is being made by {name}. You can look at other screens '
      + '— it keeps going — and if the wallet closes, opening it again before it locks picks the proof up where it was.', { name }),
  };
}

/**
 * Records a phase and its detail on a send-shaped store; false for a phase `labels` does not know
 * (the caller keeps the last one). The prover's name sticks once reported, so the banner and the
 * later phases keep saying where the proof is.
 */
export function recordPhase(store, phase, detail, labels = PHASE_LABELS) {
  if (!labels[phase]) return false;
  store.phase = phase;
  store.detail = detail && typeof detail === 'object' ? { ...detail } : null;
  if (store.detail && typeof store.detail.prover === 'string' && store.detail.prover) store.proverName = store.detail.prover;
  return true;
}
// Cancel is offered up to, but not including, the moment the transaction leaves this device: once
// the node has it, "cancel" would be a lie.
export const CANCELLABLE = ['selecting', 'witness', 'proving'];
// …and for the same reason, a failure from `'submitting'` onwards does not mean "not sent". The
// transaction may be in a mempool, in a block, or nowhere; this wallet cannot tell, and the one
// thing it must not do is invite the user to send it again.
export const AFTER_BROADCAST = ['submitting', 'confirming'];
export const ADDRESS_DEBOUNCE_MS = 150;
// The English exports are kept for any importer that still reads the old names; screens use the
// functions, which follow the language.
export const SELF_SEND_QUESTION = 'Send to yourself? This consolidates your notes.';
export const UNKNOWN_NOTICE = 'Your last transfer’s outcome is unknown — check Activity first.';
export const UNKNOWN_CONFIRM = 'I checked — it did not go through';
export const selfSendQuestion = () => t('Send to yourself? This consolidates your notes.');
export const unknownNotice = () => t('Your last transfer’s outcome is unknown — check Activity first.');
export const unknownConfirm = () => t('I checked — it did not go through');

// ------------------------------------------------------------------ recipients and the memo ---
// Spec 2026-09-26 §2.3, §3: a memo is at most 510 bytes of UTF-8 — bytes, not characters, so the
// counter reads `TextEncoder`'s length — and a chain that declares no envelope size carries none.
export const MEMO_MAX_BYTES = 510;
export { MEMO_ENVELOPE_BYTES, memoSupportedFor } from '../../lib/memo.js';
export const NO_MEMO_NOTICE = "This network doesn't carry memos; the memo will not be sent";
export const NOT_A_RECIPIENT = 'That is not a shielded address, a randpay: link, or a saved contact.';
export const noMemoNotice = () => t("This network doesn't carry memos; the memo will not be sent");
export const notARecipient = () => t('That is not a shielded address, a randpay: link, or a saved contact.');

/** The memo's length as the chain counts it: UTF-8 bytes. */
export function utf8Length(text) {
  return new TextEncoder().encode(String(text ?? '')).length;
}

/**
 * What a recipient field holds, in the order the CLI's `rand send <to>` tries them: a `rand1…`
 * address, a `randpay:` link, or (anything else) a contact name. Case-insensitive prefixes, like
 * the CLI's and like the contact-name rule that keeps a name from ever looking like either.
 */
export function recipientKind(text) {
  const s = String(text || '').trim();
  if (/^rand1/i.test(s)) return 'address';
  if (/^randpay:/i.test(s)) return 'link';
  return 'name';
}

/**
 * The confirmation every surface shows before a send (spec 2026-09-26 §3), in two lines:
 * `to <contact name, if any> · fingerprint XXXX-XXXX-XXXX-XXXX · <amount> <asset>` — the CLI's
 * form for the recipient, `name · ` omitted when there is no contact — and, below it and on its
 * own, `memoLine`'s `memo "<text>"`. The recipient line never carries memo text (final review,
 * finding 3): a memo from a link is somebody else's words, and on the same line a newline or a
 * bidi control in it could draw a second, fake `to … · fingerprint …` under the real one. Plain
 * text: the caller writes both with `textContent`, never as markup. (`memo` is accepted and
 * ignored, so a caller that still passes it cannot put it back on this line.)
 */
export function confirmationLine({ name = null, fingerprint = null, amount, symbol }) {
  // A contact name is user-entered (and may end in a space): shown through the memo rule and
  // trimmed, so the line never carries a control character or a run of spaces. Four whole
  // sentences rather than fragments, so each language can order its own.
  const who = name ? displayMemo(name).trim() : '';
  if (name && fingerprint) return t('to {name} · fingerprint {fingerprint} · {amount} {symbol}', { name: who, fingerprint, amount, symbol });
  if (name) return t('to {name} · fingerprint unavailable · {amount} {symbol}', { name: who, amount, symbol });
  if (fingerprint) return t('to fingerprint {fingerprint} · {amount} {symbol}', { fingerprint, amount, symbol });
  return t('to fingerprint unavailable · {amount} {symbol}', { amount, symbol });
}

/** The memo's own line on the confirmation: `memo "<text>"`, control and bidi characters shown
 *  as U+FFFD (`displayMemo`), so it is always exactly one line that reads as a memo. */
export function memoLine(memo = '') {
  return t('memo "{memo}"', { memo: displayMemo(memo) });
}

/**
 * The CLI's merge rule for a value that can come from the form and from a `randpay:` link: agree
 * if both are given, either alone if only one is. `same(a, b)` decides agreement (units for an
 * amount, exact text for a memo). Returns `{value}` or `{conflict: true}`.
 */
export function mergeWithLink(typed, fromLink, same = (a, b) => a === b) {
  const t = typed === undefined || typed === null ? '' : String(typed);
  const l = fromLink === undefined || fromLink === null ? '' : String(fromLink);
  if (t && l && !same(t, l)) return { conflict: true };
  return { value: t || l };
}

/** "1 proof · about 2 minutes on this computer" — from the estimate, not from a constant. Roughly
 *  two minutes of native proving per proof; a withdrawal needs two, a transfer one. `via` is
 *  `canProve`'s: `'prover'` when a prover makes them (the RandProtocol provers or a paired one),
 *  which a browser that cannot prove a transfer always uses — "on this computer" would be untrue. */
export function proveCost(proofs, via) {
  const n = Number.isFinite(Number(proofs)) && Number(proofs) >= 1 ? Math.floor(Number(proofs)) : 1;
  const minutes = n * 2;
  if (via === 'prover') {
    return n === 1
      ? t('{n} proof · about {minutes} minutes on the prover', { n, minutes })
      : t('{n} proofs · about {minutes} minutes on the prover', { n, minutes });
  }
  return n === 1
    ? t('{n} proof · about {minutes} minutes on this computer', { n, minutes })
    : t('{n} proofs · about {minutes} minutes on this computer', { n, minutes });
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

/**
 * Whether a failure left a remote proof pending that the user can Resume or Cancel: a paired
 * prover that ran out of time (`err.proverSilent`, the record kept — `engine/prover.js`).
 */
export function resumableFailure(err) {
  return !!err && err.proverSilent === true;
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
    return t('This device ran out of memory while proving. A transfer proof needs about 6.2 GB and a '
      + 'browser gives WebAssembly at most 4 GB. Your notes are untouched — send from the desktop '
      + 'app, which proves natively.');
  }
  return text || t('The transfer could not be proved.');
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
    // `memo` is what will be sealed with the payment; `link` the parsed `randpay:` link the
    // recipient field holds, if any; `recipient` what the last check resolved it to —
    // `{address, name, fingerprint}` — which is what a send is addressed to.
    draft = {
      assetIndex, to: '', amount: '', memo: '', link: null, linkText: '', recipient: null,
      selfConfirmed: false, estimate: null, knownFee: null,
    };
    ctx.state.sendDraft = draft;
  }
  return draft;
}

// ------------------------------------------------------------- the unknown-outcome record ------
/**
 * A transfer whose fate this wallet could not establish leaves a mark on the session: a standing
 * warning on every step of the flow, and an explicit "I checked" in front of proving again.
 *
 * It is lifted by exactly one thing — **a scan that started after the failure and then fulfilled**
 * — whoever started it: Check Activity, or simply going to home, which scans on mount. Both halves
 * of that rule matter:
 *   * *started after*, because a scan already running when the transfer failed may have read the
 *     chain before the transaction ever reached it, so its finishing proves nothing;
 *   * *fulfilled*, because a scan that failed or was aborted read nothing at all.
 * The shell counts both (`ctx.state.scansStarted` / `scansConfirmed`, see ui/app.js); this only has
 * to remember which ordinal it was at. Nothing secret is in the record.
 */
export function markUnknownOutcome(ctx, { hash = null } = {}) {
  ctx.state.sendUnknown = {
    hash: safeHash(hash),
    atMs: Date.now(),
    atStarted: ctx.state.scansStarted || 0,
  };
  return ctx.state.sendUnknown;
}

/** The standing record, or `null` once a later scan has settled the question. */
export function unknownOutcome(ctx) {
  const record = ctx.state.sendUnknown;
  if (!record) return null;
  return (ctx.state.scansConfirmed || 0) > record.atStarted ? null : record;
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
  return launchSend(ctx, {
    req,
    asset,
    run: (onPhase, options) => ctx.backend.send.send(req, onPhase, options),
  });
}

/**
 * Carries on a remote proof left pending (`send.pending()` → `pending`, a popup closed mid-proof)
 * through `send.resume`, on the same store a fresh send uses — so the chip, Cancel and the receipt
 * all work as they do for one. Nothing about the transfer's amount or recipient is known here (the
 * engine keeps them); the receipt shows what it can.
 */
export function resumeSend(ctx, pending) {
  const startedAt = Number(pending && pending.startedAt);
  return launchSend(ctx, {
    req: { asset: null, amount: null, to: null },
    asset: { symbol: '', decimals: 0 },
    phase: 'proving',
    detail: pending && pending.name ? { prover: String(pending.name) } : null,
    startedMs: Number.isFinite(startedAt) && startedAt > 0 && startedAt <= Date.now() ? startedAt : Date.now(),
    resumed: true,
    run: (onPhase, options) => ctx.backend.send.resume(onPhase, options),
  });
}

function launchSend(ctx, { req, asset, run, phase = 'selecting', detail = null, startedMs = Date.now(), resumed = false }) {
  const session = ctx.session;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const store = {
    sessionId: session.id,
    phase,
    detail: null,
    proverName: null,
    resumed,
    startedMs,
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
    // What the progress estimate is timed against (ui/lib/progress.js).
    kind: Number(req && req.asset) > 0 ? 'transfer-token' : 'transfer',
  };
  if (detail) recordPhase(store, phase, detail);
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
  const paintChip = () => ctx.setPinnedChip({ text: t('Proving… {elapsed}', { elapsed: elapsed(Date.now() - store.startedMs) }), go: 'send' });
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

  const onPhase = (phase, phaseDetail) => {
    if (ctx.session.id !== session.id) return;
    // A phase this build does not know: keep the last one.
    if (!recordPhase(store, phase, phaseDetail)) return;
    fan();
  };

  const finish = () => {
    store.done = true;
    stopTicker();
  };

  // The settle handler runs whatever screen happens to be mounted — including none of this flow's
  // — so everything that must happen exactly once happens here, not in a screen's listener.
  const p = new Promise((resolve) => { resolve(run(onPhase, controller ? { signal: controller.signal } : undefined)); })
    .then(
      (result) => {
        const hash = safeHash(result && result.hash);
        store.hash = hash;
        // A whole run on this device teaches the estimate; a resumed one started elsewhere.
        if (hash && !store.resumed) recordDuration(store.kind, Date.now() - store.startedMs);
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
          if (hash) ctx.setPinnedChip({ text: t('Sent — view'), go: `sent/${hash}`, kind: 'positive' });
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
  if (!raw0) return { error: t('Enter an amount to send.') };
  let units;
  try {
    units = parseUnits(raw0, asset.decimals);
  } catch (err) {
    const message = (err && err.message) || '';
    if (/decimal places/.test(message)) return { error: t('{symbol} has {decimals} decimal places — that is more.', { symbol: asset.symbol, decimals: asset.decimals }) };
    return { error: t('Enter the amount as a number, for example 1.25.') };
  }
  if (units <= 0n) return { error: t('Enter an amount greater than zero.') };
  const balance = BigInt(asset.balance || '0');
  if (units > balance) {
    return { error: t('That is more than your balance of {balance} {symbol}.', { balance: formatUnits(balance, 6, asset.decimals), symbol: asset.symbol }) };
  }
  if (fee !== null && units + fee > balance) {
    return { error: t('The amount plus the {fee} {symbol} network fee is more than your balance.', { fee: formatUnits(fee, 9, asset.decimals), symbol: asset.symbol }) };
  }
  return { units };
}
