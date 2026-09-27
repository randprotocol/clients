package org.randprotocol.wallet.ui;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONObject;
import org.junit.Test;
import org.randprotocol.wallet.rpc.RpcClient;
import org.randprotocol.wallet.rpc.RpcException;
import org.randprotocol.wallet.store.Contacts;

/**
 * The send screen's link rules (spec 2026-09-26 §3), the shared UI's {@code ui/screens/send} and
 * iOS's {@code SendLinkRules} in Java: a {@code randpay:} link fills what the form leaves empty,
 * and a value given both ways and differing is refused, never guessed.
 */
public class SendLinkTest {
    private static final String ADDR = "rand1" + "A".repeat(40);
    private static final String OTHER = "rand1" + "B".repeat(40);

    private static SendDraft.PaymentLink link(String amount, String asset, String memo) {
        return new SendDraft.PaymentLink(ADDR, amount, asset, memo, "1WCV-YC8F-47BY-5RZY");
    }

    /** A stand-in for the core: every rand1 address longer than 20 characters is valid. */
    private static final SendDraft.CoreApi FAKE = new SendDraft.CoreApi() {
        @Override
        public String addressError(String address) {
            return address.length() > 20 ? null : "not a rand1 address";
        }

        @Override
        public String fingerprint(String address) {
            return "FP-" + address.substring(address.length() - 4);
        }

        @Override
        public SendDraft.PaymentLink uriParse(String uri) throws Exception {
            String rest = uri.substring("randpay:".length());
            int q = rest.indexOf('?');
            String address = q < 0 ? rest : rest.substring(0, q);
            if (addressError(address) != null) throw new Exception("invalid address in link");
            String amount = null;
            if (q >= 0 && rest.startsWith("amount=", q + 1)) amount = rest.substring(q + 1 + "amount=".length());
            return new SendDraft.PaymentLink(address, amount, null, null, "LINK-" + address.substring(address.length() - 4));
        }
    };

    private static final class MemoryBlob implements Contacts.Backing {
        String data;

        @Override
        public String read() {
            return data;
        }

        @Override
        public void write(String json) {
            data = json;
        }
    }

    @Test
    public void recipientKind() {
        assertEquals(SendDraft.RecipientKind.ADDRESS, SendDraft.RecipientKind.of(" rand1abc "));
        assertEquals(SendDraft.RecipientKind.ADDRESS, SendDraft.RecipientKind.of("RAND1abc"));
        assertEquals(SendDraft.RecipientKind.LINK, SendDraft.RecipientKind.of("randpay:rand1abc?amount=1"));
        assertEquals(SendDraft.RecipientKind.LINK, SendDraft.RecipientKind.of("RANDPAY:rand1abc"));
        assertEquals(SendDraft.RecipientKind.NAME, SendDraft.RecipientKind.of("alice"));
    }

    @Test
    public void aLinkFillsAnEmptyAmountAndMemo() {
        SendDraft.Filled filled = SendDraft.fill(link("1.5", null, "rent"), "", "");
        assertEquals("1.5", filled.amount);
        assertEquals("rent", filled.memo);
        // Never what the user typed.
        SendDraft.Filled kept = SendDraft.fill(link("1.5", null, "rent"), "2", "mine");
        assertEquals("2", kept.amount);
        assertEquals("mine", kept.memo);
        assertFalse(SendDraft.conflicts(link("1.5", null, "rent"), "1.5", "rent").any());
        // A link for another asset never fills an amount.
        assertEquals("", SendDraft.fill(link("1.5", "1", null), "", "").amount);
    }

    @Test
    public void aMismatchIsRefused() {
        SendDraft.Conflicts c = SendDraft.conflicts(link("1", null, "rent"), "2", "food");
        assertEquals("The link asks for 1 RAND; you typed 2 RAND.", c.amount);
        assertEquals("The link’s memo is \"rent\"; you typed \"food\".", c.memo);
        assertNull(c.to);
        assertTrue(c.any());
    }

    /** Amounts agree by units, not by text: {@code 1} and {@code 1.000} are the same payment. */
    @Test
    public void amountsCompareByUnits() {
        assertNull(SendDraft.conflicts(link("1", null, null), "1.000", "").amount);
        assertNotNull(SendDraft.conflicts(link("1", null, null), "abc", "").amount);
        assertNull(SendDraft.conflicts(link("1", null, null), "", "").amount);
    }

