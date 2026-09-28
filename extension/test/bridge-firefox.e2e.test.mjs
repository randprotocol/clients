// The same walk as bridge-chrome.e2e.test.mjs, in a real Firefox: the PACKED extension
// (dist/firefox) loaded as a temporary add-on over WebDriver (selenium-webdriver + geckodriver).
//
// Two things a temporary install needs that a store install does not:
//   * `extensions.webextensions.uuids` presets the add-on's internal UUID, which is how the test
//     can open the extension's own app page (moz-extension://<uuid>/app.html) to create a wallet;
//     and Firefox 134+ lets WebDriver reach such a privileged page only when geckodriver is
//     started with --allow-system-access.
//   * `extensions.originControls.grantByDefault`: an MV3 add-on's host permissions — which its
//     content scripts need — are granted by the install prompt a temporary install never shows.
//     A store install prompts; a user who declines sees the bridge fall back to "Install Rand
//     Wallet" until they grant the site in the extension's permissions panel.
//
// Skipped, with the reason, unless:
//   RAND_BRIDGE_URL   the running bridge (see bridge-chrome.e2e.test.mjs)
//   dist/firefox      firefox/pack.sh has run (RAND_EXT_DIR overrides)
//   selenium-webdriver + geckodriver   `npm --prefix extension install`, or RAND_E2E_MODULES
//   Firefox           /Applications/Firefox.app, or RAND_FIREFOX_BIN
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = resolve(new URL('../../', import.meta.url).pathname);
const EXT_DIR = process.env.RAND_EXT_DIR || join(ROOT, 'dist', 'firefox');
const BRIDGE_URL = process.env.RAND_BRIDGE_URL || '';
const MODULES = process.env.RAND_E2E_MODULES || join(ROOT, 'extension', 'node_modules');
const FIREFOX_BIN = process.env.RAND_FIREFOX_BIN || '/Applications/Firefox.app/Contents/MacOS/firefox';
const PASSWORD = 'an-e2e-password-for-a-real-vault';
const ADDON_ID = 'wallet@randprotocol.org'; // firefox/manifest.json browser_specific_settings.gecko.id

function loadSelenium() {
  try {
    const req = createRequire(join(MODULES, 'package.json'));
    return { webdriver: req('selenium-webdriver'), firefox: req('selenium-webdriver/firefox'), geckodriver: req.resolve('geckodriver') };
  } catch { return null; }
}
const sel = loadSelenium();
const missing = [
  !BRIDGE_URL && 'RAND_BRIDGE_URL is not set',
  !existsSync(join(EXT_DIR, 'manifest.json')) && `${EXT_DIR} is not a packed extension (firefox/pack.sh)`,
  !sel && `selenium-webdriver and geckodriver are not under ${MODULES} (npm --prefix extension install)`,
  !existsSync(FIREFOX_BIN) && `Firefox is not at ${FIREFOX_BIN} (RAND_FIREFOX_BIN)`,
].filter(Boolean);
const skip = missing.length ? `Firefox bridge e2e skipped: ${missing.join('; ')}` : false;

const env = {};
const host = () => new URL(BRIDGE_URL).host;
const evalAsync = (js) => env.driver.executeAsyncScript(`const done = arguments[arguments.length - 1]; (async () => { ${js} })().then((v) => done({ ok: true, v }), (e) => done({ ok: false, e: { code: e && e.code, message: String(e && e.message || e) } }));`);

before(async () => {
  if (skip) return;
  const { Builder } = sel.webdriver;
  const { Options, ServiceBuilder } = sel.firefox;
  env.uuid = randomUUID();
  const options = new Options()
    .setBinary(FIREFOX_BIN)
    .setPreference('extensions.webextensions.uuids', JSON.stringify({ [ADDON_ID]: env.uuid }))
    .setPreference('extensions.originControls.grantByDefault', true);
  // `npm install geckodriver` puts the driver binary on PATH for npm scripts only; point selenium
  // at the one the package downloaded (it does so on first use of its own CLI).
  const service = new ServiceBuilder().addArguments('--allow-system-access');
  env.driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build();
  env.driver.manage().setTimeouts({ script: 60_000 });
  await env.driver.installAddon(resolve(EXT_DIR), true);

  await env.driver.get(`moz-extension://${env.uuid}/app.html`);
  const made = await evalAsync(`
    const m = await import('./backend-extension.js');
    const info = await m.extensionBackend().wallet.create(${JSON.stringify(PASSWORD)});
    const h = await import('./lib/recipient-hash.js');
    return { address: info.address, hash: h.recipientHash(info.address) };`);
  assert.ok(made.ok, `wallet.create: ${made.ok ? '' : made.e.message}`);
  env.wallet = made.v;
  env.appHandle = await env.driver.getWindowHandle();
  await env.driver.switchTo().newWindow('tab');
  env.bridgeHandle = await env.driver.getWindowHandle();
});

