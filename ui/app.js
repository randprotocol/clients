// App shell shared by every wallet screen: router, theme, the locked/unlocked gate, and
// navigation (tab bar when compact, sidebar when wide). Screens register themselves with
// `registerScreen` and only ever talk to the `ctx` object `mount()` hands them — never to
// `document`/`window`/the concrete backend shell directly (besides through `ctx.backend`).
import { h, raw, on } from './lib/dom.js';
import { assertBackend, BACKEND_SHAPE } from './backend.js';
import { icons } from './lib/icons.js';
import { shortAddress } from './lib/format.js';

// Screens registered so far, `#name` → { render(ctx, arg), after?(ctx, root), tab? }. Registering
// is a module-level, import-time side effect (each screens/*.js file calls `registerScreen` when
// imported) — the registry itself is shared across every `mount()` call in a process, but all
// per-mount state (routing, sheets, toasts, in-flight tracking) lives inside `mount()`'s closure.
const screens = new Map();

/** Registers a screen. `render` may be sync or return a Promise<string> (an `h`-built string). */
export function registerScreen(name, def) {
  if (!def || typeof def.render !== 'function') throw new Error(`registerScreen(${name}): render is required`);
  screens.set(name, def);
}

const TABS = [
  { name: 'home', label: 'Home', icon: 'home' },
  { name: 'activity', label: 'Activity', icon: 'activity' },
  { name: 'explore', label: 'Explore', icon: 'compass' },
  { name: 'settings', label: 'Settings', icon: 'settings' },
];
const WIDE_AT = 900; // keep in sync with tokens.css --wide-at

// The only `ctx.state` keys that survive the end of a wallet session: device-level UI preferences
// that are not derived from any wallet. Everything else in `ctx.state` is wallet data by default
// and is dropped — a new key is only added here if it is genuinely account-independent.
const SESSION_SAFE_STATE_KEYS = ['theme', 'locale'];

// Wallet methods after which a different wallet (or none) is being looked at. Each one ends the
// wallet session; see the interception in mount() and `ctx.session` below.
const SESSION_ENDING_WALLET_METHODS = ['lock', 'wipe', 'unlock', 'create', 'import'];

/**
 * The network chip's text, derived from `settings.get().chainId` — never a chain number written
 * into a screen. A numeric id reads as "Chain 13"; anything else (a named network some other
 * shell reports) is shown as given, escaped by `h` at the call site.
 */
function networkLabel(chainId) {
  if (chainId === undefined || chainId === null || chainId === '') return 'Not connected';
  return /^\d+$/.test(String(chainId)) ? `Chain ${chainId}` : String(chainId);
}

