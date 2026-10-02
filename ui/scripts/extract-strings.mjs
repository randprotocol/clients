#!/usr/bin/env node
// Regenerates ui/locales/en.js — the complete list of English strings the wallet can show — from
// the `t('…')` call sites in the shipped ui/ code, so a translator has one file to work from and
// ui/test/i18n.test.mjs can hold every language's dictionary to the same key set.
//
//   node ui/scripts/extract-strings.mjs            # rewrites ui/locales/en.js
//   node ui/scripts/extract-strings.mjs --check    # exits 1 if en.js is stale
//
// Only string literals are read: `t('Send')`, `t("…")`, and literals joined with `+` across lines
// (`t('a long ' + 'sentence')`). A `t()` whose first argument is anything else is reported and
// refused, because a key the extractor cannot see is a key no translator will ever see.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(UI, '..');
const OUT = join(UI, 'locales', 'en.js');
/**
 * Where `t()` is called from: ui/ (the engine and every screen) first, then the browser
 * extension's own windows (extension/shared/: connect.js and invoke.js build their DOM without
 * app.js, and lib/ holds the text their logic shows). en.js carries both, so one dictionary per
 * language serves every shell. A shell that calls `t()` from anywhere else is invisible to the
 * translators until it is listed here.
 */
export const ROOTS = Object.freeze([UI, join(REPO, 'extension', 'shared')]);
// Under ui/: the tests, npm, this tooling, the dictionaries and the fonts. Under extension/shared/:
// the manifest's own strings (_locales/, WebExtension i18n), the wasm core and the icons.
const SKIP_DIRS = new Set(['test', 'node_modules', 'scripts', 'locales', 'fonts', '_locales', 'core', 'icons']);
const SKIP_FILES = /^(gallery|dev)\./;
// The helper's own file defines `t(` and talks about it; nothing in it is a string to show.
const SKIP_PATHS = new Set(['i18n.js']);

/** Every shipped .js file under ui/, the same set the shells copy. */
export function sourceFiles(root = UI) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(name)) walk(p); continue; }
      if (name.endsWith('.js') && !SKIP_FILES.test(name) && !SKIP_PATHS.has(relative(root, p))) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * The source without its comments, so a `t(` in prose is not read as a call. Strings are walked
 * so a `//` inside one (a URL) is kept; the length is preserved line for line, so line numbers in
 * the report still point at the right place.
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) out += src[i] === '\n' ? '\n' : ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += c; i++;
      while (i < src.length) {
        const d = src[i];
        out += d; i++;
        if (d === '\\') { out += src[i] ?? ''; i++; continue; }
        if (d === q) break;
        if (d === '\n' && q !== '`') break;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** Reads one JS string literal starting at `i` (which is at the quote); returns [value, next]. */
function readLiteral(src, i) {
  const q = src[i];
  let out = '';
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') {
      const n = src[j + 1];
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === '\n') { /* line continuation */ }
      else out += n;
      j++;
      continue;
    }
    if (c === q) return [out, j + 1];
    if (c === '\n' && q !== '`') throw new Error('unterminated string');
    out += c;
  }
  throw new Error('unterminated string');
}

/**
 * The keys of every `t(` / `tn(` call in `src`: `[{key, line}]`, plus the call sites whose first
 * argument is not a literal, as `{line, text}` in `bad`.
 */
export function extractFromSource(raw) {
  const src = stripComments(raw);
  const keys = [];
  const bad = [];
  const re = /(?<![\w.$])t\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let key = '';
    let ok = false;
    for (;;) {
      while (/\s/.test(src[i] || '')) i++;
      const c = src[i];
      if (c === "'" || c === '"') {
        let v;
        try { [v, i] = readLiteral(src, i); } catch { break; }
        key += v;
        ok = true;
        while (/\s/.test(src[i] || '')) i++;
        if (src[i] === '+') { i++; continue; }
        if (src[i] === ',' || src[i] === ')') break;
        ok = false;
        break;
      }
      if (c === '`') {
        // A template literal with no `${}` is a plain literal; with one, it is a computed key.
        let v;
        try { [v, i] = readLiteral(src, i); } catch { break; }
        if (!v.includes('${')) { key += v; ok = true; }
        while (/\s/.test(src[i] || '')) i++;
        if (ok && src[i] === '+') { i++; continue; }
        if (ok && (src[i] === ',' || src[i] === ')')) break;
        ok = false;
        break;
      }
      break;
    }
    const line = src.slice(0, m.index).split('\n').length;
    if (ok && key !== '') keys.push({ key, line });
    else bad.push({ line, text: src.slice(m.index, m.index + 60).split('\n')[0] });
  }
  return { keys, bad };
}

/**
 * `{ keys: Map<key, [file:line…]>, bad: [{file, line, text}] }` over every shipped source under
 * `roots` (one root, or a list; ROOTS by default). Locations are repo-relative.
 */
export function extractAll(roots = ROOTS) {
  const keys = new Map();
  const bad = [];
  const files = (Array.isArray(roots) ? roots : [roots]).flatMap((root) => sourceFiles(root));
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const rel = relative(REPO, file);
    const r = extractFromSource(src);
    for (const { key, line } of r.keys) {
      if (!keys.has(key)) keys.set(key, []);
      keys.get(key).push(`${rel}:${line}`);
    }
    for (const b of r.bad) bad.push({ file: rel, ...b });
  }
  return { keys, bad };
}

const quote = (s) => JSON.stringify(s);

/** The text of ui/locales/en.js for a key map. */
export function render(keys) {
  const sorted = [...keys.keys()].sort((a, b) => a.localeCompare(b, 'en'));
  const lines = [
    '// GENERATED by ui/scripts/extract-strings.mjs — do not edit. Every English string the wallet',
    '// can show, as the `t()` call sites write it; the value is the key, since English is the',
    '// source language. Each other language is ui/locales/<code>.js, with the same keys: a string',
    '// value, or an object of CLDR plural categories ({one, few, many, other}) for a key with an',
    '// {n} hole whose translation inflects by number. `{name}` holes and the words in the glossary',
    '// at the top of each dictionary are kept as they are.',
    `// ${sorted.length} strings.`,
    'export default {',
  ];
  for (const k of sorted) lines.push(`  ${quote(k)}: ${quote(k)},`);
  lines.push('};', '');
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { keys, bad } = extractAll();
  if (bad.length) {
    for (const b of bad) console.error(`${b.file}:${b.line}: t() without a string literal: ${b.text}`);
    process.exit(2);
  }
  const text = render(keys);
  if (process.argv.includes('--check')) {
    let have = '';
    try { have = readFileSync(OUT, 'utf8'); } catch { /* absent */ }
    if (have !== text) { console.error('ui/locales/en.js is stale: run node ui/scripts/extract-strings.mjs'); process.exit(1); }
    console.log(`ui/locales/en.js is current (${keys.size} strings)`);
  } else {
    writeFileSync(OUT, text);
    console.log(`wrote ui/locales/en.js (${keys.size} strings)`);
  }
}
