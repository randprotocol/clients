// The entropy field: the ordered-dither grain behind the balance, and the brand mark.
//
// The field is a pure function of a seed string (the wallet's address): value noise, a drift
// towards the trailing edge so the figure on the leading edge stays on clean ink, then a 4×4 Bayer
// threshold. The same wallet always gets the same field and two wallets never share one, so it
// doubles as a glanceable fingerprint — the way an identicon does, without claiming to be one.
// Nothing here is secret-bearing: an address is what the user hands out to be paid.
//
// `fieldCells` is pure and importable under plain Node (the tests call it). `paintField` needs a
// canvas; it is only reached from a screen's `after()`.

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** A 32-bit hash of a string (FNV-1a), the PRNG's seed. */
export function seedOf(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, and good enough for a picture. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (t) => t * t * (3 - 2 * t);

/** A per-cell hash in [0, 1): stable under resizing, unlike drawing from the PRNG in order. */
function cellHash(seed, x, y, salt) {
  let h = Math.imul(seed ^ salt, 0x9e3779b1) ^ Math.imul(x + 1, 0x85ebca6b) ^ Math.imul(y + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// The lattices are a fixed size, indexed by absolute cell position, so a resize keeps the field's
// features where they were (the ramp re-fits to the new width) instead of reshuffling every cell.
// 640×320 cells covers any hero at 4 px a cell.
const MAX_W = 640, MAX_H = 320;

/** Value noise on a lattice of `step` cells, sampled at (x, y). */
function lattice(rand, cols, rows) {
  const g = new Float32Array((cols + 2) * (rows + 2));
  for (let i = 0; i < g.length; i++) g[i] = rand();
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const tx = smooth(x - xi), ty = smooth(y - yi);
    const w = cols + 2;
    const a = g[yi * w + xi], b = g[yi * w + xi + 1];
    const c = g[(yi + 1) * w + xi], d = g[(yi + 1) * w + xi + 1];
    return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
  };
}

/**
 * The field as cells: `Uint8Array(w*h)`, 0 = ink, 1 = grain, 2 = hot (signal colour), plus a
 * per-cell arrival in [0, 1) for the resolve animation. Deterministic in (seed, w, h).
 */
export function fieldCells(seedText, w, h) {
  const seed = seedOf(seedText || 'rand');
  const rand = prng(seed);
  const coarse = lattice(rand, Math.ceil(MAX_W / 14) + 1, Math.ceil(MAX_H / 14) + 1);
  const fine = lattice(rand, Math.ceil(MAX_W / 5) + 1, Math.ceil(MAX_H / 5) + 1);
  w = Math.min(w, MAX_W);
  h = Math.min(h, MAX_H);
  // Where the drift peaks: somewhere along the trailing edge, different per wallet.
  const peakY = 0.2 + rand() * 0.6;
  const cells = new Uint8Array(w * h);
  const arrival = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w, v = y / h;
      const n = 0.62 * coarse(x / 14, y / 14) + 0.38 * fine(x / 5, y / 5);
      // An ordered-dither ramp: clean ink on the leading 40% (where the figure sits), rising to
      // dense grain at the trailing edge. The noise only warps the ramp, so the Bayer cross-hatch
      // stays legible as structure instead of dissolving into speckle.
      const ramp = Math.min(1, Math.max(0, (u - 0.42) / 0.58));
      const gather = 1 - Math.min(1, Math.abs(v - peakY) * 1.2);
      const level = ramp * (0.62 + 0.5 * gather) + (n - 0.5) * 0.7 * Math.sqrt(ramp);
      const drift = ramp;
      const threshold = (BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
      const i = y * w + x;
      const on = level > threshold;
      cells[i] = on ? (cellHash(seed, x, y, 1) < 0.035 * drift ? 2 : 1) : 0;
      arrival[i] = cellHash(seed, x, y, 2);
    }
  }
  return { cells, arrival };
}

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Paints the field into `canvas`, sized to its box, and keeps it painted across resizes and theme
 * changes. `seed` may be updated later with `.reseed(text)` (the address arrives after the first
 * paint). Resolves out of noise once, on the first seeded paint. Returns `{reseed, destroy}`.
 */
export function paintField(canvas, { cell = 4, seed = '' } = {}) {
  const ctx = canvas.getContext && canvas.getContext('2d');
  // No 2D context (a test DOM, a locked-down webview): the hero is plain ink, which is fine.
  if (!ctx) return { reseed() {}, destroy() {} };
  let seedText = seed;
  let frame = 0;
  let resolved = false;
  let destroyed = false;

  function colours() {
    const cs = getComputedStyle(canvas);
    return {
      ink: cs.getPropertyValue('--field-ink').trim() || '#0E1220',
      grain: cs.getPropertyValue('--field-grain').trim() || '#ECE9E2',
      hot: cs.getPropertyValue('--accent').trim() || '#FF5C9D',
    };
  }

  function draw(progress) {
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const dpr = Math.max(1, Math.round(globalThis.devicePixelRatio || 1));
    const w = Math.min(640, Math.ceil(box.width / cell)), h = Math.min(320, Math.ceil(box.height / cell));
    const px = cell * dpr;
    if (canvas.width !== w * px || canvas.height !== h * px) {
      canvas.width = w * px;
      canvas.height = h * px;
    }
    const { cells, arrival } = fieldCells(seedText, w, h);
    const c = colours();
    ctx.fillStyle = c.ink;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Grain pixels are drawn a hair smaller than their cell, so the grid reads as pixels, not mush.
    const inset = Math.max(1, Math.round(dpr * 0.5));
    for (const [kind, colour] of [[1, c.grain], [2, c.hot]]) {
      ctx.fillStyle = colour;
      for (let i = 0; i < cells.length; i++) {
        if (cells[i] !== kind) continue;
        // Resolving: every cell flickers as noise until its arrival time, then settles.
        if (progress < 1 && arrival[i] > progress) {
          if (((i * 2654435761) ^ Math.floor(progress * 40)) % 7 !== 0) continue;
        }
        const x = i % w, y = (i / w) | 0;
        ctx.fillRect(x * px, y * px, px - inset, px - inset);
      }
    }
  }

  function resolve() {
    if (resolved || reducedMotion()) { resolved = true; draw(1); return; }
    resolved = true;
    const start = performance.now();
    const tick = (now) => {
      if (destroyed) return;
      const t = Math.min(1, (now - start) / 620);
      draw(1 - (1 - t) ** 3);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (resolved) draw(1); }) : null;
  ro?.observe(canvas);
  // A theme switch changes the hot colour; the ink and grain are fixed.
  const mo = typeof MutationObserver === 'function' ? new MutationObserver(() => { if (resolved) draw(1); }) : null;
  mo?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
  const onScheme = () => { if (resolved) draw(1); };
  mq?.addEventListener?.('change', onScheme);

  if (seedText) resolve();

  return {
    reseed(text) {
      if (destroyed || !text || text === seedText) return;
      seedText = text;
      if (resolved) draw(1); else resolve();
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      ro?.disconnect();
      mo?.disconnect();
      mq?.removeEventListener?.('change', onScheme);
    },
  };
}

/**
 * The brand mark: a 4×4 Bayer tile at one threshold, as inline SVG — the field's smallest piece.
 * One cell burns in the accent. Trusted markup; wrap with raw().
 */
export function markSvg() {
  const on = [0, 2, 5, 7, 8, 10, 13, 15, 1, 11]; // the cells a level of ~10/16 lights
  let rects = '';
  for (const i of on) {
    const x = (i % 4) * 6, y = Math.floor(i / 4) * 6;
    const hot = i === 11 ? ' class="hot"' : '';
    rects += `<rect${hot} x="${x}" y="${y}" width="5" height="5"/>`;
  }
  return `<svg class="mark" viewBox="0 0 23 23" aria-hidden="true" focusable="false">${rects}</svg>`;
}

/** The brand: mark plus wordmark. The visible word is `rand`; the accessible name is the product's. */
export function brandMarkup() {
  return `<div class="brand">${markSvg()}<span class="name" aria-hidden="true">rand</span><span class="sr-only">Rand Wallet</span></div>`;
}
