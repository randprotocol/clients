// Two smoke tests in one file, because they fail for the same reason — a build nobody ran.
//
//   1. the wasm core: keys, addresses, amounts (and, with an argument, a real bundle proof);
//   2. the PACKED extension: `chrome/pack.sh` and `firefox/pack.sh` output, checked as a store
//      reviewer's browser sees it — every module the pages import present *inside* the packed
//      directory, nothing reaching out of it, and none of the pre-redesign UI left behind.
//
// (2) is here because the packed tree was broken for four tasks without anything noticing: the
// extension imported `../../../ui/...`, which resolves in the repo and 404s once `dist/chrome` is
// the extension's root. A test that only ever exercised the raw core could not see it.
//
//   node extension/test/smoke.mjs [test|production]
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { initSync, call, version } from '../shared/core/rand_wallet.js';
import { UNLOCKED_SESSION_KEY } from '../../ui/engine/backend-wasm.js';

const ROOT = new URL('../../', import.meta.url);
const at = (path) => new URL(path, ROOT);

initSync({ module: readFileSync(new URL('../shared/core/rand_wallet_bg.wasm', import.meta.url)) });
const c = (m, p = {}) => { const r = JSON.parse(call(m, JSON.stringify(p))); if (!r.ok) throw new Error(`${m}: ${r.error}`); return r.value; };

console.log('core version', version(), c('version').chain_build, 'chain', c('version').default_chain_id);
const w = c('keygen');
const ver = c('version');
// `rand1` + base58(32-byte pk || 1184-byte ML-KEM encapsulation key). base58 of 1216 bytes is
// 1661 characters unless the leading bytes happen to be small, which costs one (~8% of keys),
// so a freshly generated address is 1665 or 1666 — never a single fixed number.
if (!w.address.startsWith(ver.address_hrp) || ![1665, 1666].includes(w.address.length)) throw new Error('bad address ' + w.address.length);
if (!c('parse_address', { address: w.address }).valid) throw new Error('address does not parse');
if (c('parse_address', { address: 'rand1nope' }).valid) throw new Error('bogus address parsed');
if (c('wallet_info', { spend_key: w.spend_key }).address !== w.address) throw new Error('wallet_info mismatch');
if (c('format_amount', { units: '1500000000' }) !== '1.5') throw new Error('format_amount');
if (ver.token_symbol !== 'RAND') throw new Error('token_symbol ' + ver.token_symbol);
if (!w.address.startsWith(ver.address_hrp)) throw new Error('address_hrp mismatch');
console.log('keys ok; address', w.address.slice(0, 16) + '…');

// ------------------------------------------------------------------- the packed extension -----

/** Every file under `dir`, as repo-relative paths. */
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(at(dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(path, prefix));
    else out.push(path);
  }
  return out;
}

const TEXT = /\.(js|mjs|html|css|json|txt|md)$/;
// Anything a store reviewer would reject outright, and the one thing a browser cannot resolve:
// a relative import that climbs out of the extension's own root.
const REMOTE_CODE = /\beval\(|new Function\(/;
const ESCAPES_ROOT = /\.\.\/\.\.\/\.\.\//;

/** The pre-redesign UI, and the four re-export shims that pointed outside the packed tree. */
const GONE = [
  'lib/views.js', 'lib/wallet.js', 'lib/store.js', 'lib/crypto.js',
  'lib/rpc.js', 'lib/format.js', 'lib/qr.js', 'styles.css',
  // ui/'s own tooling has no business in a store submission.
  'ui/test', 'ui/node_modules', 'ui/scripts', 'ui/gallery.html', 'ui/dev.html', 'ui/package.json',
];

/** What the popup and the app actually import, as their own root sees them. */
const NEEDED = [
  'manifest.json', 'popup.html', 'popup.js', 'app.html', 'app.js', 'background.js', 'worker.js',
  'backend-extension.js', 'lib/browser.js', 'lib/core.js', 'lib/idle-lock.js', 'lib/boot.js',
  'lib/platform.js',
  'ui/app.js', 'ui/backend.js', 'ui/tokens.css', 'ui/base.css', 'ui/components.css',
  'ui/engine/backend-wasm.js', 'ui/engine/wallet.js', 'ui/screens/home.js', 'ui/lib/qr.js',
  'ui/fonts/Inter-Variable.woff2', 'ui/fonts/DepartureMono-Regular.woff2', 'ui/lib/entropy.js',
  'core/rand_wallet.js', 'core/rand_wallet_bg.wasm',
];

/**
 * Every relative thing a packed file asks the browser to fetch: a module specifier, a `new
 * URL(…, import.meta.url)` (how the worker finds the wasm), and an HTML `src`/`href`. Bare and
 * absolute specifiers are skipped — there is no import map here, so a bare one would be a bug of
 * its own, but this check is about where relative paths land.
 */
function* references(path, source) {
  const patterns = /\.(html)$/.test(path)
    ? [/<(?:script|link)[^>]*?(?:src|href)\s*=\s*"([^"]+)"/g]
    : [/\bfrom\s*'([^']+)'/g, /\bimport\s*\(\s*'([^']+)'\s*\)/g, /\bimport\s*'([^']+)'/g, /new URL\('([^']+)',\s*import\.meta\.url\)/g];
  for (const re of patterns) {
    for (const [, ref] of source.matchAll(re)) {
      if (ref.startsWith('./') || ref.startsWith('../')) yield ref;
    }
  }
}

