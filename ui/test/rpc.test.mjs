// `ui/engine/rpc.js` on its own: one client for one node, a pool over several, and the line
// between them.
//
// The line is the point of this file (task 5.0). `makeRpc` gained a list of endpoints and
// failover, and the risk was never "does it work when the network is healthy" — it was whether a
// request could be rerouted to a host the wallet's chain gate never checked. So the cases below
// are mostly about what does NOT happen: an answer is never asked for twice, a submission is
// never repeated after a timeout, and a client handed to an operation has no path to a second
// host at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRpc, RpcError, isAllowedRpcMethod, rpcUrlList, SUBMIT_METHODS } from '../engine/rpc.js';

const A = 'https://a.example';
const B = 'https://b.example';
const C = 'https://c.example';

/**
 * A fetch over `{url: {method: handler}}`, recording `url:method` for every request.
 *
 * A handler may be a value (the JSON-RPC result), `ERROR(message, code)` (a JSON-RPC error reply —
 * an ANSWER), `REFUSED` (the connection never opened), `HANG` (nothing ever comes back, so the
 * per-request timeout fires), `HTTP(status)` or `GARBAGE` (a proxy's HTML error page).
 */
const REFUSED = Symbol('refused');
const HANG = Symbol('hang');
const GARBAGE = Symbol('garbage');
const HTTP = (status) => ({ __http: status });
const ERROR = (message, code = -32000) => ({ __error: { message, code } });

function transports(nodes) {
  const log = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    log.push(`${url}:${body.method}`);
    const node = nodes[url];
    if (!node) throw new TypeError('fetch failed');
    let answer = node[body.method];
    if (typeof answer === 'function') answer = answer(body.params);
    if (answer === REFUSED) throw new TypeError('fetch failed');
    if (answer === HANG) {
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      });
    }
    if (answer === GARBAGE) {
      return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } };
    }
    if (answer && answer.__http) return { ok: false, status: answer.__http, json: async () => ({}) };
    if (answer && answer.__error) {
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, error: answer.__error }) };
    }
    if (answer === undefined) {
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `unknown method ${body.method}` } }) };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: answer }) };
  };
  fn.log = log;
  fn.to = (url) => log.filter((line) => line.startsWith(`${url}:`)).map((line) => line.slice(url.length + 1));
  return fn;
}

const chain = (id, extra = {}) => ({
  rand_chainId: id,
  rand_getGenesisHash: 'aa'.repeat(32),
  rand_status: { height: 1, peer_count: 1, syncing: false },
  rand_getHead: { height: 1, hash: 'ff'.repeat(32) },
  rand_sendTransaction: `0x${'ab'.repeat(32)}`,
  rand_mint: `0x${'cd'.repeat(32)}`,
  ...extra,
});

// ------------------------------------------------------------------------------- the basics ----

test('a single URL behaves exactly as it always did: no probe, no failover, live url', async () => {
  const fetch = transports({ [A]: chain(13) });
  const client = makeRpc(A, { fetch, chainId: 13 });
  assert.equal(client.url, A);
  assert.deepEqual(client.urls, [A]);
  assert.equal(await client.status(), (await client.status()));
  // The one endpoint is never pre-checked: there is nothing to fail over TO, and the wallet's own
  // chainIdentity/chainVerdict gate is what judges it.
  const acquired = await client.acquire();
  assert.equal(acquired.url, A);
  assert.deepEqual(fetch.to(A).filter((m) => m === 'rand_chainId'), []);
});

test('a string and a one-item list are the same thing, and trailing slashes are normalised', () => {
  assert.deepEqual(rpcUrlList('https://a.example/'), [A]);
  assert.deepEqual(rpcUrlList([A, `${A}//`, '', '   ', B]), [A, B]);
  assert.deepEqual(rpcUrlList(['   ']), []);
  assert.throws(() => makeRpc([], { fetch: transports({}) }), /at least one node URL/);
});

test('only rand_ and bridge_ methods ever reach the wire', async () => {
  const fetch = transports({ [A]: chain(13) });
  const client = makeRpc([A, B], { fetch, chainId: 13 });
  assert.equal(isAllowedRpcMethod('eth_getBalance'), false);
  await assert.rejects(() => client.rpc('eth_getBalance'), /not allowed/);
  assert.deepEqual(fetch.log, []);
});

// ------------------------------------------------------------------------------- failover -------

test('the first endpoint being down does not make the wallet down: the second answers', async () => {
  const fetch = transports({ [A]: chain(13, { rand_status: REFUSED }), [B]: chain(13) });
  const pool = makeRpc([A, B], { fetch, chainId: 13 });
  assert.deepEqual(await pool.status(), { height: 1, peer_count: 1, syncing: false });
  assert.deepEqual(fetch.to(A), ['rand_status']);
  assert.deepEqual(fetch.to(B), ['rand_status']);
  // …and the next request starts where the last one worked, rather than walking the dead one again.
  await pool.status();
  assert.deepEqual(fetch.to(A), ['rand_status'], 'it went back to the endpoint it had just found dead');
  assert.equal(pool.url, B);
});

