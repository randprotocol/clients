// How a memo is shown (spec 2026-09-26 §2.3; final whole-branch review, finding 3).
//
// A memo is somebody else's text: the sender's, or — on the confirmation before a send — whoever
// made the randpay: link. It always goes onto the page as a text node, so it can never be markup;
// this is the other half. A line break could draw a second "to … · fingerprint …" line under the
// real one, and a bidi control (U+202A–U+202E, U+2066–U+2069, the LRM/RLM/ALM marks) could
// reorder what is shown around it. So every control character — Unicode category Cc (C0, DEL,
// C1), the bidi controls and marks, and the line/paragraph separators U+2028/U+2029 — is shown as
// U+FFFD, visibly, one for one. Ordinary spaces and every other character are left alone.
//
// Display only: the memo that is sealed and sent is the text as the user or the link gave it.
// iOS (`Memo.display`) and Android (`Memo.display`) apply exactly the same set.

const hex = (n) => n.toString(16).padStart(4, '0');
const range = (a, b) => `\\u${hex(a)}-\\u${hex(b)}`;
const one = (a) => `\\u${hex(a)}`;

// Built from code points so the source holds no invisible characters.
const NEUTRALISED = new RegExp(`[${[
  range(0x0000, 0x001f), // C0
  range(0x007f, 0x009f), // DEL and C1
  one(0x061c), // ARABIC LETTER MARK
  range(0x200e, 0x200f), // LRM, RLM
  range(0x2028, 0x2029), // LINE SEPARATOR, PARAGRAPH SEPARATOR
  range(0x202a, 0x202e), // LRE, RLE, PDF, LRO, RLO
  range(0x2066, 0x2069), // LRI, RLI, FSI, PDI
].join('')}]`, 'gu');

export const REPLACEMENT = String.fromCodePoint(0xfffd);

/** The memo as it may be shown: every control and bidi character replaced by U+FFFD. */
export function displayMemo(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(NEUTRALISED, REPLACEMENT);
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
