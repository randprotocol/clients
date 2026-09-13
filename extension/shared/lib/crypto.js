// The spend key at rest: AES-256-GCM under a key derived from the user's password with
// PBKDF2-SHA256, 600 000 iterations (OWASP 2023). Salt and IV are fresh per encryption.
const ITER = 600_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password, salt, usage) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, usage);
}

/** Returns a vault object safe to persist. */
export async function encryptSecret(password, plaintext) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext)));
  return { v: 1, kdf: 'pbkdf2-sha256', iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

/** Throws on a wrong password (GCM authentication fails). */
export async function decryptSecret(password, vault) {
  const key = await deriveKey(password, unb64(vault.salt), ['decrypt']);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, key, unb64(vault.ct));
    return dec.decode(pt);
  } catch {
    throw new Error('wrong password');
  }
}
