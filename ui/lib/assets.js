// Pure data helpers for the home, asset, activity, send and withdraw screens. Importable under
// plain Node (no `document`/`window` access at module scope, same rule as every other ui/lib file).

/** The RAND (index 0) balance, as a decimal units string. RPL assets (index >= 1) have no price
 *  feed and are never summed into this — it is the RAND figure alone, never a portfolio total. */
export function totalInRand(assets) {
  const rand = (assets || []).find((a) => a.index === 0);
  return rand ? String(rand.balance ?? '0') : '0';
}

// ------------------------------------------------------------ what a screen may offer ---------

/**
 * The one sentence for an asset this wallet holds notes of that the node's registry does not list
 * (`unlisted: true`, ui/backend.js). Its `symbol` is the wallet's own `RPL#<index>` and — the part
 * that matters — its **`decimals` is a guess**, so every amount the user typed about it would be
 * scaled by a number the chain never said. Sending it and withdrawing it are therefore both off;
 * the balance is still real and still shown.
 *
 * Owned here rather than by a screen because four places say it: the asset detail, the send
 * picker, the send flow's end of the road and the withdraw flow's first step.
 */
export const UNLISTED_TEXT = 'This node’s token registry does not list this asset, so its name '
  + 'and decimal places are this wallet’s guess rather than the chain’s. It cannot be sent or '
  + 'withdrawn until a node lists it.';

/** The RAND row of an `assets.list()` answer — always index 0, and always first (ui/backend.js). */
export function nativeAsset(assets) {
  return (assets || []).find((a) => a && a.index === 0) || null;
}

/**
 * The decimals the **network fee** is shown in.
 *
 * A fee is always RAND, whatever is being transferred or burned — chain 14's bundle pays it out of
 * slots 2–3 while the private asset moves in slots 0–1 — so it is always asset 0's own `decimals`,
 * read from the row the backend returned. Writing `9` here (which the review steps used to do)
 * is the one place in either flow where a number about money came from this file rather than from
 * the chain, and a chain whose native token had any other precision would print every fee wrong.
 *
 * The fallback is reached only by a backend that broke its own contract by omitting RAND, and 9 is
 * then this chain's own figure rather than a guess about somebody else's.
 */
export function feeDecimals(assets) {
  const rand = nativeAsset(assets);
  const d = Number(rand && rand.decimals);
  return Number.isInteger(d) && d >= 0 && d <= 9 ? d : 9;
}

/** The fee's symbol, from the same row and for the same reason. */
export function feeSymbol(assets) {
  const rand = nativeAsset(assets);
  return (rand && rand.symbol) || 'RAND';
}

/** True for a held asset the node's registry does not list — see `UNLISTED_TEXT`. */
export function isUnlisted(asset) {
  return !!(asset && asset.unlisted);
}

/**
 * The coins on other chains that hold this token's value, filtered to the ones a burn could
 * actually name (`Action::BridgeBurn` carries a `(to_chain, token)` pair). A **native** RPL token
 * has none at all: nothing off-chain is backing it, so there is nowhere to withdraw it to.
 */
export function backingsOf(asset) {
  const rows = Array.isArray(asset && asset.backings) ? asset.backings : [];
  return rows.filter((b) => b && Number.isInteger(Number(b.chain)) && typeof b.token === 'string' && b.token);
}

/** Every asset can be transferred on chain 14 — except one whose decimals are a guess. */
export function canSendAsset(asset) {
  return !!asset && !isUnlisted(asset);
}

/**
 * Whether **this asset** has anywhere to be withdrawn to: an RPL token the registry lists, with at
 * least one backing coin. Whether **this device** can carry one out is a different question and is
 * `bridge.canWithdraw()`'s alone; a screen needs both.
 */
export function canWithdrawAsset(asset) {
  return !!asset && Number(asset.index) >= 1 && !isUnlisted(asset) && backingsOf(asset).length > 0;
}

const DAY_MS = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A day bucket is keyed by the start of the *viewer's* calendar day. Shifting the timestamp by the
// zone offset and then reading it with the UTC getters gives the local calendar fields without
// ever consulting the host zone again — which is what keeps this function pure and testable at a
// zone the test machine is not in.
function startOfLocalDay(ms, tzOffsetMinutes) {
  const d = new Date(ms - tzOffsetMinutes * 60000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function formatDay(shiftedDayStartMs) {
  const d = new Date(shiftedDayStartMs);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Buckets `activity` into day groups, newest first: `[{label, items}]`, where `label` is
 * `'Today'`, `'Yesterday'` or `'D Mon YYYY'`. Each item's `.time` is a unix timestamp in
 * *seconds* (the chain's convention); `now` is milliseconds (`Date.now()`), like everywhere else
 * in ui/.
 *
 * Days are the *viewer's* calendar days: at UTC−7 an evening transaction belongs to that evening,
 * not to the next UTC day. `tzOffsetMinutes` is `Date.prototype.getTimezoneOffset()`'s sign
 * (minutes to ADD to local time to get UTC, so UTC−7 is `420`); it defaults to the host zone and
 * is a parameter only so tests can pin a zone the machine is not in.
 */
export function groupByDay(activity, now = Date.now(), tzOffsetMinutes = new Date().getTimezoneOffset()) {
  const today = startOfLocalDay(now, tzOffsetMinutes);
  const buckets = new Map(); // day-start-ms (shifted) -> items[]
  for (const item of activity || []) {
    const dayStart = startOfLocalDay(item.time * 1000, tzOffsetMinutes);
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
