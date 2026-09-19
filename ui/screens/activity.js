// Activity: every transaction, grouped by day, with a client-side filter chip row (All + one chip
// per asset). Filtering never re-fetches — it re-renders the already-fetched list in place.
import { h, raw, on } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';
import { groupByDay } from '../lib/assets.js';
import { activityRowMarkup, listMarkup } from '../lib/rows.js';

function skeletonMarkup() {
  return h`
    <h1 class="sr-only">Activity</h1>
    <div class="topbar"><span class="topbar-title">Activity</span></div>
    <div class="card flush">${listMarkup(Array.from({ length: 3 }, () => h`
      <li><div class="row"><span class="skeleton circle"></span><span class="row-main"><span class="skeleton line lg"></span><span class="skeleton line sm"></span></span></div></li>`))}</div>`;
}

function filterChipsMarkup(assets, active) {
  const chips = [{ index: 'all', symbol: 'All' }, ...assets.map((a) => ({ index: String(a.index), symbol: a.symbol }))];
  return h`<div class="cluster" role="group" aria-label="Filter activity by asset">${raw(chips.map((c) => h`
    <button class="chip action${c.index === active ? ' on' : ''}" type="button" data-filter="${c.index}" aria-pressed="${c.index === active ? 'true' : 'false'}">${c.symbol}</button>`).join(''))}</div>`;
}

function groupsMarkup(items, assetsByIndex, now) {
  if (items.length === 0) {
    return h`
      <div class="card">
        <div class="empty">
          <span class="avatar lg">${raw(icons.activity())}</span>
          <span class="empty-title">No activity yet</span>
          <span>Transactions you send or receive will appear here.</span>
          <button class="btn sm" type="button" data-go="faucet">Get test RAND from the faucet</button>
        </div>
      </div>`;
  }
  const groups = groupByDay(items, now);
  return groups.map((g) => h`
    <h2 class="section-title">${g.label}</h2>
    <div class="card flush">${listMarkup(g.items.map((item) => activityRowMarkup(item, assetsByIndex)))}</div>`).join('');
}

registerScreen('activity', {
  tab: 'activity',
  render: () => skeletonMarkup(),
  async after(ctx, root) {
    let assets, sync;
    try {
      [assets, sync] = await Promise.all([ctx.backend.assets.list(), ctx.backend.sync.cached()]);
    } catch (err) {
      if (!ctx.isCurrent()) return;
      root.innerHTML = h`<div class="banner negative"><span class="ic">${raw(icons.warning())}</span><span><span class="banner-title">Could not load your activity</span>${err && err.message ? err.message : 'Something went wrong.'}</span></div>`;
      return;
    }
    if (!ctx.isCurrent()) return;

    const assetsByIndex = new Map(assets.map((a) => [a.index, a]));
    const all = [...(sync.activity || [])].sort((a, b) => b.time - a.time);
    let active = 'all';

    function paint() {
      const items = active === 'all' ? all : all.filter((a) => String(a.asset) === active);
      root.innerHTML = h`
        <h1 class="sr-only">Activity</h1>
        <div class="topbar"><span class="topbar-title">Activity</span></div>
        ${raw(filterChipsMarkup(assets, active))}
        ${raw(groupsMarkup(items, assetsByIndex, Date.now()))}`;
    }
    paint();
    // Event delegation (see lib/dom.js's `on`) matches `[data-filter]` at click time, not bind
    // time, so one listener bound once, before the first paint(), keeps working across every
    // paint()'s full innerHTML replacement — no rebinding, so no listener leak from re-adding one
    // on every filter click.
    const offFilter = on(root, '[data-filter]', 'click', (evt, chip) => {
      evt.preventDefault();
      active = chip.dataset.filter;
      paint();
    });

    return () => { offFilter(); };
  },
});
