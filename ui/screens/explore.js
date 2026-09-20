// Explore (`#explore`, `#explore/bridge`): four independent cards — Network, Assets, Bridge and a
// Lookup field — built on `ctx.backend.rpc.call`, the raw JSON-RPC escape hatch (ui/backend.js).
// This is the first screen to make it its primary business: every other screen talks to the
// higher-level `wallet`/`sync`/`assets`/`send` groups.
//
// Task 5.1 (`ui/lib/rpc-methods.js`) built exactly the infrastructure this screen drives off:
// `METHODS` tags the methods this screen cares about with `explore: 'network' | 'assets' |
// 'bridge' | 'lookup'`, and `typed(call)` turns `ctx.backend.rpc.call` into one named async
// function per method. The three fetched cards ask **the metadata**, not a hand-written list of
// method names, which of the node's methods to call: `groupMethods()` filters `METHODS` by
// `explore` tag and by zero arguments (a method that needs a hash or a sequence number has nowhere
// to get one from at mount time, and stays reachable only through the Lookup field or a future
// screen). A method later tagged into one of these groups — with no arguments — starts appearing
// in its card with no change here.
//
// Each card fetches independently (`Promise.allSettled`, per home.js/asset.js's own-container
// convention) so a rejected call renders inside its own card without breaking the others.
import { h, raw, on } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';
import { formatUnits, shortHex } from '../lib/format.js';
import { markInvalid, markValid } from '../lib/forms.js';
import { listMarkup } from '../lib/rows.js';
import { METHODS, typed } from '../lib/rpc-methods.js';

/** The zero-argument methods tagged into `group` — the set this screen fetches on mount for it.
 *  Driven entirely off `rpc-methods.js`'s own metadata; nothing here names a method twice. */
export function groupMethods(group) {
  return Object.entries(METHODS)
    .filter(([, m]) => m.explore === group && m.params.length === 0)
    .map(([name]) => name);
}

const HEX64_RE = /^[0-9a-f]{64}$/i;
const DIGITS_RE = /^\d+$/;

// ==================================================================================== markup ====

function skeletonCardMarkup() {
  return h`<div class="skeleton block"></div>`;
}

function shellMarkup() {
  return h`
    <h1 class="sr-only">Explore</h1>
    <div class="topbar"><span class="topbar-title">Explore</span></div>
    <h2 class="section-title">Network</h2>
    <div class="card" data-role="network">${skeletonCardMarkup()}</div>
    <h2 class="section-title">Assets</h2>
    <div class="card flush" data-role="assets">${skeletonCardMarkup()}</div>
    <h2 class="section-title">Bridge</h2>
    <div class="card" data-role="bridge">${skeletonCardMarkup()}</div>
    <h2 class="section-title">Lookup</h2>
    <div class="card" data-role="lookup">
      <form data-role="lookup-form" novalidate>
        <div class="field">
          <label class="label" for="explore-lookup">Transaction, block or height</label>
          <input id="explore-lookup" name="q" type="text" autocomplete="off" spellcheck="false" placeholder="64 hex characters, or a block height" aria-describedby="explore-lookup-hint">
          <span class="hint" id="explore-lookup-hint">A transaction hash is tried first; if nothing is found, the same hash is tried as a block. All digits looks up a block by height.</span>
          <span class="error" id="explore-lookup-error"></span>
        </div>
        <button class="btn btn-primary block" type="submit">Look up</button>
      </form>
      <div data-role="lookup-result"></div>
    </div>`;
}

/** A card-level failure: every method a card asked for came back rejected. */
function cardErrorMarkup(title, err) {
  return h`<div class="banner negative"><span class="ic">${raw(icons.warning())}</span><span><span class="banner-title">${title}</span>${err && err.message ? err.message : 'Something went wrong.'}</span></div>`;
}

/** One labelled row that reads fine whether its own call succeeded or not — a card is never
 *  wiped out by one field failing among several (getPeers failing does not blank the height the
 *  same card's getHead answered). */
function fieldRow(label, result, render) {
  const value = result && result.ok ? render(result.value) : '—';
  return h`<div class="kv"><span class="k">${label}</span><span class="v">${value}</span></div>`;
}

const NETWORK_LABELS = {
  status: 'Status',
  getHead: 'Height',
  getEpoch: 'Epoch',
  getValidators: 'Validators',
  getPeers: 'Peers',
  getSupply: 'Total supply',
};

