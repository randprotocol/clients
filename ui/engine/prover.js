// Delegated proving (spec docs/superpowers/specs/2026-09-28-delegated-proving-design.md): the
// wallet's side of a paired `rand-prover`. Phase 2 (split authorisation, every chain since 17):
// the job the core seals carries the viewing key, not the spend key, and the transaction's auth
// proof is already made, on this device, before `remoteProve` is called. Three things, and none of
// them chain crypto:
//
//   * `checkProverUrl`   the URL rule a prover is held to — the node's (`screens/settings.js`'s
//                        `checkRpcUrl`): https anywhere, plain http only to this machine.
//   * `makeProverClient` a JSON-RPC client for the prover's four methods (`prover_info`,
//                        `prover_submit [sealed_hex]`, `prover_status [job]`, `prover_cancel [job]`,
//                        positional params — fullnode spec §3.2), over the engine's INJECTED `fetch`
//                        so every byte it sends is where the key-leak probes look. The pairing token
//                        is not a parameter: it travels only inside the sealed job, never in clear.
//   * `remoteProve`      submit a job the core sealed (`prepare_transfer` / `prepare_burn`), remember
//                        it in `storage.session` (plan ruling R1: `pending` carries no spend key), poll
//                        until the prover answers, and hand the reply to the core's `finish_proof` —
//                        which opens it, checks the digest and the size and verifies the proof. A
//                        reply that fails any of that never reaches `rand_sendTransaction`: the core
//                        refuses and this file turns the refusal into a definite error.
//
// Parsing a pairing link and a prover's fingerprint are the core's (`parse_prover_link`,
// `prover_fingerprint`): no base58 and no blake3 are re-implemented here.

import { urlRule } from '../lib/url-rule.js';
import { t } from '../i18n.js';
import { translateCoreError } from './core-errors.js';

/** The session-storage key the one pending remote proof lives under (see `remoteProve`). */
export const PENDING_PROOF_KEY = 'pendingProof';
/**
 * The session-storage key of the last job a window CLAIMED for submission (`claimRecord`): a job
 * id and nothing else. Deliberately not cleared on lock, so a window that finds the pending record
 * gone can tell "another window took it" (maybe submitted — never retry) from "a lock removed it"
 * (nothing was sent).
 */
export const CLAIMED_PROOF_KEY = 'claimedProof';
/** The Web Lock name the claim is serialised under, across every tab and popup of the wallet. */
export const CLAIM_LOCK = 'rand-pending-proof';

/** The prover's JSON-RPC error codes this wallet reads (fullnode `randprotocol-prover::http`). */
export const PROVER_UNKNOWN_JOB = -32001;
export const PROVER_UNPAIRED = -32003;
export const PROVER_WITNESS_KIND = -32004;
export const PROVER_BUSY = -32005;
export const PROVER_FEE = -32006;

const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_POLL_MS = 1000;
/**
 * How long a job may sit in the prover's QUEUE before the wallet stops waiting (the record stays,
 * so it can be resumed). The bound is sized for a shared `rand-prover` with many pairings: one
 * worker and a queue of 8 at ~2 min a proof puts position 8 ~16 min from its own proof. (The
 * desktop host holds at most 2 jobs per token, so one wallet paired with it never waits that long.)
 */
export const MAX_QUEUE_WAIT_MS = 30 * 60 * 1000;
/** How long one job may be PROVING — its clock restarts when it leaves the queue. */
export const MAX_PROVING_MS = 20 * 60 * 1000;
/** Kept for callers of the old name: the proving bound. */
export const DEFAULT_MAX_WAIT_MS = MAX_PROVING_MS;

/** A prover's refusal or silence. `failure` is set only where no JSON-RPC reply existed at all. */
export class ProverError extends Error {
  constructor(message, { code, data, failure } = {}) {
    super(message);
    this.name = 'ProverError';
    if (code !== undefined) this.code = code;
    if (data !== undefined) this.data = data;
    if (failure) this.failure = failure;
  }
}

function definite(message, extra = {}) {
  const err = new Error(message);
  err.definite = true;
  Object.assign(err, extra);
  return err;
}

function abortError() {
  const err = new Error(t('The operation was aborted.'));
  err.name = 'AbortError';
  return err;
}

/**
 * `{url}` (trimmed, no trailing slash) or `{error}` — `checkRpcUrl`'s rule, for a prover: a sealed
 * job is opaque to a network, but its status and reply are not something a network should be able
 * to rewrite or observe on their way to somebody else's machine. Unlike the RPC field, empty is an
 * error: a pairing without a URL names nothing.
 */
