// `idbStorage` — the `storage` half of makeWasmBackend, over IndexedDB, with a memory-only
// session. `fake-indexeddb/auto` installs a real (in-process) IndexedDB into Node.
import test from 'node:test';
import assert from 'node:assert/strict';
// By path, not by bare specifier: `fake-indexeddb` is a devDependency of `ui/package.json` (the
// one place this repo keeps JavaScript tooling — there is no package.json under web/), and Node
// only looks for `node_modules` in this file's own ancestors, which `ui/` is not one of. The
// import is the package's documented `./auto` entry point, just spelled out.
import '../../../ui/node_modules/fake-indexeddb/auto/index.mjs';
import { idbStorage } from '../idb.js';

test('set/get/clear round-trip and session is memory only', async () => {
  const s = idbStorage('t1');
  await s.set('vault', { iv: 'aa' });
  assert.deepEqual(await s.get('vault'), { iv: 'aa' });
  await s.session.set('unlocked', { spend_key: 'k' });
  const again = idbStorage('t1');
  assert.deepEqual(await again.get('vault'), { iv: 'aa' });
  await s.clear();
  assert.equal(await again.get('vault'), undefined);
});

test('a missing key is undefined, not an error', async () => {
  const s = idbStorage('t2');
  assert.equal(await s.get('nothing-here'), undefined);
  await s.remove('nothing-here'); // also a no-op
});

test('remove deletes one key and leaves the rest', async () => {
  const s = idbStorage('t3');
  await s.set('a', 1);
  await s.set('b', 2);
  await s.remove('a');
  assert.equal(await s.get('a'), undefined);
  assert.equal(await s.get('b'), 2);
});

test('the session is shared between handles to the same database, and never persisted', async () => {
  const s = idbStorage('t4');
  await s.session.set('unlocked', { spend_key: 'secret' });
  const again = idbStorage('t4');
  assert.deepEqual(await again.session.get('unlocked'), { spend_key: 'secret' });

  // Nothing in the persistent half mentions it — the session is a module-level Map, not a store.
  await s.set('vault', { ct: 'zzz' });
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('t4');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const keys = await new Promise((resolve, reject) => {
    const req = db.transaction('kv', 'readonly').objectStore('kv').getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  assert.deepEqual([...keys].sort(), ['vault']);

  await s.session.remove('unlocked');
  assert.equal(await again.session.get('unlocked'), undefined);
});

test('clear empties the session as well as the store', async () => {
  const s = idbStorage('t5');
  await s.set('vault', { ct: 'x' });
  await s.session.set('unlocked', { spend_key: 'secret' });
  await s.clear();
  assert.equal(await s.get('vault'), undefined);
  assert.equal(await s.session.get('unlocked'), undefined);
});

test('two databases do not see each other, session included', async () => {
  const a = idbStorage('t6a');
  const b = idbStorage('t6b');
  await a.set('vault', { ct: 'a' });
  await a.session.set('unlocked', { spend_key: 'a' });
  assert.equal(await b.get('vault'), undefined);
  assert.equal(await b.session.get('unlocked'), undefined);
});

test('values survive structured cloning of the shapes the backend stores', async () => {
  const s = idbStorage('t7');
  const notes = { scanned_index: 3, notes: [{ index: 1, amount: '5', spent: false }], block_times: { 7: 1788000000000 } };
  await s.set('notes', notes);
  const read = await s.get('notes');
  assert.deepEqual(read, notes);
  assert.notEqual(read, notes, 'a read gives back its own object, not the one that was written');
});
