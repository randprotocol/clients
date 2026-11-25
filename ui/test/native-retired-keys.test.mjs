// Retired prover keys (VK-9, randprotocol/monorepo#18) in the native apps. The engine's list
// (`RETIRED_PROVER_KEYS`, ui/engine/backend-shared.js) is the one the Android and iOS wallets must
// carry, entry for entry — each keeps a copy, compiled in, because neither loads the engine. A key
// added to one and not the others is a wallet that still pairs with a retired key: this fails.
// The refusal is the engine's sentence, in every language each app ships, and each native twin
// holds a key to the list at the engine's points (a link, a probe, a stored pairing, a job, a
// pinned pool member). The apps' own suites (ProverTest / RetiredProverKeysTest on the JVM,
// ProverTests under XCTest) exercise those points; this one runs wherever the UI's tests do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RETIRED_PROVER_KEYS } from '../engine/backend-shared.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const JAVA_DIR = 'android/app/src/main/java/org/randprotocol/wallet/wallet';
const JAVA_LIST = `${JAVA_DIR}/RetiredProverKeys.java`;
const SWIFT_LIST = 'ios/RandWallet/Services/ProverPairingService.swift';
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * A native list's entries: every line of exactly the shape `"FINGERPRINT", // retired YYYY-MM-DD`
 * (the one shape `no-shared-prover-key.test.mjs` lets name a retired key in a shipped source).
 */
export const NATIVE_ENTRY = /^\s*"([A-Z0-9]{4}(?:-[A-Z0-9]{4}){3})", \/\/ retired (\d{4}-\d{2}-\d{2})$/;
function nativeList(rel) {
  return read(rel).split('\n').map((l) => l.match(NATIVE_ENTRY)).filter(Boolean)
    .map((m) => ({ fingerprint: m[1], retiredOn: m[2] }));
}
const engineList = () => RETIRED_PROVER_KEYS.map((k) => ({ fingerprint: k.fingerprint, retiredOn: k.retiredOn }));

test('Android carries the engine\'s retired prover keys, entry for entry', () => {
  assert.ok(RETIRED_PROVER_KEYS.length >= 5);
  assert.deepEqual(nativeList(JAVA_LIST), engineList(), `${JAVA_LIST} and RETIRED_PROVER_KEYS differ`);
});

test('iOS carries the engine\'s retired prover keys, entry for entry', () => {
  assert.deepEqual(nativeList(SWIFT_LIST), engineList(), `${SWIFT_LIST} and RETIRED_PROVER_KEYS differ`);
});

test('no other native source names a retired key: each app has one list', () => {
  const others = [
    ...readdirSync(join(ROOT, JAVA_DIR)).filter((f) => f.endsWith('.java')).map((f) => `${JAVA_DIR}/${f}`),
    ...readdirSync(join(ROOT, 'ios/RandWallet/Services')).filter((f) => f.endsWith('.swift')).map((f) => `ios/RandWallet/Services/${f}`),
  ].filter((f) => f !== JAVA_LIST && f !== SWIFT_LIST);
  assert.ok(others.length > 10);
  for (const f of others) {
    const text = read(f);
    for (const k of RETIRED_PROVER_KEYS) assert.equal(text.includes(k.fingerprint), false, `${f} names the retired key ${k.fingerprint}`);
  }
});

// ---------------------------------------------------------------- the sentence

const SENTENCE = 'This prover\'s key was retired and is no longer used. Pair another prover in Settings, or update Rand Wallet to the latest version.';
/** ui/locales code → the Android resource directory and the iOS catalog language. */
const LANGS = {
  en: ['values', 'en'], ru: ['values-ru', 'ru'], zh: ['values-zh-rCN', 'zh-Hans'], 'zh-hk': ['values-zh-rHK', 'zh-Hant-HK'],
  ko: ['values-ko', 'ko'], id: ['values-in', 'id'], ms: ['values-ms', 'ms'], ja: ['values-ja', 'ja'], ar: ['values-ar', 'ar'],
  fa: ['values-fa', 'fa'], ur: ['values-ur', 'ur'], ps: ['values-ps', 'ps'], hi: ['values-hi', 'hi'], ta: ['values-ta', 'ta'],
  es: ['values-es', 'es'], pt: ['values-pt-rBR', 'pt-BR'], de: ['values-de', 'de'], fr: ['values-fr', 'fr'], it: ['values-it', 'it'],
  pl: ['values-pl', 'pl'],
};