function parseHash(hash) {
  const s = String(hash || '').replace(/^#/, '');
  if (!s) return { name: '', arg: undefined };
  const i = s.indexOf('/');
  return i === -1 ? { name: s, arg: undefined } : { name: s.slice(0, i), arg: s.slice(i + 1) };
}

function route(name, arg) {
  return arg === undefined ? { name } : { name, arg };
}

const PRE_WALLET_SCREENS = ['create', 'import', 'backup'];
// Once a wallet exists on the device, create/import/welcome must never render again — reaching
// wallet.create()/wallet.import() a second time would overwrite (and lose) the existing keys.
// `backup` is deliberately not in this list: it stays reachable, but only through the "unlocked"
// branch below (immediately after wallet.create()/import() itself flips `exists` to true), never
// through the `!exists` branch above.
const ONBOARDING_ONLY_SCREENS = ['welcome', 'create', 'import'];

/**
 * Pure routing decision, exported for tests. `hash` is the raw `location.hash` (leading `#`
 * optional).
 *
 *   exists  unlocked  hash names…              → resolves to
 *   false   —         create/import/backup      the requested screen
 *   false   —         anything else             welcome
 *   true    false     anything                  lock (create/import/welcome included — a locked
 *                                                device never re-exposes them)
 *   true    true      welcome/create/import      home (a wallet already exists; never re-run
 *                                                create/import over it)
 *   true    true      empty                      home
 *   true    true      anything else (incl.       the requested screen
 *                      backup, asset/1, …)
 */
export function resolveRoute({ exists, unlocked }, hash) {
  const { name, arg } = parseHash(hash);
  if (!exists) {
    return PRE_WALLET_SCREENS.includes(name) ? route(name, arg) : route('welcome');
  }
  if (!unlocked) return route('lock');
  if (!name || ONBOARDING_ONLY_SCREENS.includes(name)) return route('home');
  return route(name, arg);
}

/**
 * Wraps a backend group so every call is visible to `onCall` (for `app.idle()`).
 *
 * Two things this must not assume about `orig`, because a real shell's backend is not the
 * object-literal the fake is:
 *   * **its methods may live on a prototype.** A shell that writes `class ChromeWallet { async
 *     exists() {…} }` has *no* own enumerable keys at all, so an `Object.keys(orig)` copy silently
 *     produced an empty group and the app died on its first call. Every property on the whole
 *     prototype chain (down to, but not including, `Object.prototype`) is considered.
 *   * **it may carry more than BACKEND_SHAPE names.** `platform.name` is a plain string field;
 *     `platform.ensureHostPermission` / `platform.openFlowInTab` are optional functions only some
 *     shells have; a whole optional group (a future `bridge`) is not in BACKEND_SHAPE either.
 *     Everything present is carried over, so a screen can feature-detect it the usual way.
 *
 * Calls are also normalised: a method that throws *synchronously* (a shell's guard clause, e.g.
 * "no wallet unlocked") becomes a rejected promise, so every caller can rely on the one failure
 * channel the Backend contract describes.
 */
function trackGroup(orig, declared, onCall) {
  const g = {};
  const track = (fn) => (...args) => {
    let p;
    try { p = Promise.resolve(fn.apply(orig, args)); } catch (err) { p = Promise.reject(err); }
    onCall(p);
    return p;
  };
  const add = (key, descriptor) => {
    if (key === 'constructor' || Object.prototype.hasOwnProperty.call(g, key)) return;
    if (descriptor.get || descriptor.set) {
      // An accessor is *forwarded*, never read here. Reading it at mount would run a getter that
      // may be expensive, may throw, or may be lazily constructing the very thing it guards — and
      // the copy would then be a stale snapshot of a value the shell meant to compute per read.
      Object.defineProperty(g, key, {
        configurable: true,
        enumerable: true,
        get() {
          const value = orig[key];
          return typeof value === 'function' ? track(value) : value;
        },
      });
      return;
    }
    if (typeof descriptor.value === 'function') g[key] = track(descriptor.value);
    else if (descriptor.value !== undefined) g[key] = descriptor.value;
  };
  for (let o = orig; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const key of Object.getOwnPropertyNames(o)) add(key, Object.getOwnPropertyDescriptor(o, key));
  }
  // Anything BACKEND_SHAPE names that no descriptor turned up — a Proxy-backed backend, say —
  // still has to be wrapped, even though that does mean reading it.
  for (const key of declared) {
    if (Object.prototype.hasOwnProperty.call(g, key)) continue;
    let value;
    try { value = orig[key]; } catch { continue; }
    if (typeof value === 'function') g[key] = track(value);
  }
  return g;
}

/**
 * Replaces one method on a *wrapped* group with `fn`.
 *
 * Plain assignment is not enough: `trackGroup` forwards an accessor property with a getter and no
 * setter, so a shell that exposes `sync.scan` (or one of the session-ending `wallet.*` methods) as
 * a getter would make `group.method = …` throw "Cannot set property … which has only a getter" —
 * an ES module is always strict — and the app would fail to mount at all.
 */
function defineMethod(group, name, fn) {
  Object.defineProperty(group, name, { value: fn, writable: true, configurable: true, enumerable: true });
}

/** Wraps every backend group (the BACKEND_SHAPE ones, plus any optional group a shell adds). */
function trackedBackend(backend, onCall) {
  const wrapped = {};
  const groups = new Set(Object.keys(BACKEND_SHAPE));
  for (const [key, value] of Object.entries(backend)) {
    // A group is an object of methods; `calls` (the fake's array of recorded calls) and any other
    // non-group field on the backend itself is left alone.
    if (value && typeof value === 'object' && !Array.isArray(value)) groups.add(key);
  }
  for (const group of groups) {
    const orig = backend[group];
    if (!orig || typeof orig !== 'object') continue;
    wrapped[group] = trackGroup(orig, BACKEND_SHAPE[group] || [], onCall);
  }
  return wrapped;
}

/**
 * One per render. `alive` stays true only while that render is the one on screen: a newer render
 * retires it at the moment it commits (right where the previous screen's cleanup runs), and so
 * does `destroy()`. `signal` is an AbortSignal aborted at exactly the same moment, for screens
 * that hand a signal to something cancellable.
 */
function createRenderToken() {
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  return { alive: true, signal: ac ? ac.signal : undefined, abort: () => { if (ac) ac.abort(); } };
}

function retireToken(token) {
  if (!token || !token.alive) return;
  token.alive = false;
  try { token.abort(); } catch { /* an already-aborted controller */ }
}

