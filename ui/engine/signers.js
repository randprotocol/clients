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

export const isZero = (a) => (typeof a === 'string' ? /^0+$/.test(a.trim()) : a === 0);

/** A paying output whose asset is a whole number other than 0. Anything else is RAND (fails closed). */
export const isNonRand = (o) => o != null && o.asset != null && o.asset !== '' && Number.isInteger(Number(o.asset)) && Number(o.asset) !== 0;
/** Of the paying outputs, the owner fingerprints that receive a non-RAND asset and those that receive RAND. */
export function payeeAssets(paying) {
  const fp = (o) => (typeof o.owner_fingerprint === 'string' && o.owner_fingerprint !== '' ? o.owner_fingerprint : null);
  const tokenOwners = new Set(paying.filter(isNonRand).map(fp).filter(Boolean));
  const randOwners = new Set(paying.filter((o) => !isNonRand(o)).map(fp).filter(Boolean));
  return { tokenOwners, randOwners };
}

const amountless = (entry) => { const i = String(entry).indexOf(':'); return i < 0 || String(entry).slice(i + 1).trim() === ''; };

/** Whether a checked proposal may be signed now, by the CLI's rule, on this wallet's chain. */
export function verdict({ summary, head, chainId, genesis, url, recipients }) {
  const malformed = () => ({ signable: false, refusal: { code: 'malformed-summary', message: t('The proposal check returned an incomplete answer, so this proposal is not signed.') } });
  if (summary === null || typeof summary !== 'object') return malformed();
  // Spec §4 step 3: never sign on an unchecked payee (a coordinator could pay its own key).
  const unchecked = () => ({ signable: false, refusal: { code: 'unchecked-recipient', message: t('Enter the address of every payee: an output that does not match the address you entered, or whose address is empty, cannot be signed.') } });
  if (summary.recipients_checked !== true) return unchecked();
  // A field the rule reads that is missing or malformed fails closed: NaN compares false.
  const outs = summary.outputs;
  const amountOk = (a) => (typeof a === 'string' ? /^\s*\d+\s*$/.test(a) : Number.isSafeInteger(a) && a >= 0);
  const outputOk = (o) => o !== null && typeof o === 'object' && !Array.isArray(o) && typeof o.to_account === 'boolean' && amountOk(o.amount);
  // The review shows `lines` verbatim: missing, or anything but an array of strings, is malformed.
  if (!Array.isArray(summary.lines) || !summary.lines.every((l) => typeof l === 'string')) return malformed();
  if (!Array.isArray(outs) || !outs.every(outputOk)) return malformed();
  // No intended payment named at all while something pays out: unchecked, whatever the core said.
  const paying = outs.filter((o) => o.to_account !== true && !isZero(o.amount));
  if (Array.isArray(recipients) && recipients.length === 0 && paying.length > 0) return unchecked();
  // An amount pin is required on every entry, except an entry whose own owner fingerprint owns a
  // non-RAND paying output and NO RAND paying output: the core refuses a pin on a non-RAND output,
  // so that entry is the address alone. The exception is per row, so one small non-RAND output
  // cannot unpin the RAND rows, nor the RAND paid to its own payee (1 unit of a token beside an
  // inflated RAND output to the same payee is refused).
  if (Array.isArray(recipients) && recipients.some(amountless)) {
    const exp = summary.expected;
    if (!Array.isArray(exp)) return unchecked();
    const { tokenOwners, randOwners } = payeeAssets(paying);
    const allowed = (entry) => exp.some((x) => x !== null && typeof x === 'object' && x.entry === entry
      && typeof x.fingerprint === 'string' && x.fingerprint !== '' && tokenOwners.has(x.fingerprint)
      && !randOwners.has(x.fingerprint));
    if (!recipients.filter(amountless).every(allowed)) return unchecked();
  }
  if (outs.some((o) => o.to_account !== true && !isZero(o.amount) && !(typeof o.matches === 'string' && o.matches.trim() !== ''))) return unchecked();
  const sound = Number.isSafeInteger(summary.expires_at) && summary.expires_at >= 0
    && Number.isSafeInteger(summary.chain_id)
    && Number.isInteger(summary.binding_domain) && summary.binding_domain >= 0
    && typeof summary.genesis === 'string' && /^[0-9a-fA-F]+$/.test(summary.genesis);
  if (!sound) return malformed();
  if (head == null) {
    return { signable: false, refusal: { code: 'no-node', node: url, message: t('No node answered at {url}, so the expiry cannot be checked and this proposal is not signed. Retry when the node is reachable.', { url: url || '—' }) } };
  }
  if (Number(summary.chain_id) !== Number(chainId)) {
    return { signable: false, refusal: { code: 'wrong-chain', message: t('This proposal is for chain {theirs}; this wallet is on chain {ours}.', { theirs: String(summary.chain_id), ours: String(chainId) }) } };
  }
  if (Number(summary.binding_domain) >= 1 && String(summary.genesis).toLowerCase() !== String(genesis || '').toLowerCase()) {
    return { signable: false, refusal: { code: 'wrong-genesis', message: t('This proposal is bound to another genesis than the one this wallet\'s node serves.') } };
  }
  if (head + EXPIRY_MARGIN >= Number(summary.expires_at)) {
    return { signable: false, refusal: { code: 'expired', message: t('This proposal expires at height {expires} and the chain is at {head}: too late to sign. Ask for a new proposal.', { expires: String(summary.expires_at), head: String(head) }) } };
  }
  return { signable: true, head, blocksLeft: Number(summary.expires_at) - head };
}