test('the refusal is the engine\'s sentence on Android and iOS, in every language', async () => {
  // The engine says it, and the two native twins say the same English.
  assert.ok(read('ui/engine/backend-shared.js').includes(`t('${SENTENCE.replace(/'/g, '\\\'')}')`), 'the engine\'s sentence moved');
  const javaLiteral = read(JAVA_LIST).match(/static final String KEY_RETIRED = ((?:"[^"]*"\s*\+?\s*)+);/);
  assert.ok(javaLiteral, 'RetiredProverKeys.KEY_RETIRED');
  assert.equal([...javaLiteral[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]).join(''), SENTENCE);
  assert.ok(read(SWIFT_LIST).includes(`String(localized: "${SENTENCE}")`), 'the Swift sentence differs');

  const catalog = JSON.parse(read('ios/RandWallet/Localizable.xcstrings')).strings[SENTENCE];
  assert.ok(catalog, 'Localizable.xcstrings has no entry for the sentence');
  const locales = readdirSync(join(ROOT, 'ui/locales')).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, ''));
  assert.deepEqual(locales.slice().sort(), Object.keys(LANGS).sort(), 'a UI language has no native folder in this test');
  for (const code of locales) {
    const web = (await import(join(ROOT, 'ui/locales', `${code}.js`))).default[SENTENCE];
    assert.ok(typeof web === 'string' && web, `ui/locales/${code}.js`);
    const [dir, lang] = LANGS[code];
    const xml = read(`android/app/src/main/res/${dir}/strings.xml`).match(/<string name="prover_key_retired">([\s\S]*?)<\/string>/);
    assert.ok(xml, `${dir}/strings.xml has no prover_key_retired`);
    assert.equal(xml[1].replace(/\\(['"])/g, '$1'), web, `${dir}: not the wallet's sentence in ${code}`);
    const unit = catalog.localizations[lang] && catalog.localizations[lang].stringUnit;
    assert.ok(unit && unit.state === 'translated', `Localizable.xcstrings: no ${lang}`);
    assert.equal(unit.value, web, `iOS ${lang}: not the wallet's sentence in ${code}`);
    if (lang !== 'en') {
      assert.equal(JSON.parse(read(`ios/l10n/${lang}.json`)).Localizable[SENTENCE], web, `ios/l10n/${lang}.json`);
    }
  }
});

// ---------------------------------------------------------------- the points that hold a key to the list

/** The body of the Java method / Swift func whose declaration `signature` matches, to its closing brace at the declaration's indent. */
function body(text, signature) {
  const start = text.search(signature);
  assert.ok(start >= 0, `no ${signature}`);
  const lineStart = text.lastIndexOf('\n', start) + 1;
  const indent = text.slice(lineStart).match(/^\s*/)[0];
  const end = text.indexOf(`\n${indent}}\n`, start);
  assert.ok(end > start, `no end of ${signature}`);
  return text.slice(start, end);
}

test('Android holds a key to the list where the engine does: a link, a probe, a stored pairing, a job, a pool member', () => {
  const pairing = read(`${JAVA_DIR}/ProverPairing.java`);
  const send = read(`${JAVA_DIR}/RemoteSend.java`);
  const points = {
    'pairing a link': body(pairing, /private static Paired pairParsed\(/),
    'the probe': body(pairing, /public static Probe probe\(/),
    'the pool\'s members': body(pairing, /public static java\.util\.List<Paired> builtInPool\(/),
    'the route of a stored pairing': body(send, /public static Route route\(boolean deviceCanProve, ProverPairing display, ProverCore core,\s*java\.util\.function\.Function<ProverPairing, ProverPairing\.Probe> probe,\s*java\.util\.function\.Supplier<ProverSecret> secret, DefaultProver defaultProver\)/),
    'the job': body(send, /public static JSONObject prove\(ProverCore core, RemoteProver prover, String kind,/),
  };
  for (const [what, code] of Object.entries(points)) {
    const at = code.indexOf('RetiredProverKeys.isRetired(');
    assert.ok(at >= 0, `Android: ${what} does not check the retired list`);
    // Before anything is asked of the prover or built for it.
    for (const later of ['.info()', 'probe.apply(', 'guestsOf(', 'checkUrl(']) {
      const use = code.indexOf(later);
      if (use >= 0) assert.ok(at < use, `Android: ${what} checks the retired list after ${later}`);
    }
  }
});

test('iOS holds a key to the list where the engine does: a link, a probe, a stored pairing, a job, a pool member', () => {
  const swift = read(SWIFT_LIST);
  const points = {
    'pairing a link': body(swift, /static func pair\(/),
    'the probe': body(swift, /static func probe\(/),
    'the pool\'s members': body(swift, /static func builtInPool\(/),
    'the route of a stored pairing': body(swift, /static func route\(/),
    'the job': body(swift, /static func checkJob\(/),
  };
  for (const [what, code] of Object.entries(points)) {
    const at = code.indexOf('RetiredProverKeys.isRetired(');
    assert.ok(at >= 0, `iOS: ${what} does not check the retired list`);
    for (const later of ['.info()', 'await probe(', 'await info()', 'RandCore.chainGuests(', 'checkedURL(']) {
      const use = code.indexOf(later);
      if (use >= 0) assert.ok(at < use, `iOS: ${what} checks the retired list after ${later}`);
    }
  }
});
