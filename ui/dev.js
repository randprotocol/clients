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
//   ?scan=silent               — sync.scan() never reports progress and never resolves (the
//                                indeterminate bar, with real cached data behind it)
//   ?activity=rich             — more activity/notes spanning several days, for day-grouping and filters
//   ?faucet=fail                — faucet.request() rejects with a cooldown-style message
//   ?address=long              — a realistic ~1.6 kB shielded address, for the Receive screen
//   ?canProve=0|1              — send.canProve(): 1 = this shell proves natively (desktop),
//                                0 = it cannot (the wasm shells), with the real reason string
//   ?prove=ok|fail|slow|unknown — send.send(): resolves at once / fails with a wasm OOM while
//                                still proving (nothing broadcast) / walks a phase every 1.5 s and
//                                never finishes (for the ring) / fails at 'submitting' with a hash,
//                                which is the outcome-unknown screen
//   ?assets=one|none|rpl       — assets.list(): only RAND (the picker is skipped) / no RAND at all
//                                (the empty state) / a single RPL asset (the explanation)
//   ?chain=wrong               — the node answers rand_chainId with a different chain
//   ?rpc=down                  — rpc.call() rejects, for the Test-connection failure state
//   #hash                      — an initial route, same as any real navigation
//
// The unlocked fixture's password is `unlocked-password-1` — the settings screen's re-auth sheet
// (viewing key, spend-key export) wants it.
import { mount } from './app.js';
import { fakeBackend, unlockedBackend } from './test/fake-backend.mjs';
// The real wasm shells' own sentence, so `?canProve=0` previews exactly what they ship — never a
// harness-local paraphrase that can drift from it.
import { CANNOT_PROVE_REASON } from './engine/backend-wasm.js';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') === 'popup' ? 'popup' : 'app';
const theme = params.get('theme');
const state = params.get('state') || 'new';
const scan = params.get('scan');
const activity = params.get('activity');
const faucet = params.get('faucet');
const address = params.get('address');
const canProve = params.get('canProve');
const prove = params.get('prove');
const assetsMode = params.get('assets');
const chain = params.get('chain');
const rpcMode = params.get('rpc');

/** A shielded address at its real length (~1.6 kB), so the Receive screen can be judged honestly. */
function longAddress() {
  const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  let body = '';
  for (let i = 0; i < 1660; i++) body += alphabet[(i * 7 + (i % 13)) % alphabet.length];
  return `rand1${body}`;
}

