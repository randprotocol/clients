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

    /** This app sends RAND only; a link asking for another asset is refused on the recipient. */
    @Test
    public void aLinkForAnotherAssetIsRefused() {
        assertNull(SendDraft.conflicts(link(null, "0", null), "", "").to);
        assertNull(SendDraft.conflicts(link(null, "rand", null), "", "").to);
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
        assertTrue(SendDraft.memoSupported(1024));
        assertEquals("This network doesn't carry memos; the memo will not be sent", Memo.NO_MEMO_NOTICE);
        assertTrue(SendDraft.memoBlocksContinue(false, "hi"));
        assertFalse(SendDraft.memoBlocksContinue(false, ""));
        assertFalse(SendDraft.memoBlocksContinue(true, "hi"));
    }

    @Test
    public void confirmationLine() {
        assertEquals("to alice · fingerprint 1WCV-YC8F-47BY-5RZY · 1.5 RAND · memo \"rent\"",
                SendDraft.confirmationLine("alice", "1WCV-YC8F-47BY-5RZY", "1.5", "RAND", "rent"));
        assertEquals("to fingerprint 1WCV-YC8F-47BY-5RZY · 2 RAND · memo \"\"",
                SendDraft.confirmationLine(null, "1WCV-YC8F-47BY-5RZY", "2", "RAND", ""));
        assertEquals("to fingerprint unavailable · 2 RAND · memo \"\"",
                SendDraft.confirmationLine(null, null, "2", "RAND", ""));
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
        assertTrue(ReceiveLinkRules.showsMemo(1024));
        assertNull(ReceiveLinkRules.linkMemo("hi", null));
        assertNull(ReceiveLinkRules.linkMemo("hi", 0));
        assertNull(ReceiveLinkRules.linkMemo("", 1024));
        assertEquals("hi", ReceiveLinkRules.linkMemo("hi", 1024));
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
}
