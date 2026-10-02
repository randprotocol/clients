// node --test ui/test/
//
// Two things, both about the whole wallet rather than one screen:
//
//  1. The dictionaries. Every language in ui/i18n.js has a file under ui/locales/ with exactly the
//     keys of ui/locales/en.js, which is itself exactly what the `t()` call sites say (the
//     extractor is run here, so a wrapped string that was never added to en.js fails here, not in
//     a translator's hands). Each translation keeps the `{holes}` of its key and the glossary
//     words, and a plural object has an `other` form.
//
//  2. Completeness. A pseudo-language whose dictionary wraps every English key in ⟦ ⟧ is loaded,
//     every screen is mounted, and any visible text (text nodes, labels, placeholders, titles)
//     with a run of letters outside the marks is a string the wallet shows in English whatever
//     the language — a `t()` that was missed. `I18N_SCREENS=home,send` narrows the walk while
//     working on one group.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import './dom-env.mjs';
import { fakeBackend, unlockedBackend } from './fake-backend.mjs';
import { mountApp } from './helpers.mjs';
import { LOCALES, DEFAULT_LOCALE, setLocale, registerDictionary, t, resolveLocale, currentLocale } from '../i18n.js';
import { extractAll, render } from '../scripts/extract-strings.mjs';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..');

const { keys: extracted, bad } = extractAll(UI);
const EN_KEYS = [...extracted.keys()].sort((a, b) => a.localeCompare(b, 'en'));

test('every t() call site has a string literal for its key', () => {
  assert.deepEqual(bad, [], 'a computed key is invisible to the translators');
});

test('ui/locales/en.js is exactly what the call sites say', () => {
  const have = readFileSync(join(UI, 'locales', 'en.js'), 'utf8');
  assert.equal(have, render(extracted), 'run: node ui/scripts/extract-strings.mjs');
});

// Words a translation keeps as they are. A translation that drops one of these has changed what
// the sentence says (an asset, a product, a standard), not how it says it.
const GLOSSARY = ['RAND', 'zUSD', 'RPL', 'Rand', 'USDT', 'USDC', 'STARK', 'randscan'];
const holes = (s) => (String(s).match(/\{\w+\}/g) || []).sort();
const PLURAL_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

for (const { code, tag } of LOCALES) {
  if (code === DEFAULT_LOCALE) continue;
  test(`dictionary ${code}: the keys of en.js, each translated`, async () => {
    const file = join(UI, 'locales', `${code}.js`);
    assert.ok(existsSync(file), `ui/locales/${code}.js is missing`);
    const dict = (await import(file)).default;
    assert.deepEqual(Object.keys(dict).sort((a, b) => a.localeCompare(b, 'en')), EN_KEYS, `${code}: keys differ from en.js`);
    const rules = new Intl.PluralRules(tag);
    const needed = new Set(rules.resolvedOptions().pluralCategories);
    for (const key of EN_KEYS) {
      const v = dict[key];
      if (typeof v === 'string') {
        assert.notEqual(v.trim(), '', `${code}: "${key}" is empty`);
        assert.deepEqual(holes(v), holes(key), `${code}: "${key}" lost or gained a {hole}`);
        for (const g of GLOSSARY) {
          if (new RegExp(`\\b${g}\\b`).test(key)) assert.ok(v.includes(g), `${code}: "${key}" dropped ${g}`);
        }
      } else {
        assert.ok(v && typeof v === 'object', `${code}: "${key}" is neither a string nor a plural object`);
        assert.match(key, /\{(n|count)\}/, `${code}: "${key}" has plural forms but no {n}`);
        for (const [cat, form] of Object.entries(v)) {
          assert.ok(PLURAL_CATEGORIES.has(cat), `${code}: "${key}" has an unknown plural category ${cat}`);
          assert.equal(typeof form, 'string');
          assert.deepEqual(holes(form), holes(key), `${code}: "${key}" [${cat}] lost or gained a {hole}`);
        }
        for (const cat of needed) assert.ok(typeof v[cat] === 'string' && v[cat] !== '', `${code}: "${key}" lacks the ${cat} form`);
      }
    }
  });
}

test('resolveLocale: the setting wins, else the device language, else English', () => {
  assert.equal(resolveLocale('ru', ['ja']), 'ru');
  assert.equal(resolveLocale('auto', ['pt-BR', 'en']), 'pt');
  assert.equal(resolveLocale(undefined, ['zh-TW']), 'zh-hk');
  assert.equal(resolveLocale('auto', ['zh-Hant']), 'zh-hk');
  assert.equal(resolveLocale('auto', ['zh-CN']), 'zh');
  assert.equal(resolveLocale('auto', ['nl', 'de-AT']), 'de');
  assert.equal(resolveLocale('auto', []), 'en');
  assert.equal(resolveLocale('xx', ['xx']), 'en');
});

test('t(): fills holes, picks a plural form by the language, falls back to English', async () => {
  await setLocale('ru', { dictionary: {
    'Home': 'Главная',
    '{n} proofs': { one: '{n} доказательство', few: '{n} доказательства', many: '{n} доказательств', other: '{n} доказательства' },
  } });
  try {
    assert.equal(t('Home'), 'Главная');
    assert.equal(t('{n} proofs', { n: 1 }), '1 доказательство');
    assert.equal(t('{n} proofs', { n: 3 }), '3 доказательства');
    assert.equal(t('{n} proofs', { n: 5 }), '5 доказательств');
    assert.equal(t('Not in the dictionary {x}', { x: 1 }), 'Not in the dictionary 1');
    assert.equal(currentLocale(), 'ru');
  } finally {
    await setLocale('en');
  }
});