function richActivityAndNotes() {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const DAY = 86400;
  return {
    activity: [
      { kind: 'in', asset: 0, amount: '1000000000', time: nowSec - 900, hash: `0x${'aa'.repeat(32)}`, index: 3, address: `rand1${'s'.repeat(40)}`, block: 1402914 },
      { kind: 'out', asset: 0, amount: '500000000', time: nowSec - 3600, hash: `0x${'bb'.repeat(32)}`, address: `rand1${'p'.repeat(40)}`, block: 1402918, fee: '2100000', txKey: `tk-${'cd'.repeat(16)}` },
      { kind: 'in', asset: 1, amount: '20000000', time: nowSec - 7200, hash: `0x${'cc'.repeat(32)}`, index: 7, address: `rand1${'w'.repeat(40)}`, block: 1402918 },
      { kind: 'pending', asset: 0, amount: '12000000000', time: nowSec - 60, hash: `0x${'dd'.repeat(32)}`, address: `rand1${'x'.repeat(40)}`, status: 'proving' },
      { kind: 'faucet', asset: 0, amount: '10000000000', time: nowSec - 5400, hash: `0x${'1a'.repeat(32)}` },
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
  } else if (scan === 'silent') {
    backend.sync.scan = () => new Promise(() => {}); // cached data shows; the bar stays indeterminate
  } else if (scan === 'slow') {
    backend.sync.scan = (onProgress) => new Promise((resolve) => {
      if (typeof onProgress === 'function') onProgress({ scanned: 1402600, head: 1402918 });
      setTimeout(async () => {
        const cached = await backend.sync.cached();
        resolve({ ...cached, scannedHeight: 1402918, head: 1402918, lastSyncMs: Date.now() });
      }, 2500);
    });
  }
  if (address === 'long') {
    const full = longAddress();
    const info = await backend.wallet.info().catch(() => ({ pk: '' }));
    backend.wallet.info = async () => ({ ...info, address: full });
  }
  if (faucet === 'fail') {
    backend.faucet.request = async () => { throw new Error('This address already claimed RAND today. Try again in 11h 24m.'); };
  }

  // ---- the send flow ----
  if (canProve !== null) {
    backend.send.canProve = canProve === '1'
      ? async () => ({ ok: true })
      : async () => ({ ok: false, reason: CANNOT_PROVE_REASON });
  }
  if (assetsMode === 'one') {
    const [rand] = await backend.assets.list();
    backend.assets.list = async () => [rand];
  } else if (assetsMode === 'none') {
    const all = await backend.assets.list();
    backend.assets.list = async () => all.filter((a) => a.index !== 0);
  } else if (assetsMode === 'rpl') {
    const all = await backend.assets.list();
    backend.assets.list = async () => all.filter((a) => a.index === 1);
  }
  if (prove === 'ok') {
    backend.send.send = async (_req, onPhase) => {
      for (const phase of ['selecting', 'witness', 'proving', 'submitting', 'confirming']) onPhase(phase);
      return { hash: `0x${'ab'.repeat(32)}`, txKey: `tk1${'x8f4k2m0p7z3v6n9c1b4a7s2d5f8g1h4j7'.repeat(2)}` };
    };
  } else if (prove === 'fail') {
    backend.send.send = async (_req, onPhase) => {
      onPhase('selecting');
      onPhase('witness');
      onPhase('proving');
      await new Promise((r) => setTimeout(r, 400));
      throw new Error('RuntimeError: unreachable');
    };
  } else if (prove === 'unknown') {
    // The dangerous case: the transaction left this device and then the answer did not come back.
    backend.send.send = async (_req, onPhase) => {
      for (const phase of ['selecting', 'witness', 'proving', 'submitting']) onPhase(phase);
      await new Promise((r) => setTimeout(r, 400));
      const err = new Error('Timed out waiting for the node to acknowledge the transaction.');
      err.hash = `0x${'ab'.repeat(32)}`; // the backend got far enough to have one
      throw err;
    };
  } else if (prove === 'slow') {
    // Walks a phase every 1.5 s and never finishes on its own: the state a screenshot of the ring
    // needs. `window.__finish()` ends it, so a screenshot can also catch what happens when a proof
    // lands while the user is somewhere else.
    backend.send.send = (_req, onPhase) => new Promise((resolve) => {
      const phases = ['selecting', 'witness', 'proving'];
      let i = 0;
      onPhase(phases[0]);
      const ticking = setInterval(() => { i = Math.min(i + 1, phases.length - 1); onPhase(phases[i]); }, 1500);
      window.__finish = () => {
        clearInterval(ticking);
        onPhase('submitting');
        onPhase('confirming');
        resolve({ hash: `0x${'ab'.repeat(32)}`, txKey: `tk1${'x8f4k2m0p7z3v6n9c1b4a7s2d5f8g1h4j7'.repeat(2)}` });
      };
    });
  }

  // ---- the node, for settings ----
  if (chain === 'wrong') {
    backend.rpc.call = async (method) => (method === 'rand_chainId' ? 42 : { height: 1402918, peers: 6, syncing: false });
  } else if (rpcMode === 'down') {
    backend.rpc.call = async () => { throw new Error('Cannot reach the node at 127.0.0.1:8899 — timed out after 8s.'); };
  }

  window.__app = await mount(document.body, backend, { mode });
}

init();
