package org.randprotocol.wallet.ui;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.randprotocol.wallet.ui.SignRows.Row;
import org.randprotocol.wallet.wallet.SignFlow;
import org.randprotocol.wallet.wallet.SignFlow.Verdict;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * The sign screen's decisions, apart from the activity (iOS SignRows / PaymentsGate /
 * CheckSession / SignProposalModel): the payment rows to the core's entries, the stale gate,
 * which check's result lands, the last-four confirmation, and each refusal's sentence. The
 * summaries are the vendored fullnode vectors (ui/test/fixtures/msauth).
 */
public class SignScreenTest {
    static final String GENESIS = "0".repeat(64);
    static final String URL = "https://rpc.example.org";

    static JSONObject fixture() throws Exception {
        try (InputStream in = SignScreenTest.class.getResourceAsStream("/expected.json")) {
            return new JSONObject(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    static String recipient() throws Exception {
        return fixture().getString("recipient");
    }

    /** msauth_check's reply for the valid proposal checked with the payee at 10 RAND. */
    static JSONObject summary() throws Exception {
        JSONObject f = fixture();
        return f.getJSONObject("summary_expecting_recipient")
                .put("binding_domain", 0)
                .put("lines", f.getJSONArray("lines_expecting_recipient"))
                .put("expected", new JSONArray().put(new JSONObject().put("entry", recipient() + ":10").put("fingerprint", f.getString("recipient_owner_fingerprint"))));
    }

    static List<String> payees() throws Exception {
        return List.of(recipient() + ":10");
    }

    static SignFlow.Judgement judge(Object summary, Long head) throws Exception {
        return SignFlow.judge(summary, head, 7, GENESIS, URL, payees());
    }

    static SignFlow.Judgement signable() throws Exception {
        return judge(summary(), 2000L);
    }

    // ------------------------------------------------------------------ rows to entries

    @Test public void aRowIsAddrColonAmountAsTyped() throws Exception {
        assertEquals("rand1abc:1.5", SignRows.entry(new Row("  rand1abc ", " 1.5 "), false));
        assertEquals("rand1abc:10", SignRows.entry(new Row("rand1abc", "10"), true));
    }

    @Test public void aRowWithoutAnAddressOrAmountIsRefusedWithItsSentence() {
        assertRefused(new Row("", "1"), false, "Enter the address of every payment.");
        assertRefused(new Row("  ", "1"), true, "Enter the address of every payment.");
        assertRefused(new Row("rand1abc", ""), false, "Enter the amount of every payment: it is what stops a split or an inflated payment.");
        assertRefused(new Row("rand1abc", "abc"), false, "An amount is a number of RAND, such as 1.5.");
        assertRefused(new Row("rand1abc", "0"), false, "An amount is a number of RAND, such as 1.5.");
        assertRefused(new Row("rand1abc", "0.0000000001"), false, "An amount is a number of RAND, such as 1.5.");
        assertRefused(new Row("rand1abc", "-1"), true, "An amount is a number of RAND, such as 1.5.");
    }

    @Test public void theAddressAloneOnlyWhereTheAmountIsOptional() throws Exception {
        assertEquals("rand1abc", SignRows.entry(new Row("rand1abc", " "), true));
        assertRefused(new Row("rand1abc", ""), false, "Enter the amount of every payment: it is what stops a split or an inflated payment.");
    }

    static void assertRefused(Row r, boolean optional, String sentence) {
        try {
            SignRows.entry(r, optional);
            fail("accepted " + r.addr + " / " + r.amount);
        } catch (IllegalArgumentException e) {
            assertEquals(sentence, e.getMessage());
        }
    }

    /** A RAND-only proposal: no row may go without its amount, whatever its address. */
    @Test public void anAmountIsRequiredWhenEveryPayingOutputIsRand() throws Exception {
        JSONObject s = summary();
        assertFalse(SignRows.amountOptional(new Row(recipient(), ""), s));
        assertFalse(SignRows.amountOptional(new Row("rand1unknown", ""), s));
        assertFalse(SignRows.amountOptional(new Row(recipient(), ""), null));
    }

    /** A token output: the row whose fingerprint owns it may go address-only; a RAND payee's row may not. */
    @Test public void theAmountIsOptionalOnlyOnTheRowWhoseFingerprintOwnsATokenOutput() throws Exception {
        JSONObject s = summary();
        JSONObject token = new JSONObject().put("amount", 5).put("asset", 3).put("to_account", false).put("matches", "X").put("owner_fingerprint", "tokenowner");
        s.getJSONArray("outputs").put(token);
        s.getJSONArray("expected").put(new JSONObject().put("entry", "rand1token").put("fingerprint", "tokenowner"));
        assertTrue(SignRows.amountOptional(new Row("rand1token", ""), s));
        assertTrue(SignRows.amountOptional(new Row(" rand1token ", "1"), s));
        assertFalse("the RAND payee keeps its pin", SignRows.amountOptional(new Row(recipient(), ""), s));
        // Not fingerprinted yet: may be sent address-only so the next check can tell.
        assertTrue(SignRows.amountOptional(new Row("rand1new", ""), s));
        assertFalse(SignRows.amountOptional(new Row("", ""), new JSONObject().put("outputs", new JSONArray()).put("expected", new JSONArray())));
    }

    @Test public void theEntriesAreBuiltPerRowWithEachRowsOwnRule() throws Exception {
        JSONObject s = summary();
        s.getJSONArray("outputs").put(new JSONObject().put("amount", 5).put("asset", 3).put("to_account", false).put("owner_fingerprint", "tokenowner"));
        s.getJSONArray("expected").put(new JSONObject().put("entry", "rand1token").put("fingerprint", "tokenowner"));
        List<Row> rows = List.of(new Row(recipient(), "10"), new Row("rand1token", ""));
        assertEquals(List.of(recipient() + ":10", "rand1token"), SignRows.entries(rows, s));
        try {
            SignRows.entries(List.of(new Row(recipient(), ""), new Row("rand1token", "")), s);
            fail("the RAND row went without its amount");
        } catch (IllegalArgumentException expected) {
            // its own sentence
        }
    }

    @Test public void payingOutputsAreDecidedFromTheOutputs() throws Exception {
        JSONObject s = summary();
        assertEquals(1, SignRows.payingTotal(s)); // two zero outputs and the change are not paying
        assertEquals(1, SignRows.payingMatched(s));
        assertTrue(SignRows.showsPayments(s));
        output(s, 2).put("matches", JSONObject.NULL);
        assertEquals(0, SignRows.payingMatched(s));
        output(s, 2).put("matches", "  ");
        assertEquals(0, SignRows.payingMatched(s));
        assertFalse(SignRows.showsPayments(null));
        assertFalse(SignRows.showsPayments(new JSONObject().put("outputs", "x")));
        assertEquals(0, SignRows.payingTotal(new JSONObject().put("outputs", new JSONArray().put("x").put(JSONObject.NULL))));
        assertFalse(SignRows.needsPayee(new JSONObject().put("amount", "000").put("to_account", false)));
        assertTrue(SignRows.needsPayee(new JSONObject().put("amount", "7").put("to_account", "true")));
        assertFalse(SignRows.needsPayee(new JSONObject().put("amount", "7").put("to_account", true)));
    }

    static JSONObject output(JSONObject s, int i) throws Exception {
        return s.getJSONArray("outputs").getJSONObject(i);
    }

    // ------------------------------------------------------------------ the stale gate

    @Test public void editingARowAfterACheckDisarmsUntilACheckOfTheseRowsLands() throws Exception {
        PaymentsGate g = new PaymentsGate();
        assertEquals(1, g.rows().size());
        assertFalse(g.stale());
        g.rows().get(0).addr = recipient();
        g.rows().get(0).amount = "10";
        g.edited();
        assertTrue(g.stale());
        g.adopt(List.of(recipient() + ":10"));
        String sent = g.sentKey();
        g.landed(sent);
        assertFalse(g.stale());
        // Editing after the check.
        g.rows().get(0).amount = "11";
        g.edited();
        assertTrue(g.stale());
        // The top Check / Retry resend the last adopted payments: their snapshot is the old rows.
        g.landed(g.sentKey());
        assertTrue("Check and Retry cannot re-arm Sign after an edit", g.stale());
        // Edited back to exactly what was checked: a check now lands armed.
        g.rows().get(0).amount = "10";
        g.edited();
        g.landed(g.sentKey());
        assertFalse(g.stale());
    }

    @Test public void anEditWhileTheCheckIsOutLandsStale() throws Exception {
        PaymentsGate g = new PaymentsGate();
        g.rows().get(0).addr = recipient();
        g.rows().get(0).amount = "10";
        g.adopt(List.of(recipient() + ":10"));
        String sent = g.sentKey();
        g.addRow();
        g.landed(sent);
        assertTrue(g.stale());
        g.removeRow(g.rows().get(1));
        assertTrue(g.stale());
        g.landed(sent);
        assertFalse("the snapshot taken at send time equals the rows now", g.stale());
    }

    @Test public void theRowsKeyCannotBeForgedBySeparators() {
        assertFalse(SignRows.key(List.of(new Row("a|1:b", ""))).equals(SignRows.key(List.of(new Row("a", "b")))));
        assertFalse(SignRows.key(List.of(new Row("a\n1:", "x"))).equals(SignRows.key(List.of(new Row("a", ""), new Row("", "x")))));
    }

    // ------------------------------------------------------------------ which check lands

    @Test public void onlyTheLatestCheckLands() throws Exception {
        CheckSession c = new CheckSession();
        CheckSession.Ticket first = c.begin("{p}");
        CheckSession.Ticket second = c.begin("{p}");
        assertTrue(second.id > first.id);
        assertFalse(c.land(first, summary(), signable()));
        assertNull(c.review());
        assertTrue(c.inFlight());
        assertTrue(c.land(second, summary(), signable()));
        assertFalse(c.inFlight());
        assertNotNull(c.review());
        assertEquals("{p}", c.reviewedProposal());
        assertFalse(c.fail(first, "late"));
        assertNull(c.error());
    }

    @Test public void theSequenceNeverResets() throws Exception {
        CheckSession c = new CheckSession();
        CheckSession.Ticket t = c.begin("{p}");
        c.close();
        CheckSession.Ticket after = c.begin("{p}");
        assertTrue(after.id > t.id);
        assertFalse("a check that lands after the screen was left is ignored", c.land(t, summary(), signable()));
        c.proposalEdited("{q}");
        assertFalse(c.land(after, summary(), signable()));
        assertTrue(c.begin("{q}").id > after.id);
    }

    @Test public void theTicketSnapshotsThePayeesAndRows() throws Exception {
        CheckSession c = new CheckSession();
        c.begin("{p}");
        c.gate().rows().get(0).addr = "rand1x";
        c.gate().rows().get(0).amount = "1";
        c.gate().adopt(List.of("rand1x:1"));
        CheckSession.Ticket t = c.begin("{p}");
        assertEquals(List.of("rand1x:1"), t.payees);
        c.gate().adopt(List.of("rand1y:1"));
        assertEquals("the ticket keeps what it was sent with", List.of("rand1x:1"), t.payees);
        try {
            t.payees.add("x");
            fail("a ticket's payees are fixed");
        } catch (UnsupportedOperationException expected) {
            // fixed
        }
    }

    @Test public void signSignsOnlyTheTextTheReviewWasCheckedOn() throws Exception {
        CheckSession c = new CheckSession();
        CheckSession.Ticket t = c.begin("{p}");
        c.land(t, summary(), signable());
        c.setTyped("aak3");
        assertTrue(c.canSign("{p}"));
        c.gate().rows().get(0).addr = recipient();
        assertFalse("the editor holds other text", c.canSign("{p} "));
        c.proposalEdited("{p} ");
        assertNull(c.review());
        assertNull(c.reviewedProposal());
        assertEquals("", c.typed());
        assertNull("the payments were asked for another text", c.lastSummary());
        assertEquals("", c.gate().rows().get(0).addr);
        assertFalse(c.canSign("{p} "));
    }

    @Test public void editingBackToTheCheckedTextKeepsThePaymentsButNotTheReview() throws Exception {
        CheckSession c = new CheckSession();
        CheckSession.Ticket t = c.begin("{p}");
        c.gate().rows().get(0).addr = recipient();
        c.land(t, summary(), signable());
        c.proposalEdited("{p}");
        assertNull(c.review());
        assertNotNull(c.lastSummary());
        assertEquals(recipient(), c.gate().rows().get(0).addr);
    }

    @Test public void aNewProposalTextStartsThePaymentsOver() throws Exception {
        CheckSession c = new CheckSession();
        CheckSession.Ticket t = c.begin("{p}");
        c.land(t, summary(), signable());
        c.gate().rows().get(0).addr = "rand1x";
        c.gate().adopt(List.of("rand1x"));
        c.begin("{q}");
        assertEquals(Collections.emptyList(), c.gate().payees());
        assertEquals("", c.gate().rows().get(0).addr);
        assertNull(c.lastSummary());
    }

    @Test public void aRefusedCheckKeepsTheRowsAndTheLastGoodSummary() throws Exception {
        CheckSession c = new CheckSession();
        CheckSession.Ticket t = c.begin("{p}");
        c.land(t, summary(), judge(summary(), 2000L));
        c.gate().rows().get(0).addr = "rand1typo";
        c.gate().rows().get(0).amount = "10";
        c.gate().adopt(List.of("rand1typo:10"));
        CheckSession.Ticket t2 = c.begin("{p}");
        assertTrue(c.fail(t2, "expected recipient rand1typo: not an address"));
        assertNull(c.review());
        assertEquals("expected recipient rand1typo: not an address", c.error());
        assertNotNull(c.lastSummary());
        assertTrue(SignRows.showsPayments(c.lastSummary()));
        assertEquals("rand1typo", c.gate().rows().get(0).addr);
        assertFalse(c.canSign("{p}"));
    }

    @Test public void aStaleGateKeepsSignOff() throws Exception {
        CheckSession c = new CheckSession();
        c.land(c.begin("{p}"), summary(), signable());
        c.gate().rows().get(0).addr = recipient();
        c.gate().rows().get(0).amount = "10";
        c.gate().edited();
        c.gate().adopt(payees());
        CheckSession.Ticket t = c.begin("{p}");
        assertEquals(payees(), t.payees);
        c.gate().rows().get(0).amount = "12";
        c.gate().edited();
        c.land(t, summary(), signable());
        c.setTyped("AAK3");
        assertTrue(c.gate().stale());
        assertFalse(c.canSign("{p}"));
        c.gate().rows().get(0).amount = "10";
        c.gate().edited();
        CheckSession.Ticket t2 = c.begin("{p}");
        c.land(t2, summary(), signable());
        c.setTyped("AAK3");
        assertTrue(c.canSign("{p}"));
        assertEquals("Sign sends the list the review was checked with", payees(), c.reviewedPayees());
        c.gate().adopt(List.of("rand1other:1"));
        assertEquals(payees(), c.reviewedPayees());
    }

    @Test public void aSignaturesRefusalReplacesTheVerdictOnTheSameSummary() throws Exception {
        CheckSession c = new CheckSession();
        CheckSession.Ticket t = c.begin("{p}");
        c.land(t, summary(), signable());
        c.setTyped("aak3");
        c.refused(judge(summary(), 2020L));
        assertEquals(Verdict.EXPIRED, c.review().judgement.verdict);
        assertTrue(c.review().showsSummary());
        assertFalse(c.canSign("{p}"));
        assertEquals("This proposal expires at height 2024 and the chain is at 2020: too late to sign. Ask for a new proposal.", c.review().refusal());
    }

    // ------------------------------------------------------------------ the confirmation

    @Test public void theLastFourIgnoreDashesAndCase() throws Exception {
        SignReview r = new SignReview(summary(), signable()); // NFYW-K8E9-E5K9-AAK3
        assertTrue(r.canSign("aak3", false));
        assertTrue(r.canSign("AAK3", false));
        assertTrue(r.canSign("a-ak3", false));
        assertTrue(r.canSign(" AA-K3 ", false));
        assertFalse(r.canSign("aak", false));
        assertFalse(r.canSign("9aak3", false));
        assertFalse(r.canSign("", false));
        assertFalse("stale", r.canSign("aak3", true));
        assertFalse(new SignReview(summary().put("policy_fingerprint", 5), signable()).canSign("aak3", false));
    }

    // ------------------------------------------------------------------ the review and refusals

    @Test public void theLinesAreTheCoresVerbatim() throws Exception {
        SignReview r = new SignReview(summary(), signable());
        JSONArray want = fixture().getJSONArray("lines_expecting_recipient");
        assertEquals(want.length(), r.lines().size());
        for (int i = 0; i < want.length(); i++) assertEquals(want.getString(i), r.lines().get(i));
        assertTrue(r.showsSummary());
        assertNull(r.refusal());
        assertEquals(24, r.blocksLeft());
        assertEquals("0.001", r.fee());
        assertEquals("2024", r.expiresAt());
        assertFalse(r.retryable());
    }

    @Test public void everyRefusalIsShownByItsSentence() throws Exception {
        assertEquals("The proposal check returned an incomplete answer, so this proposal is not signed.",
                new SignReview(null, judge("x", 2000L)).refusal());
        assertEquals("Enter the address of every payee: an output that does not match the address you entered, or whose address is empty, cannot be signed.",
                new SignReview(summary(), judge(summary().put("recipients_checked", false), 2000L)).refusal());
        SignReview noNode = new SignReview(summary(), judge(summary(), null));
        assertEquals("No node answered at " + URL + ", so the expiry cannot be checked and this proposal is not signed. Retry when the node is reachable.", noNode.refusal());
        assertTrue(noNode.retryable());
        assertEquals("This proposal is for chain 7; this wallet is on chain 21.",
                new SignReview(summary(), SignFlow.judge(summary(), 2000L, 21, GENESIS, URL, payees())).refusal());
        assertEquals("This proposal is bound to another genesis than the one this wallet's node serves.",
                new SignReview(summary(), judge(summary().put("binding_domain", 1).put("genesis", "ab"), 2000L)).refusal());
        assertEquals("This proposal expires at height 2024 and the chain is at 2010: too late to sign. Ask for a new proposal.",
                new SignReview(summary(), judge(summary(), 2010L)).refusal());
        for (Verdict v : Verdict.values()) {
            if (v == Verdict.SIGNABLE) continue;
            assertEquals(v == Verdict.NO_NODE, SignReview.retryable(v));
        }
    }

    @Test public void aMalformedSummaryNeverCrashesAndShowsOnlyItsRefusal() throws Exception {
        for (Object bad : new Object[] {null, "x", new JSONArray(), JSONObject.NULL, new JSONObject(),
                new JSONObject().put("lines", "x").put("outputs", new JSONArray()),
                new JSONObject().put("lines", new JSONArray().put(1).put("ok")).put("outputs", new JSONArray().put("x")).put("fee", "abc").put("expires_at", true)}) {
            JSONObject s = bad instanceof JSONObject ? (JSONObject) bad : null;
            SignReview r = new SignReview(s, judge(bad, 2000L));
            assertFalse(r.judgement.signable());
            assertNotNull(r.refusal());
            assertFalse(r.canSign("aak3", false));
            r.lines();
            r.fee();
            r.expiresAt();
            r.payingTotal();
            r.payingMatched();
            assertEquals(0, r.blocksLeft());
        }
        SignReview half = new SignReview(new JSONObject().put("lines", new JSONArray().put(1).put("ok")).put("outputs", new JSONArray()), judge("x", 1L));
        assertTrue(half.showsSummary());
        assertEquals(List.of("ok"), half.lines());
        assertFalse(new SignReview(new JSONObject().put("lines", new JSONArray()), judge("x", 1L)).showsSummary());
    }

    // ------------------------------------------------------------------ files

    @Test public void aFileOverOneMiBIsRefusedBeforeItIsRead() throws Exception {
        InputStream untouched = new InputStream() {
            @Override public int read() throws IOException {
                throw new AssertionError("read a file it should have refused by its size");
            }
        };
        assertFileRefused((1 << 20) + 1L, untouched, "That file is larger than a proposal, a policy or a key file can be.");
        assertEquals("{}", PickedFile.read(2, new ByteArrayInputStream("{}".getBytes(StandardCharsets.UTF_8))));
        byte[] exactly = new byte[1 << 20];
        Arrays.fill(exactly, (byte) 'a');
        assertEquals(1 << 20, PickedFile.read(-1, new ByteArrayInputStream(exactly)).length());
    }

    @Test public void aFileThatGrowsPastTheCapOrFailsToReadIsRefused() throws Exception {
        byte[] big = new byte[(1 << 20) + 1];
        assertFileRefused(-1, new ByteArrayInputStream(big), "That file is larger than a proposal, a policy or a key file can be.");
        assertFileRefused(10, new ByteArrayInputStream(big), "That file is larger than a proposal, a policy or a key file can be.");
        InputStream broken = new InputStream() {
            @Override public int read() throws IOException {
                throw new IOException("gone");
            }
        };
        assertFileRefused(10, broken, "That file could not be read.");
        assertFileRefused(10, null, "That file could not be read.");
    }

    static void assertFileRefused(long size, InputStream in, String sentence) {
        try {
            PickedFile.read(size, in);
            fail("read it");
        } catch (IllegalArgumentException e) {
            assertEquals(sentence, e.getMessage());
        }
    }

    @Test public void theRowsListStartsWithOneEmptyRow() {
        PaymentsGate g = new PaymentsGate();
        assertEquals(1, g.rows().size());
        assertEquals("", g.rows().get(0).addr);
        assertEquals("", g.rows().get(0).amount);
        assertEquals(new ArrayList<String>(), g.payees());
    }
}
