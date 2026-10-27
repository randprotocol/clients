// The native apps' prover sentences (wallet 0.8.2): where a phone cannot prove and no prover route
// is set, the way out names the RandProtocol provers (turn them on) and a prover of your own, in
// every language each app ships — never only "pair a prover" or the command-line wallet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const RES = join(ROOT, 'android/app/src/main/res');
const CATALOG = JSON.parse(readFileSync(join(ROOT, 'ios/RandWallet/Localizable.xcstrings'), 'utf8'));
const IOS_LANGS = readdirSync(join(ROOT, 'ios/l10n')).map((f) => f.replace(/\.json$/, ''));

/** `name`'s text in every `values*` directory that defines it: {dir: text}. */
export function androidString(name) {
  const out = {};
  for (const dir of readdirSync(RES).filter((d) => /^values(-|$)/.test(d))) {
    let xml;
    try { xml = readFileSync(join(RES, dir, 'strings.xml'), 'utf8'); } catch { continue; }
    const m = xml.match(new RegExp(`<string name="${name}">([\\s\\S]*?)</string>`));
    if (m) out[dir] = m[1];
  }
  return out;
}

/** The catalog entry `key` in every iOS language (en and the l10n set). */
export function iosString(key) {
  const entry = CATALOG.strings[key];
  assert.ok(entry, `Localizable.xcstrings has no key ${JSON.stringify(key)}`);
  const out = {};
  for (const lang of ['en', ...IOS_LANGS]) {
    const loc = entry.localizations && entry.localizations[lang];
    assert.ok(loc && loc.stringUnit && loc.stringUnit.value, `${key}: no ${lang}`);
    out[lang] = loc.stringUnit.value;
  }
  return out;
}

const NO_ROUTE = 'Turn the RandProtocol provers on in Settings › Prover, or pair your own prover.';

test('Android: the low-memory warning names the RandProtocol provers and your own prover, in every language', () => {
  const all = androidString('review_memory_warning');
  assert.ok(all.values.endsWith(NO_ROUTE), all.values);
  assert.equal(Object.keys(all).length, 20, `review_memory_warning in ${Object.keys(all).length} directories`);
  for (const [dir, text] of Object.entries(all)) {
    assert.match(text, /RandProtocol/, `${dir} does not name the RandProtocol provers`);
    assert.doesNotMatch(text, /\brand\b/, `${dir} still points at the command-line wallet`);
  }
});

test('iOS: the send review and the swap refusal name the RandProtocol provers and your own prover, in every language', () => {
  const keys = [
    `This proof needs about %@ GB of memory and this device has %@ GB. iOS will most likely stop the app before it finishes. ${NO_ROUTE}`,
    `This device does not have the memory for this proof, and no prover is set up. ${NO_ROUTE}`,
  ];
  for (const key of keys) {
    for (const [lang, text] of Object.entries(iosString(key))) assert.match(text, /RandProtocol/, `${lang}: ${key}`);
  }
  const swift = readFileSync(join(ROOT, 'ios/RandWallet/UI/SendView.swift'), 'utf8')
    + readFileSync(join(ROOT, 'ios/RandWallet/Services/WalletService.swift'), 'utf8');
  assert.doesNotMatch(swift, /Pair a prover in Settings › Prover/);
  assert.ok(swift.includes(NO_ROUTE));
});
