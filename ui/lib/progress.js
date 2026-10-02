// An honest progress estimate for the slow part of a send: the proofs. Nothing reports a
// percentage — the device's auth proof and the prover's bundle proof each just finish — so this is
// the elapsed time against how long that kind of operation usually takes, learned on this device.
//
//   expectedMs(kind)          the typical duration: this device's own average once it has one,
//                             else a default measured on the public chain (2026-10-01)
//   progressAt(elapsed, exp)  0…1: linear to 0.9 at the expected time, then easing towards 0.99 —
//                             never "done" before the transaction is actually sent
//   remainingText(elapsed, exp)  "about 1:20 left" / "almost done" / "taking longer than usual"
//   recordDuration(kind, ms)  folds a finished run into this device's average
//
// Kinds: 'transfer' (RAND), 'transfer-token' (an RPL token), 'withdraw', 'invoke' (a program call,
// a durian.market swap). The average lives in localStorage — a per-viewer convenience, nothing
// else reads it — and every access is guarded: a private window simply keeps the defaults.
import { t } from '../i18n.js';

/** Measured 2026-10-01 on chain 20, through the RandProtocol prover: authorising on the device,
 *  the bundle proof on the pool, submitting. An invoke also proves the program call in the browser. */
export const DEFAULT_MS = Object.freeze({
  transfer: 180_000,
  'transfer-token': 185_000,
  withdraw: 190_000,
  invoke: 280_000,
});

const KEY = 'rand-wallet.proveMs';
const MIN_MS = 20_000;
const MAX_MS = 30 * 60_000;

function read() {
  try {
    const raw = globalThis.localStorage && globalThis.localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

export function expectedMs(kind) {
  const learned = Number(read()[kind]);
  if (Number.isFinite(learned) && learned >= MIN_MS && learned <= MAX_MS) return learned;
  return DEFAULT_MS[kind] || DEFAULT_MS.transfer;
}

/** A finished run, folded into this device's average (an exponential average, so a slow pool one
 *  afternoon moves the estimate without owning it). Runs outside a sane range are ignored. */
export function recordDuration(kind, ms) {
  if (!DEFAULT_MS[kind] || !Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) return;
  try {
    const all = read();
    const prev = Number(all[kind]);
    all[kind] = Math.round(Number.isFinite(prev) && prev > 0 ? prev * 0.7 + ms * 0.3 : ms);
    globalThis.localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* the defaults stay */ }
}

export function progressAt(elapsed, expected) {
  const e = Math.max(0, Number(elapsed) || 0);
  const x = Math.max(1, Number(expected) || 1);
  if (e <= x) return 0.9 * (e / x);
  return Math.min(0.99, 0.9 + 0.09 * (1 - Math.exp(-(e - x) / x)));
}

const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function remainingText(elapsed, expected) {
  const left = expected - elapsed;
  if (left > 15_000) return t('about {left} left', { left: clock(left) });
  if (left > -30_000) return t('almost done');
  return t('taking longer than usual');
}
