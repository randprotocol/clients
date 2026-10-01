// Swap: trade RAND and listed tokens through the durian.market AMM, from inside the wallet.
//
// The pools are read from the chain (`backend.program.cells(DURIAN_PROGRAM)`), the quote and the
// exact transition are this wallet's own (ui/lib/amm.js, a port of durian's planner checked against
// its vectors), and the swap is the same RPL-2 invoke a site asks for through window.rand.invoke:
// `program.quote` (every refusal that needs no proof, and the network fee) on Review, then
// `program.invoke` on Swap. Nothing is sent to durian.market itself.
//
// Steps: form → review → running → done | failed. A pool that moved between the quote and the
// chain (STALE_READ) is re-read and quoted again — the program pays exact amounts, so there is no
// slippage setting: a moved pool means a new quote the user sees, never a worse fill.
//
// A swap in flight lives in `current` (module scope), not in the screen: leaving the screen does
// not stop it, and coming back shows its progress.
import { h, raw, on } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { registerScreen } from '../app.js';
import { formatUnits, parseUnits, shortHex } from '../lib/format.js';
import { explorerLink } from '../lib/explorer.js';
import { recordDuration } from '../lib/progress.js';
import { DURIAN_PROGRAM, DURIAN_URL, FEE_BPS, RAND_ASSET, buildSwap, findRoute, poolsOf, spotRate, tradeable } from '../lib/amm.js';
import { progressRing, proverNoticeMarkup, proverDeclinedMarkup, PROVER_CONSENT_DECLINED } from './send/markup.js';
import { phaseLabel } from './send/state.js';

/** The swap in flight, or the last one's outcome until it is seen: `{startedMs, kind, phase,
 *  detail, done?: {hash, sell, buy, amountIn, amountOut}, error?: string}`. */
let current = null;

const STALE = 'The pool moved before your swap reached the chain, so nothing was sent. Here is a new quote.';

function shellMarkup() {
  return h`
    <h1 class="sr-only">Swap</h1>
    <div class="narrow">
      <div class="topbar">
        <button class="btn-icon icon-flip" type="button" data-go="home" aria-label="Back">${raw(icons.chevron())}</button>
        <span class="grow"></span>
      </div>
      <div class="stack loose" data-role="step"><div class="skeleton block"></div></div>
    </div>`;
}

/** index → {symbol, name, decimals, balance}, from the wallet's own asset list. */
function infoOf(assets, index) {
  const a = assets.find((x) => x.index === index);
  if (a) return { symbol: a.symbol || `asset ${index}`, name: a.name || a.symbol || `asset ${index}`, decimals: Number.isInteger(a.decimals) ? a.decimals : 9, balance: String(a.balance ?? '0') };
  return index === RAND_ASSET
    ? { symbol: 'RAND', name: 'Rand', decimals: 9, balance: '0' }
    : { symbol: `asset ${index}`, name: `asset ${index}`, decimals: 9, balance: '0' };
}

const amountOf = (assets, index, units, frac = 9) => {
  const i = infoOf(assets, index);
  return `${formatUnits(String(units), frac, i.decimals)} ${i.symbol}`;
};

function assetSelect(id, name, list, selected, assets) {
  const options = list.map((index) => {
    const i = infoOf(assets, index);
    return h`<option value="${String(index)}"${raw(index === selected ? ' selected' : '')}>${i.symbol}</option>`;
  }).join('');
  return raw(h`<select id="${id}" name="${name}">${raw(options)}</select>`);
}

