package org.randprotocol.wallet.wallet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.randprotocol.wallet.rpc.RpcClient;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The invoke flow ({@link Invoke}: {@code ui/engine/wallet.js}'s quoteInvoke → invoke →
 * completeInvoke) against a scripted node and a stand-in core: what is asked in what order, that
 * the anchor is taken last, and that every refusal before a proof carries the engine's code and
 * stops before anything costly.
 */
public class InvokeTest {
    static final String PROGRAM = Amm.DURIAN_PROGRAM;
    static final String KEY = AmmTest.LIVE_KEY;
    static final String VALUE = AmmTest.LIVE_VALUE;
    static final String ROOT = "77".repeat(32);
    static final String HASH = "AB".repeat(32);

    /** A node on no network: each method answers from {@code replies}, and every call is recorded in order. */
    static class Node extends RpcClient {
        final Map<String, Object> replies = new HashMap<>();
        final Map<String, String> errors = new HashMap<>();
        final List<String> calls = new ArrayList<>();
        final List<JSONArray> params = new ArrayList<>();

        Node() {
            super("https://node.example");
        }

        Node answer(String method, Object result) {
            replies.put(method, result);
            return this;
        }

        @Override
        protected Reply transport(String json) {
            try {
                JSONObject req = new JSONObject(json);
                String m = req.getString("method");
                calls.add(m);
                params.add(req.getJSONArray("params"));
                if (errors.containsKey(m)) {
                    return new Reply(200, new JSONObject().put("jsonrpc", "2.0").put("id", 1)
                            .put("error", new JSONObject().put("code", -32000).put("message", errors.get(m))).toString(), null);
                }
                Object r = replies.containsKey(m) ? replies.get(m) : JSONObject.NULL;
                return new Reply(200, new JSONObject().put("jsonrpc", "2.0").put("id", 1).put("result", r).toString(), null);
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        }

        JSONArray paramsOf(String method) {
            for (int i = 0; i < calls.size(); i++) if (calls.get(i).equals(method)) return params.get(i);
            return null;
        }
    }

    /** The core, standing in: records what it was asked, in order. */
    static final class FakeCore implements Invoke.InvokeCore {
        final List<String> calls = new ArrayList<>();
        JSONObject dryAsked;
        JSONObject planAsked;
        JSONObject proveAsked;
        Exception dryFails;
        Exception planFails;

        @Override
        public JSONObject dryRunInvoke(JSONObject transition) throws Exception {
            calls.add("dry_run_invoke");
            dryAsked = transition;
            if (dryFails != null) throw dryFails;
            return new JSONObject().put("tier", 14).put("gas", 2000).put("gas_limit", 2048).put("gas_max", 20479)
                    .put("keccak_log_height", 0).put("sha256_log_height", 0).put("context_words", 40);
        }

        @Override
        public JSONObject planInvoke(JSONObject params) throws Exception {
            calls.add("plan_invoke");
            planAsked = params;
            if (planFails != null) throw planFails;
            return new JSONObject().put("fee", params.getString("fee"))
                    .put("inputs", new JSONArray().put(new JSONObject().put("index", 4).put("amount", "300000000")))
                    .put("fee_inputs", new JSONArray());
        }

        @Override
        public JSONObject proveInvoke(JSONObject request) throws Exception {
            calls.add("prove_invoke");
            proveAsked = request;
            return new JSONObject().put("tx_hex", "aa").put("time", 900).put("spent_indices", new JSONArray().put(4));
        }
    }

    static JSONObject limits(boolean programs) throws Exception {
        JSONObject l = new JSONObject().put("envelope_bytes", 1860).put("max_proof_bytes", 4194304).put("bundle_gas_limit", 20479)
                .put("proof_window_blocks", 1024);
        if (programs) {
            l.put("program_state", new JSONObject().put("cell_fee", "10000000").put("max_reads", 8).put("max_writes", 8).put("max_payouts", 4));
        }
        return l;
    }

