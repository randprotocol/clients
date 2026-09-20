// The wallet's typed RPC surface, generated from ONE table instead of hand-copied per client.
//
// `ui/engine/rpc.js` builds two kinds of client — a failover POOL and a single-URL PINNED
// client — and until task 5.1 each hand-wrote its own subset of the node's ~15 most-used methods
// as `(args..., options) => call(wireName, [args...], options)`. That list had drifted well behind
// the vendored node (`core/vendor/fullnode/crates/randprotocol-node/src/rpc.rs`), which now
// dispatches 48 `rand_` methods. This file is the one place that list lives: `METHODS` names every
// method the node's dispatch table answers (see the "covers exactly the methods the vendored node
// dispatches" test in `ui/test/rpc-methods.test.mjs`, which pins the *set* — not the tool's own
// guess — against that source file), and `typed(call)` turns it into one async function per
// method, over whichever `call(method, params, options)` it is given.
//
// `rand_syncStatus` is `rand_status`'s alias (the dispatch arm is `"rand_syncStatus" |
// "rand_status" => {...}`) and is not a separate entry; `rand_getBalance`/`rand_getAccount`/
// `rand_getAssetBalance` are pre-account-removal names the dispatch table still refuses by name
// (`-32601`, to give a clear error rather than "method not allowed") and are not real methods.
//
// Every entry's `params` is the ORDERED list of positional arguments the wallet's own code passes
// today (or, for a method nothing calls yet, the minimum the node requires) — never the full set
// of a node parameter that happens to be optional. `rand_mint` accepts an optional second
// `amount`, `rand_getAnchor` an optional `height`, `rand_getCommitments` an optional `limit`, and
// so on (see `core/vendor/fullnode/docs/rpc.md`); this table lists only what the convenience
// method actually exposes, because `typed()` slices the caller's own argument list to `params`'s
// LENGTH — the names are documentation, the length is what decides where the trailing options
// object (`{signal}`) is found. Padding a method's `params` out to every node-optional argument
// would silently turn a caller's trailing `{signal}` into a bogus positional argument.
export const RPC_NAMESPACE = 'rand'; // the node's; see rpc.md §"Methods" / rpc.rs's dispatch table

// name → {params: [...names], explore?: 'group'}. `explore` is a hint for a future explorer
// screen grouping (network / assets / bridge / lookup); it is metadata only and never read here.
export const METHODS = {
  // -- identity, chain & node info ----------------------------------------------------------
  chainId: { params: [] },
  tokenInfo: { params: [] },
  status: { params: [], explore: 'network' },
  getHead: { params: [], explore: 'network' },
  getEpoch: { params: [], explore: 'network' },
  getValidators: { params: [], explore: 'network' },
  getPeers: { params: [], explore: 'network' },
  getSupply: { params: [], explore: 'network' },
  getVersion: { params: [] },
  getGenesisHash: { params: [] },
  getHealth: { params: [] },
  getLimits: { params: [] },
  getMempoolInfo: { params: [] },
  getEmission: { params: [] },

  // -- the commitment tree & notes -----------------------------------------------------------
  getTreeInfo: { params: [] },
  getAnchor: { params: [] },
  getWitness: { params: ['index'] },
  getWitnesses: { params: ['indices'] },
  getCommitments: { params: ['from', 'limit'] },
  getNullifiers: { params: ['fromHeight', 'limit'] },
  getCompactBlocks: { params: ['fromHeight', 'toHeight'] },

  // -- node-held viewing keys (explorer-style scanning) --------------------------------------
  importViewingKey: { params: ['viewingKey'] },
  getViewingNotes: { params: ['viewingKey'] },
  checkTransaction: { params: ['hash', 'key'] },

  // -- programs -------------------------------------------------------------------------------
  getProgram: { params: ['id'], explore: 'lookup' },
  getProgramPublic: { params: ['id'] },
  getProgramCode: { params: ['id'], explore: 'lookup' },

  // -- transactions, blocks & receipts --------------------------------------------------------
  getTransaction: { params: ['hash'], explore: 'lookup' },
  getTransactionStatus: { params: ['hashes'] },
  getRawTransaction: { params: ['hash'] },
  getReceipt: { params: ['hash'], explore: 'lookup' },
  getReceipts: { params: ['programId', 'fromHeight', 'toHeight'] },
  getCallEnvelope: { params: ['hash'], explore: 'lookup' },
  getBlockByHeight: { params: ['height'], explore: 'lookup' },
  getBlockByHash: { params: ['hash'], explore: 'lookup' },
  getBlocks: { params: ['fromHeight', 'toHeight'] },
  getFinality: { params: ['heightOrHash'] },
  getProposer: { params: ['view'] },

  // -- block aggregation ------------------------------------------------------------------------
  getAggregate: { params: ['hash'] },
  getAggregators: { params: [] },
  getUnsealed: { params: ['from', 'limit'] },

  // -- the bridge -------------------------------------------------------------------------------
  getBridgeState: { params: [], explore: 'bridge' },
  getBridgeBurn: { params: ['sequence'], explore: 'bridge' },
  bridgeAssetId: { params: ['tokenChain', 'tokenAddress'], explore: 'bridge' },
  getAssets: { params: [], explore: 'assets' },

  // -- submitting & fees --------------------------------------------------------------------
  estimateFee: { params: ['shape'] },
  sendTransaction: { params: ['hex'] },
  mint: { params: ['address'] },
};

export function wireName(name) {
  return `${RPC_NAMESPACE}_${name}`;
}

/**
 * `typed(call)` — one async function per `METHODS` key, over `call(method, params, options)`.
 *
 * Each generated function takes exactly the method's declared positional arguments, in order,
 * plus one optional trailing `options` object (`{signal}`, matching every caller across
 * `ui/engine/backend-shared.js` and `ui/engine/wallet.js` today): `args.slice(0, params.length)`
 * becomes the wire `params` array — never padded past what the caller actually passed, so a
 * one-argument call to a two-`params` method (e.g. `mint(address)`, whose second `params` name
 * exists only in the node's optional-argument sense, not in this table) sends a one-element
 * array on the wire, exactly like a hand-written convenience method would — and `args[params.
 * length]` is the options object, if the caller passed one.
 */
export function typed(call) {
  const out = {};
  for (const [name, spec] of Object.entries(METHODS)) {
    const n = spec.params.length;
    const wire = wireName(name);
    out[name] = (...args) => call(wire, args.slice(0, n), args[n]);
  }
  return out;
}