export function checkProverUrl(text) {
  const r = urlRule(text);
  if (r.url) return { url: r.url };
  if (r.empty) return { error: t('The pairing link has no prover address.') };
  if (r.problem === 'not-url') return { error: t('The pairing link\'s prover address is not a URL.') };
  if (r.problem === 'plain-http') return { error: t('Use https for a prover — plain http is only allowed for a prover on this machine.') };
  return { error: t('A prover address must be https://.') };
}

/**
 * A client for ONE prover URL. `info()`, `submit(sealedHex)` → job id, `status(job)` →
 * `{state, position?, reply?, error?}`, `cancel(job)`. Rejects with a `ProverError`: `code` for a
 * JSON-RPC error reply, `failure` (`'connect' | 'timeout' | 'http' | 'body'`) where there was none.
 */
export function makeProverClient({ fetch: fetchImpl, url, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('makeProverClient needs a fetch');
  const checked = checkProverUrl(url);
  if (checked.error) throw new Error(checked.error);
  const target = checked.url;
  let seq = 0;

  async function call(method, params = [], { signal } = {}) {
    if (signal && signal.aborted) throw abortError();
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    let body;
    try {
      seq += 1;
      const res = await doFetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: seq, method, params }),
        signal: ctl.signal,
      });
      try {
        body = await res.json();
      } catch (e) {
        if (timedOut || e?.name === 'AbortError') throw e;
        throw new ProverError(t('the prover at {url} did not answer with JSON-RPC (HTTP {status})', { url: target, status: res.status }), { failure: res.ok ? 'body' : 'http' });
      }
    } catch (e) {
      if (e instanceof ProverError) throw e;
      if (signal && signal.aborted) throw abortError();
      const out = timedOut || e?.name === 'AbortError';
      throw new ProverError(t('cannot reach the prover at {url}: {reason}', { url: target, reason: out ? t('timed out') : e?.message || e }), { failure: out ? 'timeout' : 'connect' });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    if (!body || typeof body !== 'object') throw new ProverError(t('the prover at {url} did not answer with JSON-RPC', { url: target }), { failure: 'body' });
    if (body.error) {
      const e = body.error;
      throw new ProverError(String(e.message || 'prover error'), { code: e.code, data: e.data });
    }
    return body.result;
  }

  return Object.freeze({
    url: target,
    info: (options) => call('prover_info', [], options),
    async submit(sealedHex, options) {
      const r = await call('prover_submit', [String(sealedHex)], options);
      const job = r && r.job;
      if (typeof job !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(job)) {
        throw new ProverError(t('the prover accepted the job but named no job id'), { failure: 'body' });
      }
      return job;
    },
    status: (job, options) => call('prover_status', [String(job)], options),
    cancel: (job, options) => call('prover_cancel', [String(job)], options),
  });
}

/**
 * The prover's refusal in the user's words, as a definite error (nothing reached the node).
 * Transport failures are left alone: whether to retry them is the caller's decision.
 */
export function proverRefusal(err) {
  if (!(err instanceof ProverError) || err.failure) return err;
  if (err.code === PROVER_BUSY) {
    const depth = Number(err.data && err.data.depth);
    const n = Number.isSafeInteger(depth) && depth >= 0 ? depth : '?';
    return definite(t('The prover is full ({n} waiting). Try again in a few minutes.', { n }), { busy: true });
  }
  if (err.code === PROVER_UNPAIRED) {
    return definite(t('This prover does not know this pairing. Pair it again in Settings.'), { unpaired: true });
  }
  if (err.code === PROVER_WITNESS_KIND) {
    const reason = err.data && typeof err.data.reason === 'string' ? err.data.reason.slice(0, 200) : '';
    return definite(reason
      ? t('This prover does not accept this kind of job ({reason}). Pair another prover in Settings, or send from the desktop app.', { reason })
      : t('This prover does not accept this kind of job. Pair another prover in Settings, or send from the desktop app.'));
  }
  if (err.code === PROVER_FEE) {
    return definite(t('This prover charges a fee, which this version of the wallet does not pay. Pair a prover that charges nothing, or send from the desktop app.'));
  }
  if (err.code === PROVER_UNKNOWN_JOB) {
    return definite(t('The prover no longer has this proof (it restarted or the job expired). Send again.'));
  }
  const reason = err.data && typeof err.data.reason === 'string' ? err.data.reason : '';
  return definite(reason
    ? t('The prover refused the job ({error}: {reason}).', { error: err.message, reason })
    : t('The prover refused the job ({error}).', { error: err.message }));
}

