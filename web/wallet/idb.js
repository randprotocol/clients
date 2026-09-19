// The `storage` half of `makeWasmBackend` for a page: one IndexedDB key/value store for what has
// to survive a reload, and a module-level Map for what must not.
//
// The split is the whole security model of this shell:
//
//   * the **persistent** half holds the encrypted vault, the public wallet facts (address and
//     public key), the settings and the note store — a cache of chain data that can be rebuilt
//     from leaf 0. Nothing in it is a secret at rest: the vault is AES-256-GCM under PBKDF2.
//   * the **session** half holds the unlocked spend key, and lives in a `Map` in this module.
//     It is not `sessionStorage` and not IndexedDB, so it cannot be read back after a reload, by
//     another tab, or by anything with a handle on the origin's storage — the page losing its
//     session on reload (the lock screen coming back) is the design, not a limitation.
//
// One store, `kv`. Values go through IndexedDB's structured clone, so a read gives back its own
// object and a caller mutating it cannot reach into the database.

const STORE = 'kv';
// dbName -> Map. Module-level, so two handles to the same database share one session — and so it
// dies with the page.
const sessions = new Map();
// dbName -> Promise<IDBDatabase>, so a burst of calls opens the database once.
const opening = new Map();

function openDb(dbName) {
  if (!opening.has(dbName)) {
    opening.set(dbName, new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error(`could not open ${dbName}`));
      req.onblocked = () => reject(new Error(`${dbName} is blocked by another tab`));
    }).catch((err) => { opening.delete(dbName); throw err; }));
  }
  return opening.get(dbName);
}

function run(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let value;
    const req = fn(tx.objectStore(STORE));
    if (req) req.onsuccess = () => { value = req.result; };
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

/**
 * `idbStorage(dbName = 'rand-wallet')` → the `storage` object `makeWasmBackend` takes:
 * `{get, set, remove, clear, session: {get, set, remove}}`, all async.
 */
export function idbStorage(dbName = 'rand-wallet') {
  if (!sessions.has(dbName)) sessions.set(dbName, new Map());
  const session = sessions.get(dbName);

  return {
    async get(key) {
      const db = await openDb(dbName);
      return run(db, 'readonly', (store) => store.get(key));
    },
    async set(key, value) {
      const db = await openDb(dbName);
      await run(db, 'readwrite', (store) => store.put(value, key));
    },
    async remove(key) {
      const db = await openDb(dbName);
      await run(db, 'readwrite', (store) => store.delete(key));
    },
    async clear() {
      session.clear();
      const db = await openDb(dbName);
      await run(db, 'readwrite', (store) => store.clear());
    },
    session: {
      async get(key) { return session.get(key); },
      async set(key, value) { session.set(key, value); },
      async remove(key) { session.delete(key); },
    },
  };
}
