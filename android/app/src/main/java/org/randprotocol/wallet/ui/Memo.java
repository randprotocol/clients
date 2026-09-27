package org.randprotocol.wallet.ui;

import java.nio.charset.StandardCharsets;

/** The memo: at most 510 bytes of UTF-8 — bytes, not characters (spec 2026-09-26 §2.3). */
public final class Memo {
    private Memo() {}

    public static final int MAX_BYTES = 510;
    public static final String NO_MEMO_NOTICE = "This network doesn't carry memos; the memo will not be sent";

    public static int byteCount(String text) {
        return text == null ? 0 : text.getBytes(StandardCharsets.UTF_8).length;
    }

    /** "N/510 bytes". */
    public static String counter(String text) {
        return byteCount(text) + "/" + MAX_BYTES + " bytes";
    }

    /** The one envelope size that carries a memo: fullnode's {@code EnvelopeFormat::for_chain}
     *  knows 1860 (a 112-byte note plus the 512-byte memo field, sealed) and nothing else. */
    public static final int ENVELOPE_BYTES = 1860;

    /** Whether a chain whose limits report {@code envelopeBytes} carries a memo: exactly 1860 —
     *  any other size, and none, is a chain without memos (the shared UI's and iOS's gate). */
    public static boolean supported(Integer envelopeBytes) {
        return envelopeBytes != null && envelopeBytes == ENVELOPE_BYTES;
    }

    /**
     * The memo as it may be shown (final review, finding 3). A memo is somebody else's text — the
     * sender's, or a link's — and a line break in it could draw a second "to … · fingerprint …"
     * line, a bidi control reorder what is around it. Every code point of category Cc (C0, DEL,
     * C1), the bidi controls U+202A–U+202E and U+2066–U+2069, the marks U+200E, U+200F, U+061C,
     * and the separators U+2028/U+2029 is shown as U+FFFD, one for one; everything else,
     * ordinary spaces included, is left alone. The shared UI's {@code displayMemo} and iOS's
     * {@code Memo.display} replace exactly the same set. Display only: the sealed memo is the text.
     */
    public static String display(String text) {
        if (text == null) return "";
        StringBuilder out = new StringBuilder(text.length());
        text.codePoints().forEach(c -> {
            if (neutralised(c)) out.appendCodePoint(0xFFFD);
            else out.appendCodePoint(c);
        });
        return out.toString();
    }

    static boolean neutralised(int c) {
        return c <= 0x1F || (c >= 0x7F && c <= 0x9F)
                || c == 0x061C || c == 0x200E || c == 0x200F
                || c == 0x2028 || c == 0x2029
                || (c >= 0x202A && c <= 0x202E)
                || (c >= 0x2066 && c <= 0x2069);
    }

    /** The refusal for a memo over the limit, or null. */
    public static String tooLong(String text) {
        int n = byteCount(text);
        return n > MAX_BYTES ? "The memo is " + n + " bytes; the limit is " + MAX_BYTES + "." : null;
    }
}