// Intended payments, `addr:amount` each, passed in full and unchanged but for cleanText: an entry
// that is blank or lacks its address or its amount is never dropped, it is refused.
const payees = (list) => (Array.isArray(list) ? list : []).map(cleanText);
// An empty address is always refused; a missing amount only once the summary shows no non-RAND output.
const blankPayee = (list) => payees(list).some((a) => a === '' || a.startsWith(':'));
const blankRefusal = () => new SignerRefusal('unchecked-recipient', t('Enter the address of every payee: an output that does not match the address you entered, or whose address is empty, cannot be signed.'));

export function makeSigners(deps) {
  const { c, storage, requireUnlocked, setSession, openVault, passwordAttempt, requireVerifiedChain, getSettings, currentRpcUrl } = deps;

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

  /** The head from a node that passed this wallet's chain check; any failure is "no node". */
  async function judge(summary, recipients) {
    const settings = await getSettings();
    let url = '';
    try { url = await currentRpcUrl(); } catch { /* no endpoint configured */ }
    try {
      const { client, url: u, identity } = await requireVerifiedChain();
      const h = await client.head();
      const height = Number(h && h.height);
      if (!Number.isSafeInteger(height) || height < 0) throw new Error('no height');
      return verdict({ summary, head: height, chainId: settings.chainId, genesis: identity && identity.genesis, url: u, recipients });
    } catch {
      return verdict({ summary, head: null, url, recipients });
    }
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
    // The proposal is a parameter, never stored: it carries the account's witness (§3).
    async check(id, proposal, expectedRecipients = []) {
      const p = await profileOf(id);
      if (blankPayee(expectedRecipients)) { const r = blankRefusal(); return { summary: null, signable: false, refusal: { code: r.code, message: r.message } }; }
      const summary = await c.msauthCheck(cleanText(proposal), p.policy, payees(expectedRecipients));
      return { summary, ...(await judge(summary, payees(expectedRecipients))) };
    },
    async sign(id, proposal, expectedRecipients, password) {
      const p = await profileOf(id);
      const text = cleanText(proposal);
      if (blankPayee(expectedRecipients)) throw blankRefusal();
      const summary = await c.msauthCheck(text, p.policy, payees(expectedRecipients));
      const v = await judge(summary, payees(expectedRecipients));
      if (!v.signable) throw new SignerRefusal(v.refusal.code, v.refusal.message, { node: v.refusal.node });
      const rec = ((await storage.get(SIGNER_SEEDS_KEY)) || {})[id];
      if (!rec) throw new Error(t('This signer profile has no key on this device: remove it and add it again.'));
      const seed = await passwordAttempt(() => decryptBytes(password, rec));
      if (!seed) throw new Error('wrong password');
      try {
        // The backoff above can last up to 30 s: re-read the head and re-run the rule before signing.
        const again = await judge(summary, payees(expectedRecipients));
        if (!again.signable) throw new SignerRefusal(again.refusal.code, again.refusal.message, { node: again.refusal.node });
        // The hex copy below cannot be wiped (a JS string); it is unreachable after this call, and
        // wallet-core holds its own copy in Zeroizing. The bytes are wiped here.
        // The same list the check used: the core re-runs the payee check and refuses on its own.
        const share = await c.msauthSign(text, p.policy, hexOf(seed), payees(expectedRecipients));
        return { share, index: Number(String(share).split(':')[0]) };
      } finally {
        seed.fill(0);
      }
    },
    async verifyShare(id, proposal, share) {
      const p = await profileOf(id);
      const s = cleanText(share);
      await c.msauthVerifyShare(cleanText(proposal), p.policy, s);
      return { index: Number(s.split(':')[0].trim()) };
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

  return { group, openOnUnlock, profileOf, deps };
}
