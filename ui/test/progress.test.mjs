// ui/lib/progress.js — the proving estimate: linear to 90% at the usual time, never 100% before the
// send is done, and learned from this device's own runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MS, expectedMs, progressAt, remainingText, recordDuration } from '../lib/progress.js';

test('the estimate fills to 90% at the usual time and never claims done', () => {
  const e = 180_000;
  assert.equal(progressAt(0, e), 0);
  assert.equal(progressAt(e / 2, e), 0.45);
  assert.ok(Math.abs(progressAt(e, e) - 0.9) < 1e-9);
  assert.ok(progressAt(3 * e, e) < 0.99 && progressAt(3 * e, e) > 0.97);
  assert.ok(progressAt(100 * e, e) <= 0.99, 'still not done — only "sent" is');
  assert.equal(remainingText(60_000, e), 'about 2:00 left');
  assert.equal(remainingText(e - 5_000, e), 'almost done');
  assert.equal(remainingText(e + 120_000, e), 'taking longer than usual');
});

test('every kind is 40 s, and a run on this device can only shorten the estimate', () => {
  for (const k of Object.keys(DEFAULT_MS)) assert.equal(DEFAULT_MS[k], 40_000);
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  try {
    assert.equal(expectedMs('transfer'), DEFAULT_MS.transfer);
    recordDuration('transfer', 180_000);
    assert.equal(expectedMs('transfer'), 40_000, 'a slow run never stretches the ring past 40 s');
    recordDuration('withdraw', 30_000);
    assert.equal(expectedMs('withdraw'), 30_000, 'a faster device shortens it');
    recordDuration('withdraw', 22_000);
    assert.equal(expectedMs('withdraw'), Math.round(30_000 * 0.7 + 22_000 * 0.3));
    recordDuration('withdraw', 5);
    recordDuration('nonsense', 100_000);
    assert.equal(expectedMs('withdraw'), Math.round(30_000 * 0.7 + 22_000 * 0.3), 'an absurd run is ignored');
  } finally {
    delete globalThis.localStorage;
  }
  assert.equal(expectedMs('invoke'), DEFAULT_MS.invoke, 'no storage: the defaults');
});
