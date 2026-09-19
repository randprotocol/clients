// Moved to ui/engine/rpc.js in task 1.6 (`fetch` is injectable there, and it gained
// `rand_getAssets` / `rand_estimateFee`; `makeRpc(url)` is unchanged for this caller). Re-export
// shim for the old extension UI, deleted with that UI in task 2.1.
export * from '../../../ui/engine/rpc.js';
