// Bridge to the wasm core running in a Web Worker (worker.js), so a bundle proof — a minute or
// more of single-threaded arithmetic — never blocks a page. `call(method, params)` resolves to
// the reply's `value` or rejects with the core's error text.
import { ext } from './browser.js';

let worker = null;
let seq = 0;
const pending = new Map();

function ensure() {
  if (worker) return worker;
  worker = new Worker(ext.runtime.getURL('worker.js'), { type: 'module' });
  worker.onmessage = (e) => {
    const { id, ok, value, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(value) : p.reject(new Error(error));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'core worker failed'));
    pending.clear();
    worker = null;
  };
  return worker;
}

export function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ensure().postMessage({ id, method, params });
  });
}

export const core = {
  version: () => call('version'),
  keygen: () => call('keygen'),
  walletInfo: (spend_key) => call('wallet_info', { spend_key }),
  importKey: (input) => call('import_key', { input }),
  parseAddress: (address) => call('parse_address', { address }),
  scanPage: (spend_key, rows) => call('scan_page', { spend_key, rows }),
  rebuiltDeposit: (spend_key, action) => call('rebuilt_deposit', { spend_key, action }),
  pendingCleared: (note, read_through) => call('pending_cleared', { note, read_through }),
  selectInputs: (notes, need, asset = 0) => call('select_inputs', { notes, need: String(need), asset }),
  proveTransfer: (req) => call('prove_transfer', req),
  openWithTxKey: (cm, envelope, tx_key) => call('open_with_tx_key', { cm, envelope, tx_key }),
  formatAmount: (units) => call('format_amount', { units: String(units) }),
  parseAmount: (text) => call('parse_amount', { text }),
};
