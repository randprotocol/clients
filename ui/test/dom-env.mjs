// Minimal DOM environment for `node --test ui/test/`, built on linkedom, plus the handful of
// browser APIs linkedom does not implement that app.js/screens rely on: `location.hash` (with a
// `hashchange` event, like a real browser), `matchMedia`, `KeyboardEvent`, and
// `document.activeElement` tracking through `.focus()`/`.blur()`.
//
// Dev-only. Shipped code must still feature-detect anything shimmed here (see ui/app.js's
// `typeof matchMedia === 'function'` guard) — a real browser provides all of this natively; this
// file exists only so the same code paths can be exercised under `node --test`.
//
// Side-effecting: importing this module installs `document`/`window`/etc. as globals. Every test
// file imports it first, before importing anything from ui/.
import { parseHTML } from 'linkedom';

const { window, document } = parseHTML('<!doctype html><html><body></body></html>');

// ---- location: a `hash` that fires `hashchange` on window, the way a real browser does ----
let currentHash = '';
const location = {
  get hash() { return currentHash; },
  set hash(value) {
    const next = value ? (String(value).startsWith('#') ? String(value) : `#${value}`) : '';
    if (next === currentHash) return;
    currentHash = next;
    window.dispatchEvent(new window.Event('hashchange'));
  },
  toString() { return currentHash; },
};
window.location = location;
document.location = location;

// ---- matchMedia: a tiny MediaQueryList backed by a mutable `window.innerWidth` ----
// Every list this factory hands out is remembered so `setViewportWidth()` can re-evaluate all of
// them and fire their `change` listeners, exactly as a real browser does on a resize. That is what
// lets a test cross the 900 px and 1080 px breakpoints live — `ui/app.js` switches between the
// compact, wide and two-pane layouts on those events, and the app under test holds the only other
// reference to its own MediaQueryLists.
//
// The set is pruned rather than weak: a mounted app registers a listener and `destroy()` removes
// it, so a list with no listeners left is one nobody can observe any more and is dropped on the
// next resize. Without that, a file that mounts fifty apps would resize fifty dead lists.
window.innerWidth = window.innerWidth || 375;
const mediaLists = new Set();
function matchMedia(query) {
  const m = /min-width:\s*(\d+)px/.exec(String(query));
  const minWidth = m ? Number(m[1]) : 0;
  const mql = {
    get matches() { return window.innerWidth >= minWidth; },
    media: String(query),
    _listeners: [],
    addEventListener(type, fn) { if (type === 'change') mql._listeners.push(fn); },
    removeEventListener(type, fn) { mql._listeners = mql._listeners.filter((f) => f !== fn); },
    addListener(fn) { mql._listeners.push(fn); }, // legacy alias some code still calls
    removeListener(fn) { mql._listeners = mql._listeners.filter((f) => f !== fn); },
    _check() { const now = mql.matches; for (const fn of mql._listeners.slice()) fn({ matches: now }); },
  };
  mediaLists.add(mql);
  return mql;
}
window.matchMedia = matchMedia;

/**
 * Resizes the fake viewport and notifies every live MediaQueryList, the way a browser resize does.
 * Set it *before* mounting to choose the layout an app starts in; call it after mounting to cross
 * the breakpoint under a running app.
 */
export function setViewportWidth(width) {
  window.innerWidth = width;
  for (const mql of [...mediaLists]) {
    if (mql._listeners.length === 0) { mediaLists.delete(mql); continue; }
    mql._check();
  }
}

/** How many live MediaQueryLists this environment is still tracking (for a leak assertion). */
export function liveMediaListCount() {
  return mediaLists.size;
}

/** The compact default every other test file relies on. */
export const COMPACT_WIDTH = 375;
/** Comfortably past `--wide-at` (900 px). */
export const WIDE_WIDTH = 1200;

// ---- KeyboardEvent: linkedom has no key-aware event class; Escape/Tab handling needs `.key` ----
class KeyboardEvent extends window.Event {
  constructor(type, init = {}) {
    super(type, init);
    this.key = init.key ?? '';
    // All four modifiers, not just Shift: a handler that ignores a modified keypress (the arrow
    // keys in the two-pane list, which must not fight Cmd+Down or a Shift-selection) can only be
    // tested if the environment actually carries them.
    this.shiftKey = !!init.shiftKey;
    this.metaKey = !!init.metaKey;
    this.ctrlKey = !!init.ctrlKey;
    this.altKey = !!init.altKey;
  }
}
window.KeyboardEvent = KeyboardEvent;

// ---- focus / activeElement: linkedom's .focus()/.blur() exist but never update activeElement ----
let activeElement = null;
Object.defineProperty(document, 'activeElement', {
  get() { return activeElement || document.body; },
  configurable: true,
});
const originalFocus = window.HTMLElement.prototype.focus;
window.HTMLElement.prototype.focus = function focus(...args) {
  activeElement = this;
  if (typeof originalFocus === 'function') { try { originalFocus.apply(this, args); } catch { /* linkedom no-op */ } }
};
const originalBlur = window.HTMLElement.prototype.blur;
window.HTMLElement.prototype.blur = function blur(...args) {
  if (activeElement === this) activeElement = null;
  if (typeof originalBlur === 'function') { try { originalBlur.apply(this, args); } catch { /* linkedom no-op */ } }
};

// ---- install as globals, the way a browser environment provides them ----
globalThis.window = window;
globalThis.document = document;
globalThis.location = location;
try {
  // Node's own global `navigator` (added in recent Node versions) is a getter-only accessor
  // property, so a plain assignment throws; redefine it instead.
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
} catch { /* not configurable in this Node version: leave Node's own navigator in place */ }
globalThis.matchMedia = matchMedia;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.KeyboardEvent = KeyboardEvent;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.getComputedStyle = window.getComputedStyle || (() => ({ getPropertyValue: () => '' }));

export { window, document, location };
