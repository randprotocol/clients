// Where a page opens when a remote proof was left pending — typically an extension popup closed
// mid-proof (ui/backend.js `send.pending?`). The job lives in session storage; the send screen's
// and the withdraw screen's mount hooks carry it on through `send.resume`. This only decides which
// of the two to open, before the shell mounts.

/**
 * `'#send'` for a pending transfer, `'#withdraw'` for a pending burn, `null` when nothing is
 * pending. `send.pending` is OPTIONAL in the contract, and a failure to read it is the same as
 * there being none — booting must never fail over it.
 */
export async function pendingRoute(backend) {
  const pendingFn = backend && backend.send && backend.send.pending;
  if (typeof pendingFn !== 'function') return null;
  let pending;
  try {
    pending = await pendingFn.call(backend.send);
  } catch {
    return null;
  }
  if (!pending || typeof pending !== 'object') return null;
  return pending.kind === 'burn' ? '#withdraw' : '#send';
}
