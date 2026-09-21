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
};

const { makePlatform } = await import('../shared/lib/platform.js');

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
