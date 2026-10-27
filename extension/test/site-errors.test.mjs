// lib/site-errors.js and provider-host.js's copy of it are one table: the window words a refusal
// for the site with the module, and the host re-words every answer it relays with its copy. Every
// sentence is fixed English with no figures in it, so nothing of the wallet's (a balance, a note's
// value, a prover's address) can ride along.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { SITE_ERRORS, CANNOT, siteError } from '../shared/lib/site-errors.js';

vm.runInThisContext(readFileSync(new URL('../shared/provider-host.js', import.meta.url), 'utf8'));

test('the host\'s copy is the module\'s table', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(globalThis.RAND_SITE_ERRORS)), JSON.parse(JSON.stringify(SITE_ERRORS)));
});

test('every sentence is fixed and has no digits; each kind has its catch-all', () => {
  for (const [kind, table] of Object.entries(SITE_ERRORS)) {
    assert.ok(table[CANNOT[kind]], `${kind} has no ${CANNOT[kind]}`);
    for (const [code, message] of Object.entries(table)) {
      assert.match(code, /^[A-Z_]{2,32}$/);
      assert.doesNotMatch(message, /[0-9{}]/, `${kind}.${code}`);
    }
  }
});

test('siteError: a listed code keeps its sentence; anything else is the kind\'s catch-all', () => {
  assert.deepEqual(siteError('withdraw', 'WRONG_CHAIN'), { code: 'WRONG_CHAIN', message: SITE_ERRORS.withdraw.WRONG_CHAIN });
  assert.deepEqual(siteError('withdraw', 'STALE_READ'), { code: 'CANNOT_WITHDRAW', message: SITE_ERRORS.withdraw.CANNOT_WITHDRAW });
  assert.deepEqual(siteError('invoke', 'INSUFFICIENT_FUNDS'), { code: 'CANNOT_INVOKE', message: SITE_ERRORS.invoke.CANNOT_INVOKE });
  assert.deepEqual(siteError('invoke', undefined), { code: 'CANNOT_INVOKE', message: SITE_ERRORS.invoke.CANNOT_INVOKE });
  assert.deepEqual(siteError('invoke', 'toString'), { code: 'CANNOT_INVOKE', message: SITE_ERRORS.invoke.CANNOT_INVOKE });
});
