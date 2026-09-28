// The Backend (ui/backend.js) for the one shell that can actually complete a transfer: the Tauri
// desktop app, whose `core` is the real `wallet-core` crate compiled for this machine rather than
// for wasm32.
//
//     makeNativeBackend({ core, storage, platform, fetch, locks, broadcast, systemMemoryGiB })
//
// See `./backend-shared.js` for the shared parameters. This file adds exactly one:
//
//   systemMemoryGiB()  -> number | Promise<number>   how much RAM this computer has, in GiB.
//              Injected rather than measured here, because JavaScript in a webview cannot see it:
//              on the desktop it is the `system_memory_gib` Tauri command (the `sysinfo` crate).
//              Only `canProve()` uses it. A shell that does not supply it gets a backend that
//              refuses to prove and says why — never one that tries and is killed by the OOM
//              killer half an hour in.
//
// ---- why this shell is different, and it is only two things ----
//
// The 4 GiB wasm32 address-space cap that makes `send.canProve()` unconditionally false in every
// browser shell is a property of WASM, not of the host machine. Running natively removes it, with
// no limit but the machine's real RAM. So:
//
//   1. `canProve()` is a real question with a real answer, asked of the machine;
//   2. `executeSend` really sends (`./execute.js`, shared since delegated proving with the wasm
//      shells' prover path; a machine without the memory falls back to a paired prover in
//      `backend-shared.js`) — by calling `ui/engine/wallet.js`'s `send()`, which is already
//      the complete, correct transfer (select inputs, anchor and witnesses, `prove_transfer`,
//      submit, wait for the block, re-scan with the same verified client). It has simply never run
//      in production, because until this shell every caller of `core` was wasm.
//
// Everything else — the session lifecycle, the vault, the note store, scanning, the unlock
// throttle and, above all, the verified-chain gate that task 1.6 hardened over five rounds — is
// `backend-shared.js`, unchanged and shared byte for byte with the browser shells.
import { makeSharedBackend, UNLOCKED_SESSION_KEY, unlockDelayMs } from './backend-shared.js';
import { executeTransfer, executeBurn } from './execute.js';

export { UNLOCKED_SESSION_KEY, unlockDelayMs };

/**
 * How much memory a machine must report before this wallet will attempt a bundle proof.
 *
 * The proof itself peaks at ~5.7 GB (`wallet-core`'s own `PROVER_PEAK_MEMORY_BYTES`). 8 GiB is
 * that plus room for the operating system, the webview and whatever else the user has open: a
 * machine that only just clears the peak would swap for the whole proof, or be killed part-way
 * through — and a transfer killed after `rand_sendTransaction` is the one outcome this wallet
 * must never produce by choice.
 */
export const MIN_PROVE_GIB = 8;

/** `7` and `7.5`, not `7.000000001` — this number is shown to the user, not compared. */
function saidGiB(gib) {
  return String(Math.round(gib * 10) / 10);
}

export function cannotProveReason(gib) {
  if (!Number.isFinite(gib) || gib <= 0) {
    return 'Proving needs about 5.7 GB of free memory, and this computer did not report how much it has.';
  }
  return `Proving needs about 5.7 GB of free memory; this computer reports ${saidGiB(gib)} GB.`;
}

function makeCanProve(systemMemoryGiB) {
  return async function canProve() {
    let gib = Number.NaN;
    if (typeof systemMemoryGiB === 'function') {
      // A command that failed is "we do not know", never "yes": the whole value of answering this
      // before touching the network is that the answer cannot be wrong.
      try { gib = Number(await systemMemoryGiB()); } catch { gib = Number.NaN; }
    }
    if (Number.isFinite(gib) && gib >= MIN_PROVE_GIB) return { ok: true };
    return { ok: false, reason: cannotProveReason(gib) };
  };
}

export function makeNativeBackend({ core, storage, platform, fetch: fetchImpl, locks, broadcast, systemMemoryGiB, proverOptions } = {}) {
  return makeSharedBackend({
    core, storage, platform, fetch: fetchImpl, locks, broadcast, proverOptions,
    canProve: makeCanProve(systemMemoryGiB),
    executeSend: executeTransfer,
    executeWithdraw: executeBurn,
  });
}
