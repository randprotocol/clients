// How a memo is shown (spec 2026-09-26 §2.3; final whole-branch reviews 1 and 2).
//
// A memo is anyone's text: memos are live on chains 14 and 15 (the ledger accepts a 1860-byte
// envelope anywhere under the 2048 cap), so anyone can pay a dust note carrying any memo to any
// public address, and a randpay: link can carry any memo. It always goes onto the page as a text
// node, so it can never be markup; this is the other half — one rule, the same on every surface
// (the CLI's `memo_display::sanitize`, iOS and Android `Memo.display`, randprotocol.org's
// `/account`), applied BEFORE any truncation:
//
//   - every control character, Unicode category Cc (C0 — tab and newline too — DEL and C1),
//     every format character, Cf (the bidi embeddings, overrides and isolates, LRM/RLM/ALM, the
//     zero-width space and joiners, U+2060–U+2064, U+FEFF, the soft hyphen, …), and the
//     line/paragraph separators U+2028/U+2029 (Zl, Zp) are shown as U+FFFD, one for one;
//   - every run of space separators, Zs (U+0020, U+00A0, U+2003, U+3000, …), becomes one U+0020,
//     so a memo cannot pad itself out to push a fake "to … · fingerprint …" into view.
//
// Every memo view is also one line that never wraps (`.memo-line`: nowrap + ellipsis).
// Display only: the memo that is sealed and sent is the text as the user or the link gave it.

const NEUTRALISED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const SPACES = /\p{Zs}+/gu;

export const REPLACEMENT = String.fromCodePoint(0xfffd);

/** The memo (or any other stranger-chosen text, like a contact name) as it may be shown. */
export function displayMemo(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(NEUTRALISED, REPLACEMENT).replace(SPACES, ' ');
}

/** The one envelope size that carries a memo: fullnode's `EnvelopeFormat::for_chain` knows 1860
 *  (a 112-byte note plus the 512-byte memo field, sealed) and nothing else. */
export const MEMO_ENVELOPE_BYTES = 1860;

/** The chain ids whose genesis sets no envelope size (fullnode issue #64): chains 14–17, every
 *  chain that ran a build able to seal the memo form. `rand_getLimits.envelope_bytes` is the
 *  node's word, and on such a chain the ledger admits any envelope up to 2 048 bytes, so a node
 *  answering 1860 there would have this wallet seal 1 860-byte envelopes among everyone else's
 *  1 348 — a permanent public tag on its transactions. The memo is never offered on these chains,
 *  whatever the node says, and the core (`wallet_core::LEGACY_ENVELOPE_CHAIN_IDS`, which
 *  `version.legacy_envelope_chain_ids` reports) seals legacy and refuses a memo there regardless.
 *  Chain 18 is cut with `envelope_bytes` 1860, so it is not listed. iOS and Android carry the same
 *  list. */
export const LEGACY_ENVELOPE_CHAIN_IDS = [14, 15, 16, 17];

/** Whether a chain whose limits report `envelopeBytes` carries a memo: exactly 1860, nothing else
 *  (final review, finding 6 — any other value, and no value, is a chain without memos), and never
 *  on a chain id in `LEGACY_ENVELOPE_CHAIN_IDS` (#64). `chainId` may be left out where only the
 *  size is known; the backends' `send.limits` has already applied the pin. iOS and Android gate
 *  on the same number and the same list. */
export function memoSupportedFor(envelopeBytes, chainId) {
  if (chainId !== undefined && chainId !== null && LEGACY_ENVELOPE_CHAIN_IDS.includes(Number(chainId))) return false;
  return envelopeBytes === MEMO_ENVELOPE_BYTES;
}
