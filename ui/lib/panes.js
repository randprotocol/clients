// Everything about there being *two* panes on a wide screen: the routing decision (which screen
// goes in the content pane, which in the detail pane), one mounted pane's bookkeeping, the header
// a detail screen draws depending on where it landed, and the selected-row marking a list screen
// does. Split out of ui/app.js in task 1.7 so the router stays readable.
//
// Nothing here talks to `document` at module scope, so it is importable under plain Node; the two
// DOM helpers at the bottom take the nodes they work on as arguments.
//
// The shell and the screens share one idea through this module: **a route is either a list or a
// detail of one.** `PARENT_ROUTES` is the list half — the routes made of rows the user picks from —
// and it is the single place that fact is written down. The shell uses it to remember where the
// user was; a detail screen's `parent()` uses it to refuse a `from` that is not a list.
import { h, raw } from './dom.js';
import { icons } from './icons.js';

/**
 * The width at which there is room for *two* panes — a second breakpoint, above the 900 px one
 * that brings in the sidebar. Between the two the layout is sidebar + a single content pane, and
 * a detail route replaces that pane exactly as it does on a phone.
 *
 * The arithmetic, from the layout's own numbers (`ui/base.css` mirrors it in a comment, and
 * `--two-pane-at` records the result so the two cannot drift):
 *
 *     240  the sidebar's fixed column
 *   + 452  the list column: the compact layout's 420 px column is 388 px of content inside its
 *          2 × --s-4 padding, and the wide column pads by 2 × --s-7 (64), so 388 + 64 = 452
 *   + 352  the detail column: 328 px of content — what a 360 px popup gets inside its padding —
 *          plus the pane's own --s-6 (24) right padding
 *   = 1044, rounded up to the round number below.
 *
 * Under this, one of the two panes is narrower than the single-column layout it replaced, which
 * is worse than not splitting at all.
 */
export const TWO_PANE_AT = 1080;

/** The media query for it. One string, used by the shell; `ui/base.css` mirrors it exactly. */
export const TWO_PANE_QUERY = `(min-width: ${TWO_PANE_AT}px)`;

/** The routes that can host a detail pane: screens that are lists of rows. */
export const PARENT_ROUTES = ['home', 'activity', 'asset'];