    /**
     * This app sends RAND only; a link asking for another asset is refused on the recipient. The
     * asset is read the way the core's parser and the shared UI read it: digits by value, so
     * {@code 0} and {@code 00} are RAND; {@code RAND} is not a form the core's parser accepts.
     */
    @Test
    public void aLinkForAnotherAssetIsRefused() {
        assertNull(SendDraft.conflicts(link(null, "0", null), "", "").to);
        assertNull(SendDraft.conflicts(link(null, "00", null), "", "").to);
        assertTrue(SendDraft.linkIsRand("000"));
        assertFalse("the core refuses asset=RAND, so it is not a RAND branch here", SendDraft.linkIsRand("RAND"));
        assertFalse(SendDraft.linkIsRand("rand"));
        assertFalse(SendDraft.linkIsRand("01"));
        SendDraft.Conflicts c = SendDraft.conflicts(link("1", "1", null), "", "");
        assertEquals("The link asks for an asset this wallet does not hold (1).", c.to);
        assertNull(c.amount);
        assertTrue(c.any());
    }

    @Test
    public void memoCountsUtf8Bytes() {
        assertEquals(510, Memo.MAX_BYTES);
        assertEquals(2, Memo.byteCount("hi"));
        assertEquals(2, Memo.byteCount("é"));
        assertEquals(4, Memo.byteCount("👋"));
        assertEquals("6/510 bytes", Memo.counter("héllo"));
        assertNull(Memo.tooLong("x".repeat(510)));
        assertEquals("The memo is 512 bytes; the limit is 510.", Memo.tooLong("é".repeat(256)));
    }

    /**
     * A chain that declares no envelope size carries no memo: the field is hidden, and a memo a
     * link brought blocks Continue until it is cleared.
     */
    @Test
    public void aLegacyChainCarriesNoMemo() {
        assertFalse(SendDraft.memoSupported(null));
        assertFalse(SendDraft.memoSupported(0));
        // Exactly 1860 (fullnode's EnvelopeFormat::for_chain): any other size carries no memo.
        assertFalse(SendDraft.memoSupported(1024));
        assertFalse(SendDraft.memoSupported(1861));
        assertTrue(SendDraft.memoSupported(1860));
        assertEquals("This network doesn't carry memos; the memo will not be sent", Memo.NO_MEMO_NOTICE);
        assertTrue(SendDraft.memoBlocksContinue(false, "hi"));
        assertFalse(SendDraft.memoBlocksContinue(false, ""));
        assertFalse(SendDraft.memoBlocksContinue(true, "hi"));
    }

    /**
     * The confirmation is two lines: the recipient, with no memo text on it, and the memo on its
     * own line below (final review, finding 3).
     */
    @Test
    public void confirmationLine() {
        assertEquals("to alice · fingerprint 1WCV-YC8F-47BY-5RZY · 1.5 RAND",
                SendDraft.confirmationLine("alice", "1WCV-YC8F-47BY-5RZY", "1.5", "RAND"));
        assertEquals("to fingerprint 1WCV-YC8F-47BY-5RZY · 2 RAND",
                SendDraft.confirmationLine(null, "1WCV-YC8F-47BY-5RZY", "2", "RAND"));
        assertEquals("to fingerprint unavailable · 2 RAND",
                SendDraft.confirmationLine(null, null, "2", "RAND"));
        assertEquals("memo \"rent\"", SendDraft.memoLine("rent"));
        assertEquals("memo \"\"", SendDraft.memoLine(""));
        assertEquals("memo \"\"", SendDraft.memoLine(null));
    }

    private static String cp(int... points) {
        return new String(points, 0, points.length);
    }

    /** A link's memo cannot draw a second recipient line: it never reaches the recipient line,
     *  and its own line is one line with every control and bidi character shown as U+FFFD. */
    @Test
    public void aMemoCannotFakeASecondRecipientLine() {
        String fake = cp(10, 10) + "to alice · fingerprint AAAA-AAAA-AAAA-AAAA · 1 RAND";
        String r = cp(0xFFFD);
        String line = SendDraft.memoLine(fake);
        assertEquals("memo \"" + r + r + "to alice · fingerprint AAAA-AAAA-AAAA-AAAA · 1 RAND\"", line);
        for (int lb : new int[] {10, 13, 0x2028, 0x2029}) assertFalse(line.contains(cp(lb)));
        assertEquals("to fingerprint BBBB · 1 RAND", SendDraft.confirmationLine(null, "BBBB", "1", "RAND"));
    }

