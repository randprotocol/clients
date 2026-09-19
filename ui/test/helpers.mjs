// Shared test-mount helper for app.test.mjs and screens.test.mjs. Moved out of app.test.mjs
// (task 1.4, amendment 12) so both files import one implementation instead of duplicating it.
// Callers must import './dom-env.mjs' themselves first (for its side effects) before importing
// from here, the same as every other ui/test file.
import { mount } from '../app.js';

/**
 * Mounts a fresh app for one test: sets `location.hash` (default `''`), creates and attaches a
 * root `<div>`, mounts `backend` into it, and — via `t.after` — destroys the app and detaches the
 * root once the test finishes, however it finishes (pass or fail). Every test that mounts an app
 * should go through this, never `mount()` directly, so a failed assertion can never leak a
 * window-level `hashchange` listener or DOM nodes into the rest of the suite.
 *
 * `opts.hash` sets the initial route before mounting (default `''`, i.e. whatever `resolveRoute`
 * does with an empty hash); every other key in `opts` is passed straight through to `mount()`.
 */
export async function mountApp(t, backend, opts = {}) {
  const { hash = '', ...mountOpts } = opts;
  location.hash = hash;
  const root = document.createElement('div');
  document.body.append(root);
  const app = await mount(root, backend, mountOpts);
  t.after(() => { try { app.destroy(); } catch { /* already torn down */ } root.remove(); });
  return { app, root };
}
