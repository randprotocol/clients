// The Receive line names the coin that arrives, never the burn asset (lib/withdraw-label.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { receiveLabel } from '../shared/lib/withdraw-label.js';

const t = (s, v = {}) => s.replace(/\{(\w+)\}/g, (_, k) => v[k]);
// ui/lib/format.js's two, as the packed window passes them (that path exists only when packed).
const formatUnits = (u, max, dec) => { const s = String(u).padStart(dec + 1, '0'); const w = s.slice(0, s.length - dec); const f = s.slice(s.length - dec).replace(/0+$/, ''); return f ? `${w}.${f}` : w; };
const shortHex = (h, n) => `${String(h).slice(0, n)}…`;
const fallbackChain = (id) => `Chain ${id}`;
const base = { receive: '999000000', assetDecimals: 8, t, fallbackChain, formatUnits, shortHex };

test('a known coin is named by its symbol and its chain by name', () => {
  const r = receiveLabel({ ...base, toChain: 2, token: '000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7' });
  assert.deepEqual(r, { receive: '9.99 USDT', chain: 'Ethereum', matched: true });
});

test('the same address on another chain is another coin; hex case and 0x do not matter', () => {
  const bsc = receiveLabel({ ...base, toChain: 3, token: '0x0000000000000000000000008AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' });
  assert.deepEqual([bsc.receive, bsc.chain], ['9.99 USDC', 'BNB Chain']);
  const sol = receiveLabel({ ...base, toChain: 5, token: 'ce010e60afedb22717bd63192f54145a3f965a33bb82d2c7029eb2ce1e208264' });
  assert.deepEqual([sol.receive, sol.chain], ['9.99 USDT', 'Solana']);
  const tron = receiveLabel({ ...base, toChain: 4, token: '000000000000000000000000a614f803b6fd780986a42c78ec9c7f77e6ded13c' });
  assert.deepEqual([tron.receive, tron.chain], ['9.99 USDT', 'Tron']);
  const wrong = receiveLabel({ ...base, toChain: 3, token: '000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7' });
  assert.equal(wrong.matched, false);
});

test('an unknown coin gets the bare amount and the short token, never a symbol', () => {
  const r = receiveLabel({ ...base, toChain: 9, token: 'ab'.repeat(32) });
  assert.equal(r.matched, false);
  assert.equal(r.chain, 'Chain 9');
  assert.match(r.receive, /^9\.99 token /);
  assert.doesNotMatch(r.receive, /zUSD|USD[TC]/);
});
