// Pure data helpers for the home, asset, activity and detail screens. Importable under plain
// Node (no `document`/`window` access at module scope, same rule as every other ui/lib file).

/** The RAND (index 0) balance, as a decimal units string. RPL assets (index >= 1) have no price
 *  feed and are never summed into this — it is the RAND figure alone, never a portfolio total. */
export function totalInRand(assets) {
  const rand = (assets || []).find((a) => a.index === 0);
  return rand ? String(rand.balance ?? '0') : '0';
}

const DAY_MS = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function startOfDayUTC(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function formatDay(ms) {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Buckets `activity` into day groups, newest first: `[{label, items}]`, where `label` is
 * `'Today'`, `'Yesterday'` or `'D Mon YYYY'`. Each item's `.time` is a unix timestamp in
 * *seconds* (the chain's convention); `now` is milliseconds (`Date.now()`), like everywhere else
 * in ui/.
 */
export function groupByDay(activity, now = Date.now()) {
  const today = startOfDayUTC(now);
  const buckets = new Map(); // day-start-ms -> items[]
  for (const item of activity || []) {
    const dayStart = startOfDayUTC(item.time * 1000);
    if (!buckets.has(dayStart)) buckets.set(dayStart, []);
    buckets.get(dayStart).push(item);
  }
  return [...buckets.keys()]
    .sort((a, b) => b - a)
    .map((dayStart) => {
      const diffDays = Math.round((today - dayStart) / DAY_MS);
      const label = diffDays === 0 ? 'Today' : diffDays === 1 ? 'Yesterday' : formatDay(dayStart);
      return { label, items: buckets.get(dayStart) };
    });
}

/** A small, stable string hash (not cryptographic) used only to derive a hue 0-359. */
function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Deterministic `{text, hue}` for an asset's avatar, derived from `asset.id`. RAND gets the
 * aurora marker (`hue: null` — screens render it with `.avatar.accent`, the same flat accent
 * treatment as the hero, instead of a hue-derived identicon); every RPL asset gets a one-letter
 * initial on a hue derived from its id (`.avatar.rpl`, hue set through the CSSOM).
 */
export function avatarFor(asset) {
  if (!asset) return { text: '?', hue: 0 };
  if (asset.index === 0 || asset.id === 'rand') return { text: 'R', hue: null };
  const symbol = String(asset.symbol || asset.id || '?');
  const text = (symbol.replace(/^RPL#/, '#')[0] || '?').toUpperCase();
  const key = String(asset.id ?? asset.symbol ?? asset.index ?? '');
  return { text, hue: hashString(key) % 360 };
}
