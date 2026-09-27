package org.randprotocol.wallet.ui;

/**
 * Receive's payment-link form (spec 2026-09-26 §3.3, {@code ui/screens/receive.js}, iOS's
 * {@code ReceiveLinkRules}): the memo field and its counter exist only on a chain whose limits
 * report the 1860-byte envelope, and any other chain never gets a memo in the link.
 */
public final class ReceiveLinkRules {
    private ReceiveLinkRules() {}

    public static boolean showsMemo(Integer envelopeBytes) {
        return SendDraft.memoSupported(envelopeBytes);
    }

    /** The memo to put in the link, or null. */
    public static String linkMemo(String memo, Integer envelopeBytes) {
        return showsMemo(envelopeBytes) && memo != null && !memo.isEmpty() ? memo : null;
    }
}
