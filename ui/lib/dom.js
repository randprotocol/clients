// Tiny DOM/templating helpers shared by every shell (desktop, extension, web wallet). Importable
// under plain Node (no top-level access to `document`) so `h`/`raw` can be unit tested directly.
import { escapeHtml } from './format.js';

const RAW = Symbol('raw');

/** Marks a string as pre-escaped/trusted so `h` inlines it verbatim. */
export function raw(s) {
  return { [RAW]: true, toString: () => String(s ?? '') };
}

function isRaw(v) {
  return v != null && typeof v === 'object' && v[RAW] === true;
}

function interpolate(value) {
  if (value === null || value === undefined || value === false) return '';
  if (isRaw(value)) return String(value);
  if (Array.isArray(value)) return value.map(interpolate).join('');
  return escapeHtml(String(value));
}

/**
 * Tagged template that HTML-escapes every interpolation unless it is wrapped in `raw()`.
 * Arrays are flattened and joined; each array item is escaped (or kept raw) individually.
 * `null`/`undefined`/`false` interpolate as the empty string.
 */
export function h(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += interpolate(values[i]) + strings[i + 1];
  return out;
}

/**
 * Event delegation: listens on `root` for `event`, and calls `fn(event, matched)` when the
 * event target's closest `selector` ancestor (bounded to `root`) is found. Returns an
 * unsubscribe function.
 */
export function on(root, selector, event, fn) {
  const handler = (evt) => {
    const target = evt.target instanceof Element ? evt.target : null;
    const matched = target && target.closest(selector);
    if (matched && root.contains(matched)) fn(evt, matched);
  };
  root.addEventListener(event, handler);
  return () => root.removeEventListener(event, handler);
}
