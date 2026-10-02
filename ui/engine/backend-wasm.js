// The Backend (ui/backend.js) for every shell whose chain crypto is the wasm core: the local web
// wallet (web/wallet) and, from task 2.1, the browser extension. It is the first real
// implementation of the contract — until now only ui/test/fake-backend.mjs existed.
//
//     makeWasmBackend({ core, storage, platform, fetch, locks, broadcast })
//
// See `./backend-shared.js` for the shared parameters; this file adds nothing to them. (Its
// `core` is the wasm core, reached through a Web Worker in both browser shells and through
// `initSync` under Node in a test — but that is a fact about this shell, not a different
// parameter.)
//
// This file itself is only two things: `canProve()`, which is hard-coded `{ok: false}` because a
// bundle proof cannot run in wasm at all (see below), and the `executeSend` this shell supplies to
// `send.send`, which runs only when a prover the user paired as their own makes the proof
// (delegated proving: `backend-shared.js` answers `{ok: true, via: 'prover'}` then) and is the
// desktop app's own transfer (`./execute.js`). Everything else — session lifecycle, storage, chain-identity verification, scan,
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
// A bundle proof peaks at ~6.2 GB (`wallet-core`'s own PROVER_PEAK_MEMORY_BYTES) and wasm32 stops
// at 4 GiB, so without a paired prover `send.canProve()` is `{ok: false}` and `send.send()` rejects
// before anything is selected — for a transfer of RAND, for a transfer of an RPL token (which chain 14 admits, and
// which is the same one bundle) and for a withdrawal alike. Everything else — keys, addresses,
// scanning, the note store, assets, fee estimates, the faucet — is real.
import { makeSharedBackend, UNLOCKED_SESSION_KEY, unlockDelayMs } from './backend-shared.js';
import { executeTransfer, executeBurn } from './execute.js';
import { t } from '../i18n.js';

export { UNLOCKED_SESSION_KEY, unlockDelayMs };

/**
 * Shown to the user verbatim, so it is written for them (ui/backend.js on `send.canProve`). The
 * delegated-proving spec's sentence (§4.2): it names both ways out — a prover the user pairs, or
 * the desktop app. `backend-shared.js` answers `{ok: true, via: 'prover'}` instead of this when
 * a prover is paired and answering. (Since split authorisation it need not be the user's own: the
 * spend key stays in this browser, which makes the small auth proof itself.)
 */
export const CANNOT_PROVE_REASON = 'This browser cannot make a transfer proof (it needs about 6.2 GB). '
  + 'Pair a prover in Settings, or send from the desktop app.';

/** `CANNOT_PROVE_REASON` in the user's language (the constant stays English for its importers). */
export const cannotProveText = () => t('This browser cannot make a transfer proof (it needs about 6.2 GB). '
  + 'Pair a prover in Settings, or send from the desktop app.');

async function canProve() {
  return { ok: false, reason: cannotProveText() };
}

/**
 * Reached only through a paired prover (`ctx.via === 'prover'`): the proof is made there and the
 * rest is the desktop app's transfer. Anything else — `canProve()` above always answers `ok:
 * false` — refuses the way it always has, rather than silently starting to prove here.
 */
async function executeSend(ctx) {
  // Delegated proving: the bundle proof is made by the paired prover, not in this browser (which
  // makes only the auth proof, in the core), so the rest of the transfer is the desktop app's.
  if (ctx && ctx.via === 'prover') return executeTransfer(ctx);
  const err = new Error((ctx && ctx.reason) || cannotProveText());
  err.definite = true;
  throw err;
}

/**
 * `executeSend` for a withdrawal: a burn is one bundle proof — the same one a transfer is — so it
 * runs only through a paired prover, and refuses the way it always has otherwise.
 */
async function executeWithdraw(ctx) {
  if (ctx && ctx.via === 'prover') return executeBurn(ctx);
  const err = new Error((ctx && ctx.reason) || cannotProveText());
  err.definite = true;
  throw err;
}

export function makeWasmBackend({ core, storage, platform, fetch: fetchImpl, locks, broadcast, proverOptions } = {}) {
  return makeSharedBackend({
    core, storage, platform, fetch: fetchImpl, locks, broadcast, canProve, executeSend, executeWithdraw, proverOptions,
  });
}
