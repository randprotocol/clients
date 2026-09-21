// The real Backend for the browser shells: ui/engine/backend-wasm.js, driven by a stub core, a
// Map-backed storage and a stub fetch that answers JSON-RPC. Nothing here touches a browser,
// IndexedDB or a node.
//
// Almost everything this backend does is `backend-shared.js`'s and is asserted in
// `./backend-cases.mjs`, against this factory and the native one alike. What is left here is the
// two things that are actually about wasm: `canProve()` is unconditionally `{ok: false}` because a
// bundle proof peaks at ~5.7 GB and wasm32 stops at 4 GiB, and `send.send()` therefore refuses
// before anything is selected, proved or sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWasmBackend, unlockDelayMs } from '../engine/backend-wasm.js';
import { sharedBackendCases } from './backend-cases.mjs';
import { PASSWORD, ADDRESS, mapStorage, stubCore, stubFetch, stubPlatform } from './backend-fixtures.mjs';

function build(opts = {}) {
  const core = opts.core || stubCore();
  const storage = opts.storage || mapStorage();
  const platform = opts.platform || stubPlatform();
  const fetch = opts.fetch || stubFetch();
  // `locks`/`broadcast` are explicitly off unless a test asks for them: the defaults would pick up
  // Node's own BroadcastChannel, and one left ref'd keeps the whole test process alive.
  const backend = makeWasmBackend({
    core, storage, platform, fetch,
    locks: opts.locks ?? null,
    broadcast: opts.broadcast ?? null,
    ...(opts.extra || {}),
  });
  return { backend, core, storage, platform, fetch };
}

// This shell refuses every send, so the plainest request is already the refused one.
const refusedSend = (backend) => backend.send.send({ asset: 0, to: ADDRESS, amount: '1' }, () => {});

sharedBackendCases({ label: 'wasm', build, refusedSend });

// ----------------------------------------------------------------- what wasm cannot do --------

test('the unlock delay schedule is 0, 0, 0.5s, 1s, 2s … capped at 30s', () => {
  // Re-exported by this shell for the extension's lock screen, so it is asserted through the
  // re-export rather than through backend-shared.js.
  assert.equal(unlockDelayMs(0), 0);
  assert.equal(unlockDelayMs(1), 0);
  assert.equal(unlockDelayMs(2), 500);
  assert.equal(unlockDelayMs(3), 1000);
  assert.equal(unlockDelayMs(4), 2000);
  assert.equal(unlockDelayMs(5), 4000);
  assert.equal(unlockDelayMs(20), 30000);
  assert.equal(unlockDelayMs(1000), 30000);
});

test('canProve explains the 5.7 GB wall', async () => {
  const { backend } = build();
  const answer = await backend.send.canProve();
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /5\.7 GB/);
  assert.match(answer.reason, /desktop app/);
});

test('send rejects definitely, without ever reaching prove_transfer', async () => {
  const { backend, core, fetch } = build();
  await backend.wallet.create(PASSWORD);
  const phases = [];
  await assert.rejects(
    () => backend.send.send({ asset: 0, to: ADDRESS, amount: '1' }, (p) => phases.push(p)),
    (err) => {
      assert.equal(err.definite, true);
      assert.match(err.message, /5.7 GB/);
      return true;
    },
  );
  assert.deepEqual(phases, [], 'nothing was started, so no phase was reported');
  assert.equal(core.calls.some(([m]) => m === 'prove_transfer'), false);
  assert.equal(fetch.requests.some((r) => r.body.method === 'rand_sendTransaction'), false);
});

test('send.send takes its arguments without using them, and still refuses', async () => {
  const { backend } = build();
  await backend.wallet.create(PASSWORD);
  const phases = [];
  const ac = new AbortController();
  await assert.rejects(
    () => backend.send.send({ asset: 0, to: ADDRESS, amount: '1' }, (p) => phases.push(p), { signal: ac.signal }),
    (err) => { assert.equal(err.definite, true); return true; },
  );
  assert.deepEqual(phases, []);
});
