// JSON-RPC 2.0 over HTTP to a rand-node. One request per POST; errors carry the node's message.
//
// Storage- and platform-agnostic (task 1.6): `fetch` is injectable, so this file runs unchanged in
// a page, in a browser-extension service worker and under plain Node in a test. Nothing here knows
// where the URL came from or where the answer is kept.
//
// ---------------------------------------------------------------- several endpoints (task 5.0) --
//
// `makeRpc` takes a LIST of URLs now. The default set is three hosts, so one of them being down is
// not the wallet being down. The whole difficulty is that failover must not become a hole in
// task 1.6's node-trust boundary, whose one rule is:
//
//     a verified chain is a property of ONE CLIENT OBJECT bound to ONE URL, resolved once per
//     operation  (`requireVerifiedChain`, ui/engine/backend-shared.js)
//
// A client that quietly rerouted a request from a dead `rpc1` to `rpc2` *in the middle of* a scan
// or a send would let the wallet trust data from a node the gate never asked anything. So there
// are two kinds of client here and the difference is structural, not a flag someone remembers to
// set:
//
//   * a POOL client  — what `makeRpc(urls)` returns. It knows the whole list, it fails over, and
//                      it is what a *new* operation acquires a client FROM.
//   * a PINNED client — what `pool.acquire()` returns. It closes over exactly one URL string,
//                      its `url` is a plain data property, and **it contains no failover code
//                      path at all**: a transport failure on it throws, exactly as a single-URL
//                      client has always thrown. There is no way to make one talk to a second
//                      host, because it never learned about any.
//
// `backend-shared.js`'s `rpcClient()` hands out PINNED clients, so everything downstream of it —
// `requireVerifiedChain()`, `scan`, `rescan`, `executeSend`, `executeWithdraw` — pins exactly as
// it did when there was only ever one URL, and `client.url` still means "the one URL this client
// object trusts" for the whole life of that object. Failover therefore happens BETWEEN operations
// (the next `acquire()` picks a different endpoint), never inside one.
//
// Acquisition is also where this file does its own cheap sanity check: before an endpoint is
// handed out it must answer `rand_chainId` (and `rand_getGenesisHash`, when an expected genesis
// was configured) for the expected chain. That is NOT a replacement for `chainIdentity` /
// `chainVerdict` — those still gate every operation that acts on the notes, and they are what
// judges the endpoint this file hands back. It exists to keep a permanently-wrong-chain endpoint
// out of the failover rotation entirely, so a healthy `rpc3` is preferred over a misconfigured
// `rpc2` without the user ever being shown a refusal.
export class RpcError extends Error {
  /**
   * `code` is the node's own JSON-RPC error code, or **-1** for "no usable answer came back".
   * Callers depend on that: `chainIdentity` (engine/wallet.js) reads `code !== -1` as "the node
   * answered, even if with a refusal".
   *
   * `failure` refines the -1 case and exists for exactly one decision — whether repeating the
   * request on another endpoint is safe:
   *   'connect'  nothing was ever sent (DNS, TLS, connection refused). Safe to repeat anywhere.
   *   'timeout'  something may well have been received and acted on. NEVER safe to repeat for a
   *              submission: a timed-out `rand_sendTransaction` may have landed.
   *   'http'     the endpoint answered with a status, not a JSON-RPC reply.
   *   'body'     the endpoint answered with something that is not a JSON-RPC reply at all.
   */
  constructor(message, code, failure) {
    super(message);
    this.code = code;
    if (failure) this.failure = failure;
  }
}

/**
 * The only method names a wallet may put on the wire. The node's namespace is `rand_`
 * (`wallet-core`'s own `RPC_NAMESPACE`) and the bridge's is `bridge_`; anything else is a caller
 * mistake or an attempt to use the wallet as a general-purpose HTTP client for some other RPC on
 * the same host, and is refused before a request is built.
 */
export const RPC_METHOD_RE = /^(?:rand|bridge)_[A-Za-z][A-Za-z0-9]*$/;

export function isAllowedRpcMethod(method) {
  return typeof method === 'string' && RPC_METHOD_RE.test(method);
}

/**
 * The two methods that CHANGE the chain. A failure after the request left this machine may still
 * have been executed by the node that received it, so repeating one on a second endpoint risks a
 * double-send — a second transfer, or a second faucet mint. They are repeated elsewhere only when
 * the failure proves nothing was sent (`failure: 'connect'`), and never after a timeout.
 */
export const SUBMIT_METHODS = Object.freeze(['rand_sendTransaction', 'rand_mint']);
const SUBMITS = new Set(SUBMIT_METHODS);

