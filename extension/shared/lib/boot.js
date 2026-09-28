// What every extension page does, which is the same thing in three window shapes: build the
// backend and mount the shared UI on it.
//
//   popup.html  `boot('popup')`  the toolbar popup, a hard 360×600 window (ui/base.css sizes it
//                                from `body.compact.popup`, which the shell sets for this mode)
//   sidepanel.html `boot('sidebar')` the browser's side panel: one column, the window's height
//   app.html    `boot('app')`    the same wallet in a real tab, where the layout may widen
//
// The shell mounts into `<body>`: it sets page-level classes and the theme on `<html>`, so it has
// to own the page rather than a box inside it.
import { mount } from '../ui/app.js';
import { extensionBackend } from '../backend-extension.js';
import { pendingRoute } from '../ui/lib/resume-route.js';

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
    const backend = extensionBackend();
    // A remote proof left pending (the popup closed mid-proof): open the screen whose mount hook
    // resumes it, rather than home. The job is in session storage, so it outlives the popup.
    const resume = await pendingRoute(backend);
    if (resume && location.hash !== resume) location.hash = resume;
    await mount(document.body, backend, { mode });
  } catch (err) {
    fatal((err && err.message) || String(err));
  }
}
