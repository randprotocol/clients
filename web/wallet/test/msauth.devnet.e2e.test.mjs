// One private-multisig signature from the web wallet's engine (ui/engine/signers.js) over the real
// wasm core, against the devnet scripts/e2e-msauth.sh runs: the signer profile is added from the
// policy and key files, the proposal is checked with no payee (refused), with the payee's address
// but no amount (refused), then with `addr:AMOUNT` (signable), and signed; the share is written
// to the work directory for the CLI's prove.
//
// Skipped unless MSAUTH_E2E_DIR and MSAUTH_E2E_RPC are set and the wasm core is built.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWasmBackend } from '../../../ui/engine/backend-wasm.js';
import { mapStorage } from '../../../ui/test/backend-fixtures.mjs';

const CORE_JS = new URL('../../../extension/shared/core/rand_wallet.js', import.meta.url);
const CORE_WASM = new URL('../../../extension/shared/core/rand_wallet_bg.wasm', import.meta.url);
const DIR = process.env.MSAUTH_E2E_DIR || '';
const RPC = process.env.MSAUTH_E2E_RPC || '';
const SIGNER = process.env.MSAUTH_E2E_SIGNER ?? '0';
const PASSWORD = 'an-e2e-password-for-a-real-vault';
const skip = !DIR || !RPC || !existsSync(CORE_WASM) ? 'run scripts/e2e-msauth.sh' : false;
const read = (n) => readFileSync(join(DIR, n), 'utf8');

test('a web wallet signs a private-multisig proposal on a devnet', { skip, timeout: 120_000 }, async () => {
  const mod = await import(CORE_JS.href);
  mod.initSync({ module: readFileSync(CORE_WASM) });
  const core = {
    async call(m, p = {}) {
      const r = JSON.parse(mod.call(m, JSON.stringify(p)));
      if (!r.ok) throw new Error(r.error);
      return r.value;
    },
  };
  const backend = makeWasmBackend({
    core, storage: mapStorage(), fetch,
    platform: { name: 'node-e2e', openExternal() {}, copy() {} },
    locks: null, broadcast: null,
  });
  await backend.wallet.create(PASSWORD);
  await backend.settings.set({ rpcUrl: RPC });
  const rows = await backend.signers.add({ label: 'web signer', policy: read('policy.json'), key: read(`signer${SIGNER}.key.json`), password: PASSWORD });
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.index, Number(SIGNER));
  const proposal = read('proposal.json');
  // payee.txt: `rand1…:AMOUNT`, what the payee told each signer out of band.
  const payment = read('payee.txt').trim();
  const address = payment.slice(0, payment.lastIndexOf(':'));

  const unchecked = await backend.signers.check(row.id, proposal);
  assert.equal(unchecked.signable, false);
  assert.equal(unchecked.refusal.code, 'unchecked-recipient', 'no payee entered: nothing signable');
  const amountless = await backend.signers.check(row.id, proposal, [address]);
  assert.equal(amountless.signable, false);
  assert.equal(amountless.refusal.code, 'unchecked-recipient', 'a RAND payee without its amount: nothing signable');

  const checked = await backend.signers.check(row.id, proposal, [payment]);
  assert.equal(checked.signable, true, JSON.stringify(checked.refusal));
  assert.equal(checked.summary.recipients_checked, true);
  assert.equal(checked.summary.chain_id, 21);

  const { share, index } = await backend.signers.sign(row.id, proposal, [payment], PASSWORD);
  assert.equal(index, Number(SIGNER));
  assert.match(share, new RegExp(`^${SIGNER}:[0-9a-f]+$`));
  assert.deepEqual(await backend.signers.verifyShare(row.id, proposal, share), { index });
  writeFileSync(join(DIR, `share${SIGNER}.txt`), `${share}\n`);
  console.log(`web signer ${index}: share written (${share.length} chars)`);
});
