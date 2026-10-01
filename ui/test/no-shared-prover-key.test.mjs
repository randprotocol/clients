// Wallet 0.6.9 (audit v7 VK-9, fullnode #123): the 0.6.8 shared pool key — one key on every
// member — is gone from every shell. Nothing that ships may name it, its link, or the pool's bare
// URL as a prover to pair: the RandProtocol provers are the members of the core's pinned
// descriptor, each with its own key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const SHIPPED = [
  'core/crates/wallet-core/src', 'ui/engine', 'ui/screens', 'ui/lib', 'extension/shared/lib', 'extension/shared',
  'web/wallet', 'desktop/src-tauri/src', 'android/app/src/main', 'ios/RandWallet',
];
const SKIP = new Set(['node_modules', 'test', 'core', 'ui', 'target', 'dist']);
const SHARED_KEY = 'RGTF-7HKJ-XZFV-GQ1J';
const SHARED_LINK = 'randprover:ckTGmZwrvLRt66RN';

function* files(dir, top = true) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (!top || !SKIP.has(name)) yield* files(p, false); } else if (/\.(js|mjs|rs|java|swift|json|xml|html)$/.test(name)) yield p;
  }
}

test('no shipped source names the 0.6.8 shared prover key or its link', () => {
  let seen = 0;
  for (const d of SHIPPED) {
    for (const f of files(join(ROOT, d))) {
      seen += 1;
      // A test that asserts the key's ABSENCE may name it (core's inline tests).
      const text = readFileSync(f, 'utf8').split('\n').filter((l) => !/assert/.test(l)).join('\n');
      assert.equal(text.includes(SHARED_KEY), false, `${f.slice(ROOT.length)} names the shared key ${SHARED_KEY}`);
      assert.equal(text.includes(SHARED_LINK), false, `${f.slice(ROOT.length)} carries the shared key's link`);
    }
  }
  assert.ok(seen > 50, `only ${seen} files were read`);
});
