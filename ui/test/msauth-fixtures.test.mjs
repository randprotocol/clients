// The private-multisig vectors every app's tests read (iOS bundles the directory, Android adds it to
// its test resources, wallet-core reads it): fullnode's crates/randprotocol-msig/tests/fixtures,
// byte for byte. The hashes live in ONE list, ui/test/fixtures/msauth.sha256 (`shasum -a 256`
// format), which a re-vendor rewrites; wallet-core's `the_fixture_copies_are_the_vendored_vectors`
// holds the copies to the submodule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('./fixtures/msauth/', import.meta.url);
const SUMS = readFileSync(new URL('./fixtures/msauth.sha256', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => l.split(/\s+/)).map(([hash, name]) => [name, hash]);

test('every msauth fixture is listed once, and hashes to its listed SHA-256', () => {
  assert.ok(SUMS.length >= 11, `the list names ${SUMS.length} fixtures`);
  assert.deepEqual(readdirSync(DIR).sort(), SUMS.map(([n]) => n).sort());
  for (const [name, want] of SUMS) {
    assert.equal(createHash('sha256').update(readFileSync(new URL(name, DIR))).digest('hex'), want, name);
  }
});