    @Test
    public void controlAndBidiCharactersAreNeutralised() {
        String r = cp(0xFFFD);
        assertEquals("a" + r + r + "b" + r + "c" + r + "d" + r + "e" + r + "f",
                Memo.display("a" + cp(13, 9) + "b" + cp(0) + "c" + cp(0x7F) + "d" + cp(0x85) + "e" + cp(0x9F) + "f"));
        int[] bidi = {0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069, 0x200E, 0x200F, 0x061C, 0x2028, 0x2029};
        assertEquals("x" + r.repeat(bidi.length) + "y", Memo.display("x" + cp(bidi) + "y"));
        String ordinary = "one space, " + cp(0xE9) + " and " + cp(0x1F600);
        assertEquals(ordinary, Memo.display(ordinary));
        assertEquals("", Memo.display(null));
    }

    /** {@code rand_getLimits}: the field's value, null when absent or null; anything else is an error. */
    @Test
    public void envelopeBytesFromLimits() throws Exception {
        assertEquals(Integer.valueOf(1024), RpcClient.envelopeBytesOf(new JSONObject("{\"envelope_bytes\":1024}")));
        assertNull(RpcClient.envelopeBytesOf(new JSONObject("{\"envelope_bytes\":null}")));
        assertNull(RpcClient.envelopeBytesOf(new JSONObject("{}")));
        for (Object bad : new Object[]{new JSONObject("{\"envelope_bytes\":0}"), new JSONObject("{\"envelope_bytes\":-5}"),
                new JSONObject("{\"envelope_bytes\":1.5}"), new JSONObject("{\"envelope_bytes\":\"1024\"}"),
                new JSONObject("{\"envelope_bytes\":2097152}"), "nope", null}) {
            try {
                RpcClient.envelopeBytesOf(bad);
                fail("accepted " + bad);
            } catch (RpcException expected) {
                // refused
            }
        }
    }

    /**
     * Receive's payment-link form: the memo field (and its counter) exists only on a chain whose
     * limits report an envelope size, and a memo never reaches a link for a chain without one.
     */
    @Test
    public void receiveMemoIsGatedOnEnvelopeBytes() {
        assertFalse(ReceiveLinkRules.showsMemo(null));
        assertFalse(ReceiveLinkRules.showsMemo(0));
        assertFalse(ReceiveLinkRules.showsMemo(1024));
        assertTrue(ReceiveLinkRules.showsMemo(1860));
        assertNull(ReceiveLinkRules.linkMemo("hi", null));
        assertNull(ReceiveLinkRules.linkMemo("hi", 0));
        assertNull(ReceiveLinkRules.linkMemo("hi", 1024));
        assertNull(ReceiveLinkRules.linkMemo("", 1860));
        assertEquals("hi", ReceiveLinkRules.linkMemo("hi", 1860));
    }

    /**
     * Resolution in the CLI's order: address, link, contact name — and the fingerprint is always
     * the one resolved together with the address the send goes to.
     */
    @Test
    public void resolveRecipient() throws Exception {
        Contacts book = Contacts.open(new MemoryBlob());
        book.add("alice", ADDR);

        SendDraft.Resolved byName = SendDraft.resolve("alice", book, FAKE);
        assertEquals(ADDR, byName.address);
        assertEquals("alice", byName.name);
        assertEquals(FAKE.fingerprint(ADDR), byName.fingerprint);
        assertNull(byName.link);

        SendDraft.Resolved byAddress = SendDraft.resolve("  " + ADDR + "\n", book, FAKE);
        assertEquals(ADDR, byAddress.address);
        assertEquals("alice", byAddress.name);
        assertEquals(FAKE.fingerprint(ADDR), byAddress.fingerprint);

        SendDraft.Resolved byLink = SendDraft.resolve("randpay:" + OTHER + "?amount=2", book, FAKE);
        assertEquals(OTHER, byLink.address);
        assertNull(byLink.name);
        assertEquals("2", byLink.link.amount);
        // The link's own fingerprint, computed by the core over the link's address.
        assertEquals("LINK-BBBB", byLink.fingerprint);

        try {
            SendDraft.resolve("bob", book, FAKE);
            fail();
        } catch (SendDraft.RecipientException e) {
            assertEquals(SendDraft.NOT_A_RECIPIENT, e.getMessage());
            assertEquals("That is not a shielded address, a randpay: link, or a saved contact.", e.getMessage());
        }
        try {
            SendDraft.resolve("rand1short", book, FAKE);
            fail();
        } catch (SendDraft.RecipientException e) {
            assertEquals("not a rand1 address", e.getMessage());
        }
        try {
            SendDraft.resolve("randpay:rand1x", book, FAKE);
            fail();
        } catch (SendDraft.RecipientException e) {
            assertEquals("That payment link could not be read: invalid address in link", e.getMessage());
        }
    }