after(async () => {
  if (env.driver) await env.driver.quit().catch(() => {});
});

/** The bridge, freshly loaded and hydrated, on its Withdraw tab. */
async function openWithdrawTab() {
  const { By, until } = sel.webdriver;
  await env.driver.switchTo().window(env.bridgeHandle);
  await env.driver.get(BRIDGE_URL);
  await env.driver.wait(until.elementLocated(By.css('#tab-withdraw')), 15_000);
  // Hydration first: a click on the tab before React is live does nothing, so click until it shows.
  await env.driver.wait(async () => {
    await env.driver.findElement(By.css('#tab-withdraw')).click();
    return (await env.driver.findElements(By.css('#panel-withdraw:not([hidden])'))).length > 0;
  }, 15_000);
}
const CONNECT = "//div[@id='panel-withdraw']//button[normalize-space()='Connect Rand Wallet']";

test('the e2e either runs or says why not', (t) => {
  if (skip) t.diagnostic(skip);
});

test('the bridge connects the extension: consent window, address, recipient hash', { skip, timeout: 120_000 }, async () => {
  const { By, until } = sel.webdriver;
  assert.match(env.wallet.address, /^rand1/);
  await openWithdrawTab();
  const injected = await evalAsync('return !!(window.rand && window.rand.isRandWallet);');
  assert.equal(injected.v, true, 'window.rand is injected');

  // Re-found on every poll: hydration re-renders the panel and an earlier handle goes stale.
  await env.driver.wait(async () => { const b = await env.driver.findElements(By.xpath(CONNECT)); return b.length > 0 && (await b[0].isEnabled()); }, 15_000);
  const before = await env.driver.getAllWindowHandles();
  await env.driver.findElement(By.xpath(CONNECT)).click();
  await env.driver.wait(async () => (await env.driver.getAllWindowHandles()).length > before.length, 15_000);
  const consent = (await env.driver.getAllWindowHandles()).find((h) => !before.includes(h));
  await env.driver.switchTo().window(consent);
  await env.driver.wait(until.elementLocated(By.xpath("//button[normalize-space()='Connect']")), 10_000);
  assert.ok((await env.driver.findElement(By.css('body')).getText()).includes(host()), 'the consent window names the site');
  await env.driver.findElement(By.xpath("//button[normalize-space()='Connect']")).click();

  await env.driver.switchTo().window(env.bridgeHandle);
  const shown = await env.driver.wait(until.elementLocated(By.css('#panel-withdraw .wallet-connect-address')), 15_000);
  assert.equal((await shown.getText()).trim(), env.wallet.address);
  assert.equal((await evalAsync('return await window.rand.getRecipientHash();')).v, env.wallet.hash, 'the hash the wallet vouches for');
  assert.equal((await evalAsync('return await window.rand.getAddress();')).v, env.wallet.address);
});

test('an approved origin reconnects without a window; disconnect forgets', { skip, timeout: 60_000 }, async () => {
  await openWithdrawTab();
  const handles = (await env.driver.getAllWindowHandles()).length;
  const again = await evalAsync('return await window.rand.connect();');
  await env.driver.sleep(1500);
  assert.equal(again.ok && again.v.address, env.wallet.address);
  assert.equal((await env.driver.getAllWindowHandles()).length, handles, 'no consent window for an origin already approved');

  await evalAsync('return await window.rand.disconnect();');
  const after = await evalAsync('return await window.rand.getAddress();');
  assert.equal(after.ok, false);
  assert.equal(after.e.code, 'NOT_CONNECTED');
});

test('a locked wallet answers LOCKED, and the page says to unlock', { skip, timeout: 60_000 }, async () => {
  const { By, until } = sel.webdriver;
  await env.driver.switchTo().window(env.appHandle);
  const locked = await evalAsync("const m = await import('./backend-extension.js'); await m.extensionBackend().wallet.lock(); return 'locked';");
  assert.ok(locked.ok, 'the wallet locked');
  await openWithdrawTab();
  const code = await evalAsync('return await window.rand.connect();');
  assert.equal(code.ok, false);
  assert.equal(code.e.code, 'LOCKED');

  await env.driver.findElement(By.xpath(CONNECT)).click();
  const alert = await env.driver.wait(until.elementLocated(By.css('#panel-withdraw [role=alert]')), 10_000);
  assert.match(await alert.getText(), /unlock/i);
});