    /** A node that holds the live pool unchanged and a vault that can pay. */
    static Node healthy() throws Exception {
        return new Node()
                .answer("rand_getLimits", limits(true))
                .answer("rand_getProgramCode", new JSONObject().put("base_pc", 4096).put("words", new JSONArray().put(74007).put(2566979859L)))
                .answer("rand_getProgramPublic", "")
                .answer("rand_getProgramCell", new JSONObject().put("key", KEY).put("value", VALUE))
                .answer("rand_estimateFee", "4476800")
                .answer("rand_getProgramVault", new JSONArray()
                        .put(new JSONObject().put("asset", 0).put("amount", "213800000000"))
                        .put(new JSONObject().put("asset", 2).put("amount", "18712750994")))
                .answer("rand_status", new JSONObject().put("hc_bundle", ProverTest.V3).put("hc_auth", ProverTest.AUTH).put("fri_profile", "production"))
                .answer("rand_getGenesisHash", "cd".repeat(32))
                .answer("rand_getAnchor", new JSONObject().put("height", 91000).put("root", ROOT))
                .answer("rand_getWitness", new JSONObject().put("index", 4).put("root", ROOT).put("path", new JSONArray().put("00")))
                .answer("rand_sendTransaction", "0x" + HASH);
    }

    /** 0.2 RAND for DUR at the live pool. */
    static Amm.Swap swap() {
        return Amm.buildSwap(Amm.findRoute(Arrays.asList(AmmTest.live()), 0, 2), BigInteger.valueOf(200_000_000L), new long[]{1, 2, 3}, "");
    }

    static final class Scans implements Invoke.Notes {
        int count;

        @Override
        public JSONArray scanned() throws Exception {
            count++;
            return new JSONArray().put(new JSONObject().put("index", 4).put("amount", "300000000"));
        }
    }

    static String code(Exception e) {
        return e instanceof Invoke.Refusal ? ((Invoke.Refusal) e).code : "not a refusal: " + e;
    }

    @Test
    public void theQuoteAsksTheCheapestQuestionsFirstThenScansAndPlans() throws Exception {
        Node node = healthy();
        FakeCore core = new FakeCore();
        Scans scans = new Scans();
        Amm.Swap s = swap();
        Invoke.Quote q = Invoke.quote(node, core, s.request, scans);
        assertEquals(Arrays.asList("rand_getLimits", "rand_getProgramCode", "rand_getProgramPublic", "rand_getProgramCell",
                "rand_estimateFee", "rand_getProgramVault"), node.calls);
        assertEquals(Arrays.asList("dry_run_invoke", "plan_invoke"), core.calls);
        assertEquals("the scan comes after every refusal the node can give", 1, scans.count);
        // The transition the core runs: the node's code, the request's cells and words.
        assertEquals(PROGRAM, core.dryAsked.getString("program"));
        assertEquals(4096, core.dryAsked.getJSONObject("program_code").getInt("base_pc"));
        assertEquals("", core.dryAsked.getString("public_hex"));
        assertEquals("[3,1,2,3]", core.dryAsked.getJSONArray("private_inputs").toString());
        assertEquals(VALUE, core.dryAsked.getJSONArray("reads").getJSONObject(0).getString("value"));
        assertFalse("the summary is the screen's, not the core's", core.dryAsked.has("summary"));
        // Priced by tier, gas and the proof's bytes at the chain's cap; the pool cell exists, so none is created.
        JSONObject spec = node.paramsOf("rand_estimateFee").getJSONObject(0);
        assertEquals("invoke", spec.getString("kind"));
        assertEquals(14, spec.getInt("tier"));
        assertEquals(2048, spec.getInt("gas"));
        assertEquals(4194304, spec.getInt("bytes"));
        assertEquals(0, spec.getInt("created_cells"));
        assertEquals(0, spec.getInt("keccak_log_height"));
        // The plan: RAND in as the bundle's burn, no token, the quoted fee.
        assertEquals("200000000", core.planAsked.getString("burn_r"));
        assertEquals(0, core.planAsked.getInt("burn_asset"));
        assertEquals("0", core.planAsked.getString("burn_a"));
        assertEquals("4476800", core.planAsked.getString("fee"));
        assertEquals("4476800", q.fee);
        assertEquals(0, q.cells);
        assertNotNull(q.limits.programState);
        assertEquals("10000000", q.limits.programState.cellFee);
    }

