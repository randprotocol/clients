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
     * The memo — or any other stranger-chosen text, like a contact name — as it may be shown
     * (final reviews 1 and 2). Memos are live on chains 14 and 15: anyone can pay a dust note
     * carrying any memo to any public address, and a link carries any memo. One rule, the same as
     * the CLI's {@code memo_display::sanitize}, the shared UI's {@code displayMemo}, iOS's
     * {@code Memo.display} and randprotocol.org's {@code /account}, applied before any truncation:
     * every code point of category Cc (C0 — tab and newline too — DEL, C1), Cf (the bidi
     * embeddings, overrides and isolates, LRM/RLM/ALM, zero-width space and joiners,
     * U+2060–U+2064, U+FEFF, the soft hyphen, …), Zl and Zp (U+2028/U+2029) is shown as U+FFFD,
     * one for one; every run of Zs space separators (U+3000 and U+2003 included) becomes one
     * U+0020. Display only: the sealed memo is the text.
     */
    public static String display(String text) {
        if (text == null) return "";
        StringBuilder out = new StringBuilder(text.length());
        boolean[] inSpace = {false};
        text.codePoints().forEach(c -> {
            if (Character.getType(c) == Character.SPACE_SEPARATOR) {
                if (!inSpace[0]) out.append(' ');
                inSpace[0] = true;
                return;
            }
            inSpace[0] = false;
            if (neutralised(c)) out.appendCodePoint(0xFFFD);
            else out.appendCodePoint(c);
        });
        return out.toString();
    }

    static boolean neutralised(int c) {
        int t = Character.getType(c);
        return t == Character.CONTROL || t == Character.FORMAT
                || t == Character.LINE_SEPARATOR || t == Character.PARAGRAPH_SEPARATOR;
    }

    /** The refusal for a memo over the limit, or null. */
    public static String tooLong(String text) {
        int n = byteCount(text);
        return n > MAX_BYTES ? "The memo is " + n + " bytes; the limit is " + MAX_BYTES + "." : null;
    }
}