/** The shape ui/ recognises as "this was cancelled", not "the node failed" (see ui/backend.js). */
function abortError() {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/** One trailing-slash-normalised, de-duplicated, non-empty list, from a string or an array. */
export function rpcUrlList(urls) {
  const raw = Array.isArray(urls) ? urls : [urls];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const url = item.trim().replace(/\/+$/, '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * Whether a failed attempt may be repeated on a DIFFERENT endpoint.
 *
 * A JSON-RPC error reply is an answer — the node understood the request and said no — so it is
 * never repeated anywhere: asking a second node the same question it already got a definite
 * answer to is how a wallet shops for the reply it likes.
 */
function mayRetryElsewhere(err, method) {
  if (!err || err.code !== -1) return false;           // an answer, or not ours at all
  if (SUBMITS.has(method)) return err.failure === 'connect';
  if (err.failure === 'http') return err.status === undefined || err.status >= 500 || err.status === 408 || err.status === 429;
  return true; // 'connect', 'timeout', 'body'
}

/**
 * `makeRpc(urls, {timeoutMs, fetch, chainId, genesis})` — a client for one node, or a pool over
 * several.
 *
 * `urls` is a URL or a list of them, tried in order starting from the last one that worked.
 * `fetch` defaults to the global. `chainId`/`genesis` are what an endpoint must report before this
 * file will hand it out (see the header); either may be omitted, and with a single URL no probe is
 * ever made — there is nothing to fail over to, and the wallet's own `chainIdentity` check gates
 * the endpoint anyway.
 *
 * Every call takes an optional `{signal}`: it is composed with the per-request timeout, and an
 * abort that came from the *caller's* signal is reported as an `AbortError` (which the UI treats
 * as "no longer wanted") rather than as a node failure.
 */
export function makeRpc(urls, { timeoutMs = 20000, fetch: fetchImpl, chainId, genesis } = {}) {
  const doFetch = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  if (!doFetch) throw new Error('no fetch implementation available');
  const list = rpcUrlList(urls);
  if (list.length === 0) throw new Error('makeRpc needs at least one node URL');

  const expected = {
    chainId: chainId === undefined || chainId === null || chainId === '' ? null : String(chainId),
    genesis: typeof genesis === 'string' && genesis ? genesis : null,
  };

  // Per-endpoint memory, for this client object only — never persisted, never shared between
  // clients. 'wrong' is sticky for the life of this object (a node does not wander onto the right
  // chain); 'down' and 'mute' are cleared whenever a whole pass finds nothing usable, so an
  // endpoint that recovers comes back.
  const state = new Map(); // url -> 'ok' | 'wrong' | 'down' | 'mute'
  const why = new Map();   // url -> the sentence that goes in the error
  let current = 0;

  // ------------------------------------------------------------------------------ one request ---
  /** One POST to ONE url. Never falls over to another: this is the only place bytes are sent. */
  async function request(url, method, params = [], { signal } = {}) {
    if (!isAllowedRpcMethod(method)) throw new RpcError(`${method} is not allowed from this wallet`, -32601);
    if (signal && signal.aborted) throw abortError();
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    let res;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctl.signal,
      });
    } catch (e) {
      if (signal && signal.aborted) throw abortError();
      // `timedOut` is the ONLY reliable way to tell "we waited and heard nothing" from "the
      // connection was refused before a byte left" — both surface as an AbortError from `fetch`.
      // The submission rule below turns on exactly that distinction.
      const out = timedOut || e?.name === 'AbortError';
      throw new RpcError(`cannot reach ${url}: ${out ? 'timed out' : e?.message || e}`, -1, out ? 'timeout' : 'connect');
    } finally {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    if (!res.ok) {
      const err = new RpcError(`${url} answered HTTP ${res.status}`, -1, 'http');
      err.status = res.status;
      throw err;
    }
    let body;
    try {
      body = await res.json();
    } catch {
      // A proxy's HTML error page, or a truncated reply. The node has not identified itself and
      // has not answered, so this is a transport failure (-1), not a refusal from the node.
      throw new RpcError(`${url} did not answer with JSON-RPC`, -1, 'body');
    }
    if (!body || typeof body !== 'object') throw new RpcError(`${url} did not answer with JSON-RPC`, -1, 'body');
    if (body.error) throw new RpcError(body.error.message || 'rpc error', body.error.code);
    return body.result;
  }

  // ----------------------------------------------------------------------------- the endpoints --
  function order() {
    const out = [];
    for (let i = 0; i < list.length; i += 1) out.push(list[(current + i) % list.length]);
    return out;
  }

  function note(url, mark, reason) {
    state.set(url, mark);
    if (reason) why.set(url, reason); else why.delete(url);
  }

  function select(url) {
    const at = list.indexOf(url);
    if (at >= 0) current = at;
  }

  /** Clears the failures that may be temporary, so the next pass asks again. Keeps 'wrong'. */
  function forgetTransientFailures() {
    for (const [url, mark] of [...state]) {
      if (mark !== 'wrong') { state.delete(url); why.delete(url); }
    }
  }

  /** `[{url, reason}]` for every endpoint this pass refused to use — named in the error. */
  function skippedNotes(exclude) {
    const out = [];
    for (const url of list) {
      if (url === exclude) continue;
      const mark = state.get(url);
      if (!mark || mark === 'ok') continue;
      out.push({ url, reason: why.get(url) || mark });
    }
    return out;
  }

  /**
   * The cheap pre-use check: does this endpoint say it is on the chain we are looking for?
   *
   * Resolves `'ok'`, `'wrong'` (it named a different chain — out of the rotation for good),
   * `'mute'` (it answered, but would not say which chain it is on) or `'down'` (it did not
   * answer). Never throws except for a caller's abort.
   */
  async function probe(url, options) {
    if (list.length < 2) return 'ok';                       // nothing to fail over to
    if (!expected.chainId && !expected.genesis) return 'ok'; // nothing to check it against
    let answered = false;
    const ask = async (method) => {
      try {
        const value = await request(url, method, [], options);
        answered = true;
        return value;
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        if (err && err.code !== -1) answered = true; // it answered, even if with a refusal
        return undefined;
      }
    };
    if (expected.chainId) {
      const said = await ask('rand_chainId');
      if (said === undefined || said === null || said === '') {
        note(url, answered ? 'mute' : 'down', answered ? 'would not name its chain' : 'did not answer');
        return answered ? 'mute' : 'down';
      }
      if (String(said) !== expected.chainId) {
        note(url, 'wrong', `is on chain ${said}, not ${expected.chainId}`);
        return 'wrong';
      }
    }
    if (expected.genesis) {
      const said = await ask('rand_getGenesisHash');
      if (typeof said !== 'string' || !said) {
        note(url, answered ? 'mute' : 'down', answered ? 'would not name its genesis' : 'did not answer');
        return answered ? 'mute' : 'down';
      }
      if (said !== expected.genesis) {
        note(url, 'wrong', 'has a different genesis hash');
        return 'wrong';
      }
    }
    note(url, 'ok');
    return 'ok';
  }

  // -------------------------------------------------------------------------- the two clients ---
  /** The named convenience methods, over whichever `call` they are given. */
  function surface(call) {
    return {
      rpc: call,
      chainId: (o) => call('rand_chainId', [], o),
      status: (o) => call('rand_status', [], o),
      head: (o) => call('rand_getHead', [], o),
      treeInfo: (o) => call('rand_getTreeInfo', [], o),
      commitments: (from, limit = 500, o) => call('rand_getCommitments', [from, limit], o),
      nullifiers: (fromHeight, limit = 500, o) => call('rand_getNullifiers', [fromHeight, limit], o),
      anchor: (o) => call('rand_getAnchor', [], o),
      witness: (index, o) => call('rand_getWitness', [index], o),
      sendTransaction: (hex, o) => call('rand_sendTransaction', [hex], o),
      getTransaction: (hash, o) => call('rand_getTransaction', [hash], o),
      mint: (address, o) => call('rand_mint', [address], o),
      blockByHeight: (h, o) => call('rand_getBlockByHeight', [h], o),
      bridgeState: (o) => call('rand_getBridgeState', [], o),
      // The bridge's asset registry: `[{index, chain, token, asset_id}]`, ascending by index, or
      // `[]` on a chain without a bridge. No symbols and no decimals — see assets.list().
      assets: (o) => call('rand_getAssets', [], o),
      // `[spec]`, one of {kind:'bundle'} | {kind:'deploy',…} | {kind:'call',…}; the minimum fee in
      // units as a decimal string.
      estimateFee: (spec = { kind: 'bundle' }, o) => call('rand_estimateFee', [spec], o),
    };
  }

  /**
   * A client bound to ONE url, for one operation.
   *
   * There is deliberately no branch in here that could reach a second host — that is the whole
   * mid-operation guarantee, and it is a property of the object rather than of a caller's
   * discipline. A transport failure is reported to the pool (so the NEXT acquisition starts
   * somewhere else) and then rethrown to the caller, which retries from the top of its operation
   * if it wants to. `skipped` is whatever this pass refused to use, so the failure names them.
   */
  function pinned(url, skipped = []) {
    const call = async (method, params = [], options) => {
      try {
        return await request(url, method, params, options);
      } catch (err) {
        if (err && err.name !== 'AbortError' && err.code === -1) {
          note(url, 'down', err.message);
          if (skipped.length > 0) {
            const also = skipped.map((s) => `${s.url} (${s.reason})`).join(', ');
            err.message = `${err.message}; also tried ${also}`;
            err.tried = skipped;
          }
        }
        throw err;
      }
    };
    const client = {
      url,
      urls: Object.freeze([url]),
      pinnedTo: url,
      ...surface(call),
      // Acquiring from a pinned client is a no-op on purpose: an operation that (re-)asks for a
      // client while holding one must keep the one it has, never quietly get a different host.
      acquire: async () => client,
      pinned: () => client,
    };
    if (skipped.length > 0) client.skipped = Object.freeze(skipped.map((s) => Object.freeze({ ...s })));
    return Object.freeze(client);
  }

  /** The pool's own request path: one attempt per endpoint, under the rules in the header. */
  async function failover(method, params = [], options) {
    let last = null;
    for (const url of order()) {
      if (state.get(url) === 'wrong') continue;
      try {
        const value = await request(url, method, params, options);
        select(url);
        // Reachable, and that is ALL this proves. It deliberately does not mark the endpoint
        // 'ok': that mark means "it named the chain we asked for", and letting a successful
        // `rand_status` earn it would let an endpoint skip the pre-use check it has never passed.
        if (state.get(url)) { state.delete(url); why.delete(url); }
        return value;
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        if (!mayRetryElsewhere(err, method)) throw err;
        note(url, 'down', err.message);
        last = err;
      }
    }
    forgetTransientFailures();
    throw last || new RpcError(`no endpoint could be reached for ${method}`, -1, 'connect');
  }

  /**
   * Picks an endpoint and returns a PINNED client for it. This is the ONLY place failover happens
   * for anything the wallet's gated operations do.
   *
   * When every endpoint fails, it still returns a pinned client rather than throwing — for the
   * endpoint whose failure is the most informative, a wrong-chain one first. That is not a
   * fallback to trusting it: the caller's own `chainIdentity`/`chainVerdict` gate runs against
   * whatever comes back, so a wrong-chain endpoint produces the same definite refusal it would
   * have produced as the only endpoint configured, and an unreachable one produces the same
   * retryable "could not be reached". The alternative — a brand-new error type from this file —
   * would mean two ways to say "wrong chain" and two places to keep them honest.
   */
  async function acquire(options) {
    if (list.length === 1) return pinned(list[0]);
    const probedNow = new Set();
    const tryUrl = async (url) => {
      probedNow.add(url);
      if ((await probe(url, options)) !== 'ok') return null;
      select(url);
      return pinned(url, skippedNotes(url));
    };

    // Pass 1: whatever is already known good, else whatever has nothing against it. An endpoint an
    // EARLIER operation found unusable is stepped over here rather than re-probed — a node that
    // answers `rand_chainId` and then drops every real request would otherwise be chosen for ever,
    // because the cheap check would keep saying it is fine.
    for (const url of order()) {
      const mark = state.get(url);
      if (mark === 'ok') { select(url); return pinned(url, skippedNotes(url)); }
      if (mark) continue;
      // eslint-disable-next-line no-await-in-loop -- endpoints are tried in order, by design
      const got = await tryUrl(url);
      if (got) return got;
    }
    // Pass 2: one more chance for those stepped over — but never for a wrong chain, and never for
    // one this same call has just re-checked.
    for (const url of order()) {
      if (state.get(url) === 'wrong' || probedNow.has(url)) continue;
      // eslint-disable-next-line no-await-in-loop -- endpoints are tried in order, by design
      const got = await tryUrl(url);
      if (got) return got;
    }

    // Nothing is usable. Hand back the endpoint whose failure says the most — one that answered
    // and named another chain before one that said nothing at all.
    let chosen = null;
    for (const mark of ['wrong', 'mute', 'down']) {
      chosen = list.find((url) => state.get(url) === mark) || null;
      if (chosen) break;
    }
    if (!chosen) chosen = list[current];
    const skipped = skippedNotes(chosen);
    // Everything that may be temporary is forgotten, so the NEXT operation asks again from the top
    // rather than inheriting this pass's verdict; 'wrong' survives, because it is not going to
    // change.
    const keepWrong = state.get(chosen) === 'wrong';
    forgetTransientFailures();
    if (keepWrong) select(chosen);
    return pinned(chosen, skipped);
  }

  const pool = {
    get url() { return list[current]; },
    urls: Object.freeze([...list]),
    ...surface((method, params = [], options) => failover(method, params, options)),
    acquire,
    /** The current endpoint, pinned, with no probe and no network access. */
    pinned: () => pinned(list[current]),
    /** `[{url, state, reason}]` — what this client currently believes. Diagnostics only. */
    endpoints: () => list.map((url) => ({ url, state: state.get(url) || 'unknown', reason: why.get(url) })),
  };
  return pool;
}