/** `#name/arg` → `{name, arg}`; the leading `#` is optional and `arg` may be undefined. */
export function parseHash(hash) {
  const s = String(hash || '').replace(/^#/, '');
  if (!s) return { name: '', arg: undefined };
  const i = s.indexOf('/');
  return i === -1 ? { name: s, arg: undefined } : { name: s.slice(0, i), arg: s.slice(i + 1) };
}

/** `{name, arg}` → `#name/arg`, the form `location.hash` and `href` take. */
export function routeHash(route) {
  return route.arg === undefined || route.arg === '' ? `#${route.name}` : `#${route.name}/${route.arg}`;
}

/** `{name, arg}` → `name/arg`, the form `data-go` and `ctx.selected` take. */
export function routeGo(route) {
  return route.arg === undefined || route.arg === '' ? String(route.name) : `${route.name}/${route.arg}`;
}

/** True if `hash` names a route that lists rows, i.e. one a detail pane can open beside. */
export function isParentRoute(hash) {
  return PARENT_ROUTES.includes(parseHash(hash).name);
}

/**
 * A detail screen's `parent()` for the screens whose parent is "whichever list you came from":
 * the transaction and the note. `from` is the shell's memory of the last list route; anything
 * else (a flow, a settings screen, nothing at all on a deep link) falls back.
 */
export function listParent(from, fallback = '#activity') {
  return isParentRoute(from) ? String(from) : fallback;
}

// -------------------------------------------------------------------------- the pane plan ----

/**
 * Decides what is mounted where. Pure — it reads no DOM and no module state.
 *
 * `twoPane` is the shell's answer to "is the wide layout on at all" (wide viewport, not a popup,
 * and a sidebar on screen). A detail-pane screen only *gets* a second pane when that is true and
 * it names a parent that is actually registered; otherwise it renders full-screen in the content
 * pane exactly as it did before this task, which is also what compact and the popup always get.
 *
 * Returns `{content, contentScreen, detail, detailScreen}` — `detail` is null for a single pane.
 */
export function planPanes({ route, screen, twoPane, from, lookup }) {
  const single = { content: route, contentScreen: screen, detail: null, detailScreen: null };
  if (!twoPane || !screen || screen.pane !== 'detail' || typeof screen.parent !== 'function') return single;

  let parent;
  try {
    parent = parseHash(screen.parent(route.arg, from));
  } catch {
    return single; // a screen's parent() must never be able to break routing
  }
  if (!parent.name) return single;
  // A parent that is this very route would mount the same screen twice and, worse, give its close
  // button nowhere to go.
  if (parent.name === route.name && (parent.arg ?? '') === (route.arg ?? '')) return single;
  const parentScreen = lookup(parent.name);
  if (!parentScreen) return single;
  return { content: parent, contentScreen: parentScreen, detail: route, detailScreen: screen };
}

// ------------------------------------------------------------------------- render tokens -----

/**
 * One per render, per pane. `alive` stays true only while that render is the one mounted in its
 * pane: the next render into the same pane retires it at its commit point, and so does
 * `destroy()`. `signal` is an AbortSignal aborted at exactly the same moment.
 */
export function createRenderToken() {
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  return { alive: true, signal: ac ? ac.signal : undefined, abort: () => { if (ac) ac.abort(); } };
}

export function retireToken(token) {
  if (!token || !token.alive) return;
  token.alive = false;
  try { token.abort(); } catch { /* an already-aborted controller */ }
}

/**
 * One mounted pane: the element screens render into, the key of the route mounted there, that
 * render's token and the mounted screen's `after()` cleanup.
 *
 * **`epoch` is the pane's identity, and the key is not.** A route can come back — `#tx/A → #tx/B
 * → #tx/A` — so a render that fell asleep during the first A and compared *keys* on waking would
 * find its key on the pane again and mount a second instance over the live one, orphaning that
 * instance's cleanup (which is how a revealed transaction key ends up in a detached node with its
 * `window.blur`/`visibilitychange` listeners still attached). `epoch` is monotonic: every retire
 * and every mount moves it on, and nothing can move it back. A render captures the epoch it is
 * writing against and re-checks it after every await.
 *
 * Retiring the token and running the cleanup are separable because `destroy()` wants them in a
 * particular order — every token dead *first*, so nothing a cleanup does can be painted by a
 * screen that is still mid-await, and only then the cleanups.
 */
export function createPane(el, name) {
  const pane = {
    el,
    name,
    key: null,
    epoch: 0,
    token: null,
    cleanup: null,
    retireToken() {
      retireToken(pane.token);
      pane.token = null;
    },
    runCleanup() {
      const fn = pane.cleanup;
      pane.cleanup = null;
      if (!fn) return;
      try { fn(); } catch (err) { console.error('rand-wallet: screen cleanup failed', err); }
    },
    /** This mount is over: token dead, cleanup run exactly once, key gone, epoch moved on. */
    retire() {
      pane.retireToken();
      pane.runCleanup();
      pane.key = null;
      pane.epoch += 1;
      return pane.epoch;
    },
    /** Claims the pane for a new mount and returns that mount's epoch. */
    claim(key, token) {
      pane.key = key;
      pane.token = token;
      pane.epoch += 1;
      return pane.epoch;
    },
    /** What a test needs to assert "one live instance, no orphaned cleanup". Route data only. */
    debug() {
      return { key: pane.key, epoch: pane.epoch, hasCleanup: typeof pane.cleanup === 'function' };
    },
  };
  return pane;
}

// ------------------------------------------------------------------------ screen-side bits ---

/**
 * The header of a detail screen.
 *
 * In the content pane (compact, the popup, or a detail with no parent) it is the back button it
 * has always been. In the detail pane, beside its own list, "back" is meaningless — the list is
 * right there — so it becomes a close button, and the shell (not the screen) knows where closing
 * goes: `data-action="close-detail"`.
 */
export function detailTopbar(ctx, title, backGo) {
  if (ctx && ctx.pane === 'detail') {
    return h`
      <div class="topbar">
        <span class="topbar-title">${title}</span>
        <span class="grow"></span>
        <button class="btn-icon" type="button" data-action="close-detail" aria-label="Close">${raw(icons.close())}</button>
      </div>`;
  }
  return h`
    <div class="topbar">
      <button class="btn-icon icon-flip" type="button" data-go="${backGo}" aria-label="Back">${raw(icons.chevron())}</button>
      <span class="topbar-title">${title}</span>
      <span class="spacer"></span>
    </div>`;
}

/**
 * Marks the row a list screen has open in the detail pane, and keeps marking it as the selection
 * moves — **without the list re-rendering**. That is the whole point: selecting another row must
 * cost one attribute change, not a re-fetch and a repaint.
 *
 * `apply()` is exposed because a list screen repaints its own containers for reasons of its own (a
 * filter chip, a scan landing); it calls `apply()` after each of those. `destroy()` goes in the
 * screen's cleanup.
 */
export function wireSelection(ctx, root) {
  const apply = () => {
    const selected = ctx.selected;
    for (const el of root.querySelectorAll('.row[data-go]')) {
      if (selected && el.getAttribute('data-go') === selected) el.setAttribute('aria-current', 'true');
      else el.removeAttribute('aria-current');
    }
  };
  apply();
  const off = typeof ctx.onSelectedChange === 'function' ? ctx.onSelectedChange(apply) : () => {};
  return { apply, destroy: off };
}
