// The manifest's strings: `_locales/en/messages.json` holds everything chrome/manifest.json and
// firefox/manifest.json say through `__MSG_…__`, and the language table the translators and the
// pack step work from (extension/shared/_locales/README.md) is the wallet's own list of languages
// (ui/i18n.js LOCALES), one directory each.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LOCALES } from '../../ui/i18n.js';
import { checkManifestLocales, LOCALE_DIRS, messageRefs } from './manifest-locales.mjs';

const ROOT = resolve(new URL('../../', import.meta.url).pathname);
const LOCALES_DIR = join(ROOT, 'extension', 'shared', '_locales');
const manifest = (browser) => JSON.parse(readFileSync(join(ROOT, browser, 'manifest.json'), 'utf8'));

for (const browser of ['chrome', 'firefox']) {
  test(`${browser}/manifest.json: every __MSG_ string resolves in _locales/en, and default_locale is en`, () => {
    const { names, languages } = checkManifestLocales({ manifestPath: join(ROOT, browser, 'manifest.json'), localesDir: LOCALES_DIR });
    assert.equal(manifest(browser).default_locale, 'en');
    assert.ok(languages.includes('en'));
    // The browser-shown strings: the name twice, the description and the toolbar button's tooltip;
    // Firefox's sidebar has a title of its own.
    const want = ['appName', 'appShortName', 'appDescription', 'actionTitle', ...(browser === 'firefox' ? ['sidebarTitle'] : [])].sort();
    assert.deepEqual([...new Set(names)].sort(), want);
  });
}

test('the user-visible manifest fields are all __MSG_ references, nothing left as English', () => {
  for (const browser of ['chrome', 'firefox']) {
    const m = manifest(browser);
    const where = Object.fromEntries(messageRefs(m).map((r) => [r.path, r.name]));
    assert.equal(where.name, 'appName', browser);
    assert.equal(where.short_name, 'appShortName', browser);
    assert.equal(where.description, 'appDescription', browser);
    assert.equal(where['action.default_title'], 'actionTitle', browser);
    if (m.sidebar_action) assert.equal(where['sidebar_action.default_title'], 'sidebarTitle', browser);
  }
});

test('en/messages.json: each key has a message and a note for the translator', () => {
  const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en', 'messages.json'), 'utf8'));
  for (const [key, entry] of Object.entries(en)) {
    assert.equal(typeof entry.message, 'string', key);
    assert.ok(entry.message.trim(), `${key} is empty`);
    assert.ok(typeof entry.description === 'string' && entry.description.length > 20, `${key} has no description for the translator`);
  }
  assert.equal(en.appName.message, 'Rand Wallet');
  assert.ok(en.appShortName.message.length <= 12);
  assert.ok(en.appDescription.message.length <= 132);
});

test('the language table is ui/i18n.js LOCALES, one _locales directory each, and the README agrees', () => {
  const codes = LOCALES.map((l) => l.code);
  assert.deepEqual(Object.keys(LOCALE_DIRS), codes, 'LOCALE_DIRS is not the sixteen codes in their order');
  const dirs = Object.values(LOCALE_DIRS);
  assert.equal(new Set(dirs).size, dirs.length, 'two codes share a directory');
  for (const dir of dirs) assert.match(dir, /^[a-z]{2}(_[A-Z]{2})?$/, `${dir} is not a store locale code`);
  // The four that are not the wallet's own spelling.
  assert.equal(LOCALE_DIRS.zh, 'zh_CN');
  assert.equal(LOCALE_DIRS['zh-hk'], 'zh_HK');
  assert.equal(LOCALE_DIRS.pt, 'pt_BR');
  assert.equal(LOCALE_DIRS.en, 'en');
  // The README's table rows: | `code` | `dir` | … |
  const readme = readFileSync(join(LOCALES_DIR, 'README.md'), 'utf8');
  const rows = [...readme.matchAll(/^\| `([a-z-]+)` \| `([a-zA-Z_]+)` \|/gm)].map((m) => [m[1], m[2]]);
  assert.deepEqual(Object.fromEntries(rows), { ...LOCALE_DIRS }, 'the README table and LOCALE_DIRS differ');
});
