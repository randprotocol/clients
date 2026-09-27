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

/** Whether a chain whose limits report `envelopeBytes` carries a memo: exactly 1860, nothing else
 *  (final review, finding 6 — any other value, and no value, is a chain without memos). iOS and
 *  Android gate on the same number. */
export function memoSupportedFor(envelopeBytes) {
  return envelopeBytes === MEMO_ENVELOPE_BYTES;
}
