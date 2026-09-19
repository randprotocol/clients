import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBackend, BACKEND_SHAPE } from '../backend.js';
import { fakeBackend, unlockedBackend } from './fake-backend.mjs';

test('fake backend satisfies the contract', () => assertBackend(fakeBackend()));
test('a missing method is named', () => {
  const b = fakeBackend(); delete b.send.estimate;
  assert.throws(() => assertBackend(b), /backend\.send\.estimate missing/);
});
test('platform.name is required', () => {
  const b = fakeBackend(); b.platform.name = '';
  assert.throws(() => assertBackend(b), /backend\.platform\.name/);
});

// --- additional coverage ---

test('unlockedBackend satisfies the contract', () => assertBackend(unlockedBackend()));

test('unlockedBackend already has a wallet and is unlocked', async () => {
  const b = unlockedBackend();
  assert.equal(await b.wallet.exists(), true);
  assert.equal(await b.wallet.isUnlocked(), true);
  const info = await b.wallet.info();
  assert.ok(info.address.startsWith('rand1'));
});

test('unlockedBackend returns one activity item per contract kind from cached() and scan()', async () => {
  const b = unlockedBackend();
  const cached = await b.sync.cached();
  assert.equal(cached.activity.length, 4);
  const kinds = cached.activity.map((a) => a.kind);
  assert.ok(kinds.includes('in'));
  assert.ok(kinds.includes('out'));
  // A `faucet` item was added in the task 1.4 fix round: the contract admits four kinds, and the
  // screens used to render anything that was not in/out as "Pending".
  assert.ok(kinds.includes('faucet'));
  const assetIndexes = cached.activity.map((a) => a.asset);
  assert.ok(assetIndexes.includes(1));

  const scanned = await b.sync.scan(() => {});
  assert.equal(scanned.activity.length, 4);
});

test('fake wallet.create requires a password of length >= 10', async () => {
  const b = fakeBackend();
  await assert.rejects(() => b.wallet.create('short'));
  const created = await b.wallet.create('a-long-enough-password');
  assert.ok(created.address.startsWith('rand1'));
});

test('fake wallet.unlock rejects with wrong password', async () => {
  const b = fakeBackend();
  await b.wallet.create('correct-horse-battery');
  await b.wallet.lock();
  await assert.rejects(() => b.wallet.unlock('nope'), /wrong password/);
  await assert.doesNotReject(() => b.wallet.unlock('correct-horse-battery'));
});

test('wallet.parseAddress validates rand1 addresses', async () => {
  const b = fakeBackend();
  const good = 'rand1' + 'q'.repeat(40);
  assert.deepEqual(await b.wallet.parseAddress(good), { valid: true });
  const bad = await b.wallet.parseAddress('other1' + 'q'.repeat(40));
  assert.equal(bad.valid, false);
  assert.equal(bad.reason, 'not a rand1 address');
  const short = await b.wallet.parseAddress('rand1abc');
  assert.equal(short.valid, false);
});

test('every call is recorded in b.calls', async () => {
  const b = fakeBackend();
  await b.settings.get();
  assert.deepEqual(b.calls, [['settings.get']]);
  await b.settings.set({ theme: 'dark' });
  assert.deepEqual(b.calls[1], ['settings.set', { theme: 'dark' }]);
});

test('fakeBackend(overrides) deep-merges per-group overrides', async () => {
  const b = fakeBackend({ send: { canProve: async () => ({ ok: true }) } });
  assert.deepEqual(await b.send.canProve(), { ok: true });
  // untouched sibling methods in the same group still work
  assert.ok(typeof b.send.estimate === 'function');
  const est = await b.send.estimate({ asset: 0, to: 'rand1x', amount: '1' });
  assert.ok('fee' in est);
});

test('BACKEND_SHAPE lists the expected groups', () => {
  assert.deepEqual(Object.keys(BACKEND_SHAPE).sort(), ['assets', 'faucet', 'platform', 'rpc', 'send', 'settings', 'sync', 'wallet'].sort());
  assert.ok(BACKEND_SHAPE.wallet.includes('parseAddress'));
});
