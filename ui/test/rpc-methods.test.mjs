// `ui/lib/rpc-methods.js`'s `METHODS`/`wireName`/`typed()` — task 5.1.
//
// The method *set* is pinned against the vendored node's own dispatch table rather than against
// this table's own idea of what the node answers, so a future re-vendor that adds or removes a
// `rand_` method fails this test until `METHODS` is updated to match — the whole point of
// generating the client from one table instead of hand-copying method names per convenience
// function.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { METHODS, wireName, typed } from '../lib/rpc-methods.js';

test('covers exactly the methods the vendored node dispatches', () => {
  const src = readFileSync(new URL('../../core/vendor/fullnode/crates/randprotocol-node/src/rpc.rs', import.meta.url), 'utf8');
  const node = new Set([...src.matchAll(/"(rand_[A-Za-z]+)"\s*(?:\||=>)/g)].map((m) => m[1]));
  node.delete('rand_syncStatus'); // alias of rand_status
  for (const gone of ['rand_getBalance', 'rand_getAccount', 'rand_getAssetBalance']) node.delete(gone);
  assert.deepEqual(new Set(Object.keys(METHODS).map(wireName)), node);
});

test('every method name is one this wallet is allowed to put on the wire', () => {
  const RPC_METHOD_RE = /^(?:rand|bridge)_[A-Za-z][A-Za-z0-9]*$/;
  for (const name of Object.keys(METHODS)) {
    assert.ok(RPC_METHOD_RE.test(wireName(name)), `${wireName(name)} would be refused by rpc.js's allow-list`);
  }
});

test('typed() maps positional params', async () => {
  const seen = []; const rpc = typed(async (m, p) => { seen.push([m, p]); return 1; });
  await rpc.getCommitments(10, 500);
  assert.deepEqual(seen[0], ['rand_getCommitments', [10, 500]]);
});

test('typed() never pads a call past the arguments actually given', async () => {
  const seen = []; const rpc = typed(async (m, p, o) => { seen.push([m, p, o]); return 1; });
  await rpc.mint('rand1abc');
  assert.deepEqual(seen[0], ['rand_mint', ['rand1abc'], undefined]);
});

test('typed() passes a trailing options object through untouched', async () => {
  const seen = []; const rpc = typed(async (m, p, o) => { seen.push([m, p, o]); return 1; });
  const signal = new AbortController().signal;
  await rpc.getHead({ signal });
  assert.deepEqual(seen[0], ['rand_getHead', [], { signal }]);
  await rpc.getWitness(7, { signal });
  assert.deepEqual(seen[0 + 1], ['rand_getWitness', [7], { signal }]);
});
