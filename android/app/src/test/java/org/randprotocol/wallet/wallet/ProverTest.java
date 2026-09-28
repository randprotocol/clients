package org.randprotocol.wallet.wallet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Delegated proving, Phase 1, on the JVM: the URL rule, pairing, the prover client's errors and
 * the remote send path ({@link RemoteSend} → {@link RemoteProver}) against a prover made of fake
 * {@link HttpURLConnection}s, with a stand-in for the native core (which a unit test cannot load;
 * the real core's parse of the same vector is pinned by the iOS and web integration tests).
 */
public class ProverTest {
    static final String KEM_EK = "07".repeat(1184);
    static final String FINGERPRINT = "Z254-BQX0-VPMT-8YJR";
    static final String TOKEN = "3c".repeat(32);
    static final String SPEND_KEY = "5a".repeat(32);
    static final String URL_OK = "https://prover.example:8600";

    // ------------------------------------------------------------------ fakes

    interface Handler {
        Reply reply(String method, JSONArray params) throws Exception;
    }

    static final class Reply {
        final int status;
        final String body;

        Reply(int status, String body) {
            this.status = status;
            this.body = body;
        }

        static Reply result(Object r) {
            try {
                return new Reply(200, new JSONObject().put("jsonrpc", "2.0").put("id", 1).put("result", r).toString());
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        }

        static Reply error(int code, String message, JSONObject data) {
            try {
                JSONObject e = new JSONObject().put("code", code).put("message", message);
                if (data != null) e.put("data", data);
                return new Reply(200, new JSONObject().put("jsonrpc", "2.0").put("id", 1).put("error", e).toString());
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        }
    }

    /** A prover on no network: each connection hands its request body to {@code handler}. */
    static final class FakeProver implements ProverClient.Transport {
        Handler handler;
        final List<String> bodies = new ArrayList<>();
        final List<String> methods = new ArrayList<>();

        FakeProver(Handler handler) {
            this.handler = handler;
        }

        @Override
        public HttpURLConnection open(URL url) {
            return new HttpURLConnection(url) {
                final ByteArrayOutputStream out = new ByteArrayOutputStream();
                Reply reply;

                private Reply answer() throws IOException {
                    if (reply == null) {
                        String body = out.toString(StandardCharsets.UTF_8);
                        bodies.add(body);
                        try {
                            JSONObject req = new JSONObject(body);
                            methods.add(req.getString("method"));
                            reply = handler.reply(req.getString("method"), req.getJSONArray("params"));
                        } catch (IOException e) {
                            throw e;
                        } catch (Exception e) {
                            throw new IllegalStateException(e);
                        }
                    }
                    return reply;
                }

                @Override
                public OutputStream getOutputStream() {
                    return out;
                }

                @Override
                public int getResponseCode() throws IOException {
                    return answer().status;
                }

                @Override
                public InputStream getInputStream() throws IOException {
                    return new ByteArrayInputStream(answer().body.getBytes(StandardCharsets.UTF_8));
                }

                @Override
                public InputStream getErrorStream() {
                    try {
                        return getInputStream();
                    } catch (IOException e) {
                        return null;
                    }
                }

                @Override
                public void connect() {
                }

                @Override
                public void disconnect() {
                }

                @Override
                public boolean usingProxy() {
                    return false;
                }
            };
        }
    }

    /** The core, standing in: the link and fingerprint vector the real core pins, and a sealer that records. */
    static final class FakeCore implements ProverCore {
        JSONObject prepared;
        boolean own = true;
        String url = URL_OK;

        @Override
        public JSONObject parseProverLink(String link) throws Exception {
            if (!link.startsWith("randprover:")) throw new Exception("not a pairing link");
            return new JSONObject().put("kem_ek", KEM_EK).put("url", url).put("token", TOKEN).put("own", own).put("fingerprint", FINGERPRINT);
        }

        @Override
        public String proverFingerprint(String kemEk) {
            return KEM_EK.equals(kemEk) ? FINGERPRINT : "0THR-0THR-0THR-0THR";
        }

        @Override
        public JSONObject prepareTransfer(JSONObject params) throws Exception {
            prepared = params;
            return new JSONObject().put("sealed_hex", "5e41ed").put("pending", new JSONObject().put("kind", "transfer")).put("expected", "ee");
        }

        @Override
        public JSONObject finishProof(Object pending, String replyHex) throws Exception {
            if (!"good".equals(replyHex)) throw new Exception("the proof does not verify");
            return new JSONObject().put("tx_hex", "aa").put("kind", ((JSONObject) pending).getString("kind"));
        }
    }

    static JSONObject info(String kemEk) throws Exception {
        return new JSONObject().put("kem_ek", kemEk).put("kem_fingerprint", "LIES")
                .put("witness_kinds", new JSONArray().put("spend_key"))
                .put("queue", new JSONObject().put("depth", 1).put("max", 8).put("proving", 1));
    }

    static RemoteProver fastProver(ProverClient client) {
        RemoteProver p = new RemoteProver(client);
        p.pollMs = 0;
        p.sleeper = ms -> { };
        return p;
    }

    // ------------------------------------------------------------------ the URL rule

    @Test
    public void theUrlRule() throws Exception {
        assertEquals("https://p.example", ProverClient.checkUrl(" https://p.example/ "));
        assertEquals("http://localhost:8600", ProverClient.checkUrl("http://localhost:8600"));
        assertEquals("http://127.0.0.1:8600", ProverClient.checkUrl("http://127.0.0.1:8600"));
        assertEquals("http://[::1]:8600", ProverClient.checkUrl("http://[::1]:8600"));
        refused("http://10.0.0.2:8600", "Use https for a prover — plain http is only allowed for a prover on this machine.");
        refused("ftp://p.example", "A prover address must be https://.");
        refused("", "The pairing link has no prover address.");
        refused("not a url", "The pairing link's prover address is not a URL.");
    }

    private static void refused(String url, String message) {
        try {
            ProverClient.checkUrl(url);
            fail("accepted " + url);
        } catch (ProverClient.Refusal e) {
            assertEquals(message, e.getMessage());
        }
    }

    // ------------------------------------------------------------------ pairing

    @Test
    public void pairingChecksTheProversKeyAgainstTheLink() throws Exception {
        FakeCore core = new FakeCore();
        FakeProver prover = new FakeProver((m, p) -> {
            assertEquals("prover_info", m);
            return Reply.result(info(KEM_EK.toUpperCase()));
        });
        ProverPairing.Paired paired = ProverPairing.pair(core, "randprover:xyz", prover);
        assertEquals("prover.example:8600", paired.pairing.name);
        assertEquals(URL_OK, paired.pairing.url);
        assertEquals(KEM_EK, paired.pairing.kemEk);
        assertEquals(FINGERPRINT, paired.pairing.fingerprint);
        assertTrue(paired.pairing.own);
        assertEquals(TOKEN, paired.token);
        for (String body : prover.bodies) assertFalse("the token went on the wire", body.contains(TOKEN));
        assertEquals("Answering · 1 of 8 in its queue.", ProverPairing.probe(core, paired.pairing, prover).line());

        // A pairing whose fingerprint is not the one the core computes from the key.
        ProverPairing forged = new ProverPairing("x", URL_OK, KEM_EK, "0000-0000-0000-0000", true);
        assertEquals("Not answering: the prover at that address now has a different key; pair it again.",
                ProverPairing.probe(core, forged, prover).line());

        // Another key at the same address: refused, however it names itself.
        prover.handler = (m, p) -> Reply.result(info("08".repeat(1184)).put("kem_fingerprint", FINGERPRINT));
        try {
            ProverPairing.pair(core, "randprover:xyz", prover);
            fail("paired a prover with another key");
        } catch (ProverClient.Refusal e) {
            assertEquals("The prover at that address has a different key from the one the link names. Do not pair it.", e.getMessage());
        }
    }

    @Test
    public void previewHoldsTheUrlRuleAndWarnsOnANotOwnLink() throws Exception {
        FakeCore core = new FakeCore();
        ProverPairing.Preview seen = ProverPairing.preview(core, "randprover:xyz");
        assertEquals(URL_OK, seen.url);
        assertNull(seen.warning);
        core.own = false;
        assertEquals(ProverPairing.NOT_OWN_WARNING, ProverPairing.preview(core, "randprover:xyz").warning);
        core.url = "http://192.168.1.5:8600";
        try {
            ProverPairing.preview(core, "randprover:xyz");
            fail();
        } catch (ProverClient.Refusal e) {
            assertEquals("Use https for a prover — plain http is only allowed for a prover on this machine.", e.getMessage());
        }
    }

    @Test
    public void thePairingRoundTripsThroughPrefsJsonAndAHalfOneIsNone() {
        ProverPairing p = new ProverPairing("h:1", URL_OK, KEM_EK, FINGERPRINT, true);
        ProverPairing back = ProverPairing.fromJson(p.toJson().toString());
        assertEquals(p.name, back.name);
        assertEquals(p.kemEk, back.kemEk);
        assertTrue(back.own);
        assertFalse("no token in Prefs", p.toJson().toString().contains("token"));
        assertNull(ProverPairing.fromJson("{\"url\":\"" + URL_OK + "\"}"));
        assertNull(ProverPairing.fromJson("not json"));
    }

    // ------------------------------------------------------------------ the client's errors

    @Test
    public void refusalsAreWordedAsTheOtherWallets() throws Exception {
        FakeProver prover = new FakeProver((m, p) -> Reply.error(-32005, "busy", new JSONObject().put("depth", 3)));
        ProverClient client = new ProverClient(URL_OK, prover);
        assertEquals("The prover is full (3 waiting). Try again in a few minutes.", refusalOf(client));
        prover.handler = (m, p) -> Reply.error(-32003, "unpaired", null);
        assertEquals("This prover does not know this pairing. Pair it again in Settings.", refusalOf(client));
        prover.handler = (m, p) -> Reply.result(new JSONObject().put("job", "../etc"));
        try {
            client.submit("00");
            fail();
        } catch (ProverClient.ProverError e) {
            assertEquals("body", e.failure);
        }
        prover.handler = (m, p) -> new Reply(502, "bad gateway");
        try {
            client.info();
            fail();
        } catch (ProverClient.ProverError e) {
            assertEquals("http", e.failure);
            assertNull(ProverClient.refusal(e));
        }
        prover.handler = (m, p) -> {
            throw new SocketTimeoutException("slow");
        };
        try {
            client.info();
            fail();
        } catch (ProverClient.ProverError e) {
            assertEquals("timeout", e.failure);
        }
    }

    private static String refusalOf(ProverClient client) {
        try {
            client.submit("00");
            fail();
            return null;
        } catch (ProverClient.ProverError e) {
            return ProverClient.refusal(e).getMessage();
        }
    }

    // ------------------------------------------------------------------ the remote send path

    @Test
    public void aSendIsSealedToThePairingPolledThroughATransportFailureAndOpenedByTheCore() throws Exception {
        int[] polls = {0};
        FakeProver prover = new FakeProver((m, p) -> {
            switch (m) {
                case "prover_submit":
                    assertEquals("5e41ed", p.getString(0));
                    return Reply.result(new JSONObject().put("job", "job-1"));
                case "prover_status":
                    assertEquals("job-1", p.getString(0));
                    polls[0]++;
                    if (polls[0] == 1) return Reply.result(new JSONObject().put("state", "queued").put("position", 2));
                    if (polls[0] == 2) throw new IOException("connection reset");
                    if (polls[0] == 3) return Reply.result(new JSONObject().put("state", "proving"));
                    return Reply.result(new JSONObject().put("state", "done").put("reply", "good"));
                default:
                    return Reply.error(-32601, "no", null);
            }
        });
        FakeCore core = new FakeCore();
        JSONObject request = new JSONObject().put("spend_key", SPEND_KEY).put("to", "rand1x").put("profile", "production");
        RemoteSend.Route route = new RemoteSend.Route(new ProverPairing("prover.example:8600", URL_OK, KEM_EK, FINGERPRINT, true), TOKEN);
        List<Integer> phases = new ArrayList<>();
        SendState base = new SendState(SendState.Phase.PREPARING, "", null, null, "1", "rand1x", 0);
        List<String> shown = new ArrayList<>();

        JSONObject proved = RemoteSend.prove(core, fastProver(new ProverClient(URL_OK, prover)), request, route, 2_000_000,
                "ab".repeat(32), pos -> {
                    phases.add(pos);
                    shown.add(base.remote(route.pairing.name, pos).message);
                });

        assertEquals("aa", proved.getString("tx_hex"));
        assertEquals("transfer", proved.getString("kind"));
        assertEquals(java.util.Arrays.asList(null, 2, null), phases);
        assertEquals(java.util.Arrays.asList("Proving on prover.example:8600…", "Waiting at position 2 on prover.example:8600",
                "Proving on prover.example:8600…"), shown);
        // What the core sealed: the request, the prover target and the chain's cap and guest.
        JSONObject target = core.prepared.getJSONObject("prover");
        assertEquals(KEM_EK, target.getString("kem_ek"));
        assertEquals(TOKEN, target.getString("token"));
        assertEquals("spend_key", target.getString("witness_kind"));
        assertEquals("ab".repeat(32), target.getString("hc_bundle"));
        assertEquals(2_000_000, core.prepared.getInt("max_proof_bytes"));
        assertEquals(SPEND_KEY, core.prepared.getString("spend_key"));
        assertFalse("the caller's request is not changed", request.has("prover"));
        // What went on the wire: the sealed job and job ids — never the spend key or the token.
        for (String body : prover.bodies) {
            assertFalse("the spend key went on the wire", body.contains(SPEND_KEY));
            assertFalse("the token went on the wire", body.contains(TOKEN));
        }
        assertEquals(java.util.Arrays.asList("prover_submit", "prover_status", "prover_status", "prover_status", "prover_status"), prover.methods);
    }

    @Test
    public void aReplyTheCoreRefusesNeverComesBackAndAFailedJobIsDefinite() throws Exception {
        FakeProver prover = new FakeProver((m, p) -> m.equals("prover_submit")
                ? Reply.result(new JSONObject().put("job", "j"))
                : Reply.result(new JSONObject().put("state", "done").put("reply", "forged")));
        FakeCore core = new FakeCore();
        RemoteSend.Route route = new RemoteSend.Route(new ProverPairing("p", URL_OK, KEM_EK, FINGERPRINT, true), TOKEN);
        try {
            RemoteSend.prove(core, fastProver(new ProverClient(URL_OK, prover)), new JSONObject(), route, null, null, pos -> { });
            fail();
        } catch (ProverClient.Refusal e) {
            assertEquals("The prover's proof was refused by this wallet: the proof does not verify", e.getMessage());
        }
        assertFalse("no hc_bundle when the node reports none", core.prepared.getJSONObject("prover").has("hc_bundle"));
        assertFalse(core.prepared.has("max_proof_bytes"));
        prover.handler = (m, p) -> m.equals("prover_submit")
                ? Reply.result(new JSONObject().put("job", "j"))
                : Reply.result(new JSONObject().put("state", "failed").put("error", "out of memory"));
        try {
            RemoteSend.prove(core, fastProver(new ProverClient(URL_OK, prover)), new JSONObject(), route, null, null, pos -> { });
            fail();
        } catch (ProverClient.Refusal e) {
            assertEquals("The prover could not make this proof (failed: out of memory).", e.getMessage());
        }
        prover.handler = (m, p) -> Reply.error(-32005, "busy", new JSONObject().put("depth", 8));
        try {
            RemoteSend.prove(core, fastProver(new ProverClient(URL_OK, prover)), new JSONObject(), route, null, null, pos -> { });
            fail();
        } catch (ProverClient.Refusal e) {
            assertEquals("The prover is full (8 waiting). Try again in a few minutes.", e.getMessage());
        }
    }

    @Test
    public void aSilentProverIsGivenUpAfterMaxWaitAndTheJobCancelled() throws Exception {
        FakeProver prover = new FakeProver((m, p) -> {
            if (m.equals("prover_submit")) return Reply.result(new JSONObject().put("job", "j"));
            if (m.equals("prover_cancel")) return Reply.result(true);
            throw new IOException("connection refused");
        });
        RemoteProver rp = fastProver(new ProverClient(URL_OK, prover));
        long[] t = {0};
        rp.clock = () -> t[0] += 30_000;
        rp.maxWaitMs = 120_000;
        try {
            rp.prove("ab", new JSONObject(), (pending, reply) -> null, pos -> { });
            fail();
        } catch (ProverClient.Refusal e) {
            assertEquals("Your prover has not answered for 2 minutes, so nothing was sent. Send again.", e.getMessage());
        }
        assertTrue(prover.methods.contains("prover_cancel"));
    }

    @Test
    public void theChainsProofParametersAreReadStrictly() throws Exception {
        assertEquals("ab".repeat(32), RemoteSend.hcBundleOf(new JSONObject().put("hc_bundle", " " + "AB".repeat(32) + " ")));
        assertNull(RemoteSend.hcBundleOf(new JSONObject().put("hc_bundle", "abc")));
        assertNull(RemoteSend.hcBundleOf(null));
        assertEquals("test", RemoteSend.profileOf(new JSONObject().put("fri_profile", "test")));
        assertEquals("production", RemoteSend.profileOf(new JSONObject().put("fri_profile", "fast")));
        assertEquals("production", RemoteSend.profileOf(null));
        assertEquals(Integer.valueOf(2_000_000), org.randprotocol.wallet.rpc.RpcClient.maxProofBytesOf(new JSONObject().put("max_proof_bytes", 2_000_000)));
        assertNull(org.randprotocol.wallet.rpc.RpcClient.maxProofBytesOf(new JSONObject()));
    }
}
