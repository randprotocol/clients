// Rand Wallet in a browser tab, on the real wasm core.
//
// This file is the whole of what is specific to the web shell: it wires three things that already
// exist — the shared UI (`ui/app.js`), the shared Backend (`ui/engine/backend-wasm.js`) and this
// shell's storage (`idb.js`) — to the browser's own APIs, and gets out of the way. There is no
// bundler: the browser loads these modules as it finds them.
//
// What this shell cannot do: produce a transfer proof. It needs about 5.7 GB and wasm32 stops at
// 4 GiB, so the Send flow ends in an explanation rather than a Prove button (see
// `send.canProve()`). Everything else is real — real keys, a real address, a real scan of a real
// node's commitment tree, a real note store.
import { mount } from './ui/app.js';
import { makeWasmBackend } from './ui/engine/backend-wasm.js';
import { idbStorage } from './idb.js';

// ------------------------------------------------------------------------------- the core -----
// A promise wrapper over the Web Worker in worker.js: `call(method, params)` resolves to the
// reply's `value` or rejects with the core's own error text. The worker is started lazily and
// restarted if it dies, so a crash in the core does not leave every later call hanging.
function makeCore(url) {
  let worker = null;
  let seq = 0;
  const pending = new Map();

  function ensure() {
    if (worker) return worker;
    worker = new Worker(url, { type: 'module' });
    worker.onmessage = (e) => {
      const { id, ok, value, error } = e.data;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (ok) entry.resolve(value);
      else entry.reject(new Error(error));
    };
    worker.onerror = (e) => {
      const failure = new Error(e.message || 'the wallet core stopped');
      for (const entry of pending.values()) entry.reject(failure);
      pending.clear();
      try { worker.terminate(); } catch { /* already gone */ }
      worker = null;
    };
    return worker;
  }

  return {
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        ensure().postMessage({ id, method, params });
      });
    },
  };
}

// ----------------------------------------------------------------------------- the platform ---
// Everything the UI is allowed to ask the browser for. Each member is here because a screen
// feature-detects it; nothing optional is faked.
function makePlatform(version) {
  const platform = {
    name: 'web',
    // `noopener` (and `noreferrer` through the page's meta) so the opened page gets no handle on
    // this one — the wallet's window is not something an explorer should be able to reach into.
    openExternal: (url) => { window.open(url, '_blank', 'noopener,noreferrer'); },
    copy: (text) => navigator.clipboard.writeText(String(text ?? '')),
  };
  if (version) platform.version = version;
  // Optional in the contract: where reading the clipboard is not available, the send screen offers
  // no Paste button at all rather than one that does nothing.
  if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
    platform.paste = () => navigator.clipboard.readText();
  }
  return platform;
}

// ----------------------------------------------------------------------------------- boot -----
function fatal(message) {
  const box = document.createElement('div');
  box.className = 'banner negative';
  const title = document.createElement('span');
  title.className = 'banner-title';
  title.textContent = 'Rand Wallet could not start';
  const detail = document.createElement('span');
  detail.textContent = message; // textContent, never innerHTML: this may quote an error
  const wrap = document.createElement('span');
  wrap.append(title, detail);
  box.append(wrap);
  document.body.append(box);
}

async function boot() {
  const core = makeCore(new URL('./worker.js', import.meta.url));

  // Also warms the constants the backend reads (chain id, token symbol, decimals) — and tells us
  // early if the wasm artefact is missing, which is otherwise a mystery at the first keypress.
  let version = '';
  try {
    const constants = await core.call('version');
    version = String(constants.version || '');
  } catch (err) {
    fatal(`The wallet core did not load: ${(err && err.message) || err}. Run web/wallet/build.sh and reload.`);
    return;
  }

  const backend = makeWasmBackend({
    core,
    storage: idbStorage('rand-wallet'),
    platform: makePlatform(version),
  });

  // The shell mounts into <body>: it sets page-level classes (compact/wide) and the theme on
  // <html>, so it must own the page, not a box inside it.
  await mount(document.body, backend, { mode: 'app' });
}

boot().catch((err) => fatal((err && err.message) || String(err)));
