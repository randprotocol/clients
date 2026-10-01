// background.js under plain Node, as the classic script the browser loads, against a stubbed
// WebExtension API. What is checked: on install and on update the provider is put back into the
// bridge tabs that are already open — Chrome orphans a tab's content scripts when the extension
// reloads and never re-injects them, so without this every open randbridge.org tab shows "Rand
// Wallet did not respond" until the user thinks to reload it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const plain = (v) => JSON.parse(JSON.stringify(v)); // across the vm realm, for deepEqual
const read = (f) => readFileSync(new URL(`../shared/${f}`, import.meta.url), 'utf8');

function boot({ tabs = [], refuse = () => false, browser = {} } = {}) {
  const calls = { executed: [], attempted: [], queried: [], created: [], listeners: {}, panel: [], toggled: 0 };
  const on = (name) => ({ addListener: (fn) => { calls.listeners[name] = fn; } });
  const ext = {
    alarms: { onAlarm: on('alarm') },
    runtime: {
      onInstalled: on('installed'), onStartup: on('startup'), onMessage: on('message'),
      getURL: (p) => 'chrome-extension://abc/' + p,
    },
    storage: { local: { get: async () => ({}) }, session: { remove: async () => {} } },
    tabs: {
      query: async (q) => { calls.queried.push(q); return tabs; },
      create: async (o) => { calls.created.push(o); },
      sendMessage: async () => {},
    },
    scripting: { executeScript: async (o) => { calls.attempted.push(o); if (refuse(o)) throw new Error('Cannot access contents of the page'); calls.executed.push(o); } },
    windows: { create: async () => {} },
    ...browser,
  };
  if (browser.chromePanel) {
    ext.sidePanel = { setPanelBehavior: async (o) => { calls.panel.push(o); } };
  }
  if (browser.firefoxSidebar) {
    ext.sidebarAction = { toggle: () => { calls.toggled += 1; } };
    ext.action = { onClicked: on('actionClicked') };
  }
  const sandbox = { chrome: ext, console, crypto: globalThis.crypto };
  sandbox.globalThis = sandbox;
  sandbox.importScripts = (f) => vm.runInContext(read(f), ctx);
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read('background.js'), ctx);
  return { calls, fire: (details) => calls.listeners.installed(details) };
}

test('an update re-injects inpage.js (page world) then content.js into every open bridge tab', async () => {
  const { calls, fire } = boot({ tabs: [{ id: 7, url: 'https://randbridge.org/' }, { id: 9, url: 'http://localhost:3000/' }] });
  await fire({ reason: 'update' });
  assert.equal(calls.queried.length, 1);
  assert.ok(calls.queried[0].url.includes('https://randbridge.org/*'), 'asks only for the provider sites');
  assert.deepEqual(plain(calls.executed.map((e) => [e.target.tabId, e.files, e.world ?? 'ISOLATED'])), [
    [7, ['inpage.js'], 'MAIN'], [7, ['content.js'], 'ISOLATED'],
    [9, ['inpage.js'], 'MAIN'], [9, ['content.js'], 'ISOLATED'],
  ]);
  assert.deepEqual(calls.created, [], 'no welcome tab on an update');
});

test('a first install re-injects too, and opens the welcome tab', async () => {
  const { calls, fire } = boot({ tabs: [{ id: 7, url: 'https://randbridge.org/' }] });
  await fire({ reason: 'install' });
  assert.equal(calls.executed.length, 2);
  assert.deepEqual(plain(calls.created), [{ url: 'chrome-extension://abc/app.html#welcome' }]);
});

test('a tab whose URL the extension cannot see is skipped', async () => {
  const { calls, fire } = boot({ tabs: [{ id: 1 }, { id: 2, url: 'https://randbridge.org/' }] });
  await fire({ reason: 'update' });
  assert.deepEqual(calls.executed.map((e) => e.target.tabId), [2, 2]);
});

test('a refused injection (no host permission for that tab) does not stop the rest', async () => {
  const { calls, fire } = boot({ tabs: [{ id: 1, url: 'http://localhost:3000/' }, { id: 2, url: 'https://randbridge.org/' }],
    refuse: (o) => o.target.tabId === 1 });
  await fire({ reason: 'update' });
  assert.deepEqual(calls.attempted.map((e) => e.target.tabId), [1, 1, 2, 2], 'every injection was attempted');
  assert.deepEqual(calls.executed.map((e) => e.target.tabId), [2, 2]);
});

test('a Chrome update (reason chrome_update) orphans nothing, so nothing is re-injected', async () => {
  const { calls, fire } = boot({ tabs: [{ id: 7, url: 'https://randbridge.org/' }] });
  await fire({ reason: 'chrome_update' });
  assert.deepEqual(calls.executed, []);
  assert.deepEqual(calls.queried, []);
});

test('the sites re-injected are exactly the ones both manifests inject into', () => {
  const src = read('background.js');
  const sites = JSON.parse(src.match(/const PROVIDER_SITES = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));
  for (const which of ['chrome', 'firefox']) {
    const m = JSON.parse(readFileSync(new URL(`../../${which}/manifest.json`, import.meta.url), 'utf8'));
    for (const cs of m.content_scripts) assert.deepEqual(cs.matches, sites, `${which} content_scripts.matches`);
    assert.ok(m.permissions.includes('scripting'), `${which} may re-inject`);
    for (const site of sites.filter((s) => s.startsWith('https://'))) assert.ok(m.host_permissions.includes(site), `${which} host permission for ${site}`);
  }
});

test('the toolbar button opens the side panel: Chrome is told to, Firefox toggles it on the click', () => {
  const chrome = boot({ browser: { chromePanel: true } });
  assert.deepEqual(plain(chrome.calls.panel), [{ openPanelOnActionClick: true }]);
  const firefox = boot({ browser: { firefoxSidebar: true } });
  assert.equal(firefox.calls.toggled, 0, 'nothing opens until the user clicks');
  firefox.calls.listeners.actionClicked();
  assert.equal(firefox.calls.toggled, 1);
  for (const which of ['chrome', 'firefox']) {
    const m = JSON.parse(readFileSync(new URL(`../../${which}/manifest.json`, import.meta.url), 'utf8'));
    assert.equal(m.action.default_popup, undefined, `${which}: no popup, so the click is ours to answer`);
  }
});