test('an HTTP 5xx and a non-JSON body are transport failures; a 4xx is the endpoint answering', async () => {
  const bad = transports({ [A]: chain(13, { rand_status: HTTP(503) }), [B]: chain(13) });
  assert.ok(await makeRpc([A, B], { fetch: bad, chainId: 13 }).status());
  assert.deepEqual(bad.to(B), ['rand_status']);

  const html = transports({ [A]: chain(13, { rand_status: GARBAGE }), [B]: chain(13) });
  assert.ok(await makeRpc([A, B], { fetch: html, chainId: 13 }).status());
  assert.deepEqual(html.to(B), ['rand_status']);

  const refused = transports({ [A]: chain(13, { rand_status: HTTP(403) }), [B]: chain(13) });
  await assert.rejects(() => makeRpc([A, B], { fetch: refused, chainId: 13 }).status(), /HTTP 403/);
  assert.deepEqual(refused.to(B), [], 'a 403 was shopped around for a friendlier answer');
});

test('a JSON-RPC error reply is an ANSWER and is never asked of a second endpoint', async () => {
  const fetch = transports({
    [A]: chain(13, { rand_getWitness: ERROR('no such leaf', -32000) }),
    [B]: chain(13, { rand_getWitness: { index: 7, path: [] } }),
  });
  const pool = makeRpc([A, B], { fetch, chainId: 13 });
  await assert.rejects(() => pool.witness(7), (err) => err instanceof RpcError && err.code === -32000 && /no such leaf/.test(err.message));
  assert.deepEqual(fetch.to(B), [], 'the wallet went shopping for a reply it liked better');
});

// ------------------------------------------------------------- never send a transaction twice ---

test('a timed-out submission is NEVER resubmitted elsewhere; a refused connection is', async () => {
  assert.deepEqual([...SUBMIT_METHODS], ['rand_sendTransaction', 'rand_mint']);

  for (const method of SUBMIT_METHODS) {
    // Timed out: the node that received it may well have executed it. Repeating it on another
    // endpoint is how a wallet sends the same transfer twice, or mints twice.
    const hung = transports({ [A]: chain(13, { [method]: HANG }), [B]: chain(13) });
    const pool = makeRpc([A, B], { fetch: hung, timeoutMs: 5, chainId: 13 });
    await assert.rejects(() => pool.rpc(method, ['0xff']), (err) => err.code === -1 && err.failure === 'timeout');
    assert.deepEqual(hung.to(B), [], `${method} was repeated after a timeout`);

    // Refused before a byte left: nothing can have happened, so the next endpoint is safe.
    const dead = transports({ [A]: chain(13, { [method]: REFUSED }), [B]: chain(13) });
    const ok = makeRpc([A, B], { fetch: dead, chainId: 13 });
    assert.ok(await ok.rpc(method, ['0xff']));
    assert.deepEqual(dead.to(B), [method]);
  }
});

test('a submission that came back as HTTP 502 is not repeated either: bytes were exchanged', async () => {
  const fetch = transports({ [A]: chain(13, { rand_sendTransaction: HTTP(502) }), [B]: chain(13) });
  const pool = makeRpc([A, B], { fetch, chainId: 13 });
  await assert.rejects(() => pool.sendTransaction('0xff'), /HTTP 502/);
  assert.deepEqual(fetch.to(B), []);
});

// ---------------------------------------------------------------------- the wrong chain --------

test('an endpoint on another chain is kept out of the rotation, and named', async () => {
  const fetch = transports({ [A]: chain(14), [B]: chain(13) });
  const pool = makeRpc([A, B], { fetch, chainId: 13 });
  const client = await pool.acquire();
  assert.equal(client.url, B, 'the chain-14 endpoint was handed out');
  assert.deepEqual(fetch.to(A), ['rand_chainId'], 'it was asked more than who it is');
  assert.deepEqual(client.skipped, [{ url: A, reason: 'is on chain 14, not 13' }]);
  assert.deepEqual(
    pool.endpoints().map((e) => [e.url, e.state]),
    [[A, 'wrong'], [B, 'ok']],
  );

  // And it stays out: a second acquisition does not ask it again.
  const again = await pool.acquire();
  assert.equal(again.url, B);
  assert.deepEqual(fetch.to(A), ['rand_chainId']);
});

test('an endpoint with a different genesis is kept out too, when a genesis is expected', async () => {
  const fetch = transports({
    [A]: chain(13, { rand_getGenesisHash: 'bb'.repeat(32) }),
    [B]: chain(13),
  });
  const pool = makeRpc([A, B], { fetch, chainId: 13, genesis: 'aa'.repeat(32) });
  const client = await pool.acquire();
  assert.equal(client.url, B);
  assert.deepEqual(client.skipped, [{ url: A, reason: 'has a different genesis hash' }]);
});

