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
 * Delegated proving (Phases 1 and 2: split authorisation), on the JVM: the URL rule, pairing, the
 * prover client's errors, the route and the remote send path ({@link RemoteSend} →
 * {@link RemoteProver}) against a prover made of fake {@link HttpURLConnection}s, with a stand-in
 * for the native core (which a unit test cannot load; the real core's parse of the same vector,
 * and its {@code chain_guests}, are pinned by the iOS and web integration tests).
 */
public class ProverTest {
    static final String KEM_EK = "07".repeat(1184);
    static final String FINGERPRINT = "Z254-BQX0-VPMT-8YJR";
    static final String TOKEN = "3c".repeat(32);
    static final String SPEND_KEY = "5a".repeat(32);
    static final String URL_OK = "https://prover.example:8600";
    /** Bundle guest v3 and the auth guest (fullnode v0.6.3+): a split-authorisation chain. */
    static final String V3 = "60af094acfe65d85fdb18fb3d06cf9085dcf28c96e59e87f1ee527226e6e3fce";
    static final String AUTH = "1e4e347f44cf86750b30a9a4bdf9ec9256efe353d4ff8017451eca7d195639c1";
    /** A bundle guest that is not v3: an older chain, whose witness carries the spend key. */
    static final String V2 = "ab".repeat(32);
    static final String HISTORY = "the core's own history sentence";
    /** The prover the build ships the address of (the core's {@code version.trusted_prover}). */
    /** The pool's members (wallet 0.6.9): each its own URL, key, fingerprint and public token. */
    static final String[] POOL = {"a", "b", "c"};

    static String memberUrl(String m) {
        return "https://prover.randprotocol.org/m/" + m;
    }

    static String memberEk(String m) {
        return ("0" + (char) ('a' + (m.charAt(0) - 'a'))).repeat(1184);
    }

    static String memberFingerprint(String m) {
        String c = m.toUpperCase();
        return (c + c + c + c) + "-" + (c + c + c + c) + "-" + (c + c + c + c) + "-POOL";
    }

    static String memberToken(String m) {
        return ("c" + (m.charAt(0) - 'a')).repeat(32);
    }

    static String memberLink(String m) {
        return "randprover:pool-" + m + "?url=https%3A%2F%2Fprover.randprotocol.org%2Fm%2F" + m + "&token=" + memberToken(m);
    }

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
        final List<String> urls = new ArrayList<>();
        final List<Boolean> followRedirects = new ArrayList<>();

        FakeProver(Handler handler) {
            this.handler = handler;
        }

