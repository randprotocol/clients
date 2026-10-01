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

    /**
     * HTTP 429 is "ask again later": a read is repeated after a wait, on the same node. A first
     * scan is several hundred reads, and the public endpoint allows a burst of about a hundred
     * and then about one a second — reported as a failure, the first 429 ended the scan and the
     * next scan met the same wall. The waits double from one second to eight and stop after about
     * three quarters of a minute; a {@code Retry-After} in seconds is taken at its word up to the
     * longest wait. The same rule as {@code ui/engine/rpc.js}'s {@code THROTTLE_WAITS_MS}.
     */
    static final long[] THROTTLE_WAITS_MS = {1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000};
    private static final long THROTTLE_MAX_WAIT_MS = 8000;

    /**
     * The two methods that change the chain are never repeated: a 429 on the faucet is its answer
     * about this wallet's allowance, and one on a send is for the person sending to see at once.
     */
    private static boolean submits(String method) {
        return "rand_sendTransaction".equals(method) || "rand_mint".equals(method);
    }

    /** What came back from one POST: the status, the body, and {@code Retry-After} if there was one. */
    public static final class Reply {
        public final int status;
        public final String text;
        public final String retryAfter;

        public Reply(int status, String text, String retryAfter) {
            this.status = status;
            this.text = text == null ? "" : text;
            this.retryAfter = retryAfter;
        }
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
        String json = body.toString();
        Reply reply;
        for (int attempt = 0; ; attempt++) {
            reply = transport(json);
            if (reply.status != 429 || submits(method) || attempt >= THROTTLE_WAITS_MS.length) break;
            pause(throttleWaitMs(attempt, reply.retryAfter));
        }
        if (reply.status >= 400 && !reply.text.trim().startsWith("{")) {
            throw new RpcException(0, "HTTP " + reply.status + " from " + url, reply.status);
        }
        int status = reply.status >= 400 ? reply.status : 0;
        try {
            JSONObject r = new JSONObject(reply.text);
            JSONObject err = r.optJSONObject("error");
            if (err != null) {
                throw new RpcException(err.optInt("code", 0), err.optString("message", "unknown error"), status);
            }
            return r.opt("result");
        } catch (JSONException e) {
            throw new RpcException("node reply is not JSON", e);
        }
    }

    /** How long to wait before repeating a throttled read: the header's seconds, else the schedule. */
    static long throttleWaitMs(int attempt, String retryAfter) {
        if (retryAfter != null) {
            try {
                long seconds = Long.parseLong(retryAfter.trim());
                if (seconds > 0) return Math.min(seconds > THROTTLE_MAX_WAIT_MS / 1000 ? THROTTLE_MAX_WAIT_MS : seconds * 1000, THROTTLE_MAX_WAIT_MS);
            } catch (NumberFormatException ignored) {
                // An HTTP date, or nonsense: the schedule decides.
            }
        }
        return THROTTLE_WAITS_MS[attempt];
    }

    /** The wait between two attempts. Overridden by the tests, which record it instead. */
    protected void pause(long ms) throws RpcException {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RpcException("interrupted while waiting for " + url, e);
        }
    }

    /** One POST. The only place bytes leave; overridden by the tests, which script the replies. */
    protected Reply transport(String json) throws RpcException {
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
            return new Reply(status, readAll(in), c.getHeaderField("Retry-After"));
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
     * The three {@code rand_getLimits} fields a send needs ({@code ui/engine/wallet.js}'s
     * {@code chainLimitsOf}): {@code envelopeBytes} (spec 2026-09-26 §2.4; null is the legacy
     * envelope and no memo), {@code maxProofBytes} (the proof cap a remote prover's proof is held
     * to; null is the core's own vendored cap, never "unbounded") and {@code bundleGasLimit}
     * (chain 18, constraint set 8: the gas every bundle proof must declare on a chain with a
     * {@code gas} section; null is a chain without one). Each null where the field is null or
     * absent; all three null on a node that predates the method ({@code -32601}).
     */
    public static final class ChainLimits {
        public final Integer envelopeBytes;
        public final Integer maxProofBytes;
        public final Long bundleGasLimit;
        /** Fullnode #118: blocks a bundle's time and anchor stay valid (1024 on chain 20); null = 256. */
        public final Long proofWindowBlocks;

        public ChainLimits(Integer envelopeBytes, Integer maxProofBytes, Long bundleGasLimit) {
            this(envelopeBytes, maxProofBytes, bundleGasLimit, null);
        }

        public ChainLimits(Integer envelopeBytes, Integer maxProofBytes, Long bundleGasLimit, Long proofWindowBlocks) {
            this.envelopeBytes = envelopeBytes;
            this.maxProofBytes = maxProofBytes;
            this.bundleGasLimit = bundleGasLimit;
            this.proofWindowBlocks = proofWindowBlocks;
        }

        public static final ChainLimits NONE = new ChainLimits(null, null, null, null);
    }

    /**
     * {@code rand_getLimits} in one read (see {@link ChainLimits}). Any failure but a missing
     * method propagates: a node that did not answer is not a node that said "no memo".
     */
    public ChainLimits limits() throws RpcException {
        Object reply;
        try {
            reply = call("rand_getLimits", null);
        } catch (RpcException e) {
            if (e.code == -32601) return ChainLimits.NONE;
            throw e;
        }
        return limitsOf(reply);
    }

    /** {@code rand_getLimits}' reply → its three fields, each null when absent or null, refused when not a positive integer. */
    public static ChainLimits limitsOf(Object reply) throws RpcException {
        if (!(reply instanceof JSONObject)) throw new RpcException(0, "rand_getLimits: not an object");
        Long envelope = sizeField(reply, "envelope_bytes", 1L << 20);
        Long proof = sizeField(reply, "max_proof_bytes", 1L << 30);
        Long gas = sizeField(reply, "bundle_gas_limit", Long.MAX_VALUE);
        Long window = sizeField(reply, "proof_window_blocks", 1L << 30);
        return new ChainLimits(envelope == null ? null : (int) (long) envelope, proof == null ? null : (int) (long) proof, gas, window);
    }

    /**
     * The chain's {@code envelope_bytes} alone (see {@link #limits()}), mirroring
     * {@code ui/engine/wallet.js}'s {@code envelopeBytesOf}.
     */
    public Integer envelopeBytes() throws RpcException {
        return limits().envelopeBytes;
    }

    /** {@code rand_getLimits}'s reply → its {@code envelope_bytes}: null when absent or null, else a size in 1..2^20. */
    public static Integer envelopeBytesOf(Object reply) throws RpcException {
        Long n = sizeField(reply, "envelope_bytes", 1L << 20);
        return n == null ? null : (int) (long) n;
    }

    /** The chain's proof-size cap alone (see {@link #limits()}). */
    public Integer maxProofBytes() throws RpcException {
        return limits().maxProofBytes;
    }

    /** {@code rand_getLimits}' reply → its {@code max_proof_bytes}: null when absent or null, else a size in 1..2^30. */
    public static Integer maxProofBytesOf(Object reply) throws RpcException {
        Long n = sizeField(reply, "max_proof_bytes", 1L << 30);
        return n == null ? null : (int) (long) n;
    }

    /** A positive integer field of {@code rand_getLimits}: null when absent or null, refused otherwise. */
    private static Long sizeField(Object reply, String name, long max) throws RpcException {
        if (!(reply instanceof JSONObject)) throw new RpcException(0, "rand_getLimits: not an object");
        JSONObject o = (JSONObject) reply;
        if (!o.has(name) || o.isNull(name)) return null;
        Object v = o.opt(name);
        if (v instanceof Integer || v instanceof Long) {
            long n = ((Number) v).longValue();
            if (n > 0 && n <= max) return n;
        }
        throw new RpcException(0, "rand_getLimits: " + name + " is not a positive size");
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

    /**
     * The chain's genesis hash (64 hex), or null when the node will not say. A transaction on a
     * chain after 19 binds it (fullnode BIND-1); a node that lies about it can only make this
     * wallet's transaction invalid on the real chain, never valid on another.
     */
    public String genesisHash() throws RpcException {
        Object v = call("rand_getGenesisHash", null);
        String g = v instanceof String ? ((String) v).replaceFirst("^0x", "") : null;
        return g != null && g.matches("[0-9a-fA-F]{64}") ? g.toLowerCase(java.util.Locale.ROOT) : null;
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

    /**
     * {@code rand_getBlocks(from, to)}: the headers of that range, at most 1024 a call and never
     * past the node's tip, each with a {@code tx_count}. What {@link
     * org.randprotocol.wallet.wallet.DepositWalk} pages through instead of opening every block.
     */
    public JSONArray blockHeaders(long fromHeight, long toHeight) throws RpcException {
        Object v = call("rand_getBlocks", args(fromHeight, toHeight));
        if (!(v instanceof JSONArray)) throw new RpcException(0, "rand_getBlocks: the reply is not a list");
        return (JSONArray) v;
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
