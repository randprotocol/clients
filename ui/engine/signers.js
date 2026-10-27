// Private multisig signer profiles (spec docs/superpowers/specs/2026-10-11-msauth-signing-design.md
// §3, §4) for the shared engine: web, extension, desktop.
//
// A profile is {label, policy, seed}; both halves are secret (the seed signs, the policy's `msk`
// sees every note of the account). Storage holds two vault records: `signerPolicies`, ONE
// `encryptSecret` record of every profile's {id, label, policy, index, policyHash}, opened at unlock
// into the session beside the spend key; and `signerSeeds`, one `encryptBytes` record per seed,
// opened only by `sign()` with the password typed for that signature — never at unlock, never kept.
import { encryptSecret, decryptSecret, encryptBytes, decryptBytes } from './crypto.js';
import { formatUnits, parseUnits } from '../lib/format.js';
import { t } from '../i18n.js';

export const SIGNER_POLICIES_KEY = 'signerPolicies';
export const SIGNER_SEEDS_KEY = 'signerSeeds';
/**
 * The `signerPolicies` record's ciphertext cap, on write and on read (MSC-1). It holds every
 * profile's policy text: a real 2-of-3 policy (fullnode's vector) is 8 029 bytes, so the vault's
 * 4 096-byte spend-key cap — which used to apply here on READ alone — made one saved profile
 * unreadable at the next lock. 256 KiB is some thirty such policies.
 */
export const SIGNER_POLICIES_RECORD_BYTES = 256 << 10;
/** Blocks a proposal needs before its window closes: the CLI's `EXPIRY_MARGIN` (fullnode d5b2e652). */
export const EXPIRY_MARGIN = 16;
/**
 * The fee a signer accepts unless its profile says otherwise: 0.1 RAND, in base units (1 RAND =
 * 10^9, the unit the core's summary writes `fee` in). The binding a signer signs covers the fee
 * (randprotocol-msig), so a client rule must read it (MSC-2): a signer who pinned the payee and
 * the amount would otherwise sign a fee that takes the rest of the account. A profile's `maxFee`
 * (base units, decimal text) replaces this; see `verdict`.
 */
export const DEFAULT_MAX_FEE_UNITS = '100000000';

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
/** A profile's fee limit in base units, the default when it has none it can read. */
export const maxFeeOf = (p) => (p && typeof p.maxFee === 'string' && /^\d+$/.test(p.maxFee) ? p.maxFee : DEFAULT_MAX_FEE_UNITS);
/** A fee limit typed in RAND ("0.1") → base units as decimal text; throws for anything but a positive number. */
export function parseMaxFee(text) {
  let units;
  try { units = parseUnits(String(text ?? '').trim()); } catch { units = null; }
  if (units === null || units <= 0n) throw new Error(t('An amount is a number of RAND, such as 1.5.'));
  return units.toString();
}

/**
 * The signer index a share `"i:hex"` names, read the way the core reads it (randprotocol-msig
 * `parse_share`: the text before the first `:`, trimmed, a u8) but stricter — decimal digits only,
 * no sign — and checked against the policy's signer count when it is given. Throws for anything
 * else: `Number()` read "", " ", "0x1" and "1e0" as indexes, so a pasted share could be counted
 * under a signer it does not name.
 */
