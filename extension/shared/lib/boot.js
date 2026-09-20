// What both extension pages do, which is the same thing in two window shapes: build the backend
// and mount the shared UI on it.
//
//   popup.html  `boot('popup')`  the toolbar popup, a hard 360×600 window (ui/base.css sizes it
//                                from `body.compact.popup`, which the shell sets for this mode)
//   app.html    `boot('app')`    the same wallet in a real tab, where the layout may widen
//
// The shell mounts into `<body>`: it sets page-level classes and the theme on `<html>`, so it has
// to own the page rather than a box inside it.
import { mount } from '../ui/app.js';
import { extensionBackend } from '../backend-extension.js';

/**
 * The last resort, for the two failures that happen before there is any UI to report them in: the
 * wasm core is missing (nobody ran `core/scripts/build-wasm.sh`) or the packed tree is incomplete.
 * Built from DOM nodes and `textContent`, never `innerHTML`: this quotes an error message.
 */
function fatal(message) {
  const box = document.createElement('div');
  box.className = 'banner negative';
  const title = document.createElement('span');
  title.className = 'banner-title';
  title.textContent = 'Rand Wallet could not start';
  const detail = document.createElement('span');
  detail.textContent = message;
  const wrap = document.createElement('span');
  wrap.append(title, detail);
  box.append(wrap);
  document.body.append(box);
}

export async function boot(mode) {
  try {
    await mount(document.body, extensionBackend(), { mode });
  } catch (err) {
    fatal((err && err.message) || String(err));
  }
}
