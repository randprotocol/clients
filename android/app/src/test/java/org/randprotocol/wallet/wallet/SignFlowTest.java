package org.randprotocol.wallet.wallet;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.randprotocol.wallet.security.SignerProfiles;
import org.randprotocol.wallet.wallet.SignFlow.Verdict;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CancellationException;

/**
 * The signing rules (ui/engine/signers.js {@code verdict}, iOS {@code MsauthRules.verdict}) and the
 * order a signature is made in (iOS {@code MsauthSigning}), on the JVM: the summaries are the
 * vendored fullnode vectors (ui/test/fixtures/msauth, a test resource), the core and the node are
 * stand-ins (a unit test cannot load the native core).
 */
public class SignFlowTest {
    static final long MAX_SAFE = 9_007_199_254_740_991L;
    static final String GENESIS = "0".repeat(64);

    static JSONObject fixture() throws Exception {
        try (InputStream in = SignFlowTest.class.getResourceAsStream("/expected.json")) {
            return new JSONObject(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    static String recipient() throws Exception {
        return fixture().getString("recipient");
    }

    /** The intended payment the summary below was checked with: the payee at 10 RAND. */
    static List<String> payees() throws Exception {
        return new ArrayList<>(List.of(recipient() + ":10"));
    }

    /**
     * {@code msauth_check}'s reply for the valid proposal with the payee named: fullnode's
     * {@code summary_expecting_recipient} plus what wallet-core msauth.rs adds beside it.
     */
    static JSONObject summary() throws Exception {
        JSONObject f = fixture();
        JSONObject s = f.getJSONObject("summary_expecting_recipient");
        return s.put("binding_domain", 0)
                .put("lines", f.getJSONArray("lines_expecting_recipient"))
                .put("expected", new JSONArray().put(new JSONObject().put("entry", recipient() + ":10").put("fingerprint", f.getString("recipient_owner_fingerprint"))));
    }

    static Verdict v(Object summary, Long head) throws Exception {
        return SignFlow.verdict(summary, head, 7, GENESIS, payees());
    }

    static Verdict v(Object summary, Long head, List<String> recipients) {
        return SignFlow.verdict(summary, head, 7, GENESIS, recipients);
    }

    static JSONObject output(JSONObject s, int i) throws Exception {
        return s.getJSONArray("outputs").getJSONObject(i);
    }

    // ------------------------------------------------------------------ the rule

    @Test public void theExpiryRuleIsTheClis() throws Exception {
        JSONObject s = summary(); // expires_at 2024
        assertEquals(16, SignFlow.EXPIRY_MARGIN);
        assertEquals(Verdict.SIGNABLE, v(s, 2007L));
        assertEquals(Verdict.EXPIRED, v(s, 2008L));
        assertEquals(Verdict.EXPIRED, v(s, 2024L));
        assertEquals(Verdict.EXPIRED, v(s, 5000L));
        assertEquals("overflow-safe at the top of the range", Verdict.EXPIRED, v(s, MAX_SAFE));
        assertEquals(17, SignFlow.judge(s, 2007L, 7, GENESIS, "", payees()).blocksLeft);
    }

    @Test public void noNodeNoSignature() throws Exception {
        JSONObject s = summary();
        assertEquals(Verdict.NO_NODE, v(s, null));
        assertEquals("a head past 2^53-1 is no answer", Verdict.NO_NODE, v(s, MAX_SAFE + 1));
        assertEquals(Verdict.NO_NODE, v(s, -1L));
        assertEquals(Verdict.NO_NODE, v(s, Long.MAX_VALUE));
    }

    @Test public void theChainAndTheGenesisAreThisWallets() throws Exception {
        JSONObject s = summary();
        assertEquals(Verdict.WRONG_CHAIN, SignFlow.verdict(s, 1L, 21, GENESIS, payees()));
        assertEquals("unbound: the genesis is not compared", Verdict.SIGNABLE, SignFlow.verdict(s, 1L, 7, "ab".repeat(32), payees()));
        s.put("binding_domain", 1);
        assertEquals(Verdict.WRONG_GENESIS, SignFlow.verdict(s, 1L, 7, "ab".repeat(32), payees()));
        assertEquals(Verdict.WRONG_GENESIS, SignFlow.verdict(s, 1L, 7, null, payees()));
        assertEquals("case-insensitive", Verdict.SIGNABLE, SignFlow.verdict(s.put("genesis", "AB".repeat(32)), 1L, 7, "ab".repeat(32), payees()));
    }

    @Test public void anUncheckedPayeeRefusesBeforeAnythingElse() throws Exception {
        JSONObject s = summary().put("recipients_checked", false);
        assertEquals(Verdict.UNCHECKED_RECIPIENT, v(s, null));
        for (Object notTrue : new Object[] {"true", 1, JSONObject.NULL}) {
            assertEquals(String.valueOf(notTrue), Verdict.UNCHECKED_RECIPIENT, v(summary().put("recipients_checked", notTrue), 2007L));
        }
        JSONObject missing = summary();
        missing.remove("recipients_checked");
        assertEquals(Verdict.UNCHECKED_RECIPIENT, v(missing, 2007L));
        // Unchecked comes before a malformed expiry, as on iOS and the web.
        assertEquals(Verdict.UNCHECKED_RECIPIENT, v(summary().put("recipients_checked", false).put("expires_at", "soon"), 2007L));
    }

    @Test public void theCoresOwnSummaryWithoutAPayeeIsUnchecked() throws Exception {
        JSONObject plain = fixture().getJSONObject("summary").put("binding_domain", 0); // recipients_checked false
        assertEquals(Verdict.UNCHECKED_RECIPIENT, v(plain, 2007L, Collections.emptyList()));
    }

    @Test public void everyPayingOutputNeedsAMatch() throws Exception {
        for (Object absent : new Object[] {JSONObject.NULL, "", "   ", 7, true}) {
            JSONObject s = summary();
            output(s, 2).put("matches", absent);
            assertEquals("matches = " + absent, Verdict.UNCHECKED_RECIPIENT, v(s, 2007L));
        }
        JSONObject s = summary();
        output(s, 2).remove("matches");
        assertEquals(Verdict.UNCHECKED_RECIPIENT, v(s, 2007L));
        // Change (to_account) and zero-amount slots need no payee: the fixture's outputs 0, 1 and 3.
        JSONObject zero = summary();
        output(zero, 0).put("amount", " 000 ");
        assertEquals(Verdict.SIGNABLE, v(zero, 2007L));
        // A zero-amount dummy with an amount written as "0.0" is not zero: it is malformed.
        output(zero, 0).put("amount", "0.0");
        assertEquals(Verdict.MALFORMED_SUMMARY, v(zero, 2007L));
    }

    @Test public void theListIsJudgedAsGiven() throws Exception {
        JSONObject s = summary();
        assertEquals("no payee named while one is paid", Verdict.UNCHECKED_RECIPIENT, v(s, 2007L, Collections.emptyList()));
        for (String blank : new String[] {"", "   ", ":10", " :10", "﻿"}) {
            List<String> l = payees();
            l.add(blank);
            assertEquals("entry '" + blank + "'", Verdict.UNCHECKED_RECIPIENT, v(s, 2007L, l));
        }
        List<String> withNull = payees();
        withNull.add(null);
        assertEquals(Verdict.UNCHECKED_RECIPIENT, v(s, 2007L, withNull));
        assertEquals(Verdict.UNCHECKED_RECIPIENT, v(s, 2007L, null));
    }

    @Test public void anAmountIsPinnedUnlessTheRowOwnsANonRandOutput() throws Exception {
        String fp = fixture().getString("recipient_owner_fingerprint");
        List<String> bare = List.of(recipient());
        JSONObject exp = new JSONObject().put("entry", recipient()).put("fingerprint", fp);
        // A RAND payment named without its amount: refused.
        JSONObject rand = summary().put("expected", new JSONArray().put(exp));
        assertEquals(Verdict.UNCHECKED_RECIPIENT, v(rand, 2007L, bare));
        assertEquals("an amount after the colon that is blank is no amount", Verdict.UNCHECKED_RECIPIENT, v(rand, 2007L, List.of(recipient() + ":  ")));
        // The same payee paid a token (asset 3): the address alone is the entry, as the core requires.
        JSONObject token = summary().put("expected", new JSONArray().put(exp));
        output(token, 2).put("asset", 3);
        assertEquals(Verdict.SIGNABLE, v(token, 2007L, bare));
        output(token, 2).put("asset", "3");
        assertEquals("an asset written as digits", Verdict.SIGNABLE, v(token, 2007L, bare));
        // expected missing, not a list, matched by another entry's text, or another fingerprint: refused.
        JSONObject noExp = new JSONObject(token.toString());
        noExp.remove("expected");
        assertEquals(Verdict.UNCHECKED_RECIPIENT, v(noExp, 2007L, bare));
        assertEquals(Verdict.UNCHECKED_RECIPIENT, v(new JSONObject(token.toString()).put("expected", "x"), 2007L, bare));
        assertEquals(Verdict.UNCHECKED_RECIPIENT, v(new JSONObject(token.toString()).put("expected", new JSONArray().put(new JSONObject().put("entry", recipient() + " ").put("fingerprint", fp))), 2007L, bare));
        assertEquals(Verdict.UNCHECKED_RECIPIENT, v(new JSONObject(token.toString()).put("expected", new JSONArray().put(new JSONObject().put("entry", recipient()).put("fingerprint", "ffff"))), 2007L, bare));
        assertEquals(Verdict.UNCHECKED_RECIPIENT, v(new JSONObject(token.toString()).put("expected", new JSONArray().put("not an object")), 2007L, bare));
        // A zero-amount token output does not pay: it cannot unpin a row.
        JSONObject zeroToken = new JSONObject(token.toString());
        output(zeroToken, 1).put("asset", 3).put("owner_fingerprint", "aaaa");
        output(zeroToken, 2).put("asset", 0);
        JSONObject e2 = new JSONObject().put("entry", recipient()).put("fingerprint", "aaaa");
        assertEquals(Verdict.UNCHECKED_RECIPIENT, v(zeroToken.put("expected", new JSONArray().put(e2)), 2007L, bare));
    }

    @Test public void aMalformedSummaryRefuses() throws Exception {
        assertEquals(Verdict.MALFORMED_SUMMARY, v(null, 2007L));
        assertEquals(Verdict.MALFORMED_SUMMARY, v("{}", 2007L));
        assertEquals(Verdict.MALFORMED_SUMMARY, v(new JSONArray(), 2007L));
        assertEquals(Verdict.MALFORMED_SUMMARY, v(JSONObject.NULL, 2007L));
        Object[] badUint = {-1, MAX_SAFE + 1, "2024", true, 1.5, JSONObject.NULL, new JSONArray()};
        for (String field : new String[] {"expires_at", "chain_id"}) {
            for (Object bad : badUint) {
                assertEquals(field + " = " + bad, Verdict.MALFORMED_SUMMARY, v(summary().put(field, bad), 2007L));
            }
            JSONObject missing = summary();
            missing.remove(field);
            assertEquals(field + " missing", Verdict.MALFORMED_SUMMARY, v(missing, 2007L));
        }
        for (Object bad : new Object[] {-1, "0", true, 0.5, JSONObject.NULL}) {
            assertEquals("binding_domain = " + bad, Verdict.MALFORMED_SUMMARY, v(summary().put("binding_domain", bad), 2007L));
        }
        JSONObject noDomain = summary();
        noDomain.remove("binding_domain");
        assertEquals(Verdict.MALFORMED_SUMMARY, v(noDomain, 2007L));
        for (Object bad : new Object[] {"", "zz", "0x00", 0, JSONObject.NULL}) {
            assertEquals("genesis = " + bad, Verdict.MALFORMED_SUMMARY, v(summary().put("genesis", bad), 2007L));
        }
        JSONObject noGenesis = summary();
        noGenesis.remove("genesis");
        assertEquals(Verdict.MALFORMED_SUMMARY, v(noGenesis, 2007L));
        // Integral numbers are numbers, however written.
        assertEquals(Verdict.SIGNABLE, v(new JSONObject(summary().toString().replace("\"expires_at\":2024", "\"expires_at\":2024.0")), 2007L));
    }

    @Test public void malformedOutputsRefuse() throws Exception {
        JSONObject noOuts = summary();
        noOuts.remove("outputs");
        assertEquals(Verdict.MALFORMED_SUMMARY, v(noOuts, 2007L));
        assertEquals(Verdict.MALFORMED_SUMMARY, v(summary().put("outputs", "[]"), 2007L));
        JSONObject notObject = summary();
        notObject.getJSONArray("outputs").put("x");
        assertEquals(Verdict.MALFORMED_SUMMARY, v(notObject, 2007L));
        for (Object bad : new Object[] {1, 0, "true", "false", JSONObject.NULL}) {
            JSONObject s = summary();
            output(s, 3).put("to_account", bad);
            assertEquals("to_account = " + bad, Verdict.MALFORMED_SUMMARY, v(s, 2007L));
        }
        JSONObject noTo = summary();
        output(noTo, 3).remove("to_account");
        assertEquals(Verdict.MALFORMED_SUMMARY, v(noTo, 2007L));
        // to_account as JSON text: 1 is not a boolean, even though org.json would coerce it.
        assertEquals(Verdict.MALFORMED_SUMMARY, v(new JSONObject(summary().toString().replace("\"to_account\":true", "\"to_account\":1")), 2007L));
        for (Object bad : new Object[] {"-1", "1.5", "", " ", "1e3", "١٢", -1, MAX_SAFE + 1, true, 1.5, JSONObject.NULL}) {
            JSONObject s = summary();
            output(s, 2).put("amount", bad);
            assertEquals("amount = " + bad, Verdict.MALFORMED_SUMMARY, v(s, 2007L));
        }
        JSONObject noAmount = summary();
        output(noAmount, 2).remove("amount");
        assertEquals(Verdict.MALFORMED_SUMMARY, v(noAmount, 2007L));
        JSONObject digits = summary();
        output(digits, 2).put("amount", " 10000000000 ");
        assertEquals("a digit string is an amount", Verdict.SIGNABLE, v(digits, 2007L));
        // A malformed output is found before the match check.
        JSONObject both = summary();
        output(both, 2).put("matches", JSONObject.NULL);
        output(both, 3).put("to_account", 1);
        assertEquals(Verdict.MALFORMED_SUMMARY, v(both, 2007L));
    }

    @Test public void theRefusalsReadAsTheWebsDo() throws Exception {
        JSONObject s = summary();
        assertNull(SignFlow.judge(s, 2007L, 7, GENESIS, "", payees()).message());
        assertEquals("The proposal check returned an incomplete answer, so this proposal is not signed.",
                SignFlow.judge(null, 2007L, 7, GENESIS, "", payees()).message());
        assertEquals("Enter the address of every payee: an output that does not match the address you entered, or whose address is empty, cannot be signed.",
                SignFlow.judge(s, 2007L, 7, GENESIS, "", Collections.emptyList()).message());
        assertEquals("No node answered at https://rpc.example, so the expiry cannot be checked and this proposal is not signed. Retry when the node is reachable.",
                SignFlow.judge(s, null, 7, GENESIS, "https://rpc.example", payees()).message());
        assertEquals("No node answered at —, so the expiry cannot be checked and this proposal is not signed. Retry when the node is reachable.",
                SignFlow.judge(s, null, 7, GENESIS, "", payees()).message());
        assertEquals("This proposal is for chain 7; this wallet is on chain 21.", SignFlow.judge(s, 1L, 21, GENESIS, "", payees()).message());
        assertEquals("This proposal is bound to another genesis than the one this wallet's node serves.",
                SignFlow.judge(summary().put("binding_domain", 1), 1L, 7, "ab", "", payees()).message());
        assertEquals("This proposal expires at height 2024 and the chain is at 2010: too late to sign. Ask for a new proposal.",
                SignFlow.judge(s, 2010L, 7, GENESIS, "", payees()).message());
    }

    @Test public void confirmationIsTheLastFour() {
        assertTrue(SignFlow.confirms("NFYW-K8E9-E5K9-AAK3", " aak3"));
        assertTrue(SignFlow.confirms("NFYW-K8E9-E5K9-AAK3", "a-ak3"));
        assertFalse(SignFlow.confirms("NFYW-K8E9-E5K9-AAK3", "aak"));
        assertFalse(SignFlow.confirms("NFYW-K8E9-E5K9-AAK3", "9aak3"));
        assertFalse(SignFlow.confirms("", ""));
        assertFalse(SignFlow.confirms(null, "aak3"));
        assertFalse(SignFlow.confirms("NFYW-K8E9-E5K9-AAK3", null));
    }

    @Test public void linesAreTheCoresVerbatimAndFilesAreCleaned() throws Exception {
        assertEquals(fixture().getJSONArray("lines_expecting_recipient").getString(2), SignFlow.lines(summary()).get(2));
        assertEquals("chain 7 · genesis " + GENESIS, SignFlow.lines(summary()).get(0));
        assertTrue(SignFlow.lines(new JSONObject()).isEmpty());
        assertEquals("{}", SignFlow.clean("﻿ {}\r\n"));
        assertEquals("", SignFlow.clean(null));
        assertEquals(List.of("a:1", ""), SignFlow.payees(Arrays.asList(" a:1\n", null)));
    }

    // ------------------------------------------------------------------ the order a signature is made in

    static final String PROPOSAL = "{\"proposal\":1}";
    static final String POLICY = "{\"policy\":1}";
    static final String SHARE = "2:abcd";

    static class FakeCore implements MsauthCore {
        final List<String> calls = new ArrayList<>();
        final List<List<String>> checkLists = new ArrayList<>();
        final List<List<String>> signLists = new ArrayList<>();
        JSONObject reply;
        String seedHex;
        Exception signError;

        FakeCore(JSONObject reply) {
            this.reply = reply;
        }

        @Override public JSONObject msauthCheck(String proposal, String policy, List<String> expectedRecipients) {
            calls.add("check " + proposal + " " + policy);
            checkLists.add(expectedRecipients);
            return reply;
        }

        @Override public String msauthSign(String proposal, String policy, String seedHex, List<String> expectedRecipients) throws Exception {
            calls.add("sign " + proposal + " " + policy);
            signLists.add(expectedRecipients);
            this.seedHex = seedHex;
            if (signError != null) throw signError;
            return SHARE;
        }

        @Override public void msauthVerifyShare(String proposal, String policy, String share) {
            calls.add("verify " + share);
        }

        @Override public JSONObject msauthSignerImport(String input, String policy) {
            throw new UnsupportedOperationException();
        }

        @Override public JSONObject msauthPolicyInfo(String policy) {
            throw new UnsupportedOperationException();
        }
    }

    static final class FakeNode implements SignFlow.Node {
        final List<Long> heads = new ArrayList<>();
        long chainId = 7;
        String genesis = GENESIS;
        boolean fail;
        int headReads;

        FakeNode(Long... heads) {
            this.heads.addAll(Arrays.asList(heads));
        }

        @Override public String url() {
            return "https://rpc.example";
        }

        @Override public long chainId() throws Exception {
            if (fail) throw new java.io.IOException("down");
            return chainId;
        }

        @Override public long headHeight() {
            long h = heads.get(Math.min(headReads, heads.size() - 1));
            headReads++;
            return h;
        }

        @Override public String genesisHash() {
            return genesis;
        }
    }

    /** The prompt and the decrypt, counted; the buffer it hands out is kept to see it zeroed. */
    static final class FakeSeeds implements SignFlow.SeedSource {
        int prompts;
        byte[] handed;
        Runnable onPrompt = () -> { };

        @Override public byte[] seed(String id) {
            prompts++;
            onPrompt.run();
            handed = new byte[32];
            Arrays.fill(handed, (byte) 0x11);
            return handed;
        }
    }

    static final class Profiles {
        final SignerProfiles store;

        Profiles() throws Exception {
            Map<String, String> m = new HashMap<>();
            store = new SignerProfiles(new SignerProfiles.KeyValue() {
                public String get(String k) { return m.get(k); }
                public void put(String k, String v) { m.put(k, v); }
                public void remove(String k) { m.remove(k); }
                public java.util.Set<String> keys() { return m.keySet(); }
            });
            store.add(new SignerProfiles.Profile("a1", "treasury", 2, "33".repeat(32)), POLICY, "AA==:AA==");
        }
    }

    static SignFlow flow(FakeCore core, SignFlow.Node node, FakeSeeds seeds) throws Exception {
        return new SignFlow(new Profiles().store, core, node, 7, seeds);
    }

    static void assertZeroed(byte[] b) {
        assertArrayEquals(new byte[b.length], b);
    }

    @Test public void signChecksJudgesPromptsJudgesAgainAndSignsWithTheSameList() throws Exception {
        FakeCore core = new FakeCore(summary());
        FakeNode node = new FakeNode(2000L);
        FakeSeeds seeds = new FakeSeeds();
        List<String> typed = new ArrayList<>(List.of(" " + recipient() + ":10\n"));
        SignFlow.Share share = flow(core, node, seeds).sign("a1", "﻿" + PROPOSAL + "\n", typed, null);
        assertEquals(SHARE, share.share);
        assertEquals(2, share.index);
        assertEquals(List.of("check " + PROPOSAL + " " + POLICY, "sign " + PROPOSAL + " " + POLICY), core.calls);
        assertEquals("cleaned, none dropped", payees(), core.checkLists.get(0));
        assertSame("msauth_sign gets the very list the check was given", core.checkLists.get(0), core.signLists.get(0));
        assertEquals("11".repeat(32), core.seedHex);
        assertEquals(1, seeds.prompts);
        assertEquals("the head is read before the prompt and again after it", 2, node.headReads);
        assertZeroed(seeds.handed);
    }

    @Test public void aRefusalComesBeforeThePrompt() throws Exception {
        for (Object[] c : new Object[][] {
                {summary(), new FakeNode(2010L), Verdict.EXPIRED},
                {summary().put("recipients_checked", false), new FakeNode(2000L), Verdict.UNCHECKED_RECIPIENT},
                {summary().put("chain_id", 21), new FakeNode(2000L), Verdict.WRONG_CHAIN},
                {summary().put("expires_at", "x"), new FakeNode(2000L), Verdict.MALFORMED_SUMMARY},
                {summary(), null, Verdict.NO_NODE},
        }) {
            FakeCore core = new FakeCore((JSONObject) c[0]);
            FakeSeeds seeds = new FakeSeeds();
            try {
                flow(core, (SignFlow.Node) c[1], seeds).sign("a1", PROPOSAL, payees(), null);
                fail("signed " + c[2]);
            } catch (SignFlow.Refusal r) {
                assertEquals(c[2], r.judgement.verdict);
                assertEquals(r.judgement.message(), r.getMessage());
            }
            assertEquals("no prompt, no seed: " + c[2], 0, seeds.prompts);
            assertEquals(1, core.calls.size());
        }
    }

    @Test public void aNodeThatCannotAnswerIsNoNode() throws Exception {
        FakeNode wrongChain = new FakeNode(2000L);
        wrongChain.chainId = 21;
        FakeNode down = new FakeNode(2000L);
        down.fail = true;
        FakeNode huge = new FakeNode(MAX_SAFE + 1);
        for (FakeNode n : new FakeNode[] {wrongChain, down, huge}) {
            FakeCore core = new FakeCore(summary());
            FakeSeeds seeds = new FakeSeeds();
            SignFlow.Check c = flow(core, n, seeds).check("a1", PROPOSAL, payees());
            assertEquals(Verdict.NO_NODE, c.judgement.verdict);
            assertTrue(c.judgement.message().contains("https://rpc.example"));
            try {
                flow(core, n, seeds).sign("a1", PROPOSAL, payees(), null);
                fail();
            } catch (SignFlow.Refusal r) {
                assertEquals(Verdict.NO_NODE, r.judgement.verdict);
            }
            assertEquals(0, seeds.prompts);
        }
        FakeNode wrongGenesis = new FakeNode(2000L);
        wrongGenesis.genesis = "ab".repeat(32);
        assertEquals(Verdict.WRONG_GENESIS, flow(new FakeCore(summary().put("binding_domain", 1)), wrongGenesis, new FakeSeeds()).check("a1", PROPOSAL, payees()).judgement.verdict);
    }

    @Test public void theHeadIsReadAgainAfterThePromptAndTheSeedIsZeroedOnRefusal() throws Exception {
        FakeCore core = new FakeCore(summary());
        FakeNode node = new FakeNode(2000L, 2008L); // the prompt took eight blocks too many
        FakeSeeds seeds = new FakeSeeds();
        try {
            flow(core, node, seeds).sign("a1", PROPOSAL, payees(), null);
            fail();
        } catch (SignFlow.Refusal r) {
            assertEquals(Verdict.EXPIRED, r.judgement.verdict);
        }
        assertEquals(1, seeds.prompts);
        assertEquals("the core never signed", 1, core.calls.size());
        assertZeroed(seeds.handed);
    }

    @Test public void theNodeGoingAwayDuringThePromptRefuses() throws Exception {
        FakeCore core = new FakeCore(summary());
        FakeNode node = new FakeNode(2000L);
        FakeSeeds seeds = new FakeSeeds();
        seeds.onPrompt = () -> node.fail = true;
        try {
            flow(core, node, seeds).sign("a1", PROPOSAL, payees(), null);
            fail();
        } catch (SignFlow.Refusal r) {
            assertEquals(Verdict.NO_NODE, r.judgement.verdict);
        }
        assertZeroed(seeds.handed);
    }

    @Test public void aCoreRefusalStillZeroesTheSeed() throws Exception {
        FakeCore core = new FakeCore(summary());
        core.signError = new Exception("output 2 pays b9856a063c1fb742, not an expected recipient");
        FakeSeeds seeds = new FakeSeeds();
        try {
            flow(core, new FakeNode(2000L), seeds).sign("a1", PROPOSAL, payees(), null);
            fail();
        } catch (Exception e) {
            assertEquals("output 2 pays b9856a063c1fb742, not an expected recipient", e.getMessage());
        }
        assertZeroed(seeds.handed);
    }

    @Test public void cancellingStopsBeforeThePromptAndBeforeSigning() throws Exception {
        FakeCore core = new FakeCore(summary());
        FakeSeeds seeds = new FakeSeeds();
        try {
            flow(core, new FakeNode(2000L), seeds).sign("a1", PROPOSAL, payees(), () -> true);
            fail();
        } catch (CancellationException expected) {
            // left the screen before the prompt
        }
        assertEquals(0, seeds.prompts);

        boolean[] left = {false};
        FakeSeeds seeds2 = new FakeSeeds();
        seeds2.onPrompt = () -> left[0] = true;
        FakeCore core2 = new FakeCore(summary());
        try {
            flow(core2, new FakeNode(2000L), seeds2).sign("a1", PROPOSAL, payees(), () -> left[0]);
            fail();
        } catch (CancellationException expected) {
            // left the screen during the prompt
        }
        assertEquals(1, core2.calls.size());
        assertZeroed(seeds2.handed);
    }

    @Test public void aBlankEntryIsRefusedBeforeTheCoreIsAsked() throws Exception {
        FakeCore core = new FakeCore(summary());
        List<String> l = payees();
        l.add(" ");
        SignFlow f = flow(core, new FakeNode(2000L), new FakeSeeds());
        SignFlow.Check c = f.check("a1", PROPOSAL, l);
        assertNull(c.summary);
        assertEquals(Verdict.UNCHECKED_RECIPIENT, c.judgement.verdict);
        try {
            f.sign("a1", PROPOSAL, l, null);
            fail();
        } catch (SignFlow.Refusal r) {
            assertEquals(Verdict.UNCHECKED_RECIPIENT, r.judgement.verdict);
        }
        assertTrue(core.calls.isEmpty());
    }

    @Test public void checkReturnsTheSummaryAndTheVerdictNow() throws Exception {
        FakeCore core = new FakeCore(summary());
        SignFlow.Check c = flow(core, new FakeNode(2000L), new FakeSeeds()).check("a1", PROPOSAL, payees());
        assertEquals(Verdict.SIGNABLE, c.judgement.verdict);
        assertEquals(24, c.judgement.blocksLeft);
        assertEquals("NFYW-K8E9-E5K9-AAK3", c.summary.getString("policy_fingerprint"));
    }

    @Test public void anUnknownProfileOrAShareWithoutAnIndexRefuses() throws Exception {
        try {
            flow(new FakeCore(summary()), new FakeNode(2000L), new FakeSeeds()).sign("nope", PROPOSAL, payees(), null);
            fail();
        } catch (IllegalArgumentException e) {
            assertEquals("No such signer profile.", e.getMessage());
        }
        FakeCore odd = new FakeCore(summary()) {
            @Override public String msauthSign(String p, String q, String s, List<String> l) {
                return "x:abcd";
            }
        };
        FakeSeeds seeds = new FakeSeeds();
        try {
            flow(odd, new FakeNode(2000L), seeds).sign("a1", PROPOSAL, payees(), null);
            fail();
        } catch (IllegalStateException e) {
            assertEquals("msauth_sign returned no share", e.getMessage());
        }
        assertZeroed(seeds.handed);
    }

    @Test public void verifyShareCleansAndAsksTheCore() throws Exception {
        FakeCore core = new FakeCore(summary());
        assertEquals(0, flow(core, null, new FakeSeeds()).verifyShare("a1", PROPOSAL, " 0:aa\n"));
        assertEquals(List.of("verify 0:aa"), core.calls);
    }
}
