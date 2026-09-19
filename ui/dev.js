// Developer harness for ui/dev.html. Not shipped in any shell — mounts the real app.js against
// the fake backend so screens can be eyeballed and screenshotted outside a browser extension.
//
// Query params:
//   ?mode=popup                — forces the 360x600 popup layout (default: 'app', responsive)
//   ?theme=dark|light          — forces a theme via backend.settings (default: whatever the OS reports)
//   ?state=new|locked|unlocked — wallet state before mount (default: 'new', i.e. onboarding)
//   ?scan=fail                 — sync.scan() rejects (cached data still shows; for the retry banner)
//   ?scan=hang                 — sync.cached() and sync.scan() never resolve (stuck skeleton)
//   ?scan=slow                 — sync.scan() reports progress, then resolves after ~2.5s
//   ?activity=rich             — more activity/notes spanning several days, for day-grouping and filters
//   ?faucet=fail                — faucet.request() rejects with a cooldown-style message
//   #hash                      — an initial route, same as any real navigation
import { mount } from './app.js';
import { fakeBackend, unlockedBackend } from './test/fake-backend.mjs';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') === 'popup' ? 'popup' : 'app';
const theme = params.get('theme');
const state = params.get('state') || 'new';
const scan = params.get('scan');
const activity = params.get('activity');
const faucet = params.get('faucet');

function richActivityAndNotes() {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const DAY = 86400;
  return {
    activity: [
      { kind: 'in', asset: 0, amount: '1000000000', time: nowSec - 900, hash: `0x${'aa'.repeat(32)}`, index: 3, address: `rand1${'s'.repeat(40)}`, block: 1402914 },
      { kind: 'out', asset: 0, amount: '500000000', time: nowSec - 3600, hash: `0x${'bb'.repeat(32)}`, address: `rand1${'p'.repeat(40)}`, block: 1402918, fee: '2100000', txKey: `tk-${'cd'.repeat(16)}` },
      { kind: 'in', asset: 1, amount: '20000000', time: nowSec - 7200, hash: `0x${'cc'.repeat(32)}`, index: 7, address: `rand1${'w'.repeat(40)}`, block: 1402918 },
      { kind: 'pending', asset: 0, amount: '12000000000', time: nowSec - 60, hash: `0x${'dd'.repeat(32)}`, address: `rand1${'x'.repeat(40)}` },
      { kind: 'out', asset: 0, amount: '6000000000', time: nowSec - DAY, hash: `0x${'ee'.repeat(32)}`, address: `rand1${'y'.repeat(40)}`, block: 1401800, fee: '2000000' },
      { kind: 'in', asset: 0, amount: '2500000000', time: nowSec - 8 * DAY, hash: `0x${'ff'.repeat(32)}`, index: 9, address: `rand1${'z'.repeat(40)}`, block: 1390000 },
    ],
    notes: [
      { index: 3, asset: 0, amount: '1000000000', blockHeight: 1402914, spent: false, commitment: `0x${'a1'.repeat(32)}`, time: nowSec - 900 },
      { index: 7, asset: 1, amount: '20000000', blockHeight: 1402918, spent: false, commitment: `0x${'c3'.repeat(32)}`, time: nowSec - 7200 },
      { index: 9, asset: 0, amount: '2500000000', blockHeight: 1390000, spent: true, commitment: `0x${'e5'.repeat(32)}`, time: nowSec - 8 * DAY },
    ],
  };
}

async function init() {
  let backend;
  if (state === 'unlocked') {
    backend = unlockedBackend();
  } else {
    backend = fakeBackend();
    if (state === 'locked') {
      await backend.wallet.create('dev harness password');
      await backend.wallet.lock();
    }
  }
  if (theme) await backend.settings.set({ theme });

  if (activity === 'rich' && state === 'unlocked') {
    const rich = richActivityAndNotes();
    backend.sync.cached = async () => ({ ...rich, scannedHeight: 1402918, head: 1402918, lastSyncMs: Date.now() });
    backend.sync.scan = async (onProgress) => {
      if (typeof onProgress === 'function') onProgress({ scanned: 1402918, head: 1402918 });
      return { ...rich, scannedHeight: 1402918, head: 1402918, lastSyncMs: Date.now() };
    };
  }
  if (scan === 'fail') {
    backend.sync.scan = async () => { throw new Error('Cannot reach the fullnode at 127.0.0.1:8899 — timed out after 8s.'); };
  } else if (scan === 'hang') {
    backend.sync.cached = () => new Promise(() => {}); // never resolves: stuck on the skeleton
    backend.sync.scan = () => new Promise(() => {});
  } else if (scan === 'slow') {
    backend.sync.scan = (onProgress) => new Promise((resolve) => {
      if (typeof onProgress === 'function') onProgress({ scanned: 1402600, head: 1402918 });
      setTimeout(async () => {
        const cached = await backend.sync.cached();
        resolve({ ...cached, scannedHeight: 1402918, head: 1402918, lastSyncMs: Date.now() });
      }, 2500);
    });
  }
  if (faucet === 'fail') {
    backend.faucet.request = async () => { throw new Error('This address already claimed RAND today. Try again in 11h 24m.'); };
  }

  window.__app = await mount(document.body, backend, { mode });
}

init();