function pluralise(n, word) { return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`; }

/** How one network field's value is shown, keyed by the RPC method it came from — see the module
 *  banner: the *set* of fields fetched is metadata-driven, this is just how each known one reads.
 *  A future network-tagged method this table does not yet know renders its raw JSON rather than
 *  being silently dropped. */
function renderNetworkField(name, value) {
  if (name === 'status') return value && typeof value.syncing === 'boolean' ? (value.syncing ? 'Syncing' : 'Synced') : String(value);
  if (name === 'getHead') return value && typeof value.height === 'number' ? value.height.toLocaleString('en-US') : '—';
  if (name === 'getEpoch') return value && typeof value.epoch === 'number' ? value.epoch.toLocaleString('en-US') : '—';
  if (name === 'getValidators') return Array.isArray(value) ? pluralise(value.length, 'validator') : '—';
  if (name === 'getPeers') return Array.isArray(value) ? pluralise(value.length, 'peer') : '—';
  if (name === 'getSupply') return value ? `${formatUnits(value.total_supply ?? '0', 6, 9)} RAND` : '—';
  return JSON.stringify(value);
}

function networkMarkup(names, results) {
  if (names.length > 0 && names.every((n) => !results[n].ok)) {
    return cardErrorMarkup('Could not reach the node', results[names[0]].error);
  }
  return names.map((name) => fieldRow(NETWORK_LABELS[name] || name, results[name], (v) => renderNetworkField(name, v))).join('');
}

function assetsMarkup(names, results) {
  const r = results.getAssets;
  if (!r) return h`<div class="empty"><span class="empty-title">No asset registry here</span></div>`;
  if (!r.ok) return cardErrorMarkup('Could not load the asset registry', r.error);
  const rows = Array.isArray(r.value) ? r.value : [];
  if (rows.length === 0) {
    return h`<div class="empty"><span class="empty-title">No registry assets</span><span>This chain's bridge has not registered any yet.</span></div>`;
  }
  // `listMarkup` returns a `raw()`-wrapped value (safe to interpolate into another `h` template),
  // not a plain string — every card renderer here returns a plain string straight to `innerHTML`,
  // so it is routed back through `h` rather than handed to the DOM as an object.
  return h`${listMarkup(rows.map((a) => h`
    <li>
      <div class="row">
        <span class="row-main">
          <span class="row-title"><span class="truncate">RPL#${a.index}</span><span class="chip xs">RPL</span></span>
          <span class="row-sub">Chain ${a.chain}</span>
        </span>
        <span class="row-end mono">${shortHex(a.token)}</span>
      </div>
    </li>`))}`;
}

function bridgeMarkup(names, results) {
  const r = results.getBridgeState;
  if (!r) return h`<div class="empty"><span class="empty-title">No bridge here</span></div>`;
  if (!r.ok) return cardErrorMarkup('Could not load the bridge', r.error);
  const state = r.value || {};
  const chainCount = state.emitters && typeof state.emitters === 'object' ? Object.keys(state.emitters).length : 0;
  const enabledRow = h`<div class="kv"><span class="k">Enabled</span><span class="v">${state.enabled ? 'Yes' : 'No'}</span></div>`;
  if (!state.enabled) return enabledRow;
  return enabledRow + h`
    <div class="kv"><span class="k">Guardian set</span><span class="v">${state.guardian_set_index ?? '—'}</span></div>
    <div class="kv"><span class="k">Burn sequence</span><span class="v">${state.burn_sequence ?? '—'}</span></div>
    <div class="kv"><span class="k">Chains known</span><span class="v">${chainCount}</span></div>`;
}

// ------------------------------------------------------------------------------ the JSON tree ----

function jsonLeafMarkup(value) {
  if (value === null || value === undefined) return h`<span class="mono tree-null">null</span>`;
  if (typeof value === 'boolean' || typeof value === 'number') return h`<span class="mono">${String(value)}</span>`;
  return h`<span class="mono">"${String(value)}"</span>`;
}

/** One entry: `key: value` for a leaf, or a `<details>` disclosure for an object/array. Open by
 *  default at every depth — "collapsible" is the capability, not a starting state — so the whole
 *  answer reads at a glance and any part of it can still be folded away. */
function jsonEntryMarkup(key, value) {
  const label = key === null ? '' : h`<span class="tree-key">${key}</span>: `;
  if (value !== null && typeof value === 'object') {
    const isArray = Array.isArray(value);
    const entries = isArray ? value.map((v, i) => [i, v]) : Object.entries(value);
    const summary = `${isArray ? 'Array' : 'Object'}(${entries.length})`;
    return h`
      <li>
        <details open>
          <summary>${raw(label)}<span class="tree-summary">${summary}</span></summary>
          <ul class="tree-children" role="group">${raw(entries.map(([k, v]) => jsonEntryMarkup(String(k), v)).join(''))}</ul>
        </details>
      </li>`;
  }
  return h`<li>${raw(label)}${raw(jsonLeafMarkup(value))}</li>`;
}

function jsonTreeMarkup(value) {
  if (value !== null && typeof value === 'object') {
    const isArray = Array.isArray(value);
    const entries = isArray ? value.map((v, i) => [i, v]) : Object.entries(value);
    return h`<ul class="tree" role="tree">${raw(entries.map(([k, v]) => jsonEntryMarkup(String(k), v)).join(''))}</ul>`;
  }
  return h`<ul class="tree" role="tree"><li>${raw(jsonLeafMarkup(value))}</li></ul>`;
}

