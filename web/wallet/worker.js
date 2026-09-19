// The wasm core lives here, off the UI thread. Messages: {id, method, params} → {id, ok, value|error}.
//
// Identical in shape to the extension's worker (extension/shared/worker.js); only the URL of the
// core differs. A spend key crosses this boundary as a call parameter and is never kept: this file
// holds no state of its own at all.
import init, { call } from './core/rand_wallet.js';

const ready = init({ module_or_path: new URL('./core/rand_wallet_bg.wasm', import.meta.url) })
  .catch((e) => { throw new Error('loading the wallet core failed: ' + (e?.message || e)); });

self.onmessage = async (e) => {
  const { id, method, params } = e.data;
  try {
    await ready;
    const reply = JSON.parse(call(method, JSON.stringify(params ?? {})));
    self.postMessage(reply.ok ? { id, ok: true, value: reply.value } : { id, ok: false, error: reply.error });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
};