/** `info()`, checked just enough to use: `{ok: true, queue, witnessKinds, fee, hcBundles, kemFingerprint, kemEk}`. */
export function readInfo(info) {
  if (!info || typeof info !== 'object') throw new ProverError(t('the prover\'s info is not an object'), { failure: 'body' });
  const q = info.queue && typeof info.queue === 'object' ? info.queue : {};
  const num = (v) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  return {
    kemFingerprint: typeof info.kem_fingerprint === 'string' ? info.kem_fingerprint : '',
    kemEk: typeof info.kem_ek === 'string' ? info.kem_ek.toLowerCase() : '',
    witnessKinds: Array.isArray(info.witness_kinds) ? info.witness_kinds.filter((k) => typeof k === 'string') : [],
    hcBundles: Array.isArray(info.hc_bundles) ? info.hc_bundles.filter((k) => typeof k === 'string') : [],
    queue: { depth: num(q.depth), max: num(q.max), proving: num(q.proving) },
    fee: info.fee ?? null,
  };
}

const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) { reject(abortError()); return; }
  const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(abortError()); };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
});

async function readRecord(storage) {
  try { return (await storage.session.get(PENDING_PROOF_KEY)) || null; } catch { return null; }
}

/**
 * Serialises `work` against every other claim: across windows through the Web Locks API (the
 * backend's `locks`), and within this JavaScript realm through a promise chain, which is also the
 * whole story where there is no Web Locks API (Node, tests).
 */
let localClaims = Promise.resolve();
function exclusively(locks, work) {
  const run = () => (locks && typeof locks.request === 'function'
    ? locks.request(CLAIM_LOCK, { mode: 'exclusive' }, work)
    : work());
  const result = localClaims.then(run, run);
  localClaims = result.then(() => {}, () => {});
  return result;
}

/**
 * Takes `job` for submission **exactly once**. Inside one exclusive section: the pending record
 * must still name this job; it is removed and the job written as claimed. Anyone else — a second
 * tab resuming the same job, a popup that was only asleep — finds the record gone and gets the
 * rejection below, which is `definite: false` on purpose: the other window may already have put
 * this transaction on the wire, and a "retry" here would select other notes and pay twice.
 */
async function claimRecord(storage, job, locks) {
  const verdict = await exclusively(locks, async () => {
    const current = await readRecord(storage);
    if (current && current.job === job) {
      // The marker FIRST, and confirmed, before the record goes: a window that later finds the
      // record gone reads the marker to tell "someone submitted it" from "nothing was sent". A
      // removal without a marker would tell it "nothing was sent" while this window submits.
      let marked = false;
      try {
        await storage.session.set(CLAIMED_PROOF_KEY, job);
        marked = (await storage.session.get(CLAIMED_PROOF_KEY)) === job;
      } catch { marked = false; }
      if (!marked) return 'unmarked';
      await storage.session.remove(PENDING_PROOF_KEY);
      return 'mine';
    }
    let claimed = null;
    try { claimed = await storage.session.get(CLAIMED_PROOF_KEY); } catch { claimed = null; }
    return claimed === job ? 'taken' : 'gone';
  });
  if (verdict === 'mine') return;
  if (verdict === 'unmarked') {
    // The record is left where it was, so Resume can try again. Not definite: this window could
    // not tell whether another one is about to submit it.
    const err = new Error(t('Could not claim the proof; check Activity before sending again.'));
    err.definite = false;
    err.claimFailed = true;
    throw err;
  }
  if (verdict === 'taken') {
    const err = new Error(t('This proof was already submitted from another window. Check Activity before sending again.'));
    err.definite = false;
    err.alreadySubmitted = true;
    throw err;
  }
  // Nobody claimed it: the record went with a lock, a cancel from another window, or a newer
  // record in its place while the prover worked, and nothing was submitted by anyone.
  const err = new Error(t('The pending proof was cleared (the wallet locked, or it was cancelled elsewhere), so nothing was sent. Send again.'));
  err.definite = true;
  err.pendingLost = true;
  throw err;
}

