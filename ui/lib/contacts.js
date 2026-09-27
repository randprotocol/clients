// Contacts: names for the addresses a user pays often (spec 2026-09-26 §3.3).
//
// Stored through the backend's `storage` interface (`storage.get/set`, the same one the vault, the
// note store and the settings go through — ui/engine/backend-shared.js) under ONE key, `contacts`,
// as `{entries: {name: address}}`: the CLI's own file shape (`<key>.contacts.json`, fullnode's
// `crates/randprotocol-client/src/contacts.rs`), so a list is one read and one write, and a wipe,
// which clears storage, takes it with it. No sync between devices.
//
// The rules are the CLI's, word for word in the refusals:
//   * a name is 1–64 characters (characters, not UTF-16 units) and does not start with `rand1` or
//     `randpay:` in any case — a name that looked like an address or a link would make "is this a
//     name or a recipient?" ambiguous at the one place it must not be, the send field;
//   * a name is unique;
//   * an address lives under one name only, so the confirmation line can never name the wrong one.
//
// This module does not decide what a valid address is — that is the core's (`parse_address`), and
// the backend checks it before calling `addContact`. Importable under plain Node.
export const CONTACTS_KEY = 'contacts';

export const NAME_RULE = 'a contact name is 1-64 characters and cannot start with rand1 or randpay:';

/** `null` if `name` is a name the CLI would accept, else the CLI's sentence. */
export function checkContactName(name) {
  const s = typeof name === 'string' ? name : '';
  const lower = s.toLowerCase();
  const chars = [...s].length;
  if (chars === 0 || chars > 64 || lower.startsWith('rand1') || lower.startsWith('randpay:')) return NAME_RULE;
  return null;
}

/** The stored map, with anything that is not a `name → string` pair dropped. Never throws. */
async function readEntries(storage) {
  let stored;
  try { stored = await storage.get(CONTACTS_KEY); } catch { stored = null; }
  const entries = stored && typeof stored === 'object' && stored.entries && typeof stored.entries === 'object'
    ? stored.entries : {};
  const out = new Map();
  for (const [name, address] of Object.entries(entries)) {
    if (typeof address === 'string' && address) out.set(name, address);
  }
  return out;
}

async function writeEntries(storage, map) {
  // A prototype-less object, so a contact called `__proto__` is a name like any other rather
  // than an assignment to the object's prototype.
  const entries = Object.create(null);
  for (const [name, address] of map) entries[name] = address;
  await storage.set(CONTACTS_KEY, { entries });
}

/** `[{name, address}]`, sorted by name (the CLI's BTreeMap order). */
export async function listContacts(storage) {
  const map = await readEntries(storage);
  return [...map.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((name) => ({ name, address: map.get(name) }));
}

/** Adds `name → address`, or rejects with the CLI's sentence. Resolves to the new list. */
export async function addContact(storage, name, address) {
  const bad = checkContactName(name);
  if (bad) throw new Error(bad);
  const addr = String(address || '').trim();
  if (!addr) throw new Error('a contact needs an address');
  const map = await readEntries(storage);
  if (map.has(name)) throw new Error(`a contact named ${name} exists`);
  for (const [other, saved] of map) {
    if (saved === addr) throw new Error(`this address is already saved as ${other}`);
  }
  map.set(name, addr);
  await writeEntries(storage, map);
  return listContacts(storage);
}

/** Removes `name`, or rejects if there is no such contact. */
export async function removeContact(storage, name) {
  const map = await readEntries(storage);
  if (!map.has(name)) throw new Error(`no contact named ${name}`);
  map.delete(name);
  await writeEntries(storage, map);
}

/** The address saved under `name`, or `null`. */
export async function addressOf(storage, name) {
  const map = await readEntries(storage);
  return map.has(name) ? map.get(name) : null;
}

/** The name `address` is saved under, or `null`. */
export async function nameOf(storage, address) {
  const addr = String(address || '').trim();
  for (const [name, saved] of await readEntries(storage)) if (saved === addr) return name;
  return null;
}