function lookupResultMarkup(title, value) {
  return h`
    <div class="card-head">
      <h3>${title}</h3>
      <button class="btn-icon" type="button" data-role="copy-result" aria-label="Copy as JSON">${raw(icons.copy())}</button>
    </div>
    ${raw(jsonTreeMarkup(value))}`;
}

function notFoundMarkup() {
  return h`<div class="empty"><span class="empty-title">Nothing found</span><span>No transaction or block matches that.</span></div>`;
}

// ===================================================================================== screen ====

registerScreen('explore', {
  tab: 'explore',
  render: () => shellMarkup(),
  after(ctx, root, arg) {
    const el = {
      network: root.querySelector('[data-role="network"]'),
      assets: root.querySelector('[data-role="assets"]'),
      bridge: root.querySelector('[data-role="bridge"]'),
      lookupResult: root.querySelector('[data-role="lookup-result"]'),
    };
    const rpc = typed((method, params) => ctx.backend.rpc.call(method, params));

    // #explore/bridge: still every card, but the bridge card is what the user asked to see.
    // Scrolled immediately — the card's own placeholder is already on screen from `render()`, so
    // this does not wait on the fetch below. `scrollIntoView` is browser-only (not every host
    // implements it — see ui/test/dom-env.mjs), so it is feature-detected like matchMedia is in
    // ui/app.js, exactly the pattern this codebase already uses for a DOM API a test environment
    // may not carry.
    if (arg === 'bridge' && typeof el.bridge.scrollIntoView === 'function') {
      el.bridge.scrollIntoView({ block: 'start' });
    }

    /** Fetches every zero-argument method tagged `group`, independently, and paints `target` with
     *  `render(names, results)` — `results[name]` is `{ok: true, value}` or `{ok: false, error}`.
     *  A card that has nothing to fetch (no method carries the tag) is left as `render` sees fit. */
    async function loadCard(group, target, render) {
      const names = groupMethods(group);
      const settled = await Promise.allSettled(names.map((name) => rpc[name]()));
      if (!ctx.isCurrent()) return;
      const results = {};
      names.forEach((name, i) => {
        const s = settled[i];
        results[name] = s.status === 'fulfilled' ? { ok: true, value: s.value } : { ok: false, error: s.reason };
      });
      target.innerHTML = render(names, results);
    }

    loadCard('network', el.network, networkMarkup);
    loadCard('assets', el.assets, assetsMarkup);
    loadCard('bridge', el.bridge, bridgeMarkup);

    // ---- lookup ----
    let lastResult = null;

    function setLookupError(message) {
      const input = root.querySelector('#explore-lookup');
      const wrap = input.closest('.field');
      const errorEl = root.querySelector('#explore-lookup-error');
      if (message) { errorEl.textContent = message; markInvalid(wrap, input, errorEl.id); } else { errorEl.textContent = ''; markValid(wrap, input, 'explore-lookup-hint'); }
    }

    const offLookup = on(root, '[data-role="lookup-form"]', 'submit', async (evt) => {
      evt.preventDefault();
      const input = root.querySelector('#explore-lookup');
      const submitBtn = root.querySelector('[data-role="lookup-form"] button[type=submit]');
      const raw0 = String(input.value || '').trim();
      const hex = raw0.toLowerCase();

      let kind;
      if (HEX64_RE.test(hex)) kind = 'hash';
      else if (raw0 !== '' && DIGITS_RE.test(raw0)) kind = 'height';
      else {
        setLookupError(raw0 === ''
          ? 'Enter a transaction hash, block hash or block height.'
          : 'That is neither 64 hex characters (a hash) nor a block height (digits only).');
        return;
      }
      setLookupError(null);
      lastResult = null;
      el.lookupResult.innerHTML = skeletonCardMarkup();
      submitBtn.disabled = true;
      try {
        let value, title;
        if (kind === 'hash') {
          value = await rpc.getTransaction(hex);
          title = 'Transaction';
          if (value === null || value === undefined) {
            value = await rpc.getBlockByHash(hex);
            title = 'Block';
          }
        } else {
          value = await rpc.getBlockByHeight(Number(raw0));
          title = 'Block';
        }
        if (!ctx.isCurrent()) return;
        if (value === null || value === undefined) {
          lastResult = null;
          el.lookupResult.innerHTML = notFoundMarkup();
        } else {
          lastResult = value;
          el.lookupResult.innerHTML = lookupResultMarkup(title, value);
        }
      } catch (err) {
        if (!ctx.isCurrent()) return;
        lastResult = null;
        el.lookupResult.innerHTML = cardErrorMarkup('The lookup failed', err);
      } finally {
        if (ctx.isCurrent()) submitBtn.disabled = false;
      }
    });

    const offCopy = on(root, '[data-role="copy-result"]', 'click', async (evt) => {
      evt.preventDefault();
      if (lastResult === null) return;
      await ctx.backend.platform.copy(JSON.stringify(lastResult, null, 2));
      if (!ctx.isCurrent()) return;
      ctx.toast('Copied as JSON', { kind: 'positive' });
    });

    return () => { offLookup(); offCopy(); };
  },
});
