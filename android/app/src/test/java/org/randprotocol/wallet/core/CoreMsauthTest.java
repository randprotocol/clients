package org.randprotocol.wallet.core;

import static org.junit.Assert.assertEquals;

import org.json.JSONObject;
import org.junit.Test;

import java.util.List;

/** The five {@code msauth_*} calls' parameters, named as wallet-core's dispatch reads them (the web's coreApi test). */
public class CoreMsauthTest {
    private static void same(String json, JSONObject got) throws Exception {
        JSONObject want = new JSONObject(json);
        assertEquals(got.toString(), want.length(), got.length());
        for (java.util.Iterator<String> it = want.keys(); it.hasNext(); ) {
            String k = it.next();
            assertEquals(k, String.valueOf(want.get(k)), String.valueOf(got.get(k)));
        }
    }

    @Test
    public void theParamsAreTheCoresNames() throws Exception {
        same("{\"proposal\":\"P\",\"policy\":\"Q\",\"expected_recipients\":[\"rand1a:10\"]}", Core.msauthCheckParams("P", "Q", List.of("rand1a:10")));
        same("{\"proposal\":\"P\",\"policy\":\"Q\",\"expected_recipients\":[]}", Core.msauthCheckParams("P", "Q", List.of()));
        same("{\"proposal\":\"P\",\"policy\":\"Q\",\"seed\":\"S\",\"expected_recipients\":[\"rand1a:10\"]}", Core.msauthSignParams("P", "Q", "S", List.of("rand1a:10")));
        same("{\"proposal\":\"P\",\"policy\":\"Q\",\"share\":\"0:aa\"}", Core.msauthVerifyShareParams("P", "Q", "0:aa"));
        same("{\"input\":\"K\",\"policy\":\"Q\"}", Core.msauthSignerImportParams("K", "Q"));
        same("{\"input\":\"K\"}", Core.msauthSignerImportParams("K", null));
        same("{\"policy\":\"Q\"}", Core.msauthPolicyInfoParams("Q"));
    }
}
