// The wasm core lives here. Messages: {id, method, params} → {id, ok, value|error}.
import init, { call } from './core/shrugg_wallet.js';

const ready = init({ module_or_path: new URL('./core/shrugg_wallet_bg.wasm', import.meta.url) })
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
