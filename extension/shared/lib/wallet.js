// Moved to ui/engine/wallet.js in task 1.6, where it takes its collaborators instead of importing
// them, so the browser extension and the local web wallet share one implementation of the chain
// protocol and differ only in where the bytes are kept.
//
// This file is the extension's binding of those collaborators — `chrome.storage` through
// `./store.js`, the wasm core through `./core.js` — behind the exact signatures the old extension
// UI (`views.js`) already calls. It is deleted with that UI in task 2.1, when the extension moves
// onto `ui/` and `ui/engine/backend-wasm.js`.
import { makeWallet, activity, balanceOf, isSpendable, waitForTransaction, COMMIT_TIMEOUT_MS, emptyNoteStore } from '../../../ui/engine/wallet.js';
import { makeRpc } from '../../../ui/engine/rpc.js';
import { call } from './core.js';
import { getNoteStore, setNoteStore, getSettings } from './store.js';

export { activity, balanceOf, isSpendable, waitForTransaction, COMMIT_TIMEOUT_MS, emptyNoteStore };

export async function rpcFor(settings) {
  const s = settings || (await getSettings());
  return makeRpc(s.rpcUrl);
}

const engine = makeWallet({
  core: { call },
  store: { getNoteStore, setNoteStore },
  rpc: rpcFor,
  settings: getSettings,
});

export const scan = (spendKey, options, settings) => engine.scan(spendKey, options, settings);
export const send = (spendKey, request, settings) => engine.send(spendKey, request, settings);
export const faucet = (spendKey, address, settings) => engine.faucet(spendKey, address, settings);