// A screen's own heading, in the order the screens actually write one: an explicit
// `[data-autofocus]` opt-in first, then the page title (`<h1>`, visible or `.sr-only`), then a
// topbar's title, then the first focusable control.
const SCREEN_START_SELECTOR = 'h1, .topbar-title, .title';

/**
 * Where focus goes after a route change that left it nowhere.
 *
 * A browser drops focus to `<body>` whenever the focused node is removed — which is exactly what
 * happens when a wallet session ends under an open sheet (lock → Wipe → wipe: the sheet's button
 * is torn down, then the app navigates). Focus on `<body>` means a keyboard or screen-reader user
 * starts the next screen from the very top of the document, past the nav, with no announcement of
 * where they now are. So: if focus is on `<body>` or on a node that is no longer in the document,
 * move it to the new screen's start. If the user's focus is somewhere real, it is left alone.
 */
function focusScreenStart(mainEl) {
  const active = document.activeElement;
  if (active && active !== document.body && document.body.contains(active)) return;
  const target = mainEl.querySelector('[data-autofocus]')
    || mainEl.querySelector(SCREEN_START_SELECTOR)
    || focusableIn(mainEl)[0];
  if (!target || typeof target.focus !== 'function') return;
  // A heading is not focusable on its own; `tabindex="-1"` makes it focusable programmatically
  // without adding it to the tab order.
  if (!target.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) {
    target.setAttribute('tabindex', '-1');
  }
  target.focus();
}

function focusableIn(root) {
  return Array.from(root.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  ));
}

let sheetIdSeq = 0;

// The built-in screens (onboarding + lock) register themselves as a side effect of being
// imported. They are loaded dynamically, the first time `mount()` runs, rather than with a
// static `import` at module scope: app.js ↔ screens/*.js is a genuine cycle (registerScreen is
// defined here, screens/*.js call it), and a static import of a cycle partner runs that partner's
// whole module body — including its top-level `registerScreen(...)` calls — before this module's
// own top-level code (the `screens` map) has executed, which throws. A dynamic import inside the
// already-async `mount()` sidesteps that: by the time `mount()` runs, this module has fully
// finished evaluating.
let screensLoaded = null;
function ensureBuiltinScreensLoaded() {
  if (!screensLoaded) {
    screensLoaded = Promise.all([
      import('./screens/onboarding.js'),
      import('./screens/lock.js'),
      import('./screens/home.js'),
      import('./screens/asset.js'),
      import('./screens/activity.js'),
      import('./screens/detail.js'),
      import('./screens/receive.js'),
      import('./screens/faucet.js'),
      import('./screens/send.js'),
      import('./screens/settings.js'),
    ]);
  }
  return screensLoaded;
}

/**
 * `mount(container, backend, { mode = 'app' } = {})` — throws (via `assertBackend`) if `backend`
 * does not satisfy BACKEND_SHAPE. Renders into `container`; sets `document.documentElement`'s
 * theme and `document.body`'s compact/wide/popup classes (these are page-level, not
 * container-scoped, so the real shells should mount into `document.body`). Returns
 * `{ go(hash), idle(), destroy() }`.
 */
