// JSON-RPC 2.0 over HTTP to a rand-node. One request per POST; errors carry the node's message.
//
// Storage- and platform-agnostic (task 1.6): `fetch` is injectable, so this file runs unchanged in
// a page, in a browser-extension service worker and under plain Node in a test. Nothing here knows
// where the URL came from or where the answer is kept.
export class RpcError extends Error {
  constructor(message, code) { super(message); this.code = code; }
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

/** The shape ui/ recognises as "this was cancelled", not "the node failed" (see ui/backend.js). */
function abortError() {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/**
 * `makeRpc(url, {timeoutMs, fetch})` — one client for one node URL.
 *
 * `fetch` defaults to the global. Every call takes an optional `{signal}`: it is composed with the
 * per-request timeout, and an abort that came from the *caller's* signal is reported as an
 * `AbortError` (which the UI treats as "no longer wanted") rather than as a node failure.
 */
export function makeRpc(url, { timeoutMs = 20000, fetch: fetchImpl } = {}) {
  const doFetch = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  if (!doFetch) throw new Error('no fetch implementation available');

  async function rpc(method, params = [], { signal } = {}) {
    if (!isAllowedRpcMethod(method)) throw new RpcError(`${method} is not allowed from this wallet`, -32601);
    if (signal && signal.aborted) throw abortError();
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const t = setTimeout(() => ctl.abort(), timeoutMs);
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
      throw new RpcError(`cannot reach ${url}: ${e?.name === 'AbortError' ? 'timed out' : e?.message || e}`, -1);
    } finally {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    if (!res.ok) throw new RpcError(`${url} answered HTTP ${res.status}`, -1);
    const body = await res.json();
    if (body.error) throw new RpcError(body.error.message || 'rpc error', body.error.code);
    return body.result;
  }

  return {
    url,
    rpc,
    chainId: (o) => rpc('rand_chainId', [], o),
    status: (o) => rpc('rand_status', [], o),
    head: (o) => rpc('rand_getHead', [], o),
    treeInfo: (o) => rpc('rand_getTreeInfo', [], o),
    commitments: (from, limit = 500, o) => rpc('rand_getCommitments', [from, limit], o),
    nullifiers: (fromHeight, limit = 500, o) => rpc('rand_getNullifiers', [fromHeight, limit], o),
    anchor: (o) => rpc('rand_getAnchor', [], o),
    witness: (index, o) => rpc('rand_getWitness', [index], o),
    sendTransaction: (hex, o) => rpc('rand_sendTransaction', [hex], o),
    getTransaction: (hash, o) => rpc('rand_getTransaction', [hash], o),
    mint: (address, o) => rpc('rand_mint', [address], o),
    blockByHeight: (h, o) => rpc('rand_getBlockByHeight', [h], o),
    bridgeState: (o) => rpc('rand_getBridgeState', [], o),
    // The bridge's asset registry: `[{index, chain, token, asset_id}]`, ascending by index, or
    // `[]` on a chain without a bridge. No symbols and no decimals — see assets.list().
    assets: (o) => rpc('rand_getAssets', [], o),
    // `[spec]`, one of {kind:'bundle'} | {kind:'deploy',…} | {kind:'call',…}; the minimum fee in
    // units as a decimal string.
    estimateFee: (spec = { kind: 'bundle' }, o) => rpc('rand_estimateFee', [spec], o),
  };
}