function formMarkup({ assets, list, sell, buy, amount, notice = '' }) {
  const s = infoOf(assets, sell);
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">Swap</h2>
    ${notice ? raw(h`<div class="banner warn"><span class="ic">${raw(icons.warning())}</span><span>${notice}</span></div>`) : ''}
    <form class="stack loose" data-role="swap-form" novalidate>
      <div class="field amount-field" data-role="pay-field">
        <div class="field-top">
          <label class="label" for="swap-amount">You pay</label>
          <button class="btn sm" type="button" data-role="max">Max</button>
        </div>
        <div class="swap-row">
          <input id="swap-amount" name="amount" type="text" inputmode="decimal" autocomplete="off" placeholder="0.0" value="${amount}" aria-describedby="swap-amount-hint swap-amount-error">
          ${assetSelect('swap-sell', 'sell', list, sell, assets)}
        </div>
        <span class="hint" id="swap-amount-hint">Available ${formatUnits(s.balance, 6, s.decimals)} ${s.symbol}</span>
        <span class="error" id="swap-amount-error"></span>
      </div>
      <div class="swap-flip"><button class="btn-icon" type="button" data-role="flip" aria-label="Swap the two assets">${raw(icons.swap())}</button></div>
      <div class="field amount-field">
        <label class="label" for="swap-buy">You receive</label>
        <div class="swap-row">
          <output class="swap-out" data-role="out" for="swap-amount swap-sell swap-buy" aria-live="polite">—</output>
          ${assetSelect('swap-buy', 'buy', list, buy, assets)}
        </div>
      </div>
      <div class="card" data-role="details"></div>
      <button class="btn btn-primary block" type="submit" data-role="review" disabled>Review</button>
    </form>
    <p class="caption">Priced by the durian.market pools on this chain (${FEE_BPS / 100}% pool fee). The swap is a transaction this wallet proves and sends itself.</p>`;
}

function detailsMarkup(assets, q, route) {
  if (!q || !q.ok) return '';
  const rate = spotRate(route, infoOf(assets, q.sell).decimals);
  const impact = Number(q.impactPpm) / 10_000;
  const via = q.hops.length === 2 ? raw(h`<div class="kv"><span class="k">Route</span><span class="v">${infoOf(assets, q.sell).symbol} → RAND → ${infoOf(assets, q.buy).symbol}</span></div>`) : '';
  return h`
    <div class="kv"><span class="k">Rate</span><span class="v amount">1 ${infoOf(assets, q.sell).symbol} ≈ ${amountOf(assets, q.buy, rate ?? 0n, 6)}</span></div>
    <div class="kv"><span class="k">Price impact</span><span class="v${raw(impact >= 5 ? ' negative' : '')}">${impact < 0.01 ? '< 0.01' : impact.toFixed(2)}%</span></div>
    <div class="kv"><span class="k">Pool fee</span><span class="v amount">${amountOf(assets, q.feeAsset, q.fee, 6)}</span></div>
    ${via}`;
}

function reviewMarkup(assets, q, quote, can) {
  const notice = can && can.notice ? raw(proverNoticeMarkup(can.provers)) : '';
  const prover = can && can.via === 'prover'
    ? (can.prover === 'default' ? 'One of the RandProtocol provers makes the large proof; this device makes the small ones. It takes a few minutes.' : 'Your paired prover makes the large proof; this device makes the small ones. It takes a few minutes.')
    : 'This device proves the swap. It takes a few minutes.';
  const swapBtn = can && can.notice ? '' : raw(h`<button class="btn btn-primary block" type="button" data-role="swap">Swap</button>`);
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">Review the swap</h2>
    <div class="card">
      <div class="kv"><span class="k">You pay</span><span class="v amount">${amountOf(assets, q.sell, q.amountIn)}</span></div>
      <div class="kv"><span class="k">You receive</span><span class="v amount">${amountOf(assets, q.buy, q.amountOut)}</span></div>
      <div class="kv"><span class="k">Pool fee</span><span class="v amount">${amountOf(assets, q.feeAsset, q.fee)}</span></div>
      <div class="kv"><span class="k">Network fee</span><span class="v amount">${amountOf(assets, RAND_ASSET, quote.fee)}</span></div>
      <div class="kv"><span class="k">Program</span><span class="v mono">${shortHex(DURIAN_PROGRAM, 10)}</span></div>
    </div>
    <p class="caption">The amount you receive is exact: if the pool moves before the swap lands, nothing is sent and you get a new quote. ${prover}</p>
    ${notice}
    ${swapBtn}
    <button class="btn btn-ghost block" type="button" data-role="edit">Edit</button>`;
}

