// Contacts (spec 2026-09-26 §3.3): ui/lib/contacts.js over the storage interface, the backend's
// `contacts` group, and the #contacts screen. The rules are the CLI's (`rand contacts`,
// fullnode's crates/randprotocol-client/src/contacts.rs): a name is 1–64 characters, never starts
// with `rand1` or `randpay:` in any case, is unique, and an address lives under one name only.
import test from 'node:test';
import assert from 'node:assert/strict';
import './dom-env.mjs';
import { listContacts, addContact, removeContact, nameOf, CONTACTS_KEY } from '../lib/contacts.js';
import { mapStorage } from './backend-fixtures.mjs';
import { unlockedBackend, fakeFingerprint } from './fake-backend.mjs';
import { mountApp } from './helpers.mjs';

const ALICE = `rand1${'a'.repeat(44)}`;
const BOB = `rand1${'b'.repeat(44)}`;

// ------------------------------------------------------------------------------ the library ---

test('add, list and remove, stored under the `contacts` key', async () => {
  const s = mapStorage();
  assert.deepEqual(await listContacts(s), []);
  await addContact(s, 'bob', BOB);
  await addContact(s, 'alice', ALICE);
  assert.deepEqual(await listContacts(s), [{ name: 'alice', address: ALICE }, { name: 'bob', address: BOB }], 'sorted by name');
  assert.ok(s.local.has(CONTACTS_KEY), 'written through storage.set under `contacts`');
  assert.equal(CONTACTS_KEY, 'contacts');
  await removeContact(s, 'alice');
  assert.deepEqual(await listContacts(s), [{ name: 'bob', address: BOB }]);
  await assert.rejects(removeContact(s, 'alice'), /no contact named alice/);
});

test('a name that looks like an address or a link is refused, in any case', async () => {
  const s = mapStorage();
  for (const bad of ['', 'rand1abc', 'RAND1abc', 'Rand1x', 'randpay:x', 'RandPay:x', 'n'.repeat(65)]) {
    await assert.rejects(addContact(s, bad, ALICE), /1-64 characters and cannot start with rand1 or randpay:/, JSON.stringify(bad));
  }
  await addContact(s, 'n'.repeat(64), ALICE);
  assert.equal((await listContacts(s)).length, 1, 'exactly 64 characters is allowed');
});

test('the 64-character limit counts characters, not UTF-16 units', async () => {
  const s = mapStorage();
  await addContact(s, '😀'.repeat(64), ALICE); // 128 UTF-16 units, 64 characters
  assert.equal((await listContacts(s))[0].name, '😀'.repeat(64));
});

test('a name is unique, and an address lives under one name only', async () => {
  const s = mapStorage();
  await addContact(s, 'alice', ALICE);
  await assert.rejects(addContact(s, 'alice', BOB), /a contact named alice exists/);
  await assert.rejects(addContact(s, 'alice2', ALICE), /this address is already saved as alice/);
  assert.equal(await nameOf(s, ALICE), 'alice');
  assert.equal(await nameOf(s, BOB), null);
});

test('a damaged contacts record reads as empty rather than throwing', async () => {
  const s = mapStorage();
  await s.set(CONTACTS_KEY, 'not an object');
  assert.deepEqual(await listContacts(s), []);
  await s.set(CONTACTS_KEY, { entries: { ok: ALICE, bad: 7 } });
  assert.deepEqual(await listContacts(s), [{ name: 'ok', address: ALICE }]);
});

// ---------------------------------------------------------------------------------- the screen ---

const tick = () => new Promise((r) => setTimeout(r, 0));

test('the contacts screen lists names as text, never as markup', async (t) => {
  const b = unlockedBackend();
  await b.contacts.add('<img src=x onerror=alert(1)>', ALICE);
  const { app, root } = await mountApp(t, b, { hash: '#contacts' });
  await app.idle();
  assert.equal(root.querySelector('img'), null, 'a name is never parsed as HTML');
  const names = [...root.querySelectorAll('[data-role="contact-name"]')].map((n) => n.textContent);
  assert.deepEqual(names, ['<img src=x onerror=alert(1)>']);
});

test('adding a contact shows the fingerprint before it is saved', async (t) => {
  const b = unlockedBackend();
  const { app, root } = await mountApp(t, b, { hash: '#contacts' });
  await app.idle();
  root.querySelector('input[name=contact-name]').value = 'alice';
  root.querySelector('textarea[name=contact-address]').value = ALICE;
  root.querySelector('[data-role="contact-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle();
  assert.equal((await b.contacts.list()).length, 0, 'nothing is saved before the fingerprint is confirmed');
  assert.match(root.querySelector('[data-role="contact-fingerprint"]').textContent, new RegExp(fakeFingerprint(ALICE)));
  root.querySelector('[data-role="save-contact"]').click();
  await app.idle();
  assert.deepEqual(await b.contacts.list(), [{ name: 'alice', address: ALICE }]);
  assert.deepEqual([...root.querySelectorAll('[data-role="contact-name"]')].map((n) => n.textContent), ['alice']);
});

test('a contact can be added from a randpay: link; the link’s address is what is saved', async (t) => {
  const b = unlockedBackend();
  const { app, root } = await mountApp(t, b, { hash: '#contacts' });
  await app.idle();
  root.querySelector('input[name=contact-name]').value = 'bob';
  root.querySelector('textarea[name=contact-address]').value = `randpay:${BOB}?amount=1&memo=hi`;
  root.querySelector('[data-role="contact-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle();
  root.querySelector('[data-role="save-contact"]').click();
  await app.idle();
  assert.deepEqual(await b.contacts.list(), [{ name: 'bob', address: BOB }]);
});

test('a refused name is explained on the form, and nothing is saved', async (t) => {
  const b = unlockedBackend();
  const { app, root } = await mountApp(t, b, { hash: '#contacts' });
  await app.idle();
  root.querySelector('input[name=contact-name]').value = 'rand1sneaky';
  root.querySelector('textarea[name=contact-address]').value = ALICE;
  root.querySelector('[data-role="contact-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await app.idle();
  assert.match(root.textContent, /cannot start with rand1 or randpay:/);
  assert.equal(root.querySelector('[data-role="save-contact"]'), null);
  assert.equal((await b.contacts.list()).length, 0);
});

test('removing a contact asks nothing of the chain and takes it off the list', async (t) => {
  const b = unlockedBackend();
  await b.contacts.add('alice', ALICE);
  await b.contacts.add('bob', BOB);
  const { app, root } = await mountApp(t, b, { hash: '#contacts' });
  await app.idle();
  root.querySelector('[data-remove="alice"]').click();
  await app.idle();
  await tick();
  assert.deepEqual(await b.contacts.list(), [{ name: 'bob', address: BOB }]);
  assert.deepEqual([...root.querySelectorAll('[data-role="contact-name"]')].map((n) => n.textContent), ['bob']);
});

test('settings links to contacts', async (t) => {
  const b = unlockedBackend();
  const { app, root } = await mountApp(t, b, { hash: '#settings' });
  await app.idle();
  assert.ok(root.querySelector('[data-go="contacts"]'), 'a way to the contacts screen from settings');
});
