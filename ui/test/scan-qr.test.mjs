// ui/lib/scan-qr.js — the browser camera path of the send and contacts screens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanQr, canScanQr, NO_CAMERA_TEXT } from '../lib/scan-qr.js';

function fakeVideo() {
  return { srcObject: null, muted: false, setAttribute() {}, async play() {} };
}

function withCamera(t, { codes = [[{ rawValue: 'randpay:rand1x' }]] } = {}) {
  const stopped = [];
  const hadDetector = 'BarcodeDetector' in globalThis;
  const oldDetector = globalThis.BarcodeDetector;
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let frame = 0;
  globalThis.BarcodeDetector = class { async detect() { const c = codes[Math.min(frame, codes.length - 1)]; frame += 1; return c; } };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped.push(true) }] }) } },
  });
  t.after(() => {
    if (hadDetector) globalThis.BarcodeDetector = oldDetector; else delete globalThis.BarcodeDetector;
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator;
  });
  return { stopped };
}

test('without BarcodeDetector the scan refuses with the paste sentence, and nothing offers it', async () => {
  assert.equal('BarcodeDetector' in globalThis, false, 'Node has no detector');
  assert.equal(canScanQr(), false);
  await assert.rejects(scanQr(fakeVideo()), (err) => err.message === NO_CAMERA_TEXT);
  assert.equal(NO_CAMERA_TEXT, 'camera scanning is not available here; paste the link');
});

test('with a detector and a camera, the first code is the answer and the camera is released', async (t) => {
  const { stopped } = withCamera(t, { codes: [[], [{ rawValue: '' }], [{ rawValue: 'randpay:rand1abc' }]] });
  assert.equal(canScanQr(), true);
  const video = fakeVideo();
  const text = await scanQr(video, { intervalMs: 1 });
  assert.equal(text, 'randpay:rand1abc');
  assert.equal(stopped.length, 1, 'the track was stopped');
  assert.equal(video.srcObject, null);
});

test('an abort cancels the scan and still releases the camera', async (t) => {
  const { stopped } = withCamera(t, { codes: [[]] });
  const ctl = new AbortController();
  const pending = scanQr(fakeVideo(), { signal: ctl.signal, intervalMs: 1 });
  setTimeout(() => ctl.abort(), 10);
  await assert.rejects(pending, (err) => err.name === 'AbortError');
  assert.equal(stopped.length, 1);
});
