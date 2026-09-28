// `ui/lib/resume-route.js`: where an extension page opens when a remote proof was left pending
// (a popup closed mid-proof — ui/backend.js `send.pending?`). The send screen's and the withdraw
// screen's mount hooks resume the job; this only decides which of them to open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingRoute } from '../lib/resume-route.js';

const backendWith = (pending) => ({ send: { pending } });

test('a pending transfer opens the send screen', async () => {
  const route = await pendingRoute(backendWith(async () => ({ job: 'j', name: 'laptop', kind: 'transfer', startedAt: 1 })));
  assert.equal(route, '#send');
});

test('a pending burn opens the withdraw screen', async () => {
  const route = await pendingRoute(backendWith(async () => ({ job: 'j', name: 'laptop', kind: 'burn', startedAt: 1 })));
  assert.equal(route, '#withdraw');
});

test('nothing pending, no pending method, or a failing one: no route', async () => {
  assert.equal(await pendingRoute(backendWith(async () => null)), null);
  assert.equal(await pendingRoute({ send: {} }), null);
  assert.equal(await pendingRoute({}), null);
  assert.equal(await pendingRoute(backendWith(async () => { throw new Error('locked'); })), null);
  assert.equal(await pendingRoute(backendWith(() => { throw new Error('sync throw'); })), null);
  assert.equal(await pendingRoute(backendWith(async () => 'not an object')), null);
});
