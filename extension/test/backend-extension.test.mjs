// `extension/shared/backend-extension.js`'s platform group, under plain Node with a stubbed
// WebExtension API. The one member with real logic: `ensureHostPermission`, which the settings
// screen asks before it saves a new RPC URL.
import test from 'node:test';
import assert from 'node:assert/strict';

// The stub must be in place BEFORE the module reads `globalThis.chrome` at import time.
const perms = { requestThrows: true, granted: false, calls: [] };
globalThis.chrome = {
  permissions: {
    request: async (arg) => {
      perms.calls.push(['request', arg]);
      if (perms.requestThrows) throw new Error('This permission cannot be requested');
      return true;
    },
    contains: async (arg) => {
      perms.calls.push(['contains', arg]);
      return perms.granted;
    },
  },
  windows: { getCurrent: async () => ({ id: 7 }) },
  sidePanel: {
    open: async (arg) => {
      panel.calls.push(['open', arg]);
      if (panel.openThrows) throw new Error('`sidePanel.open()` may only be called in response to a user gesture.');
    },
  },
};
const panel = { calls: [], openThrows: false, closed: 0 };
globalThis.window = { close: () => { panel.closed += 1; } };

const { makePlatform, PROVER_DATA_COLLECTION } = await import('../shared/lib/platform.js');

test('a grantable origin answers the request itself', async () => {
  perms.requestThrows = false;
  perms.calls.length = 0;
  const platform = makePlatform();
  assert.equal(await platform.ensureHostPermission('https://node.example:8545'), true);
  assert.deepEqual(perms.calls, [['request', { origins: ['https://node.example:8545/*'] }]]);
});

test('a non-requestable pattern is answered by reality, never assumed', async (t) => {
  perms.requestThrows = true;
  const platform = makePlatform();

  await t.test('a host the build already granted (the default node) is a yes', async () => {
    perms.granted = true;
    perms.calls.length = 0;
    assert.equal(await platform.ensureHostPermission('https://rpc1.randprotocol.org'), true);
    assert.deepEqual(perms.calls.map((c) => c[0]), ['request', 'contains']);
  });

  await t.test('an origin nothing covers (a plain-http LAN node) is a NO, and the save is abandoned', async () => {
    // The parked 2.1 finding: `catch { return true }` let a URL this extension can never reach
    // be saved, with every fetch failing afterwards and no hint why.
    perms.granted = false;
    perms.calls.length = 0;
    assert.equal(await platform.ensureHostPermission('http://192.168.1.20:8545'), false);
    assert.deepEqual(perms.calls.map((c) => c[0]), ['request', 'contains']);
  });
});

test('a URL that does not parse is false without asking the browser anything', async () => {
  perms.calls.length = 0;
  const platform = makePlatform();
  assert.equal(await platform.ensureHostPermission('not a url'), false);
  assert.deepEqual(perms.calls, []);
});

test('the side panel opens in this window, then the popup closes itself', async () => {
  panel.calls.length = 0; panel.closed = 0; panel.openThrows = false;
  const platform = makePlatform();
  assert.equal(typeof platform.openSidebar, 'function');
  await platform.openSidebar();
  assert.deepEqual(panel.calls, [['open', { windowId: 7 }]]);
  assert.equal(panel.closed, 1);
});

test('a side panel the browser refuses leaves the popup open and says so', async () => {
  panel.calls.length = 0; panel.closed = 0; panel.openThrows = true;
  const platform = makePlatform();
  await assert.rejects(() => platform.openSidebar(), /user gesture/);
  assert.equal(panel.closed, 0, 'the popup closed with no side panel to take its place');
  panel.openThrows = false;
});

// ---- Firefox's data-collection consent for the RandProtocol prover (wallet 0.6.8) ----
// A job to the default prover carries this wallet's viewing key to the developer's own service, so
// Firefox's `financialAndPaymentInfo` data-collection permission is asked — from the first-send
// notice's own click — and checked before any job. Chrome has no such permission: no code.

test('Firefox asks for and checks the financialAndPaymentInfo data-collection permission', async () => {
  const platform = makePlatform({ firefox: true });
  perms.calls.length = 0;
  perms.granted = false;
  assert.equal(await platform.hasDataCollectionConsent(), false);
  assert.deepEqual(perms.calls, [['contains', { data_collection: ['financialAndPaymentInfo'] }]]);
  perms.granted = true;
  assert.equal(await platform.hasDataCollectionConsent(), true);

  // The request is made synchronously — inside the click, before anything is awaited.
  perms.calls.length = 0;
  perms.requestThrows = false;
  const asked = platform.requestDataCollectionConsent();
  assert.deepEqual(perms.calls, [['request', { data_collection: ['financialAndPaymentInfo'] }]], 'the request waited for something first');
  assert.equal(await asked, true);
  // A refusal (or a browser that throws) is a no.
  perms.requestThrows = true;
  assert.equal(await platform.requestDataCollectionConsent(), false);
  assert.deepEqual(PROVER_DATA_COLLECTION, { data_collection: ['financialAndPaymentInfo'] });
});

test('Chrome has no data-collection permission and no such members', () => {
  const platform = makePlatform({ firefox: false });
  assert.equal('hasDataCollectionConsent' in platform, false);
  assert.equal('requestDataCollectionConsent' in platform, false);
});

test('the Firefox manifest requires no data collection and makes financialAndPaymentInfo optional', async () => {
  const { readFileSync } = await import('node:fs');
  const m = JSON.parse(readFileSync(new URL('../../firefox/manifest.json', import.meta.url), 'utf8'));
  const dc = m.browser_specific_settings.gecko.data_collection_permissions;
  assert.deepEqual(dc.required, ['none']);
  assert.deepEqual(dc.optional, ['financialAndPaymentInfo']);
});
