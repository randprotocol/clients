// Rand Wallet on the desktop: the shared UI, mounted on the shared engine, over Tauri's IPC.
//
// The same three lines `web/wallet/main.js` is, with a different backend underneath — which is
// the point of the whole shell. Everything the user sees is `ui/`, and it does not learn that it
// is running in a Tauri window any more than it learns it is running in a browser tab.
import { mount } from './ui/app.js';
import { makeBackend } from './backend-tauri.js';

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
  const backend = await makeBackend();

  // Warms the constants the backend reads from the core (chain id, token symbol, decimals), and
  // says so early if the core is somehow unreachable — which is otherwise a mystery at the first
  // keypress. `settings.get()` is the cheapest call that goes through it.
  try {
    await backend.settings.get();
  } catch (err) {
    fatal(`The wallet core did not answer: ${(err && err.message) || err}`);
    return;
  }

  // The shell mounts into <body>: it sets page-level classes (compact/wide) and the theme on
  // <html>, so it must own the page, not a box inside it.
  await mount(document.body, backend, { mode: 'app' });
}

boot().catch((err) => fatal((err && err.message) || String(err)));
