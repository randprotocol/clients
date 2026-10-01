// The wallet's languages. English is the source: every string a screen shows is written in
// English at the call site, wrapped in `t()`, and a language's dictionary (ui/locales/<code>.js)
// maps that English string to its translation. A string the dictionary lacks shows in English
// rather than breaking anything, and `ui/scripts/extract-strings.mjs` regenerates
// ui/locales/en.js from the call sites so the dictionaries can be held to the full key set
// (ui/test/i18n.test.mjs).
//
// Importable under plain Node (no `document` at import time), so the dictionaries and the
// formatters can be unit tested directly. Nothing here reaches the DOM: app.js sets `<html lang
// dir>` from `localeInfo()` and re-renders when the language changes.

/**
 * `code` is the setting's value and the dictionary's file name; `tag` is the BCP 47 tag for
 * `<html lang>`, `Intl` and `toLocaleString`; `name` is the language's own name, which is how the
 * picker lists it (a reader who cannot read the current language can still find their own).
 * The same sixteen as randprotocol.org, in the same order.
 */
export const LOCALES = Object.freeze([
  { code: 'en', tag: 'en', name: 'English', dir: 'ltr' },
  { code: 'ru', tag: 'ru', name: 'Русский', dir: 'ltr' },
  { code: 'zh', tag: 'zh-Hans', name: '中文（简体）', dir: 'ltr' },
  { code: 'zh-hk', tag: 'zh-Hant-HK', name: '中文（繁體）', dir: 'ltr' },
  { code: 'ko', tag: 'ko', name: '한국어', dir: 'ltr' },
  { code: 'id', tag: 'id', name: 'Bahasa Indonesia', dir: 'ltr' },
  { code: 'ms', tag: 'ms', name: 'Bahasa Melayu', dir: 'ltr' },
  { code: 'ja', tag: 'ja', name: '日本語', dir: 'ltr' },
  { code: 'ar', tag: 'ar', name: 'العربية', dir: 'rtl' },
  { code: 'fa', tag: 'fa', name: 'فارسی', dir: 'rtl' },
  { code: 'es', tag: 'es', name: 'Español', dir: 'ltr' },
  { code: 'pt', tag: 'pt', name: 'Português', dir: 'ltr' },
  { code: 'de', tag: 'de', name: 'Deutsch', dir: 'ltr' },
  { code: 'fr', tag: 'fr', name: 'Français', dir: 'ltr' },
  { code: 'it', tag: 'it', name: 'Italiano', dir: 'ltr' },
  { code: 'pl', tag: 'pl', name: 'Polski', dir: 'ltr' },
].map(Object.freeze));

export const DEFAULT_LOCALE = 'en';
/** The setting's value for "follow the device": the language is chosen from `navigator.languages`. */
export const AUTO_LOCALE = 'auto';

const BY_CODE = new Map(LOCALES.map((l) => [l.code, l]));

export const isLocale = (code) => typeof code === 'string' && BY_CODE.has(code);

/** The entry for a code; English for anything unknown. */
export const localeInfo = (code) => BY_CODE.get(code) || BY_CODE.get(DEFAULT_LOCALE);

/**
 * The language to show for a setting (`'auto'`, a code, or nothing) given the device's preferred
 * languages (`navigator.languages`, most preferred first). A device language is matched by its
 * whole tag first (zh-HK, zh-TW and zh-MO are the traditional-script page; any other zh is
 * simplified), then by its primary subtag (`pt-BR` is `pt`). Nothing matched is English.
 */
export function resolveLocale(setting, deviceLanguages = []) {
  if (isLocale(setting)) return setting;
  for (const raw of deviceLanguages || []) {
    const tag = String(raw || '').toLowerCase();
    if (!tag) continue;
    if (/^zh(-hant)?-(hk|tw|mo)\b/.test(tag) || /^zh-hant\b/.test(tag)) return 'zh-hk';
    if (/^(yue)\b/.test(tag)) return 'zh-hk';
    const primary = tag.split('-')[0];
    if (isLocale(primary)) return primary;
  }
  return DEFAULT_LOCALE;
}

// ---- the dictionary in force ----
let current = DEFAULT_LOCALE;
let dictionary = null; // null for English: every key is its own translation
let pluralRules = null;
const listeners = new Set();
// Dictionaries supplied by a caller rather than loaded from ./locales/: a test's pseudo-language,
// or a shell that bundles them its own way. Consulted before any import.
const registered = new Map();

