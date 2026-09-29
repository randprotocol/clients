// content.js under plain Node: the classic script is evaluated against a stubbed `window` (one
// message bus, shared by every script that runs against it, as the real window is shared by every
// content-script world) and a stubbed `chrome`. What is checked is what the page sees, not the
// plumbing.
//
// The second test is the one that matters: reloading the extension (a store update, or a
// developer's reload of an unpacked build) orphans the content script in every open tab — its
// `chrome.runtime` throws "Extension context invalidated" from then on — and Chrome does not put
// a new one in. background.js re-injects one on install/update, so an orphan and a live script
// share the page; the page must hear from the live one only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../shared/content.js', import.meta.url), 'utf8');
const ORIGIN = 'https://randbridge.org';

/** A window: an event bus whose `message` events are delivered asynchronously, as the browser's are. */
function fakeWindow() {
  const listeners = new Set();
  const seen = [];
  const win = {
    location: { origin: ORIGIN },
    addEventListener: (type, fn) => { if (type === 'message') listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'message') listeners.delete(fn); },
    postMessage: (data, origin) => {
      assert.equal(origin, ORIGIN);
      seen.push(data);
      setTimeout(() => { for (const fn of [...listeners]) fn({ source: win, origin: ORIGIN, data }); }, 0);
    },
    seen,
    listenerCount: () => listeners.size,
  };
  return win;
}

/** A `chrome` whose background answers `answer`, or one whose context has been invalidated. */
function fakeChrome({ answer, invalidated = false, dead = false } = {}) {
  const decisions = new Set();
  const sent = [];
  return {
    sent, decisions,
    runtime: {
      id: invalidated ? undefined : 'ext',
      sendMessage: async (msg) => {
        if (invalidated) throw new Error('Extension context invalidated.');
        if (dead) throw new Error('Could not establish connection. Receiving end does not exist.');
        sent.push(msg);
        return typeof answer === 'function' ? answer(msg) : answer;
      },
      onMessage: { addListener: (fn) => decisions.add(fn), removeListener: (fn) => decisions.delete(fn) },
    },
  };
}

function inject(win, chrome) {
  vm.runInNewContext(SOURCE, { window: win, chrome, setTimeout, console, performance });
}
const tick = () => new Promise((r) => setTimeout(r, 5));
/** What the page received for request `id`. */
const plain = (v) => JSON.parse(JSON.stringify(v)); // across the vm realm, for deepEqual
const replies = (win, id) => plain(win.seen.filter((m) => m.target === 'rand-wallet:content' && m.id === id));
const ask = (win, id, method = 'getAddress') => win.postMessage({ target: 'rand-wallet:page', id, method }, ORIGIN);

test('a page request is forwarded to the background and its answer handed back once', async () => {
  const win = fakeWindow();
  const chrome = fakeChrome({ answer: { ok: true, result: 'rand1here' } });
  inject(win, chrome);
  ask(win, 'r1');
  await tick();
  assert.deepEqual(plain(chrome.sent), [{ type: 'rand:getAddress' }]);
  assert.deepEqual(replies(win, 'r1'), [{ target: 'rand-wallet:content', id: 'r1', ok: true, result: 'rand1here' }]);
});

test('an orphaned script (extension reloaded) answers UNAVAILABLE and says to reload the page', async () => {
  const win = fakeWindow();
  inject(win, fakeChrome({ invalidated: true }));
  ask(win, 'r1');
  await tick();
  const [r] = replies(win, 'r1');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'UNAVAILABLE');
  assert.match(r.error.message, /reload/i);
});

test('a background that is not listening (a stale unpacked registration) answers NO_BACKGROUND and says to reload the extension', async () => {
  for (const chrome of [fakeChrome({ dead: true }), fakeChrome({ answer: undefined })]) {
    const win = fakeWindow();
    inject(win, chrome);
    ask(win, 'r1');
    await tick();
    const [r] = replies(win, 'r1');
    assert.equal(r.error.code, 'NO_BACKGROUND');
    assert.match(r.error.message, /reload the extension/i);
  }
});

test('a re-injected script takes over: the orphan falls silent and the page hears one answer, the live one', async () => {
  const win = fakeWindow();
  const orphan = fakeChrome({ invalidated: true });
  inject(win, orphan);
  const before = win.listenerCount();
  const live = fakeChrome({ answer: { ok: true, result: 'rand1live' } });
  await tick(); // the orphan's own notice, from page load, is long delivered
  inject(win, live);
  await tick(); // the takeover notice is a posted message, delivered asynchronously
  assert.equal(win.listenerCount(), before, 'the orphan unhooked itself; the live script is hooked in its place');
  ask(win, 'r2');
  await tick();
  assert.deepEqual(replies(win, 'r2'), [{ target: 'rand-wallet:content', id: 'r2', ok: true, result: 'rand1live' }]);
  assert.deepEqual(plain(live.sent), [{ type: 'rand:getAddress' }]);
});
