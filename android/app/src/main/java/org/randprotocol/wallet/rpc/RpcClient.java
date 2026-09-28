package org.randprotocol.wallet.rpc;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * JSON-RPC 2.0 over HTTP to a rand-node (docs/rpc.md of the fullnode). One request per POST;
 * every call is blocking and must run off the main thread.
 */
public class RpcClient {
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 60_000;
    /** Rows per commitments/nullifiers page; the node caps a page at 1000. */
    public static final int PAGE = 500;

    private final String url;

    public RpcClient(String url) {
        this.url = url;
    }

    public String url() {
        return url;
    }

    public Object call(String method, JSONArray params) throws RpcException {
        JSONObject body = new JSONObject();
        try {
            body.put("jsonrpc", "2.0");
            body.put("id", 1);
            body.put("method", method);
            body.put("params", params == null ? new JSONArray() : params);
        } catch (JSONException e) {
            throw new RpcException("building request", e);
        }
        String reply = post(body.toString());
        try {
            JSONObject r = new JSONObject(reply);
            JSONObject err = r.optJSONObject("error");
            if (err != null) {
                throw new RpcException(err.optInt("code", 0), err.optString("message", "unknown error"));
            }
            return r.opt("result");
        } catch (JSONException e) {
            throw new RpcException("node reply is not JSON", e);
        }
    }

    private String post(String json) throws RpcException {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(CONNECT_TIMEOUT_MS);
            c.setReadTimeout(READ_TIMEOUT_MS);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Accept", "application/json");
            byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = c.getOutputStream()) {
                out.write(bytes);
            }
            int status = c.getResponseCode();
            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            String text = readAll(in);
            if (status >= 400 && !text.trim().startsWith("{")) {
                throw new RpcException(0, "HTTP " + status + " from " + url);
            }
            return text;
        } catch (IOException e) {
            throw new RpcException("cannot reach " + url + ": " + e.getMessage(), e);
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String readAll(InputStream in) throws IOException {
        if (in == null) return "";
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[16 * 1024];
        int n;
        while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
        return buf.toString("UTF-8");
    }

    private static JSONArray args(Object... a) {
        JSONArray arr = new JSONArray();
        for (Object o : a) arr.put(o);
        return arr;
    }

    // ---- the methods the wallet uses ----

    /**
     * The chain's {@code envelope_bytes} from {@code rand_getLimits} (spec 2026-09-26 §2.4),
     * mirroring {@code ui/engine/wallet.js}'s {@code envelopeBytesOf}: null means the legacy
     * envelope and no memo — a chain that reports {@code null}, a reply without the field, or a
     * node that predates the method ({@code -32601}). Any other failure propagates: a node that
     * did not answer is not a node that said "no memo".
     */
    public Integer envelopeBytes() throws RpcException {
        Object reply;
        try {
            reply = call("rand_getLimits", null);
        } catch (RpcException e) {
            if (e.code == -32601) return null;
            throw e;
        }
        return envelopeBytesOf(reply);
    }

    /** {@code rand_getLimits}'s reply → its {@code envelope_bytes}: null when absent or null, else a size in 1..2^20. */
    public static Integer envelopeBytesOf(Object reply) throws RpcException {
        if (!(reply instanceof JSONObject)) throw new RpcException(0, "rand_getLimits: not an object");
        JSONObject o = (JSONObject) reply;
        if (!o.has("envelope_bytes") || o.isNull("envelope_bytes")) return null;
        Object v = o.opt("envelope_bytes");
        if (v instanceof Integer || v instanceof Long) {
            long n = ((Number) v).longValue();
            if (n > 0 && n <= (1 << 20)) return (int) n;
        }
        throw new RpcException(0, "rand_getLimits: envelope_bytes is not a positive size");
    }

    /**
     * The chain's proof-size cap, {@code rand_getLimits.max_proof_bytes} — what a remote prover's
     * proof is held to ({@code finish_proof}). Null (not reported, or a node without the method)
     * means the core's own vendored {@code MAX_PROOF_BYTES}, never "unbounded".
     */
    public Integer maxProofBytes() throws RpcException {
        Object reply;
        try {
            reply = call("rand_getLimits", null);
        } catch (RpcException e) {
            if (e.code == -32601) return null;
            throw e;
        }
        return maxProofBytesOf(reply);
    }

    /** {@code rand_getLimits}' reply → its {@code max_proof_bytes}: null when absent or null, else a size in 1..2^30. */
    public static Integer maxProofBytesOf(Object reply) throws RpcException {
        if (!(reply instanceof JSONObject)) throw new RpcException(0, "rand_getLimits: not an object");
        JSONObject o = (JSONObject) reply;
        if (!o.has("max_proof_bytes") || o.isNull("max_proof_bytes")) return null;
        Object v = o.opt("max_proof_bytes");
        if (v instanceof Integer || v instanceof Long) {
            long n = ((Number) v).longValue();
            if (n > 0 && n <= (1L << 30)) return (int) n;
        }
        throw new RpcException(0, "rand_getLimits: max_proof_bytes is not a positive size");
    }

    public long chainId() throws RpcException {
        return ((Number) call("rand_chainId", null)).longValue();
    }

    public JSONObject status() throws RpcException {
        return (JSONObject) call("rand_status", null);
    }

    /** {@code {height, hash, view}}. */
    public JSONObject head() throws RpcException {
        return (JSONObject) call("rand_getHead", null);
    }

    public long headHeight() throws RpcException {
        return head().optLong("height", 0);
    }

    public JSONObject treeInfo() throws RpcException {
        return (JSONObject) call("rand_getTreeInfo", null);
    }

    public JSONArray commitments(long fromIndex, int limit) throws RpcException {
        return (JSONArray) call("rand_getCommitments", args(fromIndex, limit));
    }

    public JSONArray nullifiers(long fromHeight, int limit) throws RpcException {
        return (JSONArray) call("rand_getNullifiers", args(fromHeight, limit));
    }

    /** {@code {height, root}} for the head. */
    public JSONObject anchor() throws RpcException {
        return (JSONObject) call("rand_getAnchor", null);
    }

    /** {@code {index, root, path:[32]}} or null past the end of the tree. */
    public JSONObject witness(long index) throws RpcException {
        Object v = call("rand_getWitness", args(index));
        return v instanceof JSONObject ? (JSONObject) v : null;
    }

    public String sendTransaction(String txHex) throws RpcException {
        return String.valueOf(call("rand_sendTransaction", args(txHex)));
    }

    /** Null until committed. */
    public JSONObject transaction(String hash) throws RpcException {
        Object v = call("rand_getTransaction", args(hash));
        return v instanceof JSONObject ? (JSONObject) v : null;
    }

    public String mint(String address) throws RpcException {
        return String.valueOf(call("rand_mint", args(address)));
    }

    public JSONObject blockByHeight(long height) throws RpcException {
        Object v = call("rand_getBlockByHeight", args(height));
        return v instanceof JSONObject ? (JSONObject) v : null;
    }

    public JSONObject bridgeState() throws RpcException {
        return (JSONObject) call("rand_getBridgeState", null);
    }

    public String estimateBundleFee() throws RpcException {
        JSONObject spec = new JSONObject();
        try {
            spec.put("kind", "bundle");
        } catch (JSONException ignored) {
        }
        return String.valueOf(call("rand_estimateFee", args(spec)));
    }
}
