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
//
// **Three outcomes, not two.** A wrong password and a *damaged* vault used to be the same error,
// which meant a user whose storage had been corrupted could only sit there typing a password that
// could never work, watching the backoff grow, with no way out but a wipe. So the record's
// structure is checked before the KDF runs, and the two failures that are not "wrong password"
// say so — and, in the backend, are not counted as password attempts:
//
//   VaultVersionError  the record is a vault, from a build this one does not understand
//   VaultDamagedError  the record is not a usable vault at all
//   Error('wrong password')  the record is fine and GCM authentication failed — which is the one
//                            case that genuinely cannot be told from a wrong password, by design
export const VAULT_VERSION = 1;
export const ITERATIONS = 600_000;
/** A tampered record must not be able to turn the KDF into a denial of service. */
const MAX_ITERATIONS = 10_000_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export class VaultDamagedError extends Error {
  constructor(detail) {
    super('wallet data is damaged');
    this.name = 'VaultDamagedError';
    this.code = 'VAULT_DAMAGED';
    /** Never shown to the user; for a log. */
    this.detail = detail;
    /** The UI's cue to offer restore-from-key (wipe + import) instead of another password. */
    this.recoverable = true;
  }
}

export class VaultVersionError extends Error {
  constructor(version) {
    super('this wallet was saved by a newer version of Rand Wallet');
    this.name = 'VaultVersionError';
    this.code = 'VAULT_VERSION';
    this.version = version;
    this.recoverable = true;
  }
}

/** True for either of the two "this is not a password problem" failures. */
export function isVaultRecordError(err) {
  return !!err && (err.name === 'VaultDamagedError' || err.name === 'VaultVersionError');
}

function base64Field(vault, name, { minBytes, maxBytes }) {
  const value = vault[name];
  if (typeof value !== 'string' || value === '' || !BASE64_RE.test(value)) {
    throw new VaultDamagedError(`${name} is not base64`);
  }
  // 4 base64 characters per 3 bytes; close enough to bound the field without decoding it.
  const bytes = Math.floor((value.length * 3) / 4);
  if (bytes < minBytes || bytes > maxBytes) throw new VaultDamagedError(`${name} is ${bytes} bytes`);
  return value;
}

/**
 * Checks that `vault` is a vault this build can *attempt*, before a single PBKDF2 iteration runs.
 * Throws `VaultVersionError` or `VaultDamagedError`; returns the iteration count to use.
 */
export function checkVault(vault) {
  if (!vault || typeof vault !== 'object' || Array.isArray(vault)) throw new VaultDamagedError('not an object');
  // Version first: a newer build's vault may legitimately have fields this one would call damaged.
  if (vault.v !== undefined && vault.v !== null) {
    if (!Number.isInteger(vault.v) || vault.v < 1) throw new VaultDamagedError(`v is ${String(vault.v)}`);
    if (vault.v > VAULT_VERSION) throw new VaultVersionError(vault.v);
  }
  if (vault.kdf !== undefined && vault.kdf !== 'pbkdf2-sha256') throw new VaultDamagedError(`kdf is ${String(vault.kdf).slice(0, 32)}`);
  const iter = vault.iter === undefined ? ITERATIONS : vault.iter;
  if (!Number.isSafeInteger(iter) || iter < ITERATIONS || iter > MAX_ITERATIONS) {
    throw new VaultDamagedError(`iter is ${String(iter)}`);
  }
  base64Field(vault, 'salt', { minBytes: 16, maxBytes: 64 });
  base64Field(vault, 'iv', { minBytes: 12, maxBytes: 16 });
  // The plaintext is a 64-character spend key; the ciphertext is that plus a 16-byte GCM tag.
  base64Field(vault, 'ct', { minBytes: 16, maxBytes: 4096 });
  return iter;
}

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
  return { v: VAULT_VERSION, kdf: 'pbkdf2-sha256', iter: ITERATIONS, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

/**
 * Opens a vault. Throws `VaultVersionError`/`VaultDamagedError` for a record that could never be
 * opened by any password (neither of which is a failed attempt), and plain `wrong password` when
 * GCM authentication fails on a record that was otherwise sound.
 *
 * The vault's own `iter` is honoured, so a record written by an older build still opens, but
 * `checkVault` has already refused anything below `ITERATIONS` — a vault is attacker-writable if
 * the storage it sits in is, and `{"iter": 1}` would otherwise turn the KDF off.
 */
export async function decryptSecret(password, vault) {
  const iterations = checkVault(vault);
  const key = await deriveKey(password, unb64(vault.salt), iterations, ['decrypt']);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, key, unb64(vault.ct));
    return dec.decode(pt);
  } catch {
    throw new Error('wrong password');
  }
}
