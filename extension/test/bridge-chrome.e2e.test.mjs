// End to end, in a real Chrome: the PACKED extension (dist/chrome) on a running randbridge.org —
// a wallet is created through the extension's own backend, the bridge's Withdraw tab offers
// "Connect Rand Wallet", the consent window names the site, and after "Connect" the page shows
// the wallet's address and gets its recipient hash. Then what must NOT happen: an approved origin
// reconnects without a window, `disconnect` forgets, a locked wallet answers LOCKED and the page
// says to unlock.
//
// The bridge is the real Next app (a randbridge.org checkout: `npm run build`, its mock status
// service, then `STATUS_URL=http://127.0.0.1:8799 node .next/standalone/server.js` — see its
// playwright.config.ts). The content scripts match localhost on any port, so a local build is
// what this drives; nothing here registers an address with a status service (the Withdraw tab
// only reads the address).
//
// Skipped, with the reason, unless:
//   RAND_BRIDGE_URL   the running bridge, e.g. http://localhost:3000
//   dist/chrome       chrome/pack.sh has run (RAND_EXT_DIR overrides the directory)
//   playwright        `npm --prefix extension install` (extension/package.json), or
//                     RAND_E2E_MODULES pointing at a node_modules that has it
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = resolve(new URL('../../', import.meta.url).pathname);
const EXT_DIR = process.env.RAND_EXT_DIR || join(ROOT, 'dist', 'chrome');
const BRIDGE_URL = process.env.RAND_BRIDGE_URL || '';
const MODULES = process.env.RAND_E2E_MODULES || join(ROOT, 'extension', 'node_modules');
const PASSWORD = 'an-e2e-password-for-a-real-vault';

function loadPlaywright() {
  try { return createRequire(join(MODULES, 'package.json'))('playwright'); } catch { return null; }
}
const playwright = loadPlaywright();
const missing = [
  !BRIDGE_URL && 'RAND_BRIDGE_URL is not set',
  !existsSync(join(EXT_DIR, 'manifest.json')) && `${EXT_DIR} is not a packed extension (chrome/pack.sh)`,
  !playwright && `playwright is not under ${MODULES} (npm --prefix extension install)`,
].filter(Boolean);
const skip = missing.length ? `Chrome bridge e2e skipped: ${missing.join('; ')}` : false;

const env = {};
const host = () => new URL(BRIDGE_URL).host;

before(async () => {
  if (skip) return;
  env.profile = mkdtempSync(join(tmpdir(), 'rand-ext-chrome-'));
  env.context = await playwright.chromium.launchPersistentContext(env.profile, {
    headless: false,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run'],
  });
  let worker = env.context.serviceWorkers()[0];
  if (!worker) worker = await env.context.waitForEvent('serviceworker', { timeout: 15_000 });
  env.extId = new URL(worker.url()).host;

  // A wallet, unlocked, made through the extension's own backend inside its own app page.
  env.app = await env.context.newPage();
  await env.app.goto(`chrome-extension://${env.extId}/app.html`);
  env.wallet = await env.app.evaluate(async (pw) => {
    const m = await import('./backend-extension.js');
    const info = await m.extensionBackend().wallet.create(pw);
    const h = await import('./lib/recipient-hash.js');
    return { address: info.address, hash: h.recipientHash(info.address) };
  }, PASSWORD);

  env.page = await env.context.newPage();
  env.pageErrors = [];
  env.page.on('pageerror', (e) => env.pageErrors.push(String(e)));
});

after(async () => {
  if (env.context) await env.context.close().catch(() => {});
  if (env.profile) rmSync(env.profile, { recursive: true, force: true });
});

/** The bridge, freshly loaded and hydrated, on its Withdraw tab. */
async function openWithdrawTab() {
  await env.page.goto(BRIDGE_URL, { waitUntil: 'networkidle' });
  // Hydration first: a click on the tab before React is live does nothing.
  await env.page.getByRole('tab', { name: 'Withdraw' }).click();
  await env.page.locator('#panel-withdraw:not([hidden])').waitFor({ timeout: 10_000 });
  return env.page.locator('#panel-withdraw');
}

test('the e2e either runs or says why not', (t) => {
  if (skip) t.diagnostic(skip);
});

test('the bridge connects the extension: consent window, address, recipient hash', { skip, timeout: 120_000 }, async () => {
  assert.match(env.wallet.address, /^rand1/);
  const panel = await openWithdrawTab();
  assert.equal(await env.page.evaluate(() => !!(window.rand && window.rand.isRandWallet)), true, 'window.rand is injected');

  const button = panel.getByRole('button', { name: 'Connect Rand Wallet' });
  await button.waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await button.isEnabled(), true, 'the extension was detected, so Connect is offered');

  const popup = env.context.waitForEvent('page', { timeout: 15_000 });
  await button.click();
  const consent = await popup;
  await consent.waitForLoadState('domcontentloaded');
  assert.ok((await consent.locator('body').innerText()).includes(host()), 'the consent window names the site');
  await consent.getByRole('button', { name: 'Connect', exact: true }).click();

  const shown = panel.locator('.wallet-connect-address');
  await shown.waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal((await shown.innerText()).trim(), env.wallet.address);
  assert.equal(await env.page.evaluate(() => window.rand.getRecipientHash()), env.wallet.hash, 'the hash the wallet vouches for');
  assert.equal(await env.page.evaluate(() => window.rand.getAddress()), env.wallet.address);
});

test('an approved origin reconnects without a window; disconnect forgets', { skip, timeout: 60_000 }, async () => {
  let extra = null;
  const guard = env.context.waitForEvent('page', { timeout: 2_000 }).then((p) => { extra = p; }, () => {});
  await env.page.reload({ waitUntil: 'networkidle' });
  const again = await env.page.evaluate(() => window.rand.connect());
  await guard;
  assert.equal(again.address, env.wallet.address);
  assert.equal(extra, null, 'no consent window for an origin already approved');

  await env.page.evaluate(() => window.rand.disconnect());
  const code = await env.page.evaluate(() => window.rand.getAddress().then(() => 'answered', (e) => e.code));
  assert.equal(code, 'NOT_CONNECTED');
});

test('a locked wallet answers LOCKED, and the page says to unlock', { skip, timeout: 60_000 }, async () => {
  await env.app.evaluate(async () => { const m = await import('./backend-extension.js'); await m.extensionBackend().wallet.lock(); });
  const code = await env.page.evaluate(() => window.rand.connect().then(() => 'connected', (e) => e.code));
  assert.equal(code, 'LOCKED');

  const panel = await openWithdrawTab();
  await panel.getByRole('button', { name: 'Connect Rand Wallet' }).click();
  const alert = panel.locator('[role=alert]');
  await alert.waitFor({ state: 'visible', timeout: 10_000 });
  assert.match(await alert.innerText(), /unlock/i);
  assert.deepEqual(env.pageErrors, [], 'no page errors on the bridge');
});