function checkPacked(browser) {
  execFileSync(at(`${browser}/pack.sh`).pathname, { cwd: at('.').pathname, stdio: 'inherit' });
  const dist = `dist/${browser}`;

  for (const needed of NEEDED) {
    const path = `${dist}/${needed}`;
    if (!existsSync(at(path))) throw new Error(`${path} is missing: the packed extension cannot load`);
    // A symlink resolves on this machine and in nobody's browser: a .crx/.xpi is a zip of files.
    const stat = lstatSync(at(path));
    if (stat.isSymbolicLink()) throw new Error(`${path} is a symlink into the repo, not a real file`);
    if (!stat.isFile()) throw new Error(`${path} is not a file`);
  }
  for (const gone of GONE) {
    if (existsSync(at(`${dist}/${gone}`))) throw new Error(`${dist}/${gone} should not be in the packed extension`);
  }

  let scanned = 0;
  let resolved = 0;
  for (const path of walk(dist)) {
    if (!TEXT.test(path)) continue;
    scanned += 1;
    const source = readFileSync(at(path), 'utf8');
    if (REMOTE_CODE.test(source)) throw new Error(`${path} runs code from a string — the CSP forbids it`);
    if (ESCAPES_ROOT.test(source)) throw new Error(`${path} refers to a path outside the packed extension`);
    // …and the real question the grep above only approximates: does every module this file
    // imports, and every stylesheet and script the HTML links, resolve to a file that is
    // actually in here? A browser given the packed directory has nothing else to fall back on.
    for (const ref of references(path, source)) {
      resolved += 1;
      const target = new URL(ref, at(path));
      if (!target.pathname.startsWith(at(`${dist}/`).pathname)) {
        throw new Error(`${path} imports ${ref}, which is outside ${dist}`);
      }
      if (!existsSync(target)) throw new Error(`${path} imports ${ref}, which does not exist in ${dist}`);
    }
  }
  console.log(`packed ${dist}: ${NEEDED.length} required files present, ${scanned} text files clean, ${resolved} references resolve inside it`);
}

checkPacked('chrome');
checkPacked('firefox');

// background.js is loaded as a CLASSIC script by both browsers, so it cannot import the key it
// has to delete; it spells it out instead. This is what keeps the two from drifting apart.
const background = readFileSync(at('extension/shared/background.js'), 'utf8');
const declared = /UNLOCKED_SESSION_KEY\s*=\s*'([^']+)'/.exec(background);
if (!declared) throw new Error('background.js no longer declares UNLOCKED_SESSION_KEY');
if (declared[1] !== UNLOCKED_SESSION_KEY) {
  throw new Error(`background.js deletes '${declared[1]}' but the backend's session key is '${UNLOCKED_SESSION_KEY}'`);
}
console.log(`auto-lock: background.js and the backend agree on storage.session['${UNLOCKED_SESSION_KEY}']`);

// ------------------------------------------------------------------------- the real prover ----
// Proving is opt-in: a bundle proof peaks at ~5.7 GB and wasm32 stops at 4 GB, so this aborts
// with `RuntimeError: unreachable` (an allocation failure) until the prover's footprint drops.
const profile = process.argv[2];
if (!profile) { console.log('keys + packaging smoke test passed (pass "test" or "production" to attempt a proof)'); process.exit(0); }
const req = c('fixture_prove_request', { profile });
console.log(`proving a fixture transfer (${profile} profile)…`);
const t0 = Date.now();
const res = c('prove_transfer', req);
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`proved in ${secs}s: tier ${res.tier}, proof ${res.proof_bytes} bytes, tx ${res.tx_bytes} bytes, hash ${res.hash.slice(0, 12)}…, change ${res.change}`);