// ---- completeness: the pseudo-language walk ----

const MARK_L = '⟦'; // ⟦
const MARK_R = '⟧'; // ⟧
const pseudo = Object.fromEntries(EN_KEYS.map((k) => [k, `${MARK_L}${k}${MARK_R}`]));

// Tokens that may appear outside the marks: symbols, product names, units, and what a fake wallet
// renders from its data (addresses, hashes, hosts). Anything else with two letters in a row is
// English that never went through `t()`.
const ALLOWED = new Set([
  'RAND', 'zUSD', 'RPL', 'Rand', 'Wallet', 'USDT', 'USDC', 'QR', 'RPC', 'URL', 'ID', 'OK', 'BFT', 'JSON',
  'rand', 'min', 'ms', 'KB', 'MB', 'GB', 'px', 'ETH', 'BSC', 'TRON', 'SOL', 'Solana', 'Tron', 'Ethereum',
  'Binance', 'Smart', 'Chain', 'fake', 'dev', 'WIPE', 'randscan', 'Durian', 'Tauri', 'Chrome', 'Firefox',
  // The fake backend's own data (ui/test/fake-backend.mjs): asset names, a prover host, a version.
  'Wrapped', 'Ether', 'wETH', 'Durian', 'Token', 'prover', 'example', 'org', 'com', 'https', 'http', 'localhost',
  // The receive screen's data: the `randpay:` link's scheme, and the fake wallet's address
  // fingerprint (fakeFingerprint of the fake address, Crockford digits split into "DPE5-S6JD-…").
  'randpay', 'DPE', 'JD', 'DEEX',
]);

const SCREENS = [
  // [hash, backend factory]
  ['welcome', () => fakeBackend()],
  ['create', () => fakeBackend()],
  ['import', () => fakeBackend()],
  ['lock', () => fakeBackend({ exists: true })],
  ['home', () => unlockedBackend()],
  ['activity', () => unlockedBackend()],
  ['explore', () => unlockedBackend()],
  ['settings', () => unlockedBackend()],
  ['send', () => unlockedBackend()],
  ['receive', () => unlockedBackend()],
  ['withdraw', () => unlockedBackend()],
  ['swap', () => unlockedBackend()],
  ['contacts', () => unlockedBackend()],
  ['faucet', () => unlockedBackend()],
  ['backup', () => unlockedBackend()],
  ['asset/0', () => unlockedBackend()],
];
const only = (process.env.I18N_SCREENS || '').split(',').map((s) => s.trim()).filter(Boolean);

/** Every visible run of text outside the marks, with where it was found. */
function unmarked(root) {
  const out = [];
  const consider = (text, where) => {
    const rest = String(text)
      .replace(new RegExp(`${MARK_L}[^${MARK_R}]*${MARK_R}`, 'g'), ' ')
      // Addresses, hashes, keys and URLs are data, not sentences.
      .replace(/rand1[\w…]*/g, ' ').replace(/0x[0-9a-fA-F…]+/g, ' ').replace(/\b[0-9a-f]{16,}\b/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ');
    const words = rest.match(/[A-Za-z][A-Za-z'’]+/g) || [];
    const leaks = words.filter((w) => !ALLOWED.has(w) && !/^rand1/.test(w) && !/^0x/.test(w));
    if (leaks.length) out.push(`${where}: "${rest.trim().slice(0, 80)}"`);
  };
  const walk = (node) => {
    if (node.nodeType === 3) { consider(node.nodeValue, `text in <${node.parentNode?.localName}>`); return; }
    if (node.nodeType !== 1) return;
    if (node.localName === 'script' || node.localName === 'style') return;
    for (const attr of ['aria-label', 'placeholder', 'title', 'alt', 'aria-description']) {
      const v = node.getAttribute && node.getAttribute(attr);
      if (v) consider(v, `${attr} on <${node.localName}>`);
    }
    if (node.localName === 'input' && /^(submit|button)$/.test(node.getAttribute('type') || '') && node.getAttribute('value')) {
      consider(node.getAttribute('value'), 'value on <input>');
    }
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return out;
}

for (const [hash, make] of SCREENS) {
  if (only.length && !only.includes(hash.split('/')[0])) continue;
  test(`every visible string on #${hash} goes through t()`, async (tctx) => {
    // The pseudo-language is registered under a real code and chosen through the setting, the
    // way a user's choice is: mount() reads the setting and loads the dictionary itself.
    registerDictionary('de', pseudo);
    tctx.after(async () => { registerDictionary('de', null); await setLocale('en'); });
    const backend = make();
    await backend.settings.set({ locale: 'de' });
    const { app, root } = await mountApp(tctx, backend, { hash });
    await app.idle();
    const leaks = unmarked(root);
    assert.deepEqual(leaks, [], `#${hash}: text shown in English whatever the language:\n  ${leaks.join('\n  ')}`);
  });
}
