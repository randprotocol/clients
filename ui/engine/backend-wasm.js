// The Backend (ui/backend.js) for every shell whose chain crypto is the wasm core: the local web
// wallet (web/wallet) and, from task 2.1, the browser extension. It is the first real
// implementation of the contract — until now only ui/test/fake-backend.mjs existed.
//
//     makeWasmBackend({ core, storage, platform, fetch, locks, broadcast })
//
//   core       `{ call(method, params) -> Promise }` — the wasm core, however this shell reaches
//              it (a Web Worker in both browser shells, `initSync` directly under Node in a test).
//   storage    `{ get(key), set(key, value), remove(key), clear(), session: {get, set, remove},
//               compareAndSet?(key, expectedRev, value) }`, all async. The persistent half survives
//              a reload; **`session` is memory only** and is the one place the plaintext spend key
//              is ever written. `compareAndSet` is OPTIONAL: where a shell's storage can write
//              conditionally on a revision (web/wallet/idb.js does it in one IndexedDB
//              transaction) the note store uses it so two tabs cannot overwrite each other; where
//              it is missing, a plain `set`.
//   platform   the `platform` group, passed through as given: `{name, openExternal, copy}` plus
//              whatever optional members this shell has (`version`, `paste`, `openFlowInTab`,
//              `ensureHostPermission`).
//   fetch      optional; defaults to the global. Only the JSON-RPC client uses it.
//   locks      optional; defaults to `navigator.locks`. Used with `ifAvailable` so only one tab
//              scans at a time. `null` turns it off.
//   broadcast  optional; defaults to `new BroadcastChannel('rand-wallet')`. How the scanning tab
//              tells the others it has finished. `null` turns it off.
//
// This file itself is only two things: `canProve()`, which is hard-coded `{ok: false}` because a
// bundle proof cannot run in wasm at all (see below), and the `executeSend` this shell supplies to
// `send.send` when `canProve()` somehow said otherwise (never happens today; see the comment on
// `executeSend`). Everything else — session lifecycle, storage, chain-identity verification, scan,
// rescan, the unlock-attempt throttle, roughly 1100 lines — has nothing to do with wasm
// specifically, and lives once in `./backend-shared.js`'s `makeSharedBackend`, which a later
// native/desktop backend (task 3.2) builds on unchanged. Read that file's header for the shared
// factory's exact contract; this file does not repeat it.
//
// ---- where the plaintext spend key can exist ----
//
//   1. inside the wasm core, for the duration of a call it is a parameter of;
//   2. in `storage.session` under `unlocked`, while the wallet is unlocked;
//   3. in a local variable of whichever method is using it, for that call.
//
// It is *never* in the persistent half of `storage`, in a URL, in an error message, in the
// console, or in anything handed to `fetch`. `ui/test/backend-wasm.test.mjs` records every
// argument every collaborator is given and scans all of them for it.
//
// ---- what this shell cannot do ----
//
// A bundle proof peaks at ~5.6 GB (`wallet-core`'s own PROVER_PEAK_MEMORY_BYTES) and wasm32 stops
// at 4 GiB, so `send.canProve()` is `{ok: false}` and `send.send()` rejects before anything is
// selected. Everything else — keys, addresses, scanning, the note store, assets, fee estimates,
// the faucet — is real.
import { makeSharedBackend, UNLOCKED_SESSION_KEY, RPL_SEND_DISABLED_TEXT, unlockDelayMs } from './backend-shared.js';

export { UNLOCKED_SESSION_KEY, RPL_SEND_DISABLED_TEXT, unlockDelayMs };

/** Shown to the user verbatim, so it is written for them (ui/backend.js on `send.canProve`). */
export const CANNOT_PROVE_REASON = 'A transfer proof needs about 5.5 GB of memory and browsers '
  + 'give WebAssembly 4 GB. Send from the Rand Wallet desktop app — your keys import there.';

async function canProve() {
  return { ok: false, reason: CANNOT_PROVE_REASON };
}

/**
 * Never actually reached: `canProve()` above always answers `ok: false`, and `send.send`
 * (backend-shared.js) refuses there, before calling this at all. It exists anyway, in the same
 * shape a real `executeSend` would have, so that shape is proven out even though this shell has no
 * way to exercise it — and so that if `canProve()` were ever changed, `send.send` would still fail
 * the way it always has, rather than silently starting to prove.
 */
async function executeSend({ reason }) {
  const err = new Error(reason || CANNOT_PROVE_REASON);
  err.definite = true;
  throw err;
}

export function makeWasmBackend({ core, storage, platform, fetch: fetchImpl, locks, broadcast } = {}) {
  return makeSharedBackend({
    core, storage, platform, fetch: fetchImpl, locks, broadcast, canProve, executeSend,
  });
}
