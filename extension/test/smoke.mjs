// Node smoke test of the wasm core: keys, addresses, and a timed proof of the built-in fixture.
//   node extension/test/smoke.mjs [test|production]
import { readFileSync } from 'node:fs';
import { initSync, call, version } from '../shared/core/rand_wallet.js';

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

// Proving is opt-in: a bundle proof peaks at ~5.5 GB and wasm32 stops at 4 GB, so this aborts
// with `RuntimeError: unreachable` (an allocation failure) until the prover's footprint drops.
const profile = process.argv[2];
if (!profile) { console.log('keys-only smoke test passed (pass "test" or "production" to attempt a proof)'); process.exit(0); }
const req = c('fixture_prove_request', { profile });
console.log(`proving a fixture transfer (${profile} profile)…`);
const t0 = Date.now();
const res = c('prove_transfer', req);
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`proved in ${secs}s: tier ${res.tier}, proof ${res.proof_bytes} bytes, tx ${res.tx_bytes} bytes, hash ${res.hash.slice(0, 12)}…, change ${res.change}`);