export async function mount(container, backend, { mode = 'app' } = {}) {
  assertBackend(backend);
  await ensureBuiltinScreensLoaded();

  const inflight = new Set();
  function trackTask(p) {
    inflight.add(p);
    p.finally(() => inflight.delete(p)).catch(() => {});
  }
  const backendApi = trackedBackend(backend, trackTask);

  let renderSeq = 0;
  let renderPromise = null;
  let currentCleanup = null;
  let lastRouteKey = null;
  let destroyed = false;
  // The token of the render whose markup is (or is about to be) on screen. Retired by the next
  // render at its commit point, and by destroy().
  let currentToken = null;

  // ---- wallet session ----
  // One session is one stretch of one wallet being looked at. It ends the moment *who is looking*
  // changes — lock, wipe, unlock, create, import, destroy — and everything derived from the
  // previous wallet has to end with it: `ctx.state` is emptied and `ctx.session.signal` aborts, so
  // an in-flight scan started under the old wallet can neither be attached to nor painted under
  // the new one. Screens never end a session themselves: the shell intercepts the five wallet
  // methods that change who is looking (see SESSION_ENDING_WALLET_METHODS below), so a screen
  // added later cannot forget to — the `ctx.lockWallet()`-style helpers are naming, not the
  // mechanism.
  let sessionSeq = 0;
  let session = null;
  let abortSession = () => {};
  function startSession() {
    sessionSeq += 1;
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    abortSession = ac ? () => ac.abort() : () => {};
    // Frozen and minimal: a screen may hold on to the object it was given and compare its `id`
    // with `ctx.session.id` later, so it must not be something a screen can quietly change.
    session = Object.freeze({ id: sessionSeq, signal: ac ? ac.signal : undefined });
    return session;
  }
  startSession();

  function endSession() {
    try { abortSession(); } catch { /* an already-aborted controller */ }
    closeSheet(); // a dialog belongs to the session that opened it
    setPinnedChip(null); // and so does anything pinned in the nav by it
    const carried = {};
    for (const key of SESSION_SAFE_STATE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(ctx.state, key)) carried[key] = ctx.state[key];
    }
    // Empty the old object as well as replacing it: a screen may already be holding a reference
    // to it, and that reference must not keep the previous wallet's data reachable.
    for (const key of Object.keys(ctx.state)) delete ctx.state[key];
    ctx.state = carried;
    return startSession();
  }

  const mainEl = document.createElement('main');
  mainEl.className = 'app';
  const sidebarEl = document.createElement('nav');
  sidebarEl.className = 'sidebar';
  const tabbarEl = document.createElement('nav');
  tabbarEl.className = 'tabbar';
  const toastArea = document.createElement('div');
  toastArea.className = 'toast-area';
  toastArea.setAttribute('aria-live', 'polite');
  toastArea.setAttribute('role', 'status');
  container.append(mainEl, toastArea);

  // ---- theme ----
  const settings = await backendApi.settings.get();
  document.documentElement.dataset.theme = settings.theme || 'system';

  // ---- compact / wide ----
  // The 3-column wide grid (sidebar | app | detail) only makes sense once there is a sidebar to
  // put in it, i.e. once the wallet is unlocked — welcome/create/import/lock stay a single
  // centred column even on a wide viewport, the same as they would on the popup or a phone.
  let mql = null;
  let mqlListener = null;
  let viewportWide = false;
  let lastUnlocked = false;
  function applyBodyLayout() {
    const wide = mode !== 'popup' && viewportWide && lastUnlocked;
    document.body.classList.toggle('wide', wide);
    document.body.classList.toggle('compact', !wide);
  }
  if (mode === 'popup') {
    document.body.classList.add('compact', 'popup');
  } else {
    document.body.classList.remove('popup');
    if (typeof matchMedia === 'function') {
      mql = matchMedia(`(min-width: ${WIDE_AT}px)`);
      viewportWide = mql.matches;
      mqlListener = (e) => { viewportWide = e.matches; applyBodyLayout(); };
      if (typeof mql.addEventListener === 'function') mql.addEventListener('change', mqlListener);
      else if (typeof mql.addListener === 'function') mql.addListener(mqlListener);
    }
    applyBodyLayout();
  }

  // ---- sheet / modal ----
  let sheetEl = null;
  let scrimEl = null;
  let sheetReturnFocus = null;
  let sheetKeydownHandler = null;

  function closeSheet() {
    if (!sheetEl) return;
    sheetEl.remove();
    if (scrimEl) scrimEl.remove();
    if (sheetKeydownHandler) document.removeEventListener('keydown', sheetKeydownHandler);
    sheetEl = null; scrimEl = null; sheetKeydownHandler = null;
    const toFocus = sheetReturnFocus;
    sheetReturnFocus = null;
    if (toFocus && typeof toFocus.focus === 'function') toFocus.focus();
  }

  /** Opens a sheet (a centred modal under body.wide) with `html` as its contents; closing any
   *  sheet already open first. Returns the sheet element so the caller can wire up its own
   *  buttons (`on(dialog, '[data-role="confirm"]', 'click', …)`). Escape and a scrim click close
   *  it; Tab is trapped inside; focus moves to the first focusable element on open and is
   *  restored to whatever was focused before on close. */
  function sheet(html) {
    closeSheet();
    sheetReturnFocus = document.activeElement;
    scrimEl = document.createElement('div');
    scrimEl.className = 'scrim';
    sheetEl = document.createElement('div');
    sheetEl.className = 'sheet';
    sheetEl.setAttribute('role', 'dialog');
    sheetEl.setAttribute('aria-modal', 'true');
    sheetEl.innerHTML = html;
    const titleEl = sheetEl.querySelector('.sheet-title, .modal-title');
    if (titleEl) {
      if (!titleEl.id) titleEl.id = `sheet-title-${++sheetIdSeq}`;
      sheetEl.setAttribute('aria-labelledby', titleEl.id);
    }
    scrimEl.addEventListener('click', closeSheet);
    sheetKeydownHandler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
      if (e.key === 'Tab') {
        const items = focusableIn(sheetEl);
        if (items.length === 0) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', sheetKeydownHandler);
    container.append(scrimEl, sheetEl);
    const focusables = focusableIn(sheetEl);
    if (focusables.length) focusables[0].focus();
    else { sheetEl.setAttribute('tabindex', '-1'); sheetEl.focus(); }
    return sheetEl;
  }

  // ---- toasts ----
  function toast(message, { kind } = {}) {
    const el = document.createElement('div');
    el.className = kind ? `toast ${kind}` : 'toast';
    const icName = kind === 'positive' ? 'check' : kind === 'negative' ? 'warning' : null;
    el.innerHTML = h`${icName ? raw(`<span class="ic">${icons[icName]()}</span>`) : ''}<span>${message}</span>`;
    toastArea.append(el);
    setTimeout(() => el.remove(), 2600);
  }

  // ---- ctx handed to every screen ----
  // This is the *base* ctx: everything that lives as long as the mount. Each render gets its own
  // view of it (`Object.create(baseCtx)` + `isCurrent`/`signal`, see doRender) so a screen can
  // tell whether it is still the screen on display after an await — `ctx.state`, `ctx.go`,
  // `ctx.toast`, `ctx.sheet`, `ctx.backend` all resolve through the prototype to the objects
  // below, so they are shared, identical and mutable across renders exactly as before.
  const ctx = {
    backend: backendApi,
    go,
    toast,
    sheet,
    closeSheet,
    setPinnedChip,
    state: {},
    mode,
    canProve: backendApi.send.canProve,
    // The current session, read fresh every time: a screen that captured `ctx.session` at render
    // time keeps the object it was given, and comparing its `.id` with `ctx.session.id` later is
    // how it tells that the wallet underneath it changed.
    get session() { return session; },
    endSession,
    // The names screens should use for a wallet transition. They read better than
    // `ctx.backend.wallet.lock()` and they document the side effect — but the session is ended by
    // the interception above, not by these, so a screen that reaches for `ctx.backend.wallet.*`
    // anyway still cannot leave a session behind.
    lockWallet: () => backendApi.wallet.lock(),
    wipeWallet: () => backendApi.wallet.wipe(),
    unlockWallet: (password) => backendApi.wallet.unlock(password),
    createWallet: (password) => backendApi.wallet.create(password),
    importWallet: (secret, password) => backendApi.wallet.import(secret, password),
  };

  // Every `sync.scan` is counted, started and finished, on session-scoped state. Nothing in the
  // shell uses the numbers; the send flow does, to decide whether the user has had a chance to see
  // whether a transfer whose outcome it could not establish is on chain after all (see
  // ui/screens/send/state.js). The shell is where this belongs because every backend call goes
  // through it, so a scan started by *any* screen counts — the one home starts on mount just as
  // much as the one the send flow starts deliberately.
  //
  // Two separate numbers on purpose: `scansStarted` is the ordinal handed to each call, and
  // `scansConfirmed` is the highest ordinal to have *fulfilled*. A rejected or aborted scan read
  // nothing, so it never moves the second one.
  //
  // **The state object is captured at the call, not resolved at the answer.** `endSession()`
  // *replaces* `ctx.state`, so a scan started under one wallet may fulfil long after another one
  // is on screen; writing its ordinal into the new session's counters would leave that session
  // with `scansConfirmed` set while its own `scansStarted` is back at 0 — and the send flow's
  // unknown-outcome gate (lifted the moment `scansConfirmed > atStarted`) would be lifted before
  // any scan had run under that wallet at all. A scan from an ended session credits nothing.
  const origScan = backendApi.sync.scan;
  if (typeof origScan === 'function') {
    defineMethod(backendApi.sync, 'scan', (...args) => {
      const state = ctx.state; // this session's state object, captured synchronously
      const ordinal = (state.scansStarted = (state.scansStarted || 0) + 1);
      const p = origScan(...args);
      p.then(
        () => {
          if (ctx.state !== state) return; // the wallet under it changed; this proves nothing
          if (ordinal > (state.scansConfirmed || 0)) state.scansConfirmed = ordinal;
        },
        () => { /* a scan that failed saw nothing */ },
      );
      return p;
    });
  }

  // One place, not five call sites: every wallet method that changes *who is looking* ends the
  // session the moment it succeeds — before the caller's `await` resumes, so a handler that
  // navigates straight afterwards (create → #backup) is already inside the new session. A failure
  // (a wrong password) changes nothing.
  for (const method of SESSION_ENDING_WALLET_METHODS) {
    const orig = backendApi.wallet[method];
    if (typeof orig !== 'function') continue;
    defineMethod(backendApi.wallet, method, (...args) => {
      const p = (async () => {
        const result = await orig(...args);
        endSession();
        return result;
      })();
      // Tracked like any other backend call: this outer promise settles *after* the inner one (it
      // still has to end the session), so `app.idle()` has to know about it too, or it can return
      // in the window between the wallet method answering and the session actually ending.
      trackTask(p);
      return p;
    });
  }

  function navLink(tab, activeName, variant) {
    const active = tab.name === activeName;
    const cls = variant === 'tab' ? (active ? 'tab on' : 'tab') : (active ? 'nav-item on' : 'nav-item');
    const current = active ? raw(' aria-current="page"') : '';
    return h`<a class="${cls}" href="#${tab.name}" data-go="${tab.name}"${current}>${raw(icons[tab.icon]())}${tab.label}</a>`;
  }

  function renderTabbar(activeName) {
    tabbarEl.innerHTML = h`
      <div class="tabbar-notice" data-role="pinned"></div>
      <div class="tabbar-inner">${raw(TABS.map((t) => navLink(t, activeName, 'tab')).join(''))}</div>`;
  }

  function renderSidebar(activeName) {
    sidebarEl.innerHTML = h`
      <div class="sidebar-inner">
        <div class="brand"><span class="mark"></span><span class="name">Rand Wallet</span></div>
        ${raw(TABS.map((t) => navLink(t, activeName, 'nav-item')).join(''))}
        <div class="sidebar-foot stack tight">
          <span data-role="pinned"></span>
          <span class="chip"><span class="dot"></span>${networkLabel(settings.chainId)}</span>
          <button class="btn sm block" type="button" data-action="lock">${raw(icons.lock())}Lock</button>
        </div>
      </div>`;
  }

  // ---- pinned chip ----
  // One small, persistent chip in the nav, for work that outlives the screen that started it: the
  // send flow uses it for "Proving… 02:41", so a proof the user walked away from is still visible
  // and one tap from being watched again. It belongs to the wallet session (a lock clears it), it
  // is re-painted after every nav re-render, and its text is escaped like anything else.
  let pinnedChip = null;

  function paintPinnedChip() {
    const done = pinnedChip && pinnedChip.kind === 'positive';
    const markup = pinnedChip
      ? h`<a class="chip ${done ? 'positive' : 'warn'}" href="#${pinnedChip.go}" data-go="${pinnedChip.go}">${raw(done ? icons.check() : '<span class="dot busy"></span>')}${pinnedChip.text}</a>`
      : '';
    for (const slot of [sidebarEl, tabbarEl]) {
      const el = slot.querySelector('[data-role="pinned"]');
      if (el) el.innerHTML = markup;
    }
  }

  /** Pins (or, with `null`, clears) the nav chip. `{text, go, kind}` — `go` is a route name, as
   *  `data-go` takes it, and `kind` is `'warn'` (the default: something is under way) or
   *  `'positive'` (it finished). Cleared automatically when the wallet session ends. */
  function setPinnedChip(chip) {
    pinnedChip = chip && chip.text
      ? { text: String(chip.text), go: String(chip.go || 'home'), kind: chip.kind === 'positive' ? 'positive' : 'warn' }
      : null;
    paintPinnedChip();
  }

  const fallbackScreen = {
    async render() {
      const info = await ctx.backend.wallet.info().catch(() => null);
      return h`
        <div class="topbar"><div class="brand"><span class="mark"></span><span class="name">Rand Wallet</span></div></div>
        <div class="card stack">
          <span class="title">More is on the way</span>
          <span class="subtitle">This screen ships in a later task. Your wallet is unlocked and ready.</span>
          ${info ? raw(h`<div class="kv"><span class="k">Address</span><span class="v mono">${shortAddress(info.address)}</span></div>`) : ''}
        </div>`;
    },
  };

  async function doRender() {
    if (destroyed) return;
    const mySeq = ++renderSeq;
    // Handed to this render's screen in place of the base ctx. Before the commit point below a
    // screen has not been mounted yet, so "superseded" is still `mySeq !== renderSeq`; after it,
    // the token is what says whether this screen is still the one on screen (a repeat render for
    // a destination already showing bumps renderSeq and then returns without committing — it must
    // not silently kill the live screen's reactions).
    const token = createRenderToken();
    const screenCtx = Object.create(ctx);
    screenCtx.isCurrent = () => token.alive && !destroyed;
    screenCtx.signal = token.signal;

    let exists = false, unlocked = false;
    try {
      exists = await backendApi.wallet.exists();
      unlocked = exists && await backendApi.wallet.isUnlocked();
    } catch (err) {
      console.error('rand-wallet: failed to read wallet state', err);
    }
    if (destroyed || mySeq !== renderSeq) { retireToken(token); return; }

    const r = resolveRoute({ exists, unlocked }, location.hash || '');
    if (destroyed || mySeq !== renderSeq) { retireToken(token); return; }

    // If the requested hash actually resolved somewhere else (e.g. #create once a wallet already
    // exists — see ONBOARDING_ONLY_SCREENS above — refuses and lands on home), keep location.hash
    // truthful: it must name the screen that is about to render, not the one that was asked for
    // and refused, otherwise the address bar and the screen on it disagree.
    const { name: requestedName } = parseHash(location.hash || '');
    if (requestedName !== '' && requestedName !== r.name) {
      const canonical = r.arg !== undefined ? `#${r.name}/${r.arg}` : `#${r.name}`;
      if (location.hash !== canonical) location.hash = canonical;
      // The assignment above may have synchronously re-entered this function (this test
      // environment dispatches `hashchange` synchronously; see dom-env.mjs) and started a newer
      // render — if so, let that one finish the job instead of doubling up on it.
      if (destroyed || mySeq !== renderSeq) { retireToken(token); return; }
    }

    // A real browser fires `hashchange` asynchronously (a task, not a microtask), so go()'s own
    // explicit render and the native event it triggers both land here — the second one after the
    // first has already finished. Rebuilding the DOM a second time for the exact same destination
    // would blow away whatever the user has since typed into the screen that render #1 produced,
    // so a repeat of the destination we already have on screen is a no-op.
    const routeKey = `${unlocked ? '1' : '0'}:${r.name}:${r.arg ?? ''}`;
    // Only this render's own token is retired here — `currentToken` (the screen actually on
    // screen) is deliberately left alone, because nothing about it is being replaced.
    if (routeKey === lastRouteKey) { retireToken(token); return; }
    lastRouteKey = routeKey;

    // ---- commit point: from here on, the screen that was on display is gone ----
    retireToken(currentToken);
    currentToken = token;
    if (currentCleanup) {
      const cleanup = currentCleanup;
      currentCleanup = null;
      try { cleanup(); } catch (err) { console.error('rand-wallet: screen cleanup failed', err); }
    }

    const screen = screens.get(r.name) || fallbackScreen;
    const activeTab = screen.tab || r.name;

    // A screen can opt out of nav even while unlocked (`nav: false`) — used by `backup`, a
    // security gate the user should not be able to tab away from mid-flow. The wide 3-column
    // grid follows nav visibility too: without a sidebar to put in its first column, it would
    // just leave a blank gutter (see applyBodyLayout).
    const showNav = unlocked && screen.nav !== false;
    lastUnlocked = showNav;
    applyBodyLayout();
    document.body.classList.toggle('nav-on', showNav);
    if (showNav) {
      if (!container.contains(sidebarEl)) container.insertBefore(sidebarEl, mainEl);
      if (!container.contains(tabbarEl)) container.append(tabbarEl);
      renderSidebar(activeTab);
      renderTabbar(activeTab);
      paintPinnedChip(); // the nav was just rebuilt, so the chip has to be put back
    } else {
      if (container.contains(sidebarEl)) sidebarEl.remove();
      if (container.contains(tabbarEl)) tabbarEl.remove();
    }

    let markup = '';
    try {
      markup = (await screen.render(screenCtx, r.arg)) || '';
    } catch (err) {
      console.error('rand-wallet: screen render failed', err);
      markup = h`<div class="banner negative"><span class="ic">${raw(icons.warning())}</span><span><span class="banner-title">Something went wrong</span>This screen could not be shown.</span></div>`;
    }
    // Past the commit point the token, not the sequence number, is the authority: a newer render
    // that resolved to the destination already on screen returns without committing, and must not
    // stop this one from finishing the job it is halfway through.
    if (!screenCtx.isCurrent()) return;
    mainEl.innerHTML = markup;

    if (typeof screen.after === 'function') {
      try {
        // `r.arg` (the `#name/arg` suffix, e.g. the index in `#asset/1` or the hash in `#tx/0x…`)
        // is a third, optional argument — added in task 1.4 for the asset/tx/note detail screens,
        // which need to know which one they are showing once their markup is already in the DOM
        // (`render(ctx, arg)` already gets it; `after` didn't). Purely additive: every screen
        // registered before this task takes only `(ctx, root)` and ignores the third argument.
        const cleanup = await screen.after(screenCtx, mainEl, r.arg);
        if (!screenCtx.isCurrent()) { if (typeof cleanup === 'function') { try { cleanup(); } catch { /* stale */ } } return; }
        if (typeof cleanup === 'function') currentCleanup = cleanup;
      } catch (err) {
        console.error('rand-wallet: screen after() failed', err);
      }
    }

    // Last, so a screen that placed focus itself (an `input.focus()` in its own `after()`) wins.
    if (screenCtx.isCurrent()) focusScreenStart(mainEl);
  }

  function scheduleRender() {
    const p = doRender();
    renderPromise = p;
    p.finally(() => { if (renderPromise === p) renderPromise = null; }).catch(() => {});
    return p;
  }

  function go(hash) {
    const next = hash ? (String(hash).startsWith('#') ? String(hash) : `#${hash}`) : '';
    if (location.hash !== next) location.hash = next;
    return scheduleRender();
  }

  async function idle() {
    // Await the current render and any backend call in flight (including ones kicked off by a
    // screen's own event handlers, e.g. a form submit), looping in case settling one spawns
    // another — never a timeout, per the app.idle() contract.
    //
    // The queue going empty is not the same as the work being finished: a handler that awaited one
    // of these promises resumes on a *later* microtask, and what it does next (call another
    // backend method, navigate) has not been queued yet at the instant the last promise settles.
    // The previous version allowed for that with a fixed number of `await Promise.resolve()`
    // passes — a magic number that silently decided how many hops a screen was allowed to take.
    // Instead each pass ends with one macrotask hop (`setTimeout(…, 0)`), which by definition runs
    // only once the whole microtask queue has drained, however deep it is; the loop ends the first
    // time a full pass finds nothing new, and still never gives up early.
    for (;;) {
      const pending = [...inflight];
      if (renderPromise) pending.push(renderPromise);
      if (pending.length > 0) await Promise.allSettled(pending);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (inflight.size === 0 && !renderPromise) return;
    }
  }

  const offHashchange = (() => {
    const handler = () => scheduleRender();
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  })();

  const offGoClicks = on(container, '[data-go]', 'click', (evt, matched) => {
    evt.preventDefault();
    go(matched.getAttribute('data-go'));
  });

  const offLockClicks = on(container, '[data-action="lock"]', 'click', async (evt) => {
    evt.preventDefault();
    await ctx.lockWallet();
    go('#lock');
  });

  // A lock the *backend* decided on — every real shell locks on an idle timer built from
  // `settings.autoLockMin`. The five wallet methods the shell intercepts cover locks the user
  // asked for; this covers the ones nobody asked for. Optional in the contract (see
  // ui/backend.js): a backend that cannot lock itself simply has no `onLocked`.
  const offLocked = (() => {
    // Deliberately the *raw* backend, not `backendApi`: `trackGroup` turns every method into one
    // that returns a promise (so `app.idle()` can wait on it), which is right for a wallet
    // operation and wrong for registering a listener — the unsubscribe function would come back
    // wrapped in a Promise and could never be called. Subscribing is not a backend call.
    const subscribe = backend.wallet && backend.wallet.onLocked;
    if (typeof subscribe !== 'function') return () => {};
    let unsubscribe;
    try {
      unsubscribe = subscribe.call(backend.wallet, () => {
        if (destroyed) return;
        // The same two steps as an intercepted `lock()`: everything derived from that wallet ends,
        // then the lock screen. `resolveRoute` would send us there anyway, but only at the next
        // render — and the screen on display is showing the previous wallet's data until then.
        endSession();
        go('#lock');
      });
    } catch (err) {
      console.error('rand-wallet: backend.wallet.onLocked failed', err);
      return () => {};
    }
    return typeof unsubscribe === 'function' ? unsubscribe : () => {};
  })();

  await scheduleRender();

  return {
    go,
    idle,
    /** The current wallet session, `{ id, signal }` — the same object screens get as `ctx.session`. */
    get session() { return session; },
    destroy() {
      destroyed = true;
      retireToken(currentToken);
      currentToken = null;
      offHashchange();
      offGoClicks();
      offLockClicks();
      try { offLocked(); } catch { /* a backend that dropped its own listener */ }
      if (mql && mqlListener) {
        if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', mqlListener);
        else if (typeof mql.removeListener === 'function') mql.removeListener(mqlListener);
      }
      if (currentCleanup) { try { currentCleanup(); } catch { /* ignore */ } currentCleanup = null; }
      // Ends the session last, so the screen's own cleanup has already run: aborts the signal,
      // closes any sheet and empties ctx.state, exactly as a lock would.
      endSession();
      container.textContent = '';
      document.body.classList.remove('compact', 'wide', 'popup', 'nav-on');
    },
  };
}