    @Test
    public void aChainWithoutProgramsIsRefusedAtTheFirstQuestion() throws Exception {
        Node node = healthy().answer("rand_getLimits", limits(false));
        FakeCore core = new FakeCore();
        Scans scans = new Scans();
        try {
            Invoke.quote(node, core, swap().request, scans);
            fail("quoted on a chain without programs");
        } catch (Exception e) {
            assertEquals(Invoke.PROGRAMS_UNSUPPORTED, code(e));
        }
        assertEquals(Arrays.asList("rand_getLimits"), node.calls);
        assertTrue(core.calls.isEmpty());
        assertEquals(0, scans.count);
    }

    @Test
    public void aPoolThatMovedIsAStaleReadBeforeTheCoreOrTheFeeIsAsked() throws Exception {
        String moved = VALUE.substring(0, 2) + "ff" + VALUE.substring(4);
        Node node = healthy().answer("rand_getProgramCell", new JSONObject().put("key", KEY).put("value", moved));
        FakeCore core = new FakeCore();
        Scans scans = new Scans();
        try {
            Invoke.quote(node, core, swap().request, scans);
            fail("quoted against a moved pool");
        } catch (Exception e) {
            assertEquals(Invoke.STALE_READ, code(e));
        }
        assertFalse(node.calls.contains("rand_estimateFee"));
        assertTrue(core.calls.isEmpty());
        assertEquals(0, scans.count);
        // A cell reply for another key is a node this wallet cannot read, never a match.
        Node lying = healthy().answer("rand_getProgramCell", new JSONObject().put("key", Amm.poolKey(9)).put("value", VALUE));
        try {
            Invoke.quote(lying, new FakeCore(), swap().request, new Scans());
            fail();
        } catch (Exception e) {
            assertTrue(e.getMessage(), e.getMessage().contains("another key"));
        }
    }

    @Test
    public void noProgramAndAProgramThatRefusesAreSaidPlainly() throws Exception {
        try {
            Invoke.quote(healthy().answer("rand_getProgramCode", JSONObject.NULL), new FakeCore(), swap().request, new Scans());
            fail();
        } catch (Exception e) {
            assertEquals(Invoke.NO_PROGRAM, code(e));
        }
        FakeCore core = new FakeCore();
        core.dryFails = new Exception("the guest halted: k mismatch");
        Node node = healthy();
        try {
            Invoke.quote(node, core, swap().request, new Scans());
            fail();
        } catch (Exception e) {
            assertEquals(Invoke.PROGRAM_REFUSED, code(e));
            assertTrue(e.getMessage(), e.getMessage().contains("k mismatch"));
        }
        assertFalse(node.calls.contains("rand_estimateFee"));
    }

    @Test
    public void aVaultThatCannotPayIsRefusedBeforeTheScan() throws Exception {
        Node node = healthy().answer("rand_getProgramVault", new JSONArray().put(new JSONObject().put("asset", 0).put("amount", "1")));
        FakeCore core = new FakeCore();
        Scans scans = new Scans();
        try {
            Invoke.quote(node, core, swap().request, scans);
            fail();
        } catch (Exception e) {
            assertEquals(Invoke.VAULT_SHORT, code(e));
        }
        assertEquals(0, scans.count);
        assertFalse(core.calls.contains("plan_invoke"));
        // What the transition itself deposits counts: a vault with no RAND still pays RAND it is sold.
        JSONObject inflow = new JSONObject().put("rand", "500").put("asset", 0).put("amount", "0").put("kind", "none");
        assertNull(Invoke.vaultShortfall(inflow, new JSONArray().put(new JSONObject().put("asset", 0).put("amount", "500")), new JSONArray()));
        JSONObject deposit = new JSONObject().put("rand", "0").put("asset", 2).put("amount", "70").put("kind", "deposit");
        assertNull(Invoke.vaultShortfall(deposit, new JSONArray().put(new JSONObject().put("asset", 2).put("amount", "70")), new JSONArray()));
        assertNotNull(Invoke.vaultShortfall(deposit, new JSONArray().put(new JSONObject().put("asset", 2).put("amount", "71")), new JSONArray()));
    }

    @Test
    public void notesThatDoNotCoverTheSwapAreInsufficientFunds() throws Exception {
        FakeCore core = new FakeCore();
        core.planFails = new Exception("need 204476800 units, have 1000");
        try {
            Invoke.quote(healthy(), core, swap().request, new Scans());
            fail();
        } catch (Exception e) {
            assertEquals(Invoke.INSUFFICIENT_FUNDS, code(e));
            assertTrue(e.getMessage(), e.getMessage().contains("need 204476800"));
        }
    }

