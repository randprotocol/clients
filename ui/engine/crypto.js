// The spend key at rest: AES-256-GCM under a key derived from the user's password with
// PBKDF2-SHA256, 600 000 iterations (OWASP 2023). Salt and IV are fresh per encryption.
//
// Platform-agnostic (task 1.6): only WebCrypto, `btoa`/`atob` and `TextEncoder`, all of which
// exist in a page, in a browser-extension worker and under Node. Nothing here reads or writes
// storage — a vault is a plain JSON object the caller keeps wherever it keeps things.
//
// The cost is the point. `unlock` and `wallet.verifyPassword` both run this full derivation over
// the real vault; a cheaper check (a stored hash, an early exit) would be an oracle that tests
// passwords faster than unlocking ever could, which is the whole of the wallet's at-rest security.
export const ITERATIONS = 600_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password, salt, iterations, usage) {
  const base = await crypto.subtle.importKey('raw', enc.encode(String(password).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    usage,
  );
}

/** Returns a vault object safe to persist. */
export async function encryptSecret(password, plaintext) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, ITERATIONS, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext)));
  return { v: 1, kdf: 'pbkdf2-sha256', iter: ITERATIONS, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

/**
 * Throws `wrong password` on a wrong password (GCM authentication fails).
 *
 * The vault's own `iter` is honoured so a vault written by an older build still opens, but it is
 * clamped to at least ITERATIONS: a vault is attacker-writable if the storage it sits in is, and
 * `{"iter": 1}` would otherwise turn the KDF off.
 */
export async function decryptSecret(password, vault) {
  if (!vault || typeof vault !== 'object' || !vault.salt || !vault.iv || !vault.ct) {
    throw new Error('wrong password');
  }
  const iterations = Math.max(ITERATIONS, Number(vault.iter) || 0);
  const key = await deriveKey(password, unb64(vault.salt), iterations, ['decrypt']);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, key, unb64(vault.ct));
    return dec.decode(pt);
  } catch {
    throw new Error('wrong password');
  }
}