async function removeRecord(storage, job) {
  const rec = await readRecord(storage);
  if (rec && (job === undefined || rec.job === job)) {
    try { await storage.session.remove(PENDING_PROOF_KEY); } catch { /* already gone */ }
  }
}

/** How many times a job is offered when the prover could not be reached at all (`startRemoteProof`). */
export const SUBMIT_TRIES = 3;
/** The waits between those tries. */
export const SUBMIT_BACKOFF_MS = Object.freeze([1000, 3000]);

/** A submit that failed before the prover answered anything: no connection, or an HTTP error page. */
function submitRetryable(err) {
  return err instanceof ProverError && (err.failure === 'connect' || err.failure === 'http');
}

/**
 * Submit a prepared job and remember it. `prepared` is the core's `prepare_*` reply
 * (`{sealed_hex, pending, expected}`); `meta` is what the submission needs afterwards and is not in
 * `pending` (`kind`, the transfer's `to` and `memo`, the prover's `name`). Returns the record.
 *
 * The record is written to `storage.session` — memory only, cleared on lock, the same place the
 * unlocked spend key lives — and it holds no spend key (the core's `pending` is asserted to carry
 * none). It is what lets a popup closed mid-proof pick the same job up again (`pollRemoteProof`).
 */
export async function startRemoteProof({
  client, prepared, storage, meta = {}, signal, now = Date.now,
  sleep = defaultSleep, submitTries = SUBMIT_TRIES, submitBackoff = SUBMIT_BACKOFF_MS,
}) {
  if (!prepared || typeof prepared.sealed_hex !== 'string' || !prepared.pending) {
    throw definite(t('The wallet could not seal this transfer for the prover.'));
  }
  let job;
  for (let attempt = 1; ; attempt += 1) {
    try {
      job = await client.submit(prepared.sealed_hex, { signal });
      break;
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      // A transport failure before any JSON-RPC reply — the connection failed, or an HTTP error
      // page came back instead of an answer — means the prover accepted nothing, so the same
      // sealed job is offered again, a bounded number of times. A JSON-RPC error is the prover's
      // answer and is final; a reply that named no job id, or a timeout (the prover may have
      // taken it), is never resubmitted; and once a job id came back there is no loop left.
      if (submitRetryable(err) && attempt < submitTries) {
        await sleep(submitBackoff[Math.min(attempt - 1, submitBackoff.length - 1)] ?? 0, signal);
        continue;
      }
      // Nothing reached the node, whatever the prover said or did not say.
      const refusal = proverRefusal(err);
      if (refusal !== err) throw refusal;
      throw definite(t('Could not hand the proof to the prover: {reason}', { reason: err && err.message }));
    }
  }
  const record = { job, pending: prepared.pending, url: client.url, startedAt: now(), ...meta };
  await storage.session.set(PENDING_PROOF_KEY, record);
  return record;
}

/**
 * Poll `record.job` until the prover answers, then open the reply through the core. Resolves with
 * `finish_proof`'s result — the ProveResult or BurnResult `prove_*` would have returned — after
 * **claiming** the job (`claimRecord`, serialised through `locks`): exactly one window ever gets
 * past it, and every other rejects (`definite: false`) rather than submit a second time.
 *
 * `onPhase('prove', {position, prover})` while queued, `onPhase('prove', {prover})` while proving,
 * each only when it changes. Each state has its own clock: a job may wait `maxQueueWait` in the
 * queue, and `maxWait` once it is proving (the clock restarts when it leaves the queue), so a deep
 * but moving queue is not mistaken for a stuck prover. Transport failures are retried within the
 * current state's bound (the prover may be restarting); a JSON-RPC error stops. Running out of
 * either bound rejects `proverSilent` and KEEPS the record, so the job can be resumed or
 * cancelled. `signal` aborts with `prover_cancel` and forgets the record.
 */