    @Test
    public void aWriteToAnEmptyCellIsACreatedCellThatTheFeePaysFor() throws Exception {
        JSONObject request = new JSONObject(swap().request.toString());
        String fresh = Amm.poolKey(9);
        request.getJSONArray("writes").put(new JSONObject().put("key", fresh).put("value", "01".repeat(32)));
        Node node = new Node() {
            @Override
            protected Reply transport(String json) {
                try {
                    JSONObject req = new JSONObject(json);
                    if ("rand_getProgramCell".equals(req.getString("method"))) {
                        String key = req.getJSONArray("params").getString(1);
                        answer("rand_getProgramCell", new JSONObject().put("key", key).put("value", key.equals(fresh) ? Invoke.ZERO_WORD8 : VALUE));
                    }
                } catch (Exception e) {
                    throw new IllegalStateException(e);
                }
                return super.transport(json);
            }
        };
        node.replies.putAll(healthy().replies);
        Invoke.Quote q = Invoke.quote(node, new FakeCore(), request, new Scans());
        assertEquals(1, q.cells);
        assertEquals(1, node.paramsOf("rand_estimateFee").getJSONObject(0).getInt("created_cells"));
    }

    @Test
    public void theAnchorIsTakenLastRightBeforeTheDeviceProves() throws Exception {
        Node node = healthy();
        FakeCore core = new FakeCore();
        Invoke.Quote q = Invoke.quote(node, core, swap().request, new Scans());
        node.calls.clear();
        List<String> phases = new ArrayList<>();
        JSONObject proved = Invoke.prove(node, core, q, ProverTest.SPEND_KEY, 20, null, phases::add);
        assertEquals(Arrays.asList("rand_status", "rand_getGenesisHash", "rand_getAnchor", "rand_getWitness"), node.calls);
        assertEquals(Arrays.asList("witness", "prove"), phases);
        assertEquals("aa", proved.getString("tx_hex"));
        JSONObject req = core.proveAsked;
        assertEquals(ProverTest.SPEND_KEY, req.getString("spend_key"));
        assertEquals(20, req.getLong("chain_id"));
        assertEquals("cd".repeat(32), req.getString("genesis"));
        assertEquals(91000, req.getLong("anchor_height"));
        assertEquals(ROOT, req.getString("anchor_root"));
        assertEquals(14, req.getInt("tier"));
        assertEquals("under a gas section the call declares the dry run's limit", 2048, req.getLong("gas_limit"));
        assertEquals("4476800", req.getString("fee"));
        assertEquals(4, req.getJSONArray("inputs").getJSONObject(0).getJSONObject("note").getInt("index"));
        assertEquals("[\"00\"]", req.getJSONArray("inputs").getJSONObject(0).getJSONArray("path").toString());
        assertEquals(0, req.getJSONArray("fee_inputs").length());
        assertEquals(1860, req.getInt("envelope_bytes"));
        assertEquals(20479, req.getLong("bundle_gas_limit"));
        assertEquals(4194304, req.getInt("max_proof_bytes"));
        assertEquals(ProverTest.V3, req.getString("hc_bundle"));
        assertEquals(ProverTest.AUTH, req.getString("hc_auth"));
        assertEquals("production", req.getString("profile"));
        assertEquals(PROGRAM, req.getString("program"));
        assertTrue(req.has("program_code") && req.has("reads") && req.has("writes") && req.has("inflow") && req.has("pays"));
    }

    @Test
    public void aDelegatedInvokeGoesToTheProverWithTheSameRequestAndTheCoreProvesNothing() throws Exception {
        Node node = healthy();
        FakeCore core = new FakeCore();
        Invoke.Quote q = Invoke.quote(node, core, swap().request, new Scans());
        JSONObject[] handed = new JSONObject[1];
        Integer[] cap = new Integer[1];
        List<String> phases = new ArrayList<>();
        JSONObject proved = Invoke.prove(node, core, q, ProverTest.SPEND_KEY, 20, (req, max) -> {
            handed[0] = req;
            cap[0] = max;
            return new JSONObject().put("tx_hex", "bb");
        }, phases::add);
        assertEquals("bb", proved.getString("tx_hex"));
        assertFalse(core.calls.contains("prove_invoke"));
        assertEquals("the prover reports its own progress", Arrays.asList("witness"), phases);
        assertEquals(Integer.valueOf(4194304), cap[0]);
        assertEquals(91000, handed[0].getLong("anchor_height"));
    }