/** Supplies the dictionary for a code; `null` forgets a registration. */
export function registerDictionary(code, dict) {
  if (dict) registered.set(code, dict); else registered.delete(code);
}

/** The code of the language in force. */
export const currentLocale = () => current;

/**
 * Loads a language's dictionary and makes it the one `t()` reads. `options.dictionary` supplies
 * the dictionary directly (a test's pseudo-locale); otherwise it is `import()`ed from
 * ./locales/<code>.js, which every shell ships beside this file. English needs no file. A
 * dictionary that fails to load leaves the wallet in English and reports the failure to the
 * caller rather than to the user: the wallet must come up whatever happens to one language.
 */
export async function setLocale(code, options = {}) {
  const next = isLocale(code) ? code : DEFAULT_LOCALE;
  let dict = null;
  if (options.dictionary) {
    dict = options.dictionary;
  } else if (registered.has(next)) {
    dict = registered.get(next);
  } else if (next !== DEFAULT_LOCALE) {
    const mod = await import(`./locales/${next}.js`);
    dict = mod.default || mod.dictionary || null;
  }
  current = next;
  dictionary = dict;
  const { tag } = localeInfo(next);
  pluralRules = typeof Intl !== 'undefined' && Intl.PluralRules ? new Intl.PluralRules(tag) : null;
  for (const fn of [...listeners]) {
    try { fn(next); } catch (err) { console.error('rand-wallet: locale listener failed', err); }
  }
  return next;
}

/** Called with the new code after every `setLocale`; returns the unsubscribe. */
export function onLocaleChange(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Fills `{name}` holes from `vars`; a hole with no value is left as it is. */
export function fill(s, vars) {
  if (!vars) return s;
  return String(s).replace(/\{(\w+)\}/g, (hole, name) => (name in vars ? String(vars[name]) : hole));
}

/**
 * The translation of an English string, with its `{name}` holes filled from `vars`.
 *
 * The English string IS the key: `t('Send')`, `t('{n} min ago', { n })`. It must be a string
 * literal at the call site (the extractor reads the literals; a computed key is invisible to it
 * and to the translators). A dictionary entry is normally a string; where a language inflects by
 * number it may be an object of CLDR plural categories (`{one, few, many, other, …}`), and the
 * category is chosen by `vars.n` (or `vars.count`) under the language's own rules — so an English
 * "{n} proofs" can become Russian "{n} доказательства" for 2 and "{n} доказательств" for 5.
 */
export function t(s, vars) {
  const key = String(s);
  let out = key;
  if (dictionary) {
    const entry = dictionary[key];
    if (typeof entry === 'string' && entry !== '') out = entry;
    else if (entry && typeof entry === 'object') out = pickPlural(entry, vars) ?? key;
  }
  return fill(out, vars);
}

function pickPlural(entry, vars) {
  const n = vars && (typeof vars.n === 'number' ? vars.n : typeof vars.count === 'number' ? vars.count : null);
  if (n !== null && pluralRules) {
    const cat = pluralRules.select(n);
    if (typeof entry[cat] === 'string' && entry[cat] !== '') return entry[cat];
  }
  if (typeof entry.other === 'string' && entry.other !== '') return entry.other;
  const any = Object.values(entry).find((v) => typeof v === 'string' && v !== '');
  return any ?? null;
}

// ---- formatters that follow the language ----
// Amounts never do: a balance is written with ASCII digits, `.` for the decimal point and `,`
// grouping in every language (ui/lib/format.js), so what the wallet shows can be pasted back
// into any amount field or into a command line unchanged.

/** A whole number with the language's grouping. */
export function formatInteger(n) {
  const v = typeof n === 'bigint' ? n : Number(n);
  try { return v.toLocaleString(localeInfo(current).tag); } catch { return String(v); }
}

/** A calendar day, as the language writes it: "2 Oct 2026", "2026年10月2日", "٢ أكتوبر ٢٠٢٦". */
export function formatDay(date) {
  const d = date instanceof Date ? date : new Date(date);
  // English is written by hand: the form the wallet has always shown, which Intl's en-GB spells
  // "Sept" and en-US reorders. Every other language is Intl's.
  if (current === DEFAULT_LOCALE) return `${d.getUTCDate()} ${MONTHS_EN[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  try {
    return new Intl.DateTimeFormat(localeInfo(current).tag, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