export function shareIndexOf(share, signers) {
  const text = String(share ?? '');
  const colon = text.indexOf(':');
  const head = colon < 0 ? '' : text.slice(0, colon).trim();
  if (!/^\d{1,3}$/.test(head) || Number(head) > 255) throw new Error(t('a share is index:hex'));
  const index = Number(head);
  if (Number.isInteger(signers) && index >= signers) {
    throw new Error(t('signer {index} is not in this policy (it has {count} signers)', { index: String(index), count: String(signers) }));
  }
  return index;
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

/**
 * Whether a checked proposal may be signed now, by the CLI's rule, on this wallet's chain.
 * `maxFee` is the signer profile's fee limit in base units (`DEFAULT_MAX_FEE_UNITS` when absent or
 * unreadable). The fee rule (MSC-2) refuses a fee over that limit, and a fee over the RAND the
 * proposal pays out (change is not a payment; a token is not RAND, so a token-only proposal is
 * bounded by the limit alone). It needs no node, and comes after the payee rule.
 */
export function verdict({ summary, head, chainId, genesis, url, recipients, maxFee }) {
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
    && typeof summary.genesis === 'string' && /^[0-9a-fA-F]+$/.test(summary.genesis)
    && amountOk(summary.fee);
  if (!sound) return malformed();
  const fee = BigInt(String(summary.fee).trim());
  const limit = BigInt(maxFeeOf({ maxFee: typeof maxFee === 'string' ? maxFee : String(maxFee ?? '') }));
  if (fee > limit) {
    return { signable: false, refusal: { code: 'fee-too-high', message: t('The fee of {fee} RAND is more than this signer allows ({max} RAND), so this proposal is not signed. Raise the signer\'s fee limit or ask for a new proposal.', { fee: formatUnits(fee), max: formatUnits(limit) }) } };
  }
  const randPaid = paying.filter((o) => !isNonRand(o)).reduce((sum, o) => sum + BigInt(String(o.amount).trim()), 0n);
  if (randPaid > 0n && fee > randPaid) {
    return { signable: false, refusal: { code: 'fee-too-high', message: t('The fee of {fee} RAND is more than the {paid} RAND this proposal pays out, so this proposal is not signed.', { fee: formatUnits(fee), paid: formatUnits(randPaid) }) } };
  }
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

  // Why the profiles record did not open, in the user's words (never "unreadable" alone).
  const REASONS = {
    oversize: () => t('the record is larger than this build allows'),
    damaged: () => t('the record is damaged'),
    newer: () => t('the record was saved by a newer version of Rand Wallet'),
    closed: () => t('the record does not open with this password'),
  };
  async function profiles() {
    const u = await requireUnlocked();
    if (u.signersUnreadable) {
      const cause = REASONS[u.signersUnreadableCause] ? u.signersUnreadableCause : 'damaged';
      throw new SignerRefusal('signers-unreadable', t('the saved signer profiles could not be opened ({reason}); nothing was changed. Restore this device\'s storage or wipe the wallet and restore it from its key', { reason: REASONS[cause]() }), { reason: cause });
    }
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
    await storage.set(SIGNER_POLICIES_KEY, await encryptSecret(password, JSON.stringify(list), { maxBytes: SIGNER_POLICIES_RECORD_BYTES }));
    await setSession({ ...(await requireUnlocked()), signers: list });
  }
  async function row(p) {
    const info = await c.msauthPolicyInfo(p.policy);
    return { id: p.id, label: p.label, index: p.index, fingerprint: info.fingerprint, threshold: info.threshold, signers: info.signers, address: info.address, maxFee: maxFeeOf(p) };
  }
  async function list() {
    return Promise.all((await profiles()).map(row));
  }

  /** The head from a node that passed this wallet's chain check; any failure is "no node". */
  async function judge(summary, recipients, profile) {
    const settings = await getSettings();
    const maxFee = maxFeeOf(profile);
    let url = '';
    try { url = await currentRpcUrl(); } catch { /* no endpoint configured */ }
    try {
      const { client, url: u, identity } = await requireVerifiedChain();
      const h = await client.head();
      const height = Number(h && h.height);
      if (!Number.isSafeInteger(height) || height < 0) throw new Error('no height');
      return verdict({ summary, head: height, chainId: settings.chainId, genesis: identity && identity.genesis, url: u, recipients, maxFee });
    } catch {
      return verdict({ summary, head: null, url, recipients, maxFee });
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
    async add({ label, policy, key, password, maxFee }) {
      const name = String(label ?? '').trim();
      if (!name || [...name].length > 64) throw new Error(t('a signer label is 1-64 characters'));
      const limit = maxFee === undefined || maxFee === null || String(maxFee).trim() === '' ? DEFAULT_MAX_FEE_UNITS : parseMaxFee(maxFee);
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
      await writeProfiles(password, [...current, { id, label: name, policy: pol, index: signer.index, policyHash: info.policy_hash, maxFee: limit }]);
      return list();
    },
    /** The profile's fee limit, typed in RAND; under the password, like every change to the record. */
    async setMaxFee(id, maxFee, password) {
      await profileOf(id);
      const limit = parseMaxFee(maxFee);
      await requirePassword(password);
      await writeProfiles(password, (await profiles()).map((p) => (p.id === id ? { ...p, maxFee: limit } : p)));
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
      return { summary, ...(await judge(summary, payees(expectedRecipients), p)) };
    },
    async sign(id, proposal, expectedRecipients, password) {
      const p = await profileOf(id);
      const text = cleanText(proposal);
      if (blankPayee(expectedRecipients)) throw blankRefusal();
      const summary = await c.msauthCheck(text, p.policy, payees(expectedRecipients));
      const v = await judge(summary, payees(expectedRecipients), p);
      if (!v.signable) throw new SignerRefusal(v.refusal.code, v.refusal.message, { node: v.refusal.node });
      const rec = ((await storage.get(SIGNER_SEEDS_KEY)) || {})[id];
      if (!rec) throw new Error(t('This signer profile has no key on this device: remove it and add it again.'));
      const seed = await passwordAttempt(() => decryptBytes(password, rec));
      if (!seed) throw new Error('wrong password');
      try {
        // The backoff above can last up to 30 s: re-read the head and re-run the rule before signing.
        const again = await judge(summary, payees(expectedRecipients), p);
        if (!again.signable) throw new SignerRefusal(again.refusal.code, again.refusal.message, { node: again.refusal.node });
        // The hex copy below cannot be wiped (a JS string); it is unreachable after this call, and
        // wallet-core holds its own copy in Zeroizing. The bytes are wiped here.
        // The same list the check used: the core re-runs the payee check and refuses on its own.
        const share = await c.msauthSign(text, p.policy, hexOf(seed), payees(expectedRecipients));
        const index = shareIndexOf(share);
        // The core signs as the policy position this seed's key holds, which is the profile's.
        if (index !== p.index) throw new Error(`the core returned a share for signer ${index}; this profile is signer ${p.index}`);
        return { share: String(share), index };
      } finally {
        seed.fill(0);
      }
    },
    async verifyShare(id, proposal, share) {
      const p = await profileOf(id);
      const s = cleanText(share);
      const info = await c.msauthPolicyInfo(p.policy);
      const index = shareIndexOf(s, info.signers);
      await c.msauthVerifyShare(cleanText(proposal), p.policy, s);
      return { index };
    },
  };

  /**
   * The profiles, opened with the password that just opened the vault: `{profiles, unreadable,
   * cause}`. A record that exists but does not open is `unreadable: true` and is never
   * overwritten — unlock must not fail on it, but add/remove/list refuse, naming `cause`:
   * `oversize` (over `SIGNER_POLICIES_RECORD_BYTES`), `newer` (a later build's record), `closed`
   * (sound, but not this password's) or `damaged` (anything else). An absent record is simply no
   * profiles.
   */
  async function openOnUnlock(password) {
    const rec = await storage.get(SIGNER_POLICIES_KEY);
    if (!rec) return { profiles: [], unreadable: false };
    try {
      const list = JSON.parse(await decryptSecret(password, rec, { maxBytes: SIGNER_POLICIES_RECORD_BYTES }));
      if (!Array.isArray(list)) throw new Error('not a list');
      return { profiles: validProfiles(list), unreadable: false };
    } catch (err) {
      const cause = err && err.name === 'VaultVersionError' ? 'newer'
        : err && err.name === 'VaultDamagedError' ? (err.reason === 'oversize' ? 'oversize' : 'damaged')
          : err && err.message === 'wrong password' ? 'closed' : 'damaged';
      return { profiles: [], unreadable: true, cause };
    }
  }

  return { group, openOnUnlock, profileOf, deps };
}
