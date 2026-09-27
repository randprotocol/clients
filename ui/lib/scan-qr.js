// Scanning a QR code with the browser's own camera API (spec 2026-09-26 §3.3): the extensions and
// the web wallet use it when the browser has one and the user grants the camera, and fall back to
// paste. Native shells (iOS, Android, desktop) scan through `platform.scanQr?()` instead; the send
// screen prefers that where it exists.
//
//   const text = await scanQr(videoEl, { signal });   // the first code's raw text
//
// `BarcodeDetector` (Shape Detection API) decodes; `navigator.mediaDevices.getUserMedia` supplies
// the frames. Where either is missing this rejects at once with the sentence the screen shows, and
// the camera button is not offered in the first place (`canScanQr`). The stream is always stopped
// — on a result, a failure or an abort — so the camera light never stays on behind the wallet.

export const NO_CAMERA_TEXT = 'camera scanning is not available here; paste the link';

/** True where this browser can plausibly scan (the user may still refuse the camera). */
export function canScanQr() {
  return 'BarcodeDetector' in globalThis
    && typeof globalThis.navigator?.mediaDevices?.getUserMedia === 'function';
}

function abortError() {
  const err = new Error('The scan was cancelled.');
  err.name = 'AbortError';
  return err;
}

/**
 * Resolves with the first QR code's raw text seen through `videoEl`, or rejects: with
 * `NO_CAMERA_TEXT` where the browser has no detector or no camera API, with the browser's own
 * error where the user refuses the camera, and with an `AbortError` when `options.signal` aborts.
 */
export async function scanQr(videoEl, { signal, intervalMs = 200 } = {}) {
  if (!('BarcodeDetector' in globalThis)) throw new Error(NO_CAMERA_TEXT);
  const media = globalThis.navigator?.mediaDevices;
  if (!media || typeof media.getUserMedia !== 'function') throw new Error(NO_CAMERA_TEXT);
  if (signal?.aborted) throw abortError();

  let detector;
  try {
    detector = new globalThis.BarcodeDetector({ formats: ['qr_code'] });
  } catch {
    throw new Error(NO_CAMERA_TEXT);
  }
  const stream = await media.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  const stop = () => {
    for (const track of stream.getTracks?.() || []) { try { track.stop(); } catch { /* already stopped */ } }
    try { videoEl.srcObject = null; } catch { /* a detached element */ }
  };
  try {
    videoEl.srcObject = stream;
    videoEl.setAttribute?.('playsinline', '');
    videoEl.muted = true;
    await videoEl.play?.();
    return await new Promise((resolve, reject) => {
      let timer = null;
      const onAbort = () => { clearTimeout(timer); reject(abortError()); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const tick = async () => {
        if (signal?.aborted) return;
        try {
          const codes = await detector.detect(videoEl);
          const hit = (codes || []).find((c) => typeof c?.rawValue === 'string' && c.rawValue);
          if (hit) {
            signal?.removeEventListener('abort', onAbort);
            resolve(hit.rawValue);
            return;
          }
        } catch { /* a frame not ready yet — try the next one */ }
        timer = setTimeout(tick, intervalMs);
      };
      tick();
    });
  } finally {
    stop();
  }
}
