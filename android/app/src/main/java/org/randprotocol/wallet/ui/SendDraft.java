package org.randprotocol.wallet.ui;

import org.json.JSONException;
import org.json.JSONObject;
import org.randprotocol.wallet.store.Contacts;
import org.randprotocol.wallet.util.Amounts;

import java.math.BigInteger;
import java.util.Locale;

/**
 * The send form's recipient and link rules (spec 2026-09-26 §3), the shared UI's
 * {@code ui/screens/send} and iOS's {@code SendLinkRules} in plain Java: what the recipient field
 * holds, how a {@code randpay:} link merges with what the user typed, and the one confirmation
 * line. Nothing here touches Android or the native core directly — the core is behind
 * {@link CoreApi} — so JUnit runs it on the host.
 */
public final class SendDraft {
    private SendDraft() {}

    public static final String SYMBOL = "RAND";
    public static final String NOT_A_RECIPIENT = "That is not a shielded address, a randpay: link, or a saved contact.";

    /** What a recipient field holds, in the order the CLI's {@code rand send <to>} tries them. */
    public enum RecipientKind {
        ADDRESS, LINK, NAME;

        public static RecipientKind of(String text) {
            String s = text == null ? "" : text.trim().toLowerCase(Locale.ROOT);
            if (s.startsWith("rand1")) return ADDRESS;
            if (s.startsWith("randpay:")) return LINK;
            return NAME;
        }
    }

    /**
     * A parsed {@code randpay:} link, exactly as the core's {@code uri_parse} answers it: absent
     * fields null, and the fingerprint of the address it carries (recomputed by the core, never
     * read off the link). {@code amount} is decimal text ("1.5"), {@code asset} an index or id.
     */
    public static final class PaymentLink {
        public final String address;
        public final String amount;
        public final String asset;
        public final String memo;
        public final String fingerprint;

        public PaymentLink(String address, String amount, String asset, String memo, String fingerprint) {
            this.address = address;
            this.amount = amount;
            this.asset = asset;
            this.memo = memo;
            this.fingerprint = fingerprint;
        }

        /** The core's reply; the address and fingerprint are required. */
        public static PaymentLink fromJson(JSONObject o) throws JSONException {
            return new PaymentLink(o.getString("address"), opt(o, "amount"), opt(o, "asset"), opt(o, "memo"), o.getString("fingerprint"));
        }

        private static String opt(JSONObject o, String k) {
            return o.isNull(k) ? null : String.valueOf(o.opt(k));
        }
    }

    /** The core calls the resolution needs; the app's are {@code parse_address}, {@code address_fingerprint}, {@code uri_parse}. */
    public interface CoreApi {
        /** Null for a valid address, else the core's reason. */
        String addressError(String address);

        String fingerprint(String address) throws Exception;

        PaymentLink uriParse(String uri) throws Exception;
    }

    /** The sentence to show on the recipient field. */
    public static final class RecipientException extends Exception {
        public RecipientException(String message) {
            super(message);
        }
    }

    /** A recipient resolved to the address a send goes to, with the fingerprint of that same address. */
    public static final class Resolved {
        public final String address;
        public final String name;
        public final String fingerprint;
        public final PaymentLink link;

        Resolved(String address, String name, String fingerprint, PaymentLink link) {
            this.address = address;
            this.name = name;
            this.fingerprint = fingerprint;
            this.link = link;
        }
    }

    /** Where the form and a link disagree: each field's sentence, or null. */
    public static final class Conflicts {
        public String to;
        public String amount;
        public String memo;

        public boolean any() {
            return to != null || amount != null || memo != null;
        }
    }

    public static final class Filled {
        public final String amount;
        public final String memo;

        Filled(String amount, String memo) {
            this.amount = amount;
            this.memo = memo;
        }
    }

    /**
     * This app sends RAND only: a link naming no asset, or an index whose value is zero
     * ({@code 0}, {@code 00}, …), is RAND — the core's {@code PaymentUri::parse} reads an index
     * as digits, and the CLI and the shared UI read it by value. {@code RAND} is not a form the
     * core's parser accepts, so it is no branch here; an id ({@code rpl1…}, 64 hex) names a token.
     */
    public static boolean linkIsRand(String asset) {
        if (asset == null || asset.trim().isEmpty()) return true;
        String a = asset.trim();
        return a.matches("[0-9]+") && a.matches("0+");
    }

