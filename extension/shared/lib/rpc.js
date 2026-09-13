// JSON-RPC 2.0 over HTTP to a shrugg-node. One request per POST; errors carry the node's message.
export class RpcError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export function makeRpc(url, { timeoutMs = 20000 } = {}) {
  async function rpc(method, params = []) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctl.signal,
      });
    } catch (e) {
      throw new RpcError(`cannot reach ${url}: ${e?.name === 'AbortError' ? 'timed out' : e?.message || e}`, -1);
    } finally { clearTimeout(t); }
    if (!res.ok) throw new RpcError(`${url} answered HTTP ${res.status}`, -1);
    const body = await res.json();
    if (body.error) throw new RpcError(body.error.message || 'rpc error', body.error.code);
    return body.result;
  }
  return {
    rpc,
    chainId: () => rpc('shrugg_chainId'),
    status: () => rpc('shrugg_status'),
    head: () => rpc('shrugg_getHead'),
    treeInfo: () => rpc('shrugg_getTreeInfo'),
    commitments: (from, limit = 500) => rpc('shrugg_getCommitments', [from, limit]),
    nullifiers: (fromHeight, limit = 500) => rpc('shrugg_getNullifiers', [fromHeight, limit]),
    anchor: () => rpc('shrugg_getAnchor'),
    witness: (index) => rpc('shrugg_getWitness', [index]),
    sendTransaction: (hex) => rpc('shrugg_sendTransaction', [hex]),
    getTransaction: (hash) => rpc('shrugg_getTransaction', [hash]),
    mint: (address) => rpc('shrugg_mint', [address]),
    blockByHeight: (h) => rpc('shrugg_getBlockByHeight', [h]),
    bridgeState: () => rpc('shrugg_getBridgeState'),
    estimateFee: () => rpc('shrugg_estimateFee', [{ kind: 'bundle' }]),
  };
}
