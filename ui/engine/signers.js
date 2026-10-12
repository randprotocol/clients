// Private multisig signer profiles (spec docs/superpowers/specs/2026-10-11-msauth-signing-design.md
// §3, §4) for the shared engine: web, extension, desktop.
//
// A profile is {label, policy, seed}; both halves are secret (the seed signs, the policy's `msk`
// sees every note of the account). Storage holds two vault records: `signerPolicies`, ONE
// `encryptSecret` record of every profile's {id, label, policy, index, policyHash}, opened at unlock
// into the session beside the spend key; and `signerSeeds`, one `encryptBytes` record per seed,
// opened only by `sign()` with the password typed for that signature — never at unlock, never kept.
import { encryptSecret, decryptSecret, encryptBytes, decryptBytes } from './crypto.js';
import { t } from '../i18n.js';

export const SIGNER_POLICIES_KEY = 'signerPolicies';
export const SIGNER_SEEDS_KEY = 'signerSeeds';
/** Blocks a proposal needs before its window closes: the CLI's `EXPIRY_MARGIN` (fullnode d5b2e652). */
export const EXPIRY_MARGIN = 16;

export class SignerRefusal extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'SignerRefusal';
    this.code = code;
    this.definite = true;
    Object.assign(this, detail);
  }
}

/** A pasted or opened file: a leading byte-order mark dropped, whitespace trimmed. */
export function cleanText(s) {
  return String(s ?? '').replace(/^\uFEFF/, '').trim();
}

export const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export function bytesOf(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}
const randomId = () => hexOf(crypto.getRandomValues(new Uint8Array(8)));

function validProfiles(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((p) => p && typeof p.id === 'string' && typeof p.label === 'string' && typeof p.policy === 'string'
    && Number.isInteger(p.index) && typeof p.policyHash === 'string');
}

export function makeSigners(deps) {
  const { c, storage, requireUnlocked, setSession, openVault } = deps;

  async function profiles() {
    const u = await requireUnlocked();
    if (u.signersUnreadable) throw new SignerRefusal('signers-unreadable', t('the saved signer profiles could not be opened; nothing was changed. Restore this device\'s storage or wipe the wallet and restore it from its key'));
    return validProfiles(u.signers);
  }
  async function profileOf(id) {
    const p = (await profiles()).find((x) => x.id === id);
    if (!p) throw new Error(t('No such signer profile.'));
    return p;
  }
  async function requirePassword(password) {
    if ((await openVault(password)) === null) throw new Error('wrong password');
  }
  async function writeProfiles(password, list) {
    await storage.set(SIGNER_POLICIES_KEY, await encryptSecret(password, JSON.stringify(list)));
    await setSession({ ...(await requireUnlocked()), signers: list });
  }
  async function row(p) {
    const info = await c.msauthPolicyInfo(p.policy);
    return { id: p.id, label: p.label, index: p.index, fingerprint: info.fingerprint, threshold: info.threshold, signers: info.signers, address: info.address };
  }
  async function list() {
    return Promise.all((await profiles()).map(row));
  }

  const group = {
    list,
    async preview({ policy, key }) {
      const pol = cleanText(policy);
      const info = await c.msauthPolicyInfo(pol);
      const signer = await c.msauthSignerImport(cleanText(key), pol);
      return { fingerprint: info.fingerprint, threshold: info.threshold, signers: info.signers, address: info.address, policyHash: info.policy_hash, index: signer.index, publicKey: signer.public_key };
    },
    async add({ label, policy, key, password }) {
      const name = String(label ?? '').trim();
      if (!name || [...name].length > 64) throw new Error(t('a signer label is 1-64 characters'));
      const pol = cleanText(policy);
      const info = await c.msauthPolicyInfo(pol);
      const signer = await c.msauthSignerImport(cleanText(key), pol);
      const current = await profiles();
      const same = current.find((p) => p.policyHash === info.policy_hash && p.index === signer.index);
      if (same) throw new Error(t('this signer is already saved as {label}', { label: same.label }));
      await requirePassword(password);
      const id = randomId();
      const seed = bytesOf(signer.seed);
      try {
        const seeds = (await storage.get(SIGNER_SEEDS_KEY)) || {};
        seeds[id] = await encryptBytes(password, seed);
        await storage.set(SIGNER_SEEDS_KEY, seeds);
      } finally {
        seed.fill(0);
      }
      await writeProfiles(password, [...current, { id, label: name, policy: pol, index: signer.index, policyHash: info.policy_hash }]);
      return list();
    },
    async remove(id, password) {
      await profileOf(id);
      await requirePassword(password);
      const seeds = (await storage.get(SIGNER_SEEDS_KEY)) || {};
      delete seeds[id];
      await storage.set(SIGNER_SEEDS_KEY, seeds);
      await writeProfiles(password, (await profiles()).filter((p) => p.id !== id));
      return list();
    },
  };

  /**
   * The profiles, opened with the password that just opened the vault: `{profiles, unreadable}`.
   * A record that exists but does not open (damaged, or from a newer build) is `unreadable: true`
   * and is never overwritten — unlock must not fail on it, but add/remove/list refuse.
   */
  async function openOnUnlock(password) {
    const rec = await storage.get(SIGNER_POLICIES_KEY);
    if (!rec) return { profiles: [], unreadable: false };
    try {
      const list = JSON.parse(await decryptSecret(password, rec));
      if (!Array.isArray(list)) throw new Error('not a list');
      return { profiles: validProfiles(list), unreadable: false };
    } catch {
      return { profiles: [], unreadable: true };
    }
  }

  return { group, openOnUnlock, profileOf, deps, decryptBytes };
}