        @Override
        public HttpURLConnection open(URL url) {
            urls.add(url.toString());
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
                    followRedirects.add(getInstanceFollowRedirects());
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

    /**
     * The core, standing in: the link and fingerprint vector the real core pins, its
     * {@code chain_guests} rule (v3 needs the auth guest and takes the viewing key; an older
     * guest takes the spend key; both absent is the default chain, v3), and a sealer that records.
     */
    static final class FakeCore implements ProverCore {
        JSONObject prepared;
        JSONObject guestsAsked;
        boolean own = true;
        String url = URL_OK;
        /** What a member's built-in link parses to: {@code own} as the link carries it. */
        boolean trustedOwn = false;
        /** The core's {@code version}: carries {@code trusted_prover_pool} only when a test puts it there. */
        JSONObject version = new JSONObject();
        /** Every {@code prepare_transfer} the core was asked, in order. */
        final List<JSONObject> preparedAll = new ArrayList<>();

        /** A {@code version} naming the pool exactly as the real core reports it. */
        FakeCore withTrustedProver() throws Exception {
            version.put("trusted_prover_pool", poolJson());
            return this;
        }

        static JSONObject poolJson() throws Exception {
            JSONArray members = new JSONArray();
            for (String m : POOL) {
                members.put(new JSONObject().put("name", m).put("url", memberUrl(m)).put("fingerprint", memberFingerprint(m))
                        .put("link", memberLink(m)).put("own", false));
            }
            return new JSONObject().put("name", "RandProtocol").put("members", members);
        }

        @Override
        public JSONObject parseProverLink(String link) throws Exception {
            if (!link.startsWith("randprover:")) throw new Exception("not a pairing link");
            for (String m : POOL) {
                if (link.equals(memberLink(m))) {
                    return new JSONObject().put("kem_ek", memberEk(m)).put("url", memberUrl(m)).put("token", memberToken(m))
                            .put("own", trustedOwn).put("fingerprint", memberFingerprint(m));
                }
            }
            return new JSONObject().put("kem_ek", KEM_EK).put("url", url).put("token", TOKEN).put("own", own).put("fingerprint", FINGERPRINT);
        }

        @Override
        public String proverFingerprint(String kemEk) {
            for (String m : POOL) if (memberEk(m).equals(kemEk)) return memberFingerprint(m);
            return KEM_EK.equals(kemEk) ? FINGERPRINT : "0THR-0THR-0THR-0THR";
        }

        @Override
        public TrustedProver trustedProver() {
            return TrustedProver.fromJson(version.optJSONObject("trusted_prover_pool"));
        }

        @Override
        public JSONObject chainGuests(JSONObject params) throws Exception {
            guestsAsked = params;
            String hc = params.isNull("hc_bundle") ? null : params.getString("hc_bundle");
            String auth = params.isNull("hc_auth") ? null : params.getString("hc_auth");
            if (hc == null && auth == null) return guests(V3, AUTH, true);
            if (V3.equals(hc)) {
                if (auth == null) throw new Exception("this chain's bundle guest is v3 (split authorisation) but the node names no auth guest");
                if (!AUTH.equals(auth)) throw new Exception("this chain's auth guest is " + auth + "; this wallet carries " + AUTH);
                return guests(V3, AUTH, true);
            }
            if (auth != null) throw new Exception("this chain names an auth guest but a v1/v2 bundle guest (" + hc + ")");
            return guests(hc, null, false);
        }

        private static JSONObject guests(String hc, String auth, boolean v3) throws Exception {
            return new JSONObject().put("hc_bundle", hc).put("hc_auth", auth == null ? JSONObject.NULL : auth)
                    .put("split_authorisation", v3).put("witness_kind", v3 ? "viewing_key" : "spend_key");
        }

        @Override
        public JSONObject prepareTransfer(JSONObject params) throws Exception {
            prepared = params;
            preparedAll.add(params);
            return new JSONObject().put("sealed_hex", "5e41ed").put("pending", new JSONObject().put("kind", "transfer")).put("expected", "ee");
        }

        @Override
        public String historyWarning() {
            return HISTORY;
        }

        @Override
        public String formatAmount(String units) {
            return units.equals("500000000") ? "0.5" : units;
        }

        @Override
        public JSONObject finishProof(Object pending, String replyHex) throws Exception {
            if (!"good".equals(replyHex)) throw new Exception("the proof does not verify");
            return new JSONObject().put("tx_hex", "aa").put("kind", ((JSONObject) pending).getString("kind"));
        }
    }

    /** A Phase 2 prover's {@code prover_info}: both kinds, no fee. */
    static JSONObject info(String kemEk) throws Exception {
        return info(kemEk, JSONObject.NULL, "viewing_key", "spend_key");
    }

    static JSONObject info(String kemEk, Object fee, String... kinds) throws Exception {
        JSONArray k = new JSONArray();
        for (String s : kinds) k.put(s);
        return new JSONObject().put("kem_ek", kemEk).put("kem_fingerprint", "LIES")
                .put("witness_kinds", k).put("fee", fee)
                .put("queue", new JSONObject().put("depth", 1).put("max", 8).put("proving", 1));
    }

    static JSONObject fee(String amount) throws Exception {
        return new JSONObject().put("amount", amount).put("address", "rand1payme");
    }

    /** A prover that answers {@code prover_info} with {@code info} and everything else with {@code rest}. */
    static Handler answering(JSONObject info, Handler rest) {
        return (m, p) -> m.equals("prover_info") ? Reply.result(info) : rest.reply(m, p);
    }

    /** What the Proving screen would show, in order: the authorising step, then the prover's phases. */
    static final class Phases implements RemoteProver.PhaseListener {
        final List<Integer> positions = new ArrayList<>();
        final List<String> shown = new ArrayList<>();
        final SendState base = new SendState(SendState.Phase.PREPARING, "", null, null, "1", "rand1x", 0);
        final String name;

        Phases(String name) {
            this.name = name;
        }

        @Override
        public void phase(Integer position) {
            positions.add(position);
            shown.add(base.remote(name, position).message);
        }

        @Override
        public void authorising() {
            shown.add(base.authorising(name).message);
        }
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
    public void previewHoldsTheUrlRuleAndWarnsOnANotOwnLinkInTheCoresWords() throws Exception {
        FakeCore core = new FakeCore();
        ProverPairing.Preview seen = ProverPairing.preview(core, "randprover:xyz");
        assertEquals(URL_OK, seen.url);
        assertTrue(seen.own);
        assertNull(seen.warning);
        core.own = false;
        ProverPairing.Preview notOwn = ProverPairing.preview(core, "randprover:xyz");
        assertFalse(notOwn.own);
        assertEquals("the warning is the core's sentence (version.prover_history_warning)", HISTORY, notOwn.warning);
        // The fallback, and the shared UI's PROVER_WARNING: the one sentence every shell shows.
        assertEquals("This prover will be able to read this wallet's whole history — every payment received and sent, "
                + "before and after today. It cannot spend. To keep your history private, run your own.", ProverPairing.WARNING);
        assertEquals("Not marked as your own: it can read this wallet's whole history. It cannot spend.", ProverPairing.NOT_OWN_NOTE);
        // A pairing not marked own pairs like any other (it will get viewing-key jobs).
        FakeProver prover = new FakeProver((m, p) -> Reply.result(info(KEM_EK)));
        ProverPairing.Paired paired = ProverPairing.pair(core, "randprover:xyz", prover);
        assertFalse(paired.pairing.own);
        assertFalse("own is in the vault record", ProverSecret.of(paired.pairing, paired.token).own);
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

    // ------------------------------------------------------------------ the RandProtocol provers (0.6.9)

    /** The pool is read from the core's {@code version.trusted_prover_pool}; links stay package-private. */
    @Test
    public void thePoolIsReadFromTheCoresVersionAndNullWhenItNamesNone() throws Exception {
        TrustedProver t = new FakeCore().withTrustedProver().trustedProver();
        assertEquals("RandProtocol", t.name);
        assertEquals(3, t.members.size());
        for (int i = 0; i < POOL.length; i++) {
            assertEquals(POOL[i], t.members.get(i).name);
            assertEquals(memberUrl(POOL[i]), t.members.get(i).url);
            assertEquals(memberFingerprint(POOL[i]), t.members.get(i).fingerprint);
        }
        assertNull(new FakeCore().trustedProver());
        assertNull(TrustedProver.fromJson(new JSONObject().put("members", new JSONArray())));
        assertNull("a pool with no link is none", TrustedProver.fromJson(new JSONObject().put("members",
                new JSONArray().put(new JSONObject().put("name", "a").put("url", memberUrl("a")).put("fingerprint", memberFingerprint("a"))))));
    }

    /** Each member is held to ITS pin; one that fails is left out, the others keep working. */
    @Test
    public void builtInPoolHoldsEachMemberToItsOwnPinAndLeavesOutOnlyAMismatch() throws Exception {
        FakeCore core = new FakeCore().withTrustedProver();
        List<ProverPairing.Paired> all = ProverPairing.builtInPool(core);
        assertEquals(3, all.size());
        for (int i = 0; i < POOL.length; i++) {
            ProverPairing.Paired m = all.get(i);
            assertEquals("RandProtocol (" + POOL[i] + ")", m.pairing.name);
            assertEquals(memberUrl(POOL[i]), m.pairing.url);
            assertEquals(memberEk(POOL[i]), m.pairing.kemEk);
            assertEquals(memberFingerprint(POOL[i]), m.pairing.fingerprint);
            assertEquals(memberToken(POOL[i]), m.token);
            assertFalse(m.pairing.own);
        }
        core.version.getJSONObject("trusted_prover_pool").getJSONArray("members").getJSONObject(0).put("fingerprint", "ZZZZ-ZZZZ-ZZZZ-ZZZZ");
        List<ProverPairing.Paired> rest = ProverPairing.builtInPool(core);
        assertEquals("the mismatched member was kept", 2, rest.size());
        assertEquals(memberUrl("b"), rest.get(0).pairing.url);
        // A link marked own is nobody's pool member.
        FakeCore own = new FakeCore().withTrustedProver();
        own.trustedOwn = true;
        try {
            ProverPairing.builtInPool(own);
            fail("an own link joined the pool");
        } catch (ProverClient.Refusal e) {
            assertTrue(e.getMessage(), e.getMessage().startsWith("None of the built-in RandProtocol prover links"));
        }
        try {
            ProverPairing.builtInPool(new FakeCore());
            fail("a build without a pool used one");
        } catch (ProverClient.Refusal e) {
            assertEquals("This build ships no prover to use.", e.getMessage());
        }
    }

    // ------------------------------------------------------------------ the client's errors

    @Test
    public void refusalsAreWordedAsTheOtherWallets() throws Exception {
        FakeProver prover = new FakeProver((m, p) -> Reply.error(-32005, "busy", new JSONObject().put("depth", 3)));
        ProverClient client = new ProverClient(URL_OK, prover);
        assertEquals("The prover is full (3 waiting). Try again in a few minutes.", refusalOf(client));
        prover.handler = (m, p) -> Reply.error(-32003, "unpaired", null);
        assertEquals("This prover does not know this pairing. Pair it again in Settings.", refusalOf(client));
        prover.handler = (m, p) -> Reply.error(-32004, "kind", new JSONObject().put("reason", "spend_key jobs need --accept-spend-key"));
        assertEquals("This prover does not accept this kind of job (spend_key jobs need --accept-spend-key). Pair another prover in Settings.", refusalOf(client));
        prover.handler = (m, p) -> Reply.error(-32006, "fee", null);
        assertEquals(ProverClient.FEE_REFUSAL, refusalOf(client));
        assertEquals("This prover charges a fee, which this version of the wallet does not pay. Pair a prover that charges nothing in Settings, "
                + "or send from the rand command-line wallet.", ProverClient.FEE_REFUSAL);
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

    /**
     * Split authorisation, the main path: on a v3 chain the job is a VIEWING-KEY job, so a pairing
     * not marked as the user's own takes it — sealed with {@code own: false}, the prover's
     * {@code fee} passed through, and NO {@code witness_kind} (the core's decision; naming
     * "spend_key" there is refused by it). The device authorises the spend first, and says so.
     */
    @Test
    public void aSendIsSealedToThePairingPolledThroughATransportFailureAndOpenedByTheCore() throws Exception {
        int[] polls = {0};
        FakeProver prover = new FakeProver((m, p) -> {
            switch (m) {
                case "prover_info":
                    return Reply.result(info(KEM_EK.toUpperCase(), JSONObject.NULL, "viewing_key"));
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
        JSONObject request = new JSONObject().put("spend_key", SPEND_KEY).put("to", "rand1x");
        RemoteSend.applyProofParams(request, new JSONObject().put("fri_profile", "test").put("hc_bundle", V3).put("hc_auth", AUTH));
        RemoteSend.Route route = new RemoteSend.Route(new ProverPairing("prover.example:8600", URL_OK, KEM_EK, FINGERPRINT, false), TOKEN);
        Phases phases = new Phases(route.pairing.name);

        JSONObject proved = RemoteSend.prove(core, fastProver(new ProverClient(URL_OK, prover)), request, route, 2_000_000, phases);

        assertEquals("aa", proved.getString("tx_hex"));
        assertEquals("transfer", proved.getString("kind"));
        assertEquals(java.util.Arrays.asList(null, 2, null), phases.positions);
        assertEquals(java.util.Arrays.asList("Authorising the spend on this device…", "Proving on prover.example:8600…",
                "Waiting at position 2 on prover.example:8600", "Proving on prover.example:8600…"), phases.shown);
        // The core was asked what the chain's guests take, with both, before anything was built.
        assertEquals(V3, core.guestsAsked.getString("hc_bundle"));
        assertEquals(AUTH, core.guestsAsked.getString("hc_auth"));
        // What the core sealed: the request, the prover target and the chain's cap and guests.
        JSONObject target = core.prepared.getJSONObject("prover");
        assertEquals(KEM_EK, target.getString("kem_ek"));
        assertEquals(TOKEN, target.getString("token"));
        assertFalse("the pairing is not the user's own", target.getBoolean("own"));
        assertFalse("the witness kind is the core's decision, never named by the shell", target.has("witness_kind"));
        assertTrue("the prover's fee, verbatim: none", target.isNull("fee"));
        assertEquals(V3, target.getString("hc_bundle"));
        assertEquals(2_000_000, core.prepared.getInt("max_proof_bytes"));
        assertEquals("test", core.prepared.getString("profile"));
        assertEquals(V3, core.prepared.getString("hc_bundle"));
        assertEquals(AUTH, core.prepared.getString("hc_auth"));
        assertEquals(SPEND_KEY, core.prepared.getString("spend_key"));
        assertFalse("the caller's request is not changed", request.has("prover"));
        // What went on the wire: the sealed job and job ids — never the spend key or the token.
        for (String body : prover.bodies) {
            assertFalse("the spend key went on the wire", body.contains(SPEND_KEY));
            assertFalse("the token went on the wire", body.contains(TOKEN));
        }
        assertEquals(java.util.Arrays.asList("prover_info", "prover_submit", "prover_status", "prover_status", "prover_status", "prover_status"), prover.methods);
    }

    /** The same send to a pairing marked own: {@code own: true}, still a viewing-key job, still no kind named. */
    @Test
    public void anOwnPairingOnAV3ChainGetsTheSameViewingKeyJob() throws Exception {
        FakeProver prover = new FakeProver(answering(info(KEM_EK), (m, p) -> m.equals("prover_submit")
                ? Reply.result(new JSONObject().put("job", "j"))
                : Reply.result(new JSONObject().put("state", "done").put("reply", "good"))));
        FakeCore core = new FakeCore();
        JSONObject request = new JSONObject().put("spend_key", SPEND_KEY);
        RemoteSend.applyProofParams(request, new JSONObject().put("hc_bundle", V3).put("hc_auth", AUTH));
        RemoteSend.Route route = new RemoteSend.Route(new ProverPairing("p", URL_OK, KEM_EK, FINGERPRINT, true), TOKEN);
        RemoteSend.prove(core, fastProver(new ProverClient(URL_OK, prover)), request, route, null, pos -> { });
        JSONObject target = core.prepared.getJSONObject("prover");
        assertTrue(target.getBoolean("own"));
        assertFalse(target.has("witness_kind"));
        // A v3 chain whose prover predates viewing-key jobs: refused before anything is built.
        prover.handler = answering(info(KEM_EK, JSONObject.NULL, "spend_key"), (m, p) -> Reply.error(-32601, "no", null));
        core.prepared = null;
        try {
            RemoteSend.prove(core, fastProver(new ProverClient(URL_OK, prover)), request, route, null, pos -> { });
            fail();
        } catch (ProverClient.Refusal e) {
            assertEquals("Your prover does not take viewing-key jobs (it is older than this chain). Update it, or pair another.", e.getMessage());
        }
        assertNull(core.prepared);
    }

    /**
     * An older chain (bundle guest v1/v2, no auth guest): its witness carries the spend key, which
     * goes only to a prover paired as the user's own. A pairing not marked own is refused BEFORE
     * anything is built or the prover even asked — the core would refuse it too, after making
     * nothing; this says so first.
     */
    @Test
    public void anOldChainsSpendKeyJobIsRefusedForANotOwnPairingBeforeAnythingIsBuilt() throws Exception {
        FakeProver prover = new FakeProver(answering(info(KEM_EK), (m, p) -> Reply.result(new JSONObject().put("job", "j"))));
        FakeCore core = new FakeCore();
        JSONObject request = new JSONObject().put("spend_key", SPEND_KEY);
        RemoteSend.applyProofParams(request, new JSONObject().put("hc_bundle", V2));
        assertTrue("hc_auth is sent as null on a chain without one", request.has("hc_auth") && request.isNull("hc_auth"));
        RemoteSend.Route notOwn = new RemoteSend.Route(new ProverPairing("p", URL_OK, KEM_EK, FINGERPRINT, false), TOKEN);
        try {
            RemoteSend.prove(core, fastProver(new ProverClient(URL_OK, prover)), request, notOwn, null, pos -> { });
            fail("sealed a spend-key job to a prover not paired as own");
        } catch (ProverClient.Refusal e) {
            assertEquals("On this chain a proof needs the spend key, which goes only to a prover paired as your own. "
                    + "Pair your own prover in Settings, or send from the rand command-line wallet.", e.getMessage());
        }
        assertNull("prepare_transfer was never called", core.prepared);
        assertTrue("the prover was never asked", prover.methods.isEmpty());
        assertEquals("spend_key", core.chainGuests(core.guestsAsked).getString("witness_kind"));
        // The same chain, a pairing marked own: the spend-key job goes out, own: true, no kind named.
        prover.handler = answering(info(KEM_EK), (m, p) -> m.equals("prover_submit")
                ? Reply.result(new JSONObject().put("job", "j"))
                : Reply.result(new JSONObject().put("state", "done").put("reply", "good")));
        RemoteSend.Route own = new RemoteSend.Route(new ProverPairing("p", URL_OK, KEM_EK, FINGERPRINT, true), TOKEN);
        RemoteSend.prove(core, fastProver(new ProverClient(URL_OK, prover)), request, own, null, pos -> { });
        assertTrue(core.prepared.getJSONObject("prover").getBoolean("own"));
        assertFalse(core.prepared.getJSONObject("prover").has("witness_kind"));
        assertTrue(core.prepared.isNull("hc_auth"));
    }

    /**
     * A prover quoting a fee is refused at the one point a job is made — after its {@code
     * prover_info} is re-read, before the auth proof is made ({@code prepare_transfer}) and before
     * anything is submitted; and a prover that refuses an unpaid job ({@code -32006}) is definite.
     */
    @Test
    public void aProverQuotingAFeeIsRefusedBeforeTheAuthProofIsMade() throws Exception {
        FakeProver prover = new FakeProver(answering(info(KEM_EK, fee("500000000"), "viewing_key"),
                (m, p) -> Reply.result(new JSONObject().put("job", "j"))));
        FakeCore core = new FakeCore();
        JSONObject request = new JSONObject().put("spend_key", SPEND_KEY);
        RemoteSend.applyProofParams(request, new JSONObject().put("hc_bundle", V3).put("hc_auth", AUTH));
        RemoteSend.Route route = new RemoteSend.Route(new ProverPairing("p", URL_OK, KEM_EK, FINGERPRINT, false), TOKEN);
        Phases phases = new Phases("p");
        try {
            RemoteSend.prove(core, fastProver(new ProverClient(URL_OK, prover)), request, route, null, phases);
            fail("sealed a job to a prover that charges");
        } catch (ProverClient.Refusal e) {
            assertEquals(ProverClient.FEE_REFUSAL, e.getMessage());
        }
        assertNull("no auth proof was made for nothing", core.prepared);
        assertTrue(phases.shown.isEmpty());
        assertEquals(java.util.Collections.singletonList("prover_info"), prover.methods);
        // A zero quote is no fee.
        prover.handler = answering(info(KEM_EK, fee("0"), "viewing_key"), (m, p) -> m.equals("prover_submit")
                ? Reply.result(new JSONObject().put("job", "j"))
                : Reply.result(new JSONObject().put("state", "done").put("reply", "good")));
        RemoteSend.prove(core, fastProver(new ProverClient(URL_OK, prover)), request, route, null, pos -> { });
        assertEquals("0", core.prepared.getJSONObject("prover").getJSONObject("fee").getString("amount"));
        // A quote this wallet cannot read is a fee, never "free".
        assertNotNull(ProverClient.feeRefusal(new JSONObject().put("amount", 5), core));
        assertNull(ProverClient.feeRefusal(JSONObject.NULL, core));
        assertNull(ProverClient.feeRefusal(null, core));
        assertEquals("it charges a fee of 0.5 RAND per proof, which this version of the wallet does not pay",
                ProverClient.feeRefusal(fee("500000000"), core));
        // The prover refusing the unpaid job itself: definite, in words.
        prover.handler = answering(info(KEM_EK), (m, p) -> Reply.error(-32006, "fee not paid", null));
        try {
            RemoteSend.prove(core, fastProver(new ProverClient(URL_OK, prover)), request, route, null, pos -> { });
            fail();
        } catch (ProverClient.Refusal e) {
            assertEquals(ProverClient.FEE_REFUSAL, e.getMessage());
        }
    }

    @Test
    public void aReplyTheCoreRefusesNeverComesBackAndAFailedJobIsDefinite() throws Exception {
        FakeProver prover = new FakeProver(answering(info(KEM_EK), (m, p) -> m.equals("prover_submit")
                ? Reply.result(new JSONObject().put("job", "j"))
                : Reply.result(new JSONObject().put("state", "done").put("reply", "forged"))));
        FakeCore core = new FakeCore();
        RemoteSend.Route route = new RemoteSend.Route(new ProverPairing("p", URL_OK, KEM_EK, FINGERPRINT, true), TOKEN);
        try {
            RemoteSend.prove(core, fastProver(new ProverClient(URL_OK, prover)), new JSONObject(), route, null, pos -> { });
            fail();
        } catch (ProverClient.Refusal e) {
            assertEquals("The prover's proof was refused by this wallet: the proof does not verify", e.getMessage());
        }
        assertFalse("no hc_bundle when the node reports none", core.prepared.getJSONObject("prover").has("hc_bundle"));
        assertFalse(core.prepared.has("max_proof_bytes"));
        assertTrue("both guests absent: the core was told so", core.guestsAsked.isNull("hc_bundle") && core.guestsAsked.isNull("hc_auth"));
        prover.handler = answering(info(KEM_EK), (m, p) -> m.equals("prover_submit")
                ? Reply.result(new JSONObject().put("job", "j"))
                : Reply.result(new JSONObject().put("state", "failed").put("error", "out of memory")));
        try {
            RemoteSend.prove(core, fastProver(new ProverClient(URL_OK, prover)), new JSONObject(), route, null, pos -> { });
            fail();
        } catch (ProverClient.Refusal e) {
            assertEquals("The prover could not make this proof (failed: out of memory).", e.getMessage());
        }
        prover.handler = answering(info(KEM_EK), (m, p) -> Reply.error(-32005, "busy", new JSONObject().put("depth", 8)));
        try {
            RemoteSend.prove(core, fastProver(new ProverClient(URL_OK, prover)), new JSONObject(), route, null, pos -> { });
            fail();
        } catch (ProverClient.Refusal e) {
            assertEquals("The prover is full (8 waiting). Try again in a few minutes.", e.getMessage());
        }
        // The prover as it is NOW: another key at the pairing's address, or silence, is a refusal.
        prover.handler = answering(info("08".repeat(1184)), (m, p) -> Reply.error(-32601, "no", null));
        try {
            RemoteSend.prove(core, fastProver(new ProverClient(URL_OK, prover)), new JSONObject(), route, null, pos -> { });
            fail();
        } catch (ProverClient.Refusal e) {
            assertEquals("The prover at that address now has a different key. Pair it again in Settings.", e.getMessage());
        }
        prover.handler = (m, p) -> {
            throw new IOException("refused");
        };
        try {
            RemoteSend.prove(core, fastProver(new ProverClient(URL_OK, prover)), new JSONObject(), route, null, pos -> { });
            fail();
        } catch (ProverClient.Refusal e) {
            assertTrue(e.getMessage(), e.getMessage().startsWith("Your prover did not answer: "));
        }
        // A chain this build cannot prove for: the core's own words, before the prover is asked.
        JSONObject v3NoAuth = new JSONObject();
        RemoteSend.applyProofParams(v3NoAuth, new JSONObject().put("hc_bundle", V3));
        prover.methods.clear();
        try {
            RemoteSend.prove(core, fastProver(new ProverClient(URL_OK, prover)), v3NoAuth, route, null, pos -> { });
            fail();
        } catch (ProverClient.Refusal e) {
            assertEquals("this chain's bundle guest is v3 (split authorisation) but the node names no auth guest", e.getMessage());
        }
        assertTrue(prover.methods.isEmpty());
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
        assertEquals(AUTH, RemoteSend.hcAuthOf(new JSONObject().put("hc_auth", AUTH.toUpperCase())));
        assertNull(RemoteSend.hcBundleOf(null));
        assertNull(RemoteSend.hcAuthOf(new JSONObject().put("hc_bundle", V2)));
        assertNull(RemoteSend.hcAuthOf(new JSONObject().put("hc_auth", JSONObject.NULL)));
        // Present but malformed is a node this wallet cannot read — never the default guest.
        for (String field : new String[] {"hc_bundle", "hc_auth"}) {
            try {
                RemoteSend.applyProofParams(new JSONObject(), new JSONObject().put("hc_bundle", V3).put(field, "abc"));
                fail(field);
            } catch (org.randprotocol.wallet.rpc.RpcException e) {
                assertEquals("rand_status: " + field + " is not 64 hex characters", e.getMessage());
            }
        }
        assertEquals("test", RemoteSend.profileOf(new JSONObject().put("fri_profile", "test")));
        assertEquals("production", RemoteSend.profileOf(new JSONObject().put("fri_profile", "fast")));
        assertEquals("production", RemoteSend.profileOf(null));
        assertEquals(Integer.valueOf(2_000_000), org.randprotocol.wallet.rpc.RpcClient.maxProofBytesOf(new JSONObject().put("max_proof_bytes", 2_000_000)));
        assertNull(org.randprotocol.wallet.rpc.RpcClient.maxProofBytesOf(new JSONObject()));
    }

    // ------------------------------------------------------------------ fix round 1

    /**
     * The local {@code prove_transfer} request ({@code ui/engine/wallet.js}'s {@code guestFields}):
     * both guests from {@code rand_status}, {@code hc_auth} as JSON null when the node names a
     * bundle guest but no auth guest, neither when it names neither.
     */
    @Test
    public void theLocalRequestCarriesTheChainsProfileAndBothGuests() throws Exception {
        JSONObject req = new JSONObject().put("spend_key", SPEND_KEY).put("profile", "production");
        RemoteSend.applyProofParams(req, new JSONObject().put("height", 5).put("fri_profile", "test")
                .put("hc_bundle", V3.toUpperCase()).put("hc_auth", AUTH.toUpperCase()));
        assertEquals("test", req.getString("profile"));
        assertEquals(V3, req.getString("hc_bundle"));
        assertEquals("hc_auth reaches the local prove request", AUTH, req.getString("hc_auth"));
        // A bundle guest without an auth guest: hc_auth sent as null, never left out.
        RemoteSend.applyProofParams(req, new JSONObject().put("hc_bundle", V2));
        assertEquals(V2, req.getString("hc_bundle"));
        assertTrue(req.has("hc_auth") && req.isNull("hc_auth"));
        RemoteSend.applyProofParams(req, new JSONObject().put("hc_bundle", V3).put("hc_auth", JSONObject.NULL));
        assertTrue(req.has("hc_auth") && req.isNull("hc_auth"));
        // An auth guest alone: sent, and hc_bundle removed (the core holds it to its own).
        RemoteSend.applyProofParams(req, new JSONObject().put("hc_auth", AUTH));
        assertFalse(req.has("hc_bundle"));
        assertEquals(AUTH, req.getString("hc_auth"));
        // A node that reports neither (or predates rand_status): production, and neither key.
        RemoteSend.applyProofParams(req, null);
        assertEquals("production", req.getString("profile"));
        assertFalse(req.has("hc_bundle"));
        assertFalse(req.has("hc_auth"));
        RemoteSend.applyProofParams(req, new JSONObject().put("hc_bundle", JSONObject.NULL).put("hc_auth", JSONObject.NULL));
        assertFalse(req.has("hc_auth"));
    }

    private static ProverPairing.Probe okProbe(String... kinds) throws Exception {
        JSONArray k = new JSONArray();
        for (String s : kinds) k.put(s);
        return new ProverPairing.Probe(new ProverClient.Info(new JSONObject().put("kem_ek", KEM_EK).put("witness_kinds", k)), null);
    }

    /**
     * The route (the JS's {@code proveRoute}): the device first; then the paired prover, own or
     * not, answering, charging nothing, and taking a job this wallet can send it — a viewing-key
     * job, or, for a pairing marked own, a spend-key one. Which a given send needs is settled
     * when the job is made; this only rules out a prover that could take neither.
     */
    @Test
    public void theRouteTakesAnyPairingThatAnswersChargesNothingAndTakesAJob() throws Exception {
        FakeCore core = new FakeCore();
        ProverPairing own = new ProverPairing("p:1", URL_OK, KEM_EK, FINGERPRINT, true);
        ProverPairing notOwn = new ProverPairing("p:1", URL_OK, KEM_EK, FINGERPRINT, false);
        ProverPairing.Probe both = okProbe("viewing_key", "spend_key");
        int[] probed = {0};
        java.util.function.Function<ProverPairing, ProverPairing.Probe> probe = p -> {
            probed[0]++;
            return both;
        };
        assertNull(RemoteSend.route(true, own, core, probe, () -> SECRET));
        assertNull(RemoteSend.route(false, null, core, probe, () -> SECRET));
        assertEquals(0, probed[0]);

        // Not own: usable — for viewing-key jobs.
        RemoteSend.Route r = RemoteSend.route(false, notOwn, core, probe, () -> SECRET_NOT_OWN);
        assertFalse(r.pairing.own);
        assertEquals(TOKEN, r.token);
        ProverPairing.Probe viewingOnly = okProbe("viewing_key");
        assertFalse(RemoteSend.route(false, notOwn, core, p -> viewingOnly, () -> SECRET_NOT_OWN).pairing.own);
        // Not own, and the prover takes only spend-key jobs: nothing this wallet could send it.
        ProverPairing.Probe spendOnly = okProbe("spend_key");
        routeRefused(() -> RemoteSend.route(false, notOwn, core, p -> spendOnly, () -> SECRET_NOT_OWN),
                "This device does not have the memory for this proof. Your paired prover is not available: it does not take this wallet's jobs.");
        // Own: a spend-key-only prover is still a prover (an older chain's job).
        assertTrue(RemoteSend.route(false, own, core, p -> spendOnly, () -> SECRET).pairing.own);
        ProverPairing.Probe none = okProbe();
        routeRefused(() -> RemoteSend.route(false, own, core, p -> none, () -> SECRET),
                "This device does not have the memory for this proof. Your paired prover is not available: it does not take this wallet's jobs.");

        // A fee: refused; a zero quote is none.
        ProverPairing.Probe charging = probeWithFee(fee("500000000"));
        ProverPairing.Probe free = probeWithFee(fee("0"));
        routeRefused(() -> RemoteSend.route(false, notOwn, core, p -> charging, () -> SECRET_NOT_OWN),
                "This device does not have the memory for this proof. Your paired prover is not available: "
                        + "it charges a fee of 0.5 RAND per proof, which this version of the wallet does not pay.");
        assertNotNull(RemoteSend.route(false, notOwn, core, p -> free, () -> SECRET_NOT_OWN));

        routeRefused(() -> RemoteSend.route(false, own, core, p -> new ProverPairing.Probe(null, "the prover at x did not answer (down)"), () -> SECRET),
                "This device does not have the memory for this proof. Your paired prover is not available: the prover at x did not answer (down).");
        routeRefused(() -> RemoteSend.route(false, own, core, probe, () -> null),
                "Your prover's pairing could not be opened. Pair the prover again in Settings.");
        routeRefused(() -> RemoteSend.route(false, own, core, probe, () -> new ProverSecret("", KEM_EK, URL_OK, FINGERPRINT, true)),
                "Your prover's pairing could not be opened. Pair the prover again in Settings.");

        r = RemoteSend.route(false, own, core, probe, () -> SECRET);
        assertEquals(own.toJson().toString(), r.pairing.toJson().toString());
        assertEquals(TOKEN, r.token);
    }

    private static ProverPairing.Probe probeWithFee(Object fee) throws Exception {
        return new ProverPairing.Probe(new ProverClient.Info(info(KEM_EK, fee, "viewing_key")), null);
    }

    static final ProverSecret SECRET = new ProverSecret(TOKEN, KEM_EK, URL_OK, FINGERPRINT, true);
    static final ProverSecret SECRET_NOT_OWN = new ProverSecret(TOKEN, KEM_EK, URL_OK, FINGERPRINT, false);

    /**
     * {@link org.randprotocol.wallet.security.Prefs} is plaintext: anything that can write it could
     * name another key and URL, or mark a prover as "own". The probe, the route, the sealed job's
     * target and {@code own} come from the vault's record instead; only the name is read from
     * Prefs.
     */
    @Test
    public void aTamperedPrefsKemEkDoesNotMoveTheSealTargetNorPromoteAProverToOwn() throws Exception {
        String evilEk = "66".repeat(1184);
        ProverPairing tampered = new ProverPairing("p:1", "https://evil.example", evilEk, "EVIL-EVIL-EVIL-EVIL", true);
        ProverPairing.Probe ok = okProbe("viewing_key", "spend_key");
        ProverPairing[] probedAt = {null};
        FakeCore core = new FakeCore();
        RemoteSend.Route r = RemoteSend.route(false, tampered, core, p -> { probedAt[0] = p; return ok; }, () -> SECRET_NOT_OWN);
        assertEquals("the probe asked the tampered URL", URL_OK, probedAt[0].url);
        assertEquals(KEM_EK, probedAt[0].kemEk);
        assertEquals("the route took the tampered key", KEM_EK, r.pairing.kemEk);
        assertEquals(URL_OK, r.pairing.url);
        assertEquals("p:1", r.pairing.name);
        assertFalse("Prefs said own; the vault record decides", r.pairing.own);
        // ... so on an older chain the spend-key job is refused, whatever Prefs says.
        ProverPairing.Probe spendOnly = okProbe("spend_key");
        routeRefused(() -> RemoteSend.route(false, tampered, core, p -> spendOnly, () -> SECRET_NOT_OWN),
                "This device does not have the memory for this proof. Your paired prover is not available: it does not take this wallet's jobs.");

        FakeProver prover = new FakeProver(answering(info(KEM_EK), (m, p) -> m.equals("prover_submit")
                ? Reply.result(new JSONObject().put("job", "j"))
                : Reply.result(new JSONObject().put("state", "failed").put("error", "stub"))));
        try {
            RemoteSend.prove(core, fastProver(new ProverClient(r.pairing.url, prover)), new JSONObject(), r, null, pos -> { });
            fail();
        } catch (ProverClient.Refusal expected) {
            // the stub fails the job; what matters is what was sealed
        }
        assertEquals("the job was sealed to the tampered key", KEM_EK, core.prepared.getJSONObject("prover").getString("kem_ek"));
        assertFalse(core.prepared.getJSONObject("prover").getBoolean("own"));
    }

    @Test
    public void theVaultRecordRoundTripsAndABareTokenIsNoPairing() {
        ProverSecret back = ProverSecret.fromJson(SECRET.toJson());
        assertEquals(TOKEN, back.token);
        assertEquals(KEM_EK, back.kemEk);
        assertEquals(URL_OK, back.url);
        assertEquals(FINGERPRINT, back.fingerprint);
        assertTrue(back.own);
        assertFalse(ProverSecret.fromJson(SECRET_NOT_OWN.toJson()).own);
        // A record stored before `own` was kept (Phase 1): not own — viewing-key jobs only.
        assertFalse(ProverSecret.fromJson("{\"token\":\"" + TOKEN + "\",\"kemEk\":\"" + KEM_EK + "\",\"url\":\"" + URL_OK
                + "\",\"fingerprint\":\"" + FINGERPRINT + "\"}").own);
        assertTrue(ProverSecret.of(new ProverPairing("p", URL_OK, KEM_EK, FINGERPRINT, true), TOKEN).own);
        assertNull("a pre-release bare token names no seal target", ProverSecret.fromJson(TOKEN));
        assertNull(ProverSecret.fromJson("{\"token\":\"\",\"kemEk\":\"a\",\"url\":\"b\",\"fingerprint\":\"c\"}"));
    }

    interface RouteCall {
        RemoteSend.Route run() throws Exception;
    }

    private static void routeRefused(RouteCall call, String message) throws Exception {
        try {
            call.run();
            fail("routed");
        } catch (ProverClient.Refusal e) {
            assertEquals(message, e.getMessage());
        }
    }

    @Test
    public void aRedirectIsNotFollowed() throws Exception {
        FakeProver prover = new FakeProver((m, p) -> new Reply(307, ""));
        try {
            new ProverClient(URL_OK, prover).info();
            fail();
        } catch (ProverClient.ProverError e) {
            assertEquals("http", e.failure);
        }
        assertEquals(java.util.Collections.singletonList(false), prover.followRedirects);
    }

    // ------------------------------------------------------------------ the default: the pool

    /** A transport that routes each member's URL to its own fake prover; any other URL to {@code rest}. */
    static final class PoolTransport implements ProverClient.Transport {
        final java.util.Map<String, FakeProver> members = new java.util.HashMap<>();
        final List<String> urls = new ArrayList<>();
        final List<String> methods = new ArrayList<>();

        PoolTransport member(String m, Handler h) {
            members.put(memberUrl(m), new FakeProver(h));
            return this;
        }

        @Override
        public HttpURLConnection open(URL url) throws IOException {
            FakeProver p = members.get(url.toString());
            if (p == null) throw new IOException("no such host " + url);
            urls.add(url.toString());
            HttpURLConnection c = p.open(url);
            return c;
        }

        List<String> calls(String method) {
            List<String> out = new ArrayList<>();
            for (java.util.Map.Entry<String, FakeProver> e : members.entrySet()) {
                for (String m : e.getValue().methods) if (m.equals(method)) out.add(e.getKey());
            }
            return out;
        }
    }

    /** A member that answers with its own key, takes viewing-key jobs, has room, accepts and proves. */
    static Handler healthy(String m) {
        return (method, p) -> {
            switch (method) {
                case "prover_info": return Reply.result(info(memberEk(m), JSONObject.NULL, "viewing_key").put("queue", new JSONObject().put("depth", 0).put("max", 1).put("proving", 0)));
                case "prover_submit": return Reply.result(new JSONObject().put("job", "job-" + m));
                default: return Reply.result(new JSONObject().put("state", "done").put("reply", "good"));
            }
        };
    }

    static java.util.function.Function<ProverPairing, ProverPairing.Probe> probeWith(FakeCore core, ProverClient.Transport t) {
        return p -> ProverPairing.probe(core, p, t);
    }

    static RemoteSend.DefaultProver inOrder(FakeCore core, String... names) {
        return () -> {
            List<ProverPairing.Paired> all = ProverPairing.builtInPool(core);
            List<ProverPairing.Paired> out = new ArrayList<>();
            for (String n : names) for (ProverPairing.Paired p : all) if (p.pairing.url.equals(memberUrl(n))) out.add(p);
            return out;
        };
    }

    @Test
    public void withNothingPairedTheRouteIsTheFirstMemberThatCanTakeAJobByItsOwnKey() throws Exception {
        FakeCore core = new FakeCore().withTrustedProver();
        PoolTransport t = new PoolTransport()
                .member("a", (m, p) -> Reply.result(info("08".repeat(1184), JSONObject.NULL, "viewing_key")))
                .member("b", (m, p) -> Reply.result(info(memberEk("b"), JSONObject.NULL, "viewing_key").put("queue", new JSONObject().put("depth", 1).put("max", 1))))
                .member("c", healthy("c"));
        RemoteSend.Route r = RemoteSend.route(false, null, core, probeWith(core, t), () -> null, inOrder(core, "a", "b", "c"));
        assertNotNull("a fresh wallet that cannot prove had no route", r);
        assertTrue(r.isDefault);
        assertEquals(memberUrl("c"), r.pairing.url);
        assertEquals(memberEk("c"), r.pairing.kemEk);
        assertEquals(memberToken("c"), r.token);
        assertFalse(r.pairing.own);
        assertEquals("RandProtocol", r.poolName);
        assertEquals("c leads, the rest follow in their order", java.util.Arrays.asList(memberUrl("c"), memberUrl("a"), memberUrl("b")),
                java.util.Arrays.asList(r.members.get(0).pairing.url, r.members.get(1).pairing.url, r.members.get(2).pairing.url));
        // A device that can prove asks nobody; no prover chosen is no route; a paired one wins.
        PoolTransport unasked = new PoolTransport().member("a", healthy("a"));
        assertNull(RemoteSend.route(true, null, core, probeWith(core, unasked), () -> null, inOrder(core, "a")));
        assertNull(RemoteSend.route(false, null, core, probeWith(core, unasked), () -> null, null));
        assertTrue(unasked.urls.isEmpty());
        ProverPairing.Probe ok = okProbe("viewing_key");
        RemoteSend.Route paired = RemoteSend.route(false, new ProverPairing("mine", URL_OK, KEM_EK, FINGERPRINT, false), core,
                p -> ok, () -> SECRET_NOT_OWN, inOrder(core, "a"));
        assertFalse(paired.isDefault);
        assertEquals(URL_OK, paired.pairing.url);
    }

    @Test
    public void noMemberReadyIsSaidPlainlyAllBusyOrUnreachable() throws Exception {
        FakeCore core = new FakeCore().withTrustedProver();
        PoolTransport full = new PoolTransport();
        for (String m : POOL) {
            full.member(m, (x, p) -> Reply.result(info(memberEk(m), JSONObject.NULL, "viewing_key").put("queue", new JSONObject().put("depth", 1).put("max", 1))));
        }
        try {
            RemoteSend.route(false, null, core, probeWith(core, full), () -> null, inOrder(core, "a", "b", "c"));
            fail("routed to a full pool");
        } catch (ProverClient.Refusal e) {
            assertEquals("This device does not have the memory for this proof. The RandProtocol provers are all busy right now; "
                    + "try again in a minute, or pair your own prover in Settings.", e.getMessage());
            assertTrue(e.busy);
        }
        PoolTransport mixed = new PoolTransport()
                .member("a", (x, p) -> { throw new IOException("connection refused"); })
                .member("b", (x, p) -> Reply.result(info("08".repeat(1184), JSONObject.NULL, "viewing_key")));
        try {
            RemoteSend.route(false, null, core, probeWith(core, mixed), () -> null, inOrder(core, "a", "b"));
            fail("routed to a pool that is not there");
        } catch (ProverClient.Refusal e) {
            assertEquals("This device does not have the memory for this proof. The RandProtocol provers cannot be reached right now "
                    + "(a did not answer; b answered with another key than the one this wallet pins). Try again later, or pair your own prover in Settings.",
                    e.getMessage());
            assertFalse(e.busy);
        }
    }

    @Test
    public void provePoolSkipsABusySubmitAndPollsOnlyTheMemberThatTookTheJob() throws Exception {
        FakeCore core = new FakeCore().withTrustedProver();
        PoolTransport t = new PoolTransport()
                .member("a", (m, p) -> m.equals("prover_submit") ? Reply.error(-32005, "busy", new JSONObject().put("depth", 1)) : healthy("a").reply(m, p))
                .member("b", healthy("b"));
        RemoteSend.Route r = RemoteSend.route(false, null, core, probeWith(core, t), () -> null, inOrder(core, "a", "b"));
        JSONObject request = new JSONObject().put("spend_key", SPEND_KEY).put("to", "rand1x");
        RemoteSend.applyProofParams(request, new JSONObject().put("hc_bundle", V3).put("hc_auth", AUTH));
        JSONObject out = RemoteSend.provePool(core, url -> fastPoolProver(url, t), request, r, null, pos -> { });
        assertEquals("aa", out.getString("tx_hex"));
        assertEquals("sealed for a, then again for b", java.util.Arrays.asList(memberEk("a"), memberEk("b")),
                java.util.Arrays.asList(core.preparedAll.get(0).getJSONObject("prover").getString("kem_ek"),
                        core.preparedAll.get(1).getJSONObject("prover").getString("kem_ek")));
        assertEquals(memberToken("b"), core.preparedAll.get(1).getJSONObject("prover").getString("token"));
        assertEquals(java.util.Collections.singletonList(memberUrl("b")), t.calls("prover_status"));
        // Every member busy at submit: one submit each, then plainly — never a loop.
        PoolTransport busy = new PoolTransport();
        for (String m : POOL) busy.member(m, (x, p) -> x.equals("prover_submit") ? Reply.error(-32005, "busy", null) : healthy(m).reply(x, p));
        RemoteSend.Route all = RemoteSend.route(false, null, core, probeWith(core, busy), () -> null, inOrder(core, "a", "b", "c"));
        try {
            RemoteSend.provePool(core, url -> fastPoolProver(url, busy), request, all, null, pos -> { });
            fail("sent through a busy pool");
        } catch (ProverClient.Refusal e) {
            assertEquals("The RandProtocol provers are all busy right now; try again in a minute, or pair your own prover in Settings.", e.getMessage());
            assertTrue(e.busy);
        }
        assertEquals(3, busy.calls("prover_submit").size());
    }

    static RemoteProver fastPoolProver(String url, ProverClient.Transport t) {
        try {
            return fastProver(new ProverClient(url, t));
        } catch (ProverClient.Refusal e) {
            throw new IllegalStateException(e);
        }
    }

    @Test
    public void aSubmitThatNeverReachedTheProverIsOfferedAgainBoundedWithBackoff() throws Exception {
        int[] submits = {0};
        FakeProver prover = new FakeProver((m, p) -> {
            if (m.equals("prover_submit")) {
                submits[0]++;
                if (submits[0] == 1) throw new IOException("fetch failed");
                if (submits[0] == 2) return new Reply(502, "<html>bad gateway</html>");
                return Reply.result(new JSONObject().put("job", "job-9"));
            }
            return Reply.result(new JSONObject().put("state", "done").put("reply", "good"));
        });
        RemoteProver rp = fastProver(new ProverClient(URL_OK, prover));
        List<Long> waits = new ArrayList<>();
        rp.sleeper = waits::add;
        FakeCore core = new FakeCore();
        JSONObject out = rp.prove("5e41ed", new JSONObject().put("kind", "transfer"), core::finishProof, pos -> { });
        assertEquals("aa", out.getString("tx_hex"));
        assertEquals(3, submits[0]);
        assertEquals(java.util.Arrays.asList(1_000L, 3_000L), waits.subList(0, 2));
        // Three failures: given up, with the transport's words.
        int[] down = {0};
        FakeProver gone = new FakeProver((m, p) -> { down[0]++; throw new IOException("fetch failed"); });
        try {
            fastProver(new ProverClient(URL_OK, gone)).prove("5e41ed", new JSONObject(), core::finishProof, pos -> { });
            fail();
        } catch (ProverClient.Refusal e) {
            assertTrue(e.getMessage(), e.getMessage().startsWith("Could not hand the proof to your prover"));
        }
        assertEquals(RemoteProver.SUBMIT_TRIES, down[0]);
    }

    @Test
    public void aJsonRpcRefusalOrAReplyWithoutAJobIdIsNeverResubmitted() throws Exception {
        for (Reply first : new Reply[]{Reply.error(-32003, "unpaired", null), Reply.result(new JSONObject().put("nojob", true))}) {
            int[] submits = {0};
            FakeProver prover = new FakeProver((m, p) -> {
                submits[0]++;
                return submits[0] == 1 ? first : Reply.result(new JSONObject().put("job", "j"));
            });
            try {
                fastProver(new ProverClient(URL_OK, prover)).prove("5e41ed", new JSONObject(), new FakeCore()::finishProof, pos -> { });
                fail();
            } catch (ProverClient.Refusal expected) {
                // final
            }
            assertEquals("resubmitted after " + first.body, 1, submits[0]);
        }
    }

    @Test
    public void aDelegatedJobCarriesTheChainsGenesisAsALocalProofDoes() throws Exception {
        // BIND-1: a chain after 19 binds its genesis hash; the sealed job is made over the same
        // binding the device's own proof would be — through a paired prover and the default alike.
        String genesis = "ab".repeat(32);
        for (boolean isDefault : new boolean[]{false, true}) {
            FakeCore core = new FakeCore().withTrustedProver();
            JSONObject request = new JSONObject().put("spend_key", SPEND_KEY).put("to", "rand1x").put("genesis", genesis);
            RemoteSend.applyProofParams(request, new JSONObject().put("hc_bundle", V3).put("hc_auth", AUTH));
            if (isDefault) {
                PoolTransport t = new PoolTransport().member("a", healthy("a"));
                RemoteSend.Route r = RemoteSend.route(false, null, core, probeWith(core, t), () -> null, inOrder(core, "a"));
                RemoteSend.provePool(core, url -> fastPoolProver(url, t), request, r, null, pos -> { });
            } else {
                FakeProver prover = new FakeProver(answering(info(KEM_EK, JSONObject.NULL, "viewing_key"), (m, p) -> m.equals("prover_submit")
                        ? Reply.result(new JSONObject().put("job", "j"))
                        : Reply.result(new JSONObject().put("state", "done").put("reply", "good"))));
                RemoteSend.Route r = new RemoteSend.Route(new ProverPairing("p", URL_OK, KEM_EK, FINGERPRINT, false), TOKEN);
                RemoteSend.prove(core, fastProver(new ProverClient(r.pairing.url, prover)), request, r, null, pos -> { });
            }
            assertEquals("the job carries no genesis (default " + isDefault + ")", genesis, core.prepared.optString("genesis", null));
        }
    }
}
