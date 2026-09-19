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
 * A conditional write lost its race. Identified by `name`, not by class, so `ui/engine/` can
 * recognise it (`isStaleStoreError`) without this file and that one having to share a module.
 */
export class StaleStoreError extends Error {
  constructor(key, expected, found) {
    super(`${key} changed underneath this write (expected revision ${expected}, found ${found})`);
    this.name = 'StaleStoreError';
    this.expectedRev = expected;
    this.foundRev = found;
  }
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

    /**
     * OPTIONAL in the storage contract (see ui/engine/backend-wasm.js): writes `value` at `key`
     * **only if** what is stored there is still at revision `expectedRev`, and resolves with the
     * new revision. The read and the write happen in **one** IndexedDB readwrite transaction,
     * which the database serialises against every other one on this store, so nothing can slip in
     * between them.
     *
     * This is what stops two tabs of the same wallet from silently overwriting each other's note
     * store. Without it the last writer wins and one tab's whole scan disappears — including,
     * potentially, a cursor that had moved further than the surviving tab's.
     *
     * `expectedRev === undefined` means "there was nothing stored when I loaded it".
     * A mismatch rejects with `StaleStoreError`; the engine merges and retries once.
     */
    async compareAndSet(key, expectedRev, value) {
      const db = await openDb(dbName);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        let nextRev;
        let stale = null;
        const read = store.get(key);
        read.onsuccess = () => {
          const current = read.result;
          const found = current && typeof current === 'object' ? current.rev : undefined;
          if (found !== expectedRev) {
            stale = new StaleStoreError(key, expectedRev, found);
            // Aborting is what makes this atomic: the put below never happens.
            try { tx.abort(); } catch { /* already finishing */ }
            return;
          }
          nextRev = Number.isSafeInteger(found) ? found + 1 : 1;
          store.put({ ...value, rev: nextRev }, key);
        };
        tx.oncomplete = () => resolve(nextRev);
        // An explicit `abort()` leaves `tx.error` null, so the stale error is carried across.
        tx.onabort = () => reject(stale || tx.error || new Error('transaction aborted'));
        tx.onerror = () => reject(stale || tx.error);
      });
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