function runningMarkup(store) {
  const label = phaseLabel(store.phase, store.detail);
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">Swapping</h2>
    <div class="stage">
      ${raw(progressRing(store, label))}
      <span class="subtitle" data-role="phase">${label}</span>
    </div>
    <div class="banner"><span class="ic">${raw(icons.shield())}</span><span><span class="banner-title">You can look at other screens</span>The swap keeps going. Closing the wallet before it says sent stops it, and nothing is lost.</span></div>`;
}

function doneMarkup(assets, done, explorer) {
  return h`
    <div class="stage">
      <span class="avatar lg in">${raw(icons.check())}</span>
      <h2 class="title" data-role="step-title" tabindex="-1">Swap submitted</h2>
      <span class="amount">${amountOf(assets, done.buy, done.amountOut)}</span>
    </div>
    <div class="card">
      <div class="kv"><span class="k">Paid</span><span class="v amount">${amountOf(assets, done.sell, done.amountIn)}</span></div>
      <div class="kv">
        <span class="k">Transaction</span>
        <span class="v cluster"><span class="mono truncate">${shortHex(done.hash, 10)}</span><button class="btn-icon" type="button" data-role="copy-hash" aria-label="Copy the transaction hash">${raw(icons.copy())}</button></span>
      </div>
    </div>
    <p class="caption">What the pool pays you arrives as a note your wallet finds on its next sync.</p>
    ${explorer ? raw(h`<button class="btn block" type="button" data-role="explorer">${explorer.label}</button>`) : ''}
    <button class="btn btn-primary block" type="button" data-role="finish">Done</button>`;
}

function failedMarkup(message) {
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">Not swapped</h2>
    <div class="banner negative"><span class="ic">${raw(icons.warning())}</span><span><span class="banner-title">Nothing was sent</span>${message}</span></div>
    <button class="btn btn-primary block" type="button" data-role="again">Try again</button>
    <button class="btn btn-ghost block" type="button" data-go="home">Back to home</button>`;
}

function unavailableMarkup(message) {
  return h`
    <h2 class="title" data-role="step-title" tabindex="-1">Swap</h2>
    <div class="card"><div class="empty">
      <span class="avatar lg">${raw(icons.swap())}</span>
      <span>${message}</span>
    </div></div>
    <button class="btn block" type="button" data-role="open-durian">Open durian.market</button>
    <button class="btn btn-ghost block" type="button" data-go="home">Back to home</button>`;
}

