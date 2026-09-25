// The entropy field and the balance veil (ui/lib/entropy.js, screens/home.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import './dom-env.mjs';
import { unlockedBackend } from './fake-backend.mjs';
import { mountApp } from './helpers.mjs';
import { fieldCells, markSvg, brandMarkup, seedOf } from '../lib/entropy.js';

test('the field is a pure function of the seed: same wallet, same field', () => {
  const a = fieldCells('rand1abc', 120, 48);
  const b = fieldCells('rand1abc', 120, 48);
  assert.deepEqual(a.cells, b.cells);
  assert.deepEqual(a.arrival, b.arrival);
});

test('two wallets never share a field', () => {
  const a = fieldCells('rand1abc', 120, 48).cells;
  const b = fieldCells('rand1abd', 120, 48).cells;
  assert.notDeepEqual(a, b);
  assert.notEqual(seedOf('rand1abc'), seedOf('rand1abd'));
});

test('the leading edge, where the figure sits, is clean ink for every seed', () => {
  const w = 120, h = 48;
  for (const seed of ['', 'rand', 'rand1abc', 'rand1' + 'q'.repeat(60), 'x'.repeat(500)]) {
    const { cells } = fieldCells(seed, w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < Math.floor(w * 0.4); x++) {
        assert.equal(cells[y * w + x], 0, `seed ${JSON.stringify(seed.slice(0, 12))} lit (${x}, ${y})`);
      }
    }
  }
});

test('the field has grain and a few hot pixels, but is not solid', () => {
  const { cells } = fieldCells('rand1abc', 160, 56);
  const lit = cells.filter((c) => c > 0).length;
  const hot = cells.filter((c) => c === 2).length;
  assert.ok(lit > cells.length * 0.1 && lit < cells.length * 0.6, `density ${lit / cells.length}`);
  assert.ok(hot > 0 && hot < lit * 0.1, `hot ${hot} of ${lit}`);
});

test('the mark burns exactly one pixel in the signal colour, and the brand keeps the product name', () => {
  assert.equal(markSvg().match(/class="hot"/g).length, 1);
  assert.match(brandMarkup(), /class="sr-only">Rand Wallet</);
  assert.match(brandMarkup(), /aria-hidden="true">rand</);
});

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

test('home: the veil hides every balance, is a pressed toggle, and is remembered', async (t) => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true, writable: true });
  t.after(() => {
    if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete globalThis.localStorage;
    document.documentElement.classList.remove('veiled');
  });

  const { app, root } = await mountApp(t, unlockedBackend(), { hash: '#home' });
  await app.idle();
  const btn = root.querySelector('.hero [data-action="veil"]');
  assert.ok(btn, 'the hero has a veil toggle');
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  assert.equal(btn.getAttribute('aria-label'), 'Hide balances', 'one label; the state is aria-pressed');
  assert.equal(document.documentElement.classList.contains('veiled'), false);

  btn.click();
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  assert.equal(btn.getAttribute('aria-label'), 'Hide balances');
  assert.equal(document.documentElement.classList.contains('veiled'), true);
  assert.equal(localStorage.getItem('rand-wallet:veil'), '1');
  // The amount is still in the document for assistive tech: the veil is visual only.
  assert.match(root.querySelector('.hero .amount').textContent, /3\.5/);

  btn.click();
  assert.equal(document.documentElement.classList.contains('veiled'), false);
  assert.equal(localStorage.getItem('rand-wallet:veil'), '0');
});

test('home: a remembered veil is applied on the next visit', async (t) => {
  const store = memoryStorage();
  store.setItem('rand-wallet:veil', '1');
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true });
  t.after(() => {
    if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete globalThis.localStorage;
    document.documentElement.classList.remove('veiled');
  });

  const { app, root } = await mountApp(t, unlockedBackend(), { hash: '#home' });
  await app.idle();
  assert.equal(root.querySelector('.hero [data-action="veil"]').getAttribute('aria-pressed'), 'true');
  assert.equal(document.documentElement.classList.contains('veiled'), true);
});
