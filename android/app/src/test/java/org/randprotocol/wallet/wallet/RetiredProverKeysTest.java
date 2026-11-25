package org.randprotocol.wallet.wallet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import static org.randprotocol.wallet.wallet.ProverTest.FINGERPRINT;
import static org.randprotocol.wallet.wallet.ProverTest.KEM_EK;
import static org.randprotocol.wallet.wallet.ProverTest.TOKEN;
import static org.randprotocol.wallet.wallet.ProverTest.URL_OK;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Retired prover keys (VK-9, randprotocol/monorepo#18), on the JVM — the Java twin of the
 * "retired prover keys" tests in {@code ui/test/prover.test.mjs}: the list, and the four points
 * that hold a key to it (a link, a stored pairing's probe and send, a pinned pool member).
 */
public class RetiredProverKeysTest {
    static final String RETIRED_TEXT = "This prover's key was retired and is no longer used. "
            + "Pair another prover in Settings, or update Rand Wallet to the latest version.";

    @After
    public void theShippedListAgain() {
        RetiredProverKeys.setForTest();
    }

    /** A prover that would pair, take a job and prove it — and records every call it is asked. */
    static ProverTest.FakeProver willing() throws Exception {
        return new ProverTest.FakeProver(ProverTest.answering(ProverTest.info(KEM_EK, JSONObject.NULL, "viewing_key"),
                (m, p) -> m.equals("prover_submit")
                        ? ProverTest.Reply.result(new JSONObject().put("job", "j"))
                        : ProverTest.Reply.result(new JSONObject().put("state", "done").put("reply", "good"))));
    }

    static JSONObject request() throws Exception {
        JSONObject request = new JSONObject().put("spend_key", ProverTest.SPEND_KEY).put("to", "rand1x");
        RemoteSend.applyProofParams(request, new JSONObject().put("hc_bundle", ProverTest.V3).put("hc_auth", ProverTest.AUTH));
        return request;
    }

    @Test
    public void theRetiredPoolKeysAreListedAndTheRefusalIsTheOtherWalletsSentence() {
        assertEquals(Arrays.asList("RGTF-7HKJ-XZFV-GQ1J", "ZEXQ-1JHV-ZT60-KFB5", "D2XV-WXVT-PZRC-D7G8", "SR28-MYT0-GR6A-03DE",
                "GMNX-Q1QD-FEXG-JHJM"), Arrays.asList(RetiredProverKeys.FINGERPRINTS));
        for (String fp : RetiredProverKeys.FINGERPRINTS) assertTrue(fp, RetiredProverKeys.isRetired(fp));
        // The pool wallet 0.8.1 and later pin, and anything that is not a listed key.
        assertFalse(RetiredProverKeys.isRetired("4SK4-P64N-XWEN-ZSZZ"));
        assertFalse(RetiredProverKeys.isRetired("0XZX-NZ1J-SPMB-GWZN"));
        assertFalse(RetiredProverKeys.isRetired(FINGERPRINT));
        assertFalse(RetiredProverKeys.isRetired(""));
        assertFalse(RetiredProverKeys.isRetired(null));
        assertEquals(RETIRED_TEXT, RetiredProverKeys.text());
    }

    @Test
    public void aLinkThatNamesARetiredKeyIsNotPairedAndNothingIsAskedOfIt() throws Exception {
        ProverTest.FakeCore core = new ProverTest.FakeCore();
        ProverTest.FakeProver prover = willing();
        RetiredProverKeys.setForTest(FINGERPRINT);
        try {
            ProverPairing.pair(core, "randprover:xyz", prover);
            fail("paired a retired key");
        } catch (ProverClient.Refusal e) {
            assertEquals(RETIRED_TEXT, e.getMessage());
        }
        assertEquals("the retired key was asked", 0, prover.methods.size());
        assertEquals("a connection was opened to the retired key", 0, prover.urls.size());
        // The control: the same link, on a build whose list does not name its key, pairs.
        RetiredProverKeys.setForTest();
        assertEquals(FINGERPRINT, ProverPairing.pair(core, "randprover:xyz", prover).pairing.fingerprint);
    }

    @Test
    public void aPairingStoredBeforeItsKeyWasRetiredIsSentNothingAfterTheUpdate() throws Exception {
        ProverTest.FakeCore core = new ProverTest.FakeCore();
        ProverTest.FakeProver prover = willing();
        // Paired on a build that did not know the key was retired…
        ProverPairing.Paired paired = ProverPairing.pair(core, "randprover:xyz", prover);
        ProverSecret secret = ProverSecret.of(paired.pairing, paired.token);
        assertTrue(ProverPairing.probe(core, paired.pairing, prover).ok());
        prover.methods.clear();
        prover.urls.clear();
        // …then the wallet is updated: the same stored pairing, a build whose list names the key.
        RetiredProverKeys.setForTest(FINGERPRINT);

        // The route: refused in the sentence itself, before the prover is probed.
        int[] probed = {0};
        try {
            RemoteSend.route(false, paired.pairing, core, p -> {
                probed[0]++;
                return ProverPairing.probe(core, p, prover);
            }, () -> secret);
            fail("a retired key was given a route");
        } catch (ProverClient.Refusal e) {
            assertEquals(RETIRED_TEXT, e.getMessage());
        }
        assertEquals(0, probed[0]);
        // The vault record decides: a display copy naming another fingerprint changes nothing.
        ProverPairing display = new ProverPairing("mine", URL_OK, KEM_EK, "0000-0000-0000-0000", false);
        try {
            RemoteSend.route(false, display, core, p -> ProverPairing.probe(core, p, prover), () -> secret);
            fail("the display copy's fingerprint hid a retired key");
        } catch (ProverClient.Refusal e) {
            assertEquals(RETIRED_TEXT, e.getMessage());
        }
        // A device that proves for itself never uses the pairing, so nothing is refused.
        assertNull(RemoteSend.route(true, paired.pairing, core, p -> ProverPairing.probe(core, p, prover), () -> secret));

        // The probe (Settings' status line): not answering, in the same words, and nothing asked.
        ProverPairing.Probe probe = ProverPairing.probe(core, paired.pairing, prover);
        assertFalse(probe.ok());
        assertEquals(RETIRED_TEXT, probe.reason);
        assertFalse(probe.keyChanged);
        assertFalse(probe.network);
        assertEquals("Not answering: " + RETIRED_TEXT, probe.line());

        // The job itself, for a route come by before the update: nothing built, nothing sent.
        RemoteSend.Route stale = new RemoteSend.Route(paired.pairing, paired.token);
        for (String kind : new String[] {RemoteSend.KIND_TRANSFER, RemoteSend.KIND_INVOKE}) {
            try {
                RemoteSend.prove(core, ProverTest.fastProver(new ProverClient(URL_OK, prover)), kind, request(), stale, null, pos -> { });
                fail("a job went to a retired key");
            } catch (ProverClient.Refusal e) {
                assertEquals(RETIRED_TEXT, e.getMessage());
            }
        }
        assertNull("the chain's guests were asked for a retired key", core.guestsAsked);
        assertNull("a job was sealed to a retired key", core.prepared);
        assertEquals(0, core.invokesPrepared.size());
        assertEquals("the retired key was asked", 0, prover.methods.size());
        assertEquals("a connection was opened to the retired key", 0, prover.urls.size());

        // The control: the same pairing, on a build whose list does not name its key, is used.
        RetiredProverKeys.setForTest();
        RemoteSend.Route route = RemoteSend.route(false, paired.pairing, core, p -> ProverPairing.probe(core, p, prover), () -> secret);
        assertEquals(TOKEN, route.token);
        assertNotNull(RemoteSend.prove(core, ProverTest.fastProver(new ProverClient(URL_OK, prover)), request(), route, null, pos -> { }));
        assertTrue(prover.methods.contains("prover_submit"));
    }

    @Test
    public void aPoolMemberWhoseKeyIsOnTheRetiredListIsNeverAskedTheOthersStillAre() throws Exception {
        ProverTest.FakeCore core = new ProverTest.FakeCore().withTrustedProver();
        RetiredProverKeys.setForTest(ProverTest.memberFingerprint("a"));
        List<ProverPairing.Paired> members = ProverPairing.builtInPool(core);
        List<String> urls = new ArrayList<>();
        for (ProverPairing.Paired m : members) urls.add(m.pairing.url);
        assertEquals(Arrays.asList(ProverTest.memberUrl("b"), ProverTest.memberUrl("c")), urls);

        ProverTest.PoolTransport t = new ProverTest.PoolTransport()
                .member("a", ProverTest.healthy("a")).member("b", ProverTest.healthy("b")).member("c", ProverTest.healthy("c"));
        RemoteSend.Route r = RemoteSend.route(false, null, core, ProverTest.probeWith(core, t), () -> null,
                ProverTest.inOrder(core, "a", "b", "c"));
        assertTrue(r.isDefault);
        assertEquals(ProverTest.memberUrl("b"), r.pairing.url);
        JSONObject proved = RemoteSend.provePool(core, url -> ProverTest.fastPoolProver(url, t), request(), r, null, pos -> { });
        assertEquals("aa", proved.getString("tx_hex"));
        assertFalse("the retired member was asked", t.urls.contains(ProverTest.memberUrl("a")));
        assertEquals(Arrays.asList(ProverTest.memberUrl("b")), t.calls("prover_submit"));

        // A route made before the update still names the member: provePool passes it over unasked.
        RetiredProverKeys.setForTest();
        RemoteSend.Route before = RemoteSend.route(false, null, core, ProverTest.probeWith(core, t), () -> null,
                ProverTest.inOrder(core, "a", "b", "c"));
        assertEquals(ProverTest.memberUrl("a"), before.pairing.url);
        t.urls.clear();
        RetiredProverKeys.setForTest(ProverTest.memberFingerprint("a"));
        RemoteSend.provePool(core, url -> ProverTest.fastPoolProver(url, t), request(), before, null, pos -> { });
        assertFalse("the retired member was asked", t.urls.contains(ProverTest.memberUrl("a")));

        // Every member retired: the pool is no pool, said as a mismatch with the pins.
        RetiredProverKeys.setForTest(ProverTest.memberFingerprint("a"), ProverTest.memberFingerprint("b"), ProverTest.memberFingerprint("c"));
        try {
            ProverPairing.builtInPool(core);
            fail("a pool of retired keys was used");
        } catch (ProverClient.Refusal e) {
            assertTrue(e.getMessage(), e.getMessage().startsWith("None of the built-in RandProtocol prover links"));
        }
    }
}
