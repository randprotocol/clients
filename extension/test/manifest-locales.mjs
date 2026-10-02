// The manifest's strings (`_locales/<dir>/messages.json`, WebExtension i18n) checked against the
// manifest that uses them. Two callers: extension/test/locales.test.mjs, against the source tree
// (chrome/manifest.json, firefox/manifest.json, extension/shared/_locales/), and smoke.mjs,
// against each packed tree, where a missing directory is a store rejection rather than a 404.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ui/i18n.js code → `_locales/` directory. The browsers take the Chrome Web Store's locale codes,
 * with an underscore before a region, which is why four of these are not the wallet's own codes.
 * The same table, for translators, is extension/shared/_locales/README.md.
 */
export const LOCALE_DIRS = Object.freeze({
  en: 'en', ru: 'ru', zh: 'zh_CN', 'zh-hk': 'zh_HK', ko: 'ko', id: 'id', ms: 'ms', ja: 'ja',
  ar: 'ar', fa: 'fa', ur: 'ur', ps: 'ps', hi: 'hi', ta: 'ta', es: 'es', pt: 'pt_BR', de: 'de', fr: 'fr', it: 'it', pl: 'pl',
});

/** The stores' limits on two of the strings. */
const LIMITS = { appShortName: 12, appDescription: 132 };

/** Every `__MSG_name__` in a manifest, with where it sits: `[{path, name}]`. */
export function messageRefs(manifest) {
  const out = [];
  const walk = (v, path) => {
    if (typeof v === 'string') {
      const m = /^__MSG_(\w+)__$/.exec(v);
      if (m) out.push({ path, name: m[1] });
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    }
  };
  walk(manifest, '');
  return out;
}

function readMessages(dir, label) {
  const file = join(dir, 'messages.json');
  if (!existsSync(file)) throw new Error(`${label}: ${file} is missing`);
  let json;
  try { json = JSON.parse(readFileSync(file, 'utf8')); } catch (err) { throw new Error(`${label}: ${file} is not JSON: ${err.message}`); }
  for (const [key, entry] of Object.entries(json)) {
    if (!entry || typeof entry.message !== 'string' || entry.message.trim() === '') throw new Error(`${label}: "${key}" has no message`);
    if (LIMITS[key] && [...entry.message].length > LIMITS[key]) throw new Error(`${label}: "${key}" is over ${LIMITS[key]} characters`);
  }
  return json;
}

/**
 * Throws on the first thing a browser or a store would refuse; otherwise returns
 * `{ names, languages }` — the `__MSG_` names the manifest uses and the language directories found.
 *
 *   - `default_locale` is named, its directory exists and its messages.json parses;
 *   - every `__MSG_name__` in the manifest is a key of the default language with a message;
 *   - every directory under `_locales/` is one the wallet's language table knows, and its
 *     messages.json carries exactly the default language's keys (a translator's file is held to the
 *     English one as ui/locales/<code>.js is held to en.js).
 */
export function checkManifestLocales({ manifestPath, localesDir }) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const def = manifest.default_locale;
  if (typeof def !== 'string' || !def) throw new Error(`${manifestPath} names no default_locale`);
  if (!existsSync(localesDir)) throw new Error(`${localesDir} is missing`);
  const base = readMessages(join(localesDir, def), `default locale ${def}`);
  const baseKeys = Object.keys(base).sort();

  const names = messageRefs(manifest).map((r) => r.name);
  if (!names.length) throw new Error(`${manifestPath} uses no __MSG_ strings`);
  for (const { path, name } of messageRefs(manifest)) {
    if (!base[name]) throw new Error(`${manifestPath}: ${path} is __MSG_${name}__, which ${def}/messages.json does not define`);
  }

  const known = new Set(Object.values(LOCALE_DIRS));
  const languages = readdirSync(localesDir).filter((n) => statSync(join(localesDir, n)).isDirectory()).sort();
  for (const dir of languages) {
    if (!known.has(dir)) throw new Error(`_locales/${dir} is not a directory the language table knows (extension/shared/_locales/README.md)`);
    if (dir === def) continue;
    const dict = readMessages(join(localesDir, dir), `_locales/${dir}`);
    const keys = Object.keys(dict).sort();
    if (JSON.stringify(keys) !== JSON.stringify(baseKeys)) throw new Error(`_locales/${dir}/messages.json: keys differ from ${def}: have ${keys.join(', ')}; want ${baseKeys.join(', ')}`);
  }
  return { names, languages };
}
