// "Unlock with Touch ID" in a real Chrome: the packed extension's own page creates a platform
// passkey under the extension's id with the WebAuthn PRF extension, seals the password with it,
// and gets the password back from it — against Chrome's virtual authenticator (DevTools
// `WebAuthn.addVirtualAuthenticator`, internal transport, user verification, PRF), which stands in
// for the Mac's Touch ID sensor. What only a real browser can say: that Chrome lets an extension
// page use its own id as the relying party, and returns PRF output for it.
//
//   RAND_EXT_DIR=dist/chrome node --test extension/test/passkey-chrome.e2e.test.mjs
//   (default dist/chrome-devnet; playwright under extension/node_modules)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = resolve(new URL('../../', import.meta.url).pathname);
const EXT_DIR = process.env.RAND_EXT_DIR || join(ROOT, 'dist', 'chrome-devnet');
const MODULES = process.env.RAND_E2E_MODULES || join(ROOT, 'extension', 'node_modules');
const PASSWORD = 'an-e2e-password-for-a-real-vault';

function loadPlaywright() {
  try { return createRequire(join(MODULES, 'package.json'))('playwright'); } catch { return null; }
}
const playwright = loadPlaywright();
const missing = [
  !existsSync(join(EXT_DIR, 'lib', 'passkey.js')) && `${EXT_DIR} is not a packed extension with passkey unlock`,
  !playwright && `playwright is not under ${MODULES}`,
].filter(Boolean);
const skip = missing.length ? `Chrome passkey e2e skipped: ${missing.join('; ')}` : false;

const env = {};
before(async () => {
  if (skip) return;
  env.profile = mkdtempSync(join(tmpdir(), 'rand-passkey-chrome-'));
  env.context = await playwright.chromium.launchPersistentContext(env.profile, {
    headless: false,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run'],
  });
  let worker = env.context.serviceWorkers()[0];
  if (!worker) worker = await env.context.waitForEvent('serviceworker', { timeout: 15_000 });
  env.extId = new URL(worker.url()).host;
  env.app = await env.context.newPage();
  await env.app.goto(`chrome-extension://${env.extId}/app.html`);
  const cdp = await env.context.newCDPSession(env.app);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
      automaticPresenceSimulation: true, hasPrf: true,
    },
  });
});

after(async () => {
  if (env.context) await env.context.close().catch(() => {});
  if (env.profile) rmSync(env.profile, { recursive: true, force: true });
});

test('the Chrome passkey e2e either runs or says why not', (t) => { if (skip) t.diagnostic(skip); });

test('an extension page makes a PRF passkey under its own id, and it gives the password back', { skip, timeout: 120_000 }, async () => {
  await env.app.bringToFront();
  const out = await env.app.evaluate(async (pw) => {
    const m = await import('./backend-extension.js');
    const b = m.extensionBackend();
    await b.wallet.create(pw);
    const pk = b.wallet.passkey;
    if (!pk) return { error: 'no wallet.passkey group' };
    const r = { label: pk.label(), available: await pk.available(), before: await pk.enabled() };
    await pk.enable(pw);
    r.after = await pk.enabled();
    await b.wallet.lock();
    r.locked = !(await b.wallet.isUnlocked());
    const recovered = await pk.recoverPassword();
    r.same = recovered === pw;
    await b.wallet.unlock(recovered);
    r.unlocked = await b.wallet.isUnlocked();
    const bag = await chrome.storage.local.get('passkeyUnlock');
    r.stored = !!bag.passkeyUnlock && !JSON.stringify(bag.passkeyUnlock).includes(pw);
    await pk.disable();
    r.offAfter = await pk.enabled();
    return r;
  }, PASSWORD);
  assert.deepEqual(out, {
    label: 'Touch ID', available: true, before: false, after: true, locked: true,
    same: true, unlocked: true, stored: true, offAfter: false,
  });
});
