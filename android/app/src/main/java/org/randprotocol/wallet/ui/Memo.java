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

    /** The refusal for a memo over the limit, or null. */
    public static String tooLong(String text) {
        int n = byteCount(text);
        return n > MAX_BYTES ? "The memo is " + n + " bytes; the limit is " + MAX_BYTES + "." : null;
    }
}