export async function pollRemoteProof({
  client, core, record, storage, onPhase, signal, locks, announced,
  poll = DEFAULT_POLL_MS, maxWait = MAX_PROVING_MS, maxQueueWait = MAX_QUEUE_WAIT_MS,
  now = Date.now, sleep = defaultSleep,
}) {
  const { job, name } = record;
  // `stage` is what the prover last said: 'queued' until it says 'proving'. The clock is the
  // stage's own, restarted on the move.
  let stage = 'queued';
  let started = now();
  const bound = () => (stage === 'proving' ? maxWait : maxQueueWait);
  const minutes = (ms) => Math.round(ms / 60000);
  const outOfTime = (silent) => definite(
    silent
      ? t('Your prover has not answered for {n} minutes. Resume later, or cancel.', { n: minutes(bound()) })
      : stage === 'proving'
        ? t('Your prover has not finished after {n} minutes of proving. Resume later, or cancel.', { n: minutes(maxWait) })
        : t('Your prover has not started this proof after {n} minutes in its queue. Resume later, or cancel.', { n: minutes(maxQueueWait) }),
    { proverSilent: true },
  );
  // `announced` is the detail the caller already reported, so it is not reported twice.
  let last = announced === undefined ? '' : JSON.stringify(announced);
  const say = (detail) => {
    const key = JSON.stringify(detail);
    if (key === last) return;
    last = key;
    if (typeof onPhase === 'function') onPhase('prove', detail);
  };
  const cancel = async () => {
    try { await client.cancel(job); } catch { /* best effort: the job expires on the prover anyway */ }
    await removeRecord(storage, job);
  };
  const giveUp = async (err) => { await removeRecord(storage, job); return err; };

  for (;;) {
    if (signal && signal.aborted) { await cancel(); throw abortError(); }
    let st;
    try {
      st = await client.status(job, { signal });
    } catch (err) {
      if (err && err.name === 'AbortError') { await cancel(); throw err; }
      if (err instanceof ProverError && err.failure) {
        if (now() - started >= bound()) {
          // The record stays: the job may still finish, and `send.resume` can pick it up.
          throw outOfTime(true);
        }
        try { await sleep(poll, signal); } catch (e) { await cancel(); throw e; }
        continue;
      }
      throw await giveUp(proverRefusal(err));
    }
    const state = st && st.state;
    if (state === 'queued') {
      const p = Number(st.position);
      say({ position: Number.isSafeInteger(p) && p > 0 ? p : 1, prover: name });
    } else if (state === 'proving') {
      if (stage !== 'proving') { stage = 'proving'; started = now(); }
      say({ prover: name });
    } else if (state === 'done') {
      if (typeof st.reply !== 'string' || !st.reply) throw await giveUp(definite(t('The prover finished but sent no proof.')));
      let res;
      try {
        res = await core.call('finish_proof', { pending: record.pending, reply_hex: st.reply });
      } catch (err) {
        // A reply for another transaction, an oversized proof, one that does not verify: the core
        // refused, and none of it goes near the node.
        throw await giveUp(definite(t('The prover\'s proof was refused by this wallet: {reason}', { reason: translateCoreError(err && err.message) }), { badProof: true }));
      }
      await claimRecord(storage, job, locks);
      return res;
    } else if (state === 'failed' || state === 'expired') {
      const why = typeof st.error === 'string' && st.error ? st.error : '';
      throw await giveUp(definite(why
        ? t('The prover could not make this proof ({state}: {reason}).', { state, reason: why })
        : t('The prover could not make this proof ({state}).', { state })));
    } else {
      throw await giveUp(definite(t('The prover answered with an unknown state ({state}).', { state: String(state).slice(0, 32) })));
    }
    if (now() - started >= bound()) throw outOfTime(false);
    try { await sleep(poll, signal); } catch (e) { await cancel(); throw e; }
  }
}

/** `startRemoteProof` then `pollRemoteProof`: the whole remote proof for a fresh send. */
export async function remoteProve({ client, core, prepared, storage, meta = {}, onPhase, signal, locks, poll, maxWait, maxQueueWait, now, sleep }) {
  // Reported before the submit, so even a job the prover answers `done` at once shows the phase.
  const announced = { prover: meta.name };
  if (typeof onPhase === 'function') onPhase('prove', announced);
  const record = await startRemoteProof({ client, prepared, storage, meta, signal, now, ...(sleep ? { sleep } : {}) });
  return pollRemoteProof({ client, core, record, storage, onPhase, signal, locks, announced, poll, maxWait, maxQueueWait, now, sleep });
}

/** The pending record, or `null`. */
export function pendingProof(storage) {
  return readRecord(storage);
}

/** Cancel the pending job (best effort) and forget it. */
export async function cancelPendingProof({ storage, fetch: fetchImpl }) {
  const rec = await readRecord(storage);
  if (!rec) return false;
  try { await makeProverClient({ fetch: fetchImpl, url: rec.url }).cancel(rec.job); } catch { /* expired or unreachable */ }
  await removeRecord(storage, rec.job);
  return true;
}