    /**
     * The CLI's merge rule: a value given both ways and differing is refused. Only fields the
     * link actually carries are compared, amounts by units.
     */
    public static Conflicts conflicts(PaymentLink link, String typedAmount, String typedMemo) {
        Conflicts out = new Conflicts();
        if (!linkIsRand(link.asset)) {
            out.to = "The link asks for an asset this wallet does not hold (" + link.asset + ").";
        }
        String typed = typedAmount == null ? "" : typedAmount.trim();
        if (out.to == null && link.amount != null && !typed.isEmpty()) {
            BigInteger a = Amounts.parse(typed), b = Amounts.parse(link.amount);
            if (a == null || b == null || !a.equals(b)) {
                out.amount = "The link asks for " + link.amount + " " + SYMBOL + "; you typed " + typed + " " + SYMBOL + ".";
            }
        }
        String memo = typedMemo == null ? "" : typedMemo;
        if (link.memo != null && !link.memo.isEmpty() && !memo.isEmpty() && !memo.equals(link.memo)) {
            out.memo = "The link’s memo is \"" + link.memo + "\"; you typed \"" + memo + "\".";
        }
        return out;
    }

    /** A link fills what the form leaves empty — never what the user typed. */
    public static Filled fill(PaymentLink link, String amount, String memo) {
        String a = amount == null ? "" : amount;
        String m = memo == null ? "" : memo;
        if (a.trim().isEmpty() && link.amount != null && linkIsRand(link.asset)) a = link.amount;
        if (m.isEmpty() && link.memo != null && !link.memo.isEmpty()) m = link.memo;
        return new Filled(a, m);
    }

    /** A chain carries a memo only when its limits report exactly the 1860-byte envelope
     *  ({@link Memo#supported}): any other size, and none, gets no memo field. */
    public static boolean memoSupported(Integer envelopeBytes) {
        return Memo.supported(envelopeBytes);
    }

    /** A memo on a chain that cannot carry one blocks Continue until it is cleared. */
    public static boolean memoBlocksContinue(boolean memoSupported, String memo) {
        return !memoSupported && memo != null && !memo.isEmpty();
    }

    /**
     * The confirmation every surface shows before a send (spec 2026-09-26 §3), recipient part:
     * {@code to <name?> · fingerprint XXXX-XXXX-XXXX-XXXX · <amount> <asset>}. It never carries
     * memo text (final review, finding 3): a link's memo is somebody else's words, and on this
     * line a newline or a bidi control in it could draw a fake second recipient line. The memo is
     * {@link #memoLine}, a row of its own below this one.
     */
    public static String confirmationLine(String name, String fingerprint, String amount, String symbol) {
        String who = name != null ? name + " · " : "";
        String fp = fingerprint != null ? "fingerprint " + fingerprint : "fingerprint unavailable";
        return "to " + who + fp + " · " + amount + " " + symbol;
    }

    /** The memo's own row on the confirmation: {@code memo "<text>"}, with every control and bidi
     *  character shown as U+FFFD ({@link Memo#display}), so it is one line that reads as a memo. */
    public static String memoLine(String memo) {
        return "memo \"" + Memo.display(memo) + "\"";
    }

    /**
     * The recipient field resolved in the CLI's order: a {@code rand1…} address, a
     * {@code randpay:} link, a contact name. Throws with the sentence to show on the field.
     */
    public static Resolved resolve(String text, Contacts contacts, CoreApi core) throws RecipientException {
        String s = text == null ? "" : text.trim();
        switch (RecipientKind.of(s)) {
            case ADDRESS: {
                String err = core.addressError(s);
                if (err != null) throw new RecipientException(err);
                return new Resolved(s, contacts.nameOf(s), fingerprint(core, s), null);
            }
            case LINK: {
                PaymentLink link;
                try {
                    link = core.uriParse(s);
                } catch (Exception e) {
                    throw new RecipientException("That payment link could not be read: " + e.getMessage());
                }
                return new Resolved(link.address, contacts.nameOf(link.address), link.fingerprint, link);
            }
            default: {
                String addr = contacts.addressOf(s);
                if (addr == null) throw new RecipientException(NOT_A_RECIPIENT);
                return new Resolved(addr, s, fingerprint(core, addr), null);
            }
        }
    }

    private static String fingerprint(CoreApi core, String address) throws RecipientException {
        try {
            return core.fingerprint(address);
        } catch (Exception e) {
            throw new RecipientException(e.getMessage());
        }
    }

    /**
     * A {@code randpay:} link from outside the app (a VIEW intent, while Send may be showing
     * anything). It is held until Send's form is up — never applied under a running proof — and
     * a later link replaces an earlier one: the last one wins.
     */
    public static final class LinkInbox {
        private String pending;

        public synchronized void offer(String link) {
            String s = link == null ? "" : link.trim();
            if (!s.isEmpty()) pending = s;
        }

        /** The waiting link, once, if the form is showing; null otherwise. */
        public synchronized String take(boolean formShowing) {
            if (!formShowing || pending == null) return null;
            String s = pending;
            pending = null;
            return s;
        }

        public synchronized boolean hasPending() {
            return pending != null;
        }
    }
}
