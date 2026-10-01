// Amount and text formatting. Units are decimal strings (1 RAND = 10^9 units) and are handled
// as BigInt: a balance can exceed 2^53.
//
// Amounts are written the same way in every language — ASCII digits, `.` for the decimal point,
// `,` grouping — so what the wallet shows can be pasted back into any amount field or a command
// line unchanged; only the words around them follow the language (ui/i18n.js).
import { t } from '../i18n.js';

export const UNITS = 1_000_000_000n;

export function toBig(s) { try { return BigInt(String(s ?? '0')); } catch { return 0n; } }

/** "1500000000" → "1.5"; trims trailing zeros; optional max fraction digits; optional unit decimals. */
export function formatUnits(units, maxFrac = 9, decimals = 9) {
  const base = 10n ** BigInt(decimals);
  const u = toBig(units);
  const neg = u < 0n;
  const a = neg ? -u : u;
  const whole = a / base;
  const frac = (a % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  const w = whole.toLocaleString('en-US');
  return (neg ? '-' : '') + (frac ? `${w}.${frac}` : w);
}

/** "1.5" → 1500000000n; throws on bad input. */
export function parseUnits(text, decimals = 9) {
  const s = String(text).trim();
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') throw new Error('not a number');
  const [w = '0', f = ''] = s.split('.');
  if (f.length > decimals) throw new Error(`at most ${decimals} decimal places`);
  const base = 10n ** BigInt(decimals);
  return BigInt(w || '0') * base + BigInt((f + '0'.repeat(decimals)).slice(0, decimals));
}

export function shortAddress(a, head = 12, tail = 6) {
  if (!a) return '';
  return a.length <= head + tail + 1 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`;
}

export function shortHex(h, n = 8) { return h ? `${h.slice(0, n)}…${h.slice(-4)}` : ''; }

export function timeAgo(ms) {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return t('just now');
  if (s < 3600) return t('{n} min ago', { n: Math.floor(s / 60) });
  if (s < 86400) return t('{n} h ago', { n: Math.floor(s / 3600) });
  return t('{n} d ago', { n: Math.floor(s / 86400) });
}

export function elapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