    @Test
    public void aStaleReadAtSubmitIsAStaleReadAndAHashIsLowercased() throws Exception {
        Node node = healthy();
        List<String> phases = new ArrayList<>();
        assertEquals(HASH.toLowerCase(), Invoke.submit(node, new JSONObject().put("tx_hex", "aa"), phases::add));
        assertEquals(Arrays.asList("submit"), phases);
        node.errors.put("rand_sendTransaction", "transaction rejected: StaleRead { key: 0100… }");
        try {
            Invoke.submit(node, new JSONObject().put("tx_hex", "aa"), p -> { });
            fail();
        } catch (Exception e) {
            assertEquals(Invoke.STALE_READ, code(e));
        }
        node.errors.put("rand_sendTransaction", "insufficient fee");
        try {
            Invoke.submit(node, new JSONObject().put("tx_hex", "aa"), p -> { });
            fail();
        } catch (Exception e) {
            assertFalse(e instanceof Invoke.Refusal);
            assertTrue(e.getMessage().contains("insufficient fee"));
        }
    }

    @Test
    public void theProgramStateMethodsAreHeldToTheirShape() throws Exception {
        // The section off: every method answers {"enabled": false}.
        JSONObject off = new JSONObject().put("enabled", false);
        Node node = new Node().answer("rand_getProgramCells", off).answer("rand_getProgramVault", off).answer("rand_getProgramCell", off);
        assertNull(node.programCellsAll(PROGRAM));
        assertNull(node.programVault(PROGRAM));
        assertNull(node.programCell(PROGRAM, KEY));
        // Paged with {after, limit}; a cursor that does not move ends the walk.
        Node paged = new Node() {
            int page;

            @Override
            protected Reply transport(String json) {
                try {
                    page++;
                    String next = page == 1 ? Amm.poolKey(2) : Amm.poolKey(2); // the second page names the same cursor
                    answer("rand_getProgramCells", new JSONObject().put("cells", new JSONArray().put(new JSONObject().put("key", KEY).put("value", VALUE))).put("next", next));
                } catch (Exception e) {
                    throw new IllegalStateException(e);
                }
                return super.transport(json);
            }
        };
        JSONArray all = paged.programCellsAll(PROGRAM);
        assertEquals(2, all.length());
        assertEquals(2, paged.calls.size());
        assertEquals(256, paged.params.get(0).getJSONObject(1).getInt("limit"));
        assertFalse(paged.params.get(0).getJSONObject(1).has("after"));
        assertEquals(Amm.poolKey(2), paged.params.get(1).getJSONObject(1).getString("after"));
        // A vault out of order, a fee that is not units, code words that are not u32: refused.
        Node bad = new Node().answer("rand_getProgramVault", new JSONArray()
                .put(new JSONObject().put("asset", 2).put("amount", "1")).put(new JSONObject().put("asset", 0).put("amount", "1")))
                .answer("rand_estimateFee", 1.5)
                .answer("rand_getProgramCode", new JSONObject().put("base_pc", 0).put("words", new JSONArray().put(-1)));
        for (Runnable r : new Runnable[]{
                () -> { try { bad.programVault(PROGRAM); fail(); } catch (org.randprotocol.wallet.rpc.RpcException expected) { } },
                () -> { try { bad.estimateFee(new JSONObject()); fail(); } catch (org.randprotocol.wallet.rpc.RpcException expected) { } },
                () -> { try { bad.programCode(PROGRAM); fail(); } catch (org.randprotocol.wallet.rpc.RpcException expected) { } },
        }) r.run();
        // program_state that is there but not its shape is refused, not read as "no programs".
        try {
            RpcClient.limitsOf(new JSONObject().put("program_state", new JSONObject().put("cell_fee", "x")));
            fail();
        } catch (org.randprotocol.wallet.rpc.RpcException expected) {
            // final
        }
        assertNull(RpcClient.limitsOf(new JSONObject().put("program_state", JSONObject.NULL)).programState);
    }
}