    /**
     * A link from outside the app is held until Send's form is showing (never while a proof
     * runs), then taken once; a second link arriving before that replaces the first.
     */
    @Test
    public void linkInboxTakesTheLastLinkOnlyOnTheForm() {
        SendDraft.LinkInbox inbox = new SendDraft.LinkInbox();
        assertNull(inbox.take(true));
        inbox.offer("randpay:" + ADDR);
        inbox.offer("randpay:" + OTHER + "?amount=1");
        assertNull(inbox.take(false));
        assertEquals("randpay:" + OTHER + "?amount=1", inbox.take(true));
        assertNull(inbox.take(true));
        inbox.offer("  ");
        assertNull(inbox.take(true));
    }

    @Test
    public void paymentLinkFromCoreJson() throws Exception {
        SendDraft.PaymentLink p = SendDraft.PaymentLink.fromJson(new JSONObject(
                "{\"address\":\"" + ADDR + "\",\"amount\":\"1\",\"asset\":null,\"memo\":\"hi\",\"fingerprint\":\"1WCV-YC8F-47BY-5RZY\"}"));
        assertEquals(ADDR, p.address);
        assertEquals("1", p.amount);
        assertNull(p.asset);
        assertEquals("hi", p.memo);
        assertEquals("1WCV-YC8F-47BY-5RZY", p.fingerprint);
        assertSame(null, SendDraft.PaymentLink.fromJson(new JSONObject("{\"address\":\"" + ADDR + "\",\"fingerprint\":\"F\"}")).amount);
        // No fingerprint from the core is an error, never an empty one on the confirmation.
        try {
            SendDraft.PaymentLink.fromJson(new JSONObject("{\"address\":\"" + ADDR + "\"}"));
            fail();
        } catch (org.json.JSONException expected) {
            // refused
        }
    }

    // ---- Final review 2, item A: one display rule (the CLI's, the shared UI's, iOS's and
    // randprotocol.org's), applied before any truncation. Memos are live on chains 14 and 15:
    // anyone can pay a dust note carrying any memo to any public address.
    private static final String TAIL = "to alice · fingerprint AAAA-AAAA-AAAA-AAAA · 1 RAND";

    private static String[] hostile() {
        return new String[] {
            "x" + cp(0x3000).repeat(120) + TAIL,
            "x" + " ".repeat(400) + TAIL,
            "x" + cp(0x2003).repeat(60) + TAIL,
            cp(13, 0x1B) + "[2K" + TAIL,
            cp(10, 10) + "to alice" + cp(0x2028) + TAIL + cp(0x2029),
            cp(0x202E) + "DNAR 1" + cp(0x202C) + " " + cp(0x2066) + TAIL + cp(0x2069, 0x200E, 0x200F, 0x061C),
            "a" + cp(0x200B, 0x200C, 0x200D) + "b" + cp(0x2060, 0x2061, 0x2062, 0x2063, 0x2064) + "c" + cp(0xFEFF) + "d" + cp(0xAD) + "e",
            cp(9) + TAIL + cp(0x7F, 0x85, 0x9B) + "31m",
        };
    }

    /** No line break, no control/format/separator character, no space but U+0020, no run of two. */
    private static void assertDisplayable(String shown) {
        shown.codePoints().forEach(c -> {
            int t = Character.getType(c);
            assertFalse("control/format/separator U+" + Integer.toHexString(c) + " in " + shown,
                    t == Character.CONTROL || t == Character.FORMAT || t == Character.LINE_SEPARATOR || t == Character.PARAGRAPH_SEPARATOR);
            assertFalse("non-ASCII space U+" + Integer.toHexString(c) + " in " + shown, t == Character.SPACE_SEPARATOR && c != ' ');
        });
        assertFalse("a run of spaces in " + shown, shown.contains("  "));
    }

