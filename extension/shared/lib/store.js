// Persistence. `storage.local` holds public wallet facts, the encrypted vault, settings and
// the note store (a cache of chain data, rescannable from leaf 0). `storage.session` holds the
// unlocked spend key in memory only; background.js clears it on the auto-lock alarm.
import { ext } from './browser.js';

export const DEFAULTS = Object.freeze({
  rpcUrl: 'https://rpc.randprotocol.org',
  chainId: 8,
  autoLockMin: 15,
  theme: 'system', // system | dark | light
  explorerUrl: 'https://randscan.org',
});

export function emptyNoteStore() {
  return { scanned_index: 0, scanned_height: 0, scanned_attest_height: 0, notes: [], sent: [], submissions: [], last_sync_ms: 0, head: 0 };
}

const local = () => ext.storage.local;
const session = () => ext.storage.session;

export async function getSettings() {
  const { settings } = await local().get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}
export async function setSettings(patch) {
  const s = await getSettings();
  const next = { ...s, ...patch };
  await local().set({ settings: next });
  return next;
}

/** Public wallet facts: address, pk, viewing key hidden until asked. */
export async function getWallet() { return (await local().get('wallet')).wallet || null; }
export async function setWallet(wallet) { await local().set({ wallet }); }
export async function getVault() { return (await local().get('vault')).vault || null; }
export async function setVault(vault) { await local().set({ vault }); }

export async function getNoteStore() {
  const { notes } = await local().get('notes');
  return { ...emptyNoteStore(), ...(notes || {}) };
}
export async function setNoteStore(notes) { await local().set({ notes }); }

export async function wipeAll() {
  await local().clear();
  try { await session().clear(); } catch {}
}

// ---- unlock session ----
export async function getUnlocked() {
  try {
    const { unlocked } = await session().get('unlocked');
    if (!unlocked) return null;
    if (unlocked.expires && Date.now() > unlocked.expires) { await lock(); return null; }
    return unlocked; // { spend_key, viewing_key, expires }
  } catch { return null; }
}
export async function setUnlocked(spend_key, viewing_key) {
  const { autoLockMin } = await getSettings();
  const expires = autoLockMin > 0 ? Date.now() + autoLockMin * 60_000 : 0;
  await session().set({ unlocked: { spend_key, viewing_key, expires } });
  try {
    await ext.alarms.clear('autolock');
    if (autoLockMin > 0) await ext.alarms.create('autolock', { delayInMinutes: autoLockMin });
  } catch {}
}
export async function touchUnlock() {
  const u = await getUnlocked();
  if (u) await setUnlocked(u.spend_key, u.viewing_key);
}
export async function lock() {
  try { await session().remove('unlocked'); } catch {}
  try { await ext.alarms.clear('autolock'); } catch {}
}