registerScreen('swap', {
  tab: 'home',
  render: () => shellMarkup(),
  async after(ctx, root) {
    const stepEl = root.querySelector('[data-role="step"]');
    const program = ctx.backend.program;
    const platform = ctx.backend.platform || {};
    let assets = [];
    let pools = [];
    let sell = RAND_ASSET;
    let buy = null;
    let amount = '';
    let quote = null; // amm.buildSwap's result for the form's values
    let route = null;
    let ticker = null;
    let acknowledging = false;
    const offs = [];
    const live = () => ctx.isCurrent();
    const focusTitle = () => { const t = stepEl.querySelector('[data-role="step-title"]'); if (t && t.focus) t.focus(); };
    const stopTicker = () => { if (ticker) { clearInterval(ticker); ticker = null; } };

    async function loadPools() {
      const [cells, list] = await Promise.all([program.cells(DURIAN_PROGRAM), ctx.backend.assets.list().catch(() => [])]);
      assets = list || [];
      pools = poolsOf(cells || []);
      return cells !== null;
    }

    function requote() {
      route = buy === null ? null : findRoute(pools, sell, buy);
      const i = infoOf(assets, sell);
      let units = null;
      try { units = amount.trim() ? parseUnits(amount.trim(), i.decimals) : null; } catch { units = null; }
      const out = stepEl.querySelector('[data-role="out"]');
      const details = stepEl.querySelector('[data-role="details"]');
      const err = stepEl.querySelector('#swap-amount-error');
      const btn = stepEl.querySelector('[data-role="review"]');
      if (!out) return;
      const field = stepEl.querySelector('[data-role="pay-field"]');
      err.textContent = '';
      quote = null;
      if (amount.trim() && (units === null || units <= 0n)) err.textContent = 'Enter an amount like 1.5.';
      else if (units !== null && units > BigInt(i.balance)) err.textContent = `You have ${formatUnits(i.balance, 6, i.decimals)} ${i.symbol}.`;
      if (units !== null && units > 0n) {
        quote = buildSwap({ route, dx: units });
        if (!quote.ok && !err.textContent) err.textContent = quote.message;
      }
      field.classList.toggle('invalid', !!err.textContent);
      // The amount only: the asset is the picker beside it.
      out.textContent = quote && quote.ok ? formatUnits(quote.amountOut.toString(), 9, infoOf(assets, buy).decimals) : '—';
      details.innerHTML = quote && quote.ok ? detailsMarkup(assets, quote, route) : '';
      details.hidden = !(quote && quote.ok);
      btn.disabled = !(quote && quote.ok) || !!err.textContent;
    }

    function showForm(notice = '') {
      stopTicker();
      const list = tradeable(pools);
      if (buy === null || !list.includes(buy) || buy === sell) buy = list.find((a) => a !== sell) ?? null;
      stepEl.innerHTML = formMarkup({ assets, list, sell, buy, amount, notice });
      const input = stepEl.querySelector('#swap-amount');
      input.addEventListener('input', () => { amount = input.value; requote(); });
      stepEl.querySelector('#swap-sell').addEventListener('change', (e) => {
        sell = Number(e.target.value);
        if (sell === buy) buy = list.find((a) => a !== sell) ?? null;
        showForm();
      });
      stepEl.querySelector('#swap-buy').addEventListener('change', (e) => {
        buy = Number(e.target.value);
        if (buy === sell) sell = list.find((a) => a !== buy) ?? RAND_ASSET;
        showForm();
      });
      stepEl.querySelector('[data-role="flip"]').addEventListener('click', () => {
        [sell, buy] = [buy, sell];
        amount = '';
        showForm();
      });
      stepEl.querySelector('[data-role="max"]').addEventListener('click', () => {
        const i = infoOf(assets, sell);
        // Selling RAND leaves room for the network fee, which is paid in RAND too.
        const room = sell === RAND_ASSET ? BigInt(i.balance) - 10_000_000n : BigInt(i.balance);
        amount = room > 0n ? formatUnits(room.toString(), i.decimals, i.decimals).replace(/,/g, '') : '';
        input.value = amount;
        requote();
      });
      stepEl.querySelector('[data-role="swap-form"]').addEventListener('submit', (e) => { e.preventDefault(); void review(); });
      requote();
      focusTitle();
    }

    async function review() {
      if (!quote || !quote.ok) return;
      const built = quote;
      stepEl.innerHTML = h`<h2 class="title" data-role="step-title" tabindex="-1">Checking the swap…</h2><div class="skeleton block"></div>`;
      let can;
      let q;
      try {
        can = await program.canInvoke();
        if (!can || !can.ok) throw new Error((can && can.reason) || 'This wallet cannot send a swap here.');
        q = await program.quote(built.request);
      } catch (err) {
        if (!live()) return;
        if (err && err.code === 'STALE_READ') { await refreshAndForm(STALE); return; }
        stepEl.innerHTML = failedMarkup((err && err.message) || 'The swap could not be checked.');
        wireFailed();
        return;
      }
      if (!live()) return;
      showReview(built, q, can);
    }

    function showReview(built, q, can) {
      stepEl.innerHTML = reviewMarkup(assets, built, q, can);
      stepEl.querySelector('[data-role="edit"]').addEventListener('click', () => showForm());
      const go = stepEl.querySelector('[data-role="swap"]');
      if (go) go.addEventListener('click', () => { void run(built); });
      const ack = stepEl.querySelector('[data-action="acknowledge-prover"]');
      if (ack) {
        ack.addEventListener('click', async () => {
          if (acknowledging) return;
          // Firefox: its consent to send the viewing key, asked synchronously inside this click.
          const consent = typeof platform.requestDataCollectionConsent === 'function' ? platform.requestDataCollectionConsent() : null;
          acknowledging = true;
          try {
            if (consent) {
              let granted = false;
              try { granted = (await consent) === true; } catch { granted = false; }
              if (!granted) {
                if (!live()) return;
                for (const el of stepEl.querySelectorAll('[data-role="prover-notice"], [data-action="acknowledge-prover"], [data-role="use-own-prover"]')) el.remove();
                stepEl.insertAdjacentHTML('beforeend', proverDeclinedMarkup());
                return;
              }
            }
            await ctx.backend.prover.acknowledgeDefault();
            if (!live()) return;
            const { notice, ...rest } = can;
            void notice;
            showReview(built, q, rest);
          } catch (err) {
            if (live()) stepEl.insertAdjacentHTML('beforeend', h`<p class="caption error">${(err && err.message) || PROVER_CONSENT_DECLINED}</p>`);
          } finally {
            acknowledging = false;
          }
        });
      }
      focusTitle();
    }

    async function run(built) {
      ctx.backend.wallet.noteActivity?.();
      current = { startedMs: Date.now(), kind: 'invoke', phase: 'selecting', detail: null, session: ctx.session && ctx.session.id };
      const mine = current;
      showRunning();
      try {
        const { hash } = await program.invoke(built.request, (phase, detail) => {
          mine.phase = phase;
          mine.detail = detail || null;
          if (current === mine && live()) {
            const ph = stepEl.querySelector('[data-role="phase"]');
            if (ph) ph.textContent = phaseLabel(phase, detail);
          }
        });
        recordDuration('invoke', Date.now() - mine.startedMs);
        mine.done = { hash: String(hash).replace(/^0x/, '').toLowerCase(), sell: built.sell, buy: built.buy, amountIn: built.amountIn, amountOut: built.amountOut };
        // A swap pays into the wallet: the next sync finds the note.
        ctx.backend.sync?.scan?.(() => {}).catch?.(() => {});
      } catch (err) {
        mine.error = err && err.code === 'STALE_READ' ? STALE : ((err && err.message) || 'The swap did not go through.');
        mine.stale = !!(err && err.code === 'STALE_READ');
      }
      if (current === mine && live()) await showOutcome();
    }

    function showRunning() {
      stepEl.innerHTML = runningMarkup(current);
      stopTicker();
      ticker = setInterval(() => {
        if (!live() || !current || current.done || current.error) { stopTicker(); return; }
        const ring = stepEl.querySelector('[data-role="ring"]');
        if (ring) ring.outerHTML = progressRing(current, phaseLabel(current.phase, current.detail));
      }, 1000);
      focusTitle();
    }

    async function showOutcome() {
      stopTicker();
      const c = current;
      if (c.error) {
        current = null;
        if (c.stale) { await refreshAndForm(c.error); return; }
        stepEl.innerHTML = failedMarkup(c.error);
        wireFailed();
        return;
      }
      let settings = {};
      try { settings = await ctx.backend.settings.get(); } catch { /* no explorer link then */ }
      if (!live()) return;
      const explorer = explorerLink(settings.explorerUrl, c.done.hash);
      // Shown is seen: the next visit starts a new swap.
      if (current === c) current = null;
      stepEl.innerHTML = doneMarkup(assets, c.done, explorer);
      stepEl.querySelector('[data-role="finish"]').addEventListener('click', () => ctx.go('#home'));
      stepEl.querySelector('[data-role="copy-hash"]').addEventListener('click', async () => {
        try { await platform.copy(c.done.hash); } catch { ctx.toast('That could not be copied.', { kind: 'negative' }); return; }
        ctx.toast('Transaction hash copied', { kind: 'positive' });
      });
      const ex = stepEl.querySelector('[data-role="explorer"]');
      if (ex && explorer) ex.addEventListener('click', () => platform.openExternal(explorer.url));
      focusTitle();
    }

    function wireFailed() {
      stepEl.querySelector('[data-role="again"]')?.addEventListener('click', () => { void refreshAndForm(); });
      focusTitle();
    }

    async function refreshAndForm(notice = '') {
      stepEl.innerHTML = h`<div class="skeleton block"></div>`;
      try { await loadPools(); } catch { /* the form says what it can */ }
      if (live()) showForm(notice);
    }

    offs.push(on(root, '[data-role="open-durian"]', 'click', (evt) => { evt.preventDefault(); platform.openExternal?.(DURIAN_URL); }));

    // A swap already running (or just finished) from an earlier visit of this wallet session:
    // show it. One from another session (the wallet was locked or switched) is not this user's.
    if (current && current.session !== (ctx.session && ctx.session.id)) current = null;
    if (current) {
      try { assets = await ctx.backend.assets.list(); } catch { /* amounts show by index */ }
      if (!live()) return;
      if (current.done || current.error) await showOutcome(); else showRunning();
      return () => { stopTicker(); offs.forEach((f) => f()); };
    }

    if (!program || typeof program.cells !== 'function') {
      stepEl.innerHTML = unavailableMarkup('This wallet cannot run programs, so it cannot swap here.');
      return () => offs.forEach((f) => f());
    }
    let ok;
    try {
      ok = await loadPools();
    } catch (err) {
      if (!live()) return;
      stepEl.innerHTML = unavailableMarkup(`The pools could not be read: ${(err && err.message) || 'the node did not answer'}.`);
      return () => offs.forEach((f) => f());
    }
    if (!live()) return;
    if (!ok) stepEl.innerHTML = unavailableMarkup('This chain does not run programs, so there is nothing to swap through.');
    else if (pools.length === 0) stepEl.innerHTML = unavailableMarkup('durian.market has no pools on this chain yet.');
    else showForm();

    return () => { stopTicker(); offs.forEach((f) => f()); };
  },
});