    @Test
    public void aHostileMemoIsOneLineHidesNothingAndCannotPadItselfOut() {
        String r = cp(0xFFFD);
        for (String m : hostile()) {
            assertDisplayable(Memo.display(m));
            assertDisplayable(SendDraft.memoLine(m));
            assertDisplayable(SendDraft.confirmationLine(m, "BBBB", "1", "RAND"));
        }
        assertEquals("x to alice", Memo.display("x" + cp(0x3000).repeat(120) + "to alice"));
        assertEquals("x to alice", Memo.display("x" + " ".repeat(400) + "to alice"));
        assertEquals(r + r + "[2Kto alice", Memo.display(cp(13, 0x1B) + "[2Kto alice"));
        assertEquals("a" + r + "b" + r + "c" + r + "d", Memo.display("a" + cp(0x200B) + "b" + cp(0xFEFF) + "c" + cp(0xAD) + "d"));
        // A saved name may end in a space: it and the separator collapse into one.
        assertEquals("to alice · fingerprint BBBB · 1 RAND", SendDraft.confirmationLine("alice ", "BBBB", "1", "RAND"));
        // The link/typed memo conflict message shows both memos through the same rule.
        SendDraft.Conflicts c = SendDraft.conflicts(link("1", null, "a" + cp(10) + "b"), "1", "x  y");
        assertEquals("The link’s memo is \"a" + r + "b\"; you typed \"x y\".", c.memo);
    }

    /** The memo row is one line that never wraps: the rest is cut with an ellipsis. */
    @Test
    public void theConfirmationMemoRowIsOneEllipsizedLine() throws Exception {
        String xml = new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get("src/main/res/layout/activity_send.xml")),
                java.nio.charset.StandardCharsets.UTF_8);
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("<TextView android:id=\"@\\+id/r_memo\"[^>]*/>").matcher(xml);
        assertTrue("the r_memo row", m.find());
        String row = m.group();
        assertTrue(row, row.contains("android:maxLines=\"1\""));
        assertTrue(row, row.contains("android:ellipsize=\"end\""));
    }

    /** The live "who" preview above the amount field, and the contact picker dialog `pickContact`
     *  opens, are `SendActivity` code — not reachable from a plain JUnit test without an Android
     *  framework — so, like {@link #theConfirmationMemoRowIsOneEllipsizedLine}, this reads the
     *  source (final review, finding: both showed a saved contact name raw). */
    @Test
    public void sendActivityShowsContactNamesSanitised() throws Exception {
        String src = new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(
                "src/main/java/org/randprotocol/wallet/ui/SendActivity.java")), java.nio.charset.StandardCharsets.UTF_8);
        assertTrue("the live recipient preview must sanitise the name: " + src,
                src.contains("Memo.display(resolved.name + \" · \")"));
        assertFalse("a raw, unsanitised name in the recipient preview is still present",
                src.contains("resolved.name + \" · \" : \"\""));
        assertTrue("the contact picker dialog must show sanitised names: " + src,
                src.contains(".setItems(shown,"));
        // Picking one must still fill the To field with the real, unsanitised name — that is
        // what a later lookup by name matches against.
        assertTrue("picking a contact must still use its real name: " + src,
                src.contains("b.to.setText(names[which])"));
    }

    /** {@code ContactsActivity}'s list row, its "Copy address / Remove" dialog title and the
     *  remove-confirmation title all showed a saved name raw (final review, finding); read the
     *  source for the same reason as {@link #sendActivityShowsContactNamesSanitised}. The
     *  underlying {@code remove(c.name)} call must still use the real name — it is the storage
     *  key, never shown. */
    @Test
    public void contactsActivityShowsNamesSanitised() throws Exception {
        String src = new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(
                "src/main/java/org/randprotocol/wallet/ui/ContactsActivity.java")), java.nio.charset.StandardCharsets.UTF_8);
        assertTrue("the list row must sanitise the name: " + src, src.contains("text(Memo.display(c.name), R.style.Text_Body, true)"));
        assertTrue("the options dialog title must sanitise the name: " + src, src.contains(".setTitle(Memo.display(c.name)).setItems"));
        assertTrue("the remove-confirmation title must sanitise the name: " + src,
                src.contains(".setTitle(getString(R.string.contacts_remove_title, Memo.display(c.name)))"));
        assertTrue("removal must still key on the real name", src.contains("wallet().contacts().remove(c.name)"));
    }

    /** Contact names are saved exactly as typed, so a name is looked up exactly as typed too. */
    @Test
    public void aContactNameIsNeverTrimmedBeforeTheLookup() throws Exception {
        Contacts book = Contacts.open(new MemoryBlob());
        book.add("alice ", ADDR);
        SendDraft.Resolved r = SendDraft.resolve("alice ", book, FAKE);
        assertEquals(ADDR, r.address);
        assertEquals("alice ", r.name);
        try {
            SendDraft.resolve("alice", book, FAKE);
            fail("\"alice\" is not \"alice \"");
        } catch (SendDraft.RecipientException expected) {
            // refused
        }
    }
}