test('when every endpoint fails, the one that ANSWERED is handed back, so the gate can refuse it', async () => {
  // A is simply not there; B is on chain 14. Neither is usable, and this file does not invent a
  // second way to say "wrong chain" — it hands back the endpoint whose failure is a definite,
  // actionable fact and lets the wallet's own chainIdentity/chainVerdict produce the refusal it
  // would have produced for a single misconfigured endpoint.
  const fetch = transports({ [B]: chain(14) });
  const pool = makeRpc([A, B], { fetch, chainId: 13 });
  const client = await pool.acquire();
  assert.equal(client.url, B);
  assert.equal(await client.chainId(), 14, 'the endpoint is reachable; it is just on the wrong chain');
  assert.deepEqual(client.skipped.map((s) => s.url), [A]);
});

test('an endpoint that is merely down comes back; one on another chain does not', async () => {
  const nodes = { [A]: chain(13), [B]: chain(13) };
  let downA = true;
  const inner = transports(nodes);
  const fetch = async (url, init) => {
    if (downA && url === A) { inner.log.push(`${url}:${JSON.parse(init.body).method}`); throw new TypeError('fetch failed'); }
    return inner(url, init);
  };
  fetch.to = inner.to;
  const pool = makeRpc([A, B], { fetch, chainId: 13 });
  assert.equal((await pool.acquire()).url, B);
  downA = false;
  // B is remembered as good, so it stays — failover is not a preference for the first host.
  assert.equal((await pool.acquire()).url, B);
});

// ------------------------------------------------- the mid-operation guarantee, structurally ----

test('a pinned client has no path to a second host, whatever happens to its own', async () => {
  const inner = transports({ [A]: chain(13), [B]: chain(13) });
  let deadA = false;
  const fetch = async (url, init) => {
    if (deadA && url === A) { inner.log.push(`${url}:${JSON.parse(init.body).method}`); throw new TypeError('fetch failed'); }
    return inner(url, init);
  };
  fetch.to = inner.to;
  const pool = makeRpc([A, B], { fetch, chainId: 13 });
  const pinned = await pool.acquire();
  assert.equal(pinned.url, A);
  deadA = true;

  // The endpoint dies under it. It reports the failure; it does not reroute.
  await assert.rejects(() => pinned.head(), (err) => err.code === -1);
  assert.deepEqual(fetch.to(B), [], 'a pinned client rerouted a request to a host nobody checked');

  // `url` is a frozen data property, not a live view of the pool's choice.
  assert.equal(pinned.url, A);
  assert.throws(() => { 'use strict'; pinned.url = B; }, TypeError);
  assert.deepEqual(pinned.urls, [A]);
  // Asking a pinned client for a client gives back the same one — an operation that re-resolves
  // mid-flight must keep the host it was verified on.
  assert.equal(await pinned.acquire(), pinned);
  assert.equal(pinned.pinned(), pinned);

  // Only the NEXT acquisition moves, and only after the new endpoint has named its chain.
  const next = await pool.acquire();
  assert.equal(next.url, B);
  assert.equal(fetch.to(B)[0], 'rand_chainId', 'the second endpoint was used before it identified itself');
});

test('an endpoint that names its chain and then drops every real request is stepped over', async () => {
  // The cheap pre-use check is not a health check: a node can answer `rand_chainId` happily and
  // serve nothing else. Re-probing it on the next acquisition would pick it again, for ever, and
  // no amount of retrying from the top would ever reach the healthy endpoint.
  const inner = transports({ [A]: chain(13), [B]: chain(13) });
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url === A && body.method === 'rand_getCommitments') {
      inner.log.push(`${url}:${body.method}`);
      throw new TypeError('fetch failed');
    }
    return inner(url, init);
  };
  fetch.to = inner.to;
  const pool = makeRpc([A, B], { fetch, chainId: 13 });
  const first = await pool.acquire();
  assert.equal(first.url, A);
  await assert.rejects(() => first.commitments(0, 10), (err) => err.code === -1);
  const second = await pool.acquire();
  assert.equal(second.url, B, 'the next operation went back to the endpoint that had just failed');
  assert.equal(fetch.to(B)[0], 'rand_chainId');
});

test('the endpoint a failed pinned client was on is named in the error alongside the others', async () => {
  const fetch = transports({ [A]: chain(14), [B]: chain(13, { rand_getHead: REFUSED }) });
  const pool = makeRpc([A, B, C], { fetch, chainId: 13 });
  const pinned = await pool.acquire();
  assert.equal(pinned.url, B);
  await assert.rejects(() => pinned.head(), (err) => {
    assert.match(err.message, /cannot reach https:\/\/b\.example/);
    assert.match(err.message, /also tried/);
    assert.match(err.message, /a\.example \(is on chain 14, not 13\)/);
    return true;
  });
});

test('an abort from the caller is a cancellation, never an endpoint failure', async () => {
  const fetch = transports({ [A]: chain(13, { rand_getHead: HANG }), [B]: chain(13) });
  const pool = makeRpc([A, B], { fetch, chainId: 13 });
  const ctl = new AbortController();
  const inflight = pool.head({ signal: ctl.signal });
  ctl.abort();
  await assert.rejects(() => inflight, (err) => err.name === 'AbortError');
  assert.deepEqual(fetch.to(B), [], 'a cancelled request was retried on another host');
});
