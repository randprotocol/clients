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

// `randpay:` deep links (spec 2026-09-26 §3.3): `src-tauri/src/main.rs` registers the OS as
// handing this app `randpay:` links (the scheme in `tauri.conf.json`'s
// `plugins.deep-link.desktop.schemes`) through `tauri-plugin-deep-link`, which re-emits every one
// — a link opened while this app is already running (macOS), or the one it was launched with
// (Windows/Linux, and macOS's `getCurrent()` for a cold start) — as the `deep-link://new-url`
// event, `[url, …]`. This never parses the link: it forwards the raw string to the send screen
// exactly as a pasted or scanned link is (`ui/screens/send.js`'s `takeRecipient` reaches
// `core.call('uri_parse')`), through the same `#send?uri=` the web wallet's protocol handler opens
// (`ui/lib/panes.js`'s `parseHash`).
function wireDeepLinks(app) {
  const { event, core } = window.__TAURI__;
  const open = (urls) => {
    const url = Array.isArray(urls) ? urls[0] : urls;
    if (url) app.go(`send?uri=${encodeURIComponent(String(url))}`);
  };
  event.listen('deep-link://new-url', (e) => open(e.payload));
  // A link this process was launched with (cold start) rather than one that arrived while it was
  // already running: `on_open_url`/the CLI-argument path only fire for a *later* one.
  core.invoke('plugin:deep-link|get_current').then(open).catch(() => { /* none pending */ });
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
  const app = await mount(document.body, backend, { mode: 'app' });
  wireDeepLinks(app);
}

boot().catch((err) => fatal((err && err.message) || String(err)));
