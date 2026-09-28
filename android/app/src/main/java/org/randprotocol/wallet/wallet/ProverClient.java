package org.randprotocol.wallet.wallet;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

/**
 * Delegated proving, Phase 1 (spec docs/superpowers/specs/2026-09-28-delegated-proving-design.md):
 * a JSON-RPC client for ONE paired {@code rand-prover} — the Java twin of
 * {@code ui/engine/prover.js}'s {@code makeProverClient}. Four methods, positional params:
 * {@code prover_info}, {@code prover_submit [sealed_hex]}, {@code prover_status [job]},
 * {@code prover_cancel [job]}. The pairing token is not a parameter: it travels only inside the
 * job the core sealed, never in clear. Blocking; call off the main thread.
 */
public class ProverClient {
    public static final int UNKNOWN_JOB = -32001;
    public static final int UNPAIRED = -32003;
    public static final int WITNESS_KIND = -32004;
    public static final int BUSY = -32005;

    private static final int TIMEOUT_MS = 20_000;
    private static final Pattern JOB = Pattern.compile("^[A-Za-z0-9_-]{1,128}$");

    /** Opens the connection for one request; tests hand in a fake. */
    public interface Transport {
        HttpURLConnection open(URL url) throws IOException;
    }

    public static final Transport HTTP = url -> (HttpURLConnection) url.openConnection();

    /** A prover's refusal or silence. {@code failure} is set only where no JSON-RPC reply existed. */
    public static final class ProverError extends Exception {
        public final Integer code;
        public final JSONObject data;
        /** {@code connect | timeout | http | body}, or null for a JSON-RPC error reply. */
        public final String failure;

        public ProverError(String message, Integer code, JSONObject data, String failure) {
            super(message);
            this.code = code;
            this.data = data;
            this.failure = failure;
        }
    }

    /** A definite failure of a send: nothing reached the node. The message is shown verbatim. */
    public static final class Refusal extends Exception {
        public Refusal(String message) {
            super(message);
        }
    }

    /** {@code prover_info}, checked just enough to use. */
    public static final class Info {
        public final String kemEk;
        public final String kemFingerprint;
        public final java.util.List<String> witnessKinds = new java.util.ArrayList<>();
        public final int depth;
        public final int max;
        public final int proving;

        public Info(Object value) throws ProverError {
            if (!(value instanceof JSONObject)) throw new ProverError("the prover's info is not an object", null, null, "body");
            JSONObject o = (JSONObject) value;
            kemEk = o.optString("kem_ek", "").toLowerCase(java.util.Locale.ROOT);
            kemFingerprint = o.optString("kem_fingerprint", "");
            JSONArray kinds = o.optJSONArray("witness_kinds");
            if (kinds != null) for (int i = 0; i < kinds.length(); i++) {
                Object k = kinds.opt(i);
                if (k instanceof String) witnessKinds.add((String) k);
            }
            JSONObject q = o.optJSONObject("queue");
            depth = q == null ? 0 : Math.max(0, q.optInt("depth", 0));
            max = q == null ? 0 : Math.max(0, q.optInt("max", 0));
            proving = q == null ? 0 : Math.max(0, q.optInt("proving", 0));
        }
    }

    /**
     * The rule a prover's address is held to — the node's, and {@code ui/lib/url-rule.js}'s:
     * https to any host, plain http only to this machine. Returns the trimmed URL (no trailing
     * slash) or throws a {@link Refusal} in the user's words.
     */
    public static String checkUrl(String text) throws Refusal {
        String value = text == null ? "" : text.trim();
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        if (value.isEmpty()) throw new Refusal("The pairing link has no prover address.");
        URI u;
        try {
            u = new URI(value);
        } catch (URISyntaxException e) {
            throw new Refusal("The pairing link's prover address is not a URL.");
        }
        String scheme = u.getScheme() == null ? null : u.getScheme().toLowerCase(java.util.Locale.ROOT);
        if (scheme == null) throw new Refusal("The pairing link's prover address is not a URL.");
        String host = u.getHost() == null ? "" : u.getHost().toLowerCase(java.util.Locale.ROOT);
        boolean web = scheme.equals("https") || scheme.equals("http");
        if (web && host.isEmpty()) throw new Refusal("The pairing link's prover address is not a URL.");
        boolean local = host.equals("localhost") || host.equals("127.0.0.1") || host.equals("[::1]") || host.equals("::1");
        if (scheme.equals("https")) return value;
        if (scheme.equals("http") && local) return value;
        if (scheme.equals("http")) throw new Refusal("Use https for a prover — plain http is only allowed for a prover on this machine.");
        throw new Refusal("A prover address must be https://.");
    }

    private final String url;
    private final Transport transport;
    private int seq;

    public ProverClient(String url) throws Refusal {
        this(url, HTTP);
    }

    public ProverClient(String url, Transport transport) throws Refusal {
        this.url = checkUrl(url);
        this.transport = transport;
    }

    public String url() {
        return url;
    }

    public Object call(String method, JSONArray params) throws ProverError {
        String body;
        try {
            body = new JSONObject().put("jsonrpc", "2.0").put("id", ++seq).put("method", method)
                    .put("params", params == null ? new JSONArray() : params).toString();
        } catch (JSONException e) {
            throw new ProverError("building request: " + e.getMessage(), null, null, "body");
        }
        HttpURLConnection c = null;
        int status;
        String text;
        try {
            c = transport.open(new URL(url));
            c.setRequestMethod("POST");
            // A 307 would carry the POST to a host the URL rule never saw: a redirect is an answer
            // that is not JSON-RPC, never a place to follow.
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(TIMEOUT_MS);
            c.setReadTimeout(TIMEOUT_MS);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = c.getOutputStream()) {
                out.write(bytes);
            }
            status = c.getResponseCode();
            text = readAll(status >= 400 ? c.getErrorStream() : c.getInputStream());
        } catch (SocketTimeoutException e) {
            throw new ProverError("cannot reach the prover at " + url + ": timed out", null, null, "timeout");
        } catch (IOException e) {
            throw new ProverError("cannot reach the prover at " + url + ": " + e.getMessage(), null, null, "connect");
        } finally {
            if (c != null) c.disconnect();
        }
        JSONObject r;
        try {
            r = new JSONObject(text);
        } catch (JSONException e) {
            boolean ok = status >= 200 && status < 300;
            throw new ProverError("the prover at " + url + " did not answer with JSON-RPC (HTTP " + status + ")", null, null, ok ? "body" : "http");
        }
        JSONObject err = r.optJSONObject("error");
        if (err != null) {
            Integer code = err.has("code") ? err.optInt("code") : null;
            throw new ProverError(err.optString("message", "prover error"), code, err.optJSONObject("data"), null);
        }
        return r.opt("result");
    }

    public Info info() throws ProverError {
        return new Info(call("prover_info", null));
    }

    /** The job id the prover assigned. */
    public String submit(String sealedHex) throws ProverError {
        Object r = call("prover_submit", new JSONArray().put(sealedHex));
        String job = r instanceof JSONObject ? ((JSONObject) r).optString("job", "") : "";
        if (!JOB.matcher(job).matches()) throw new ProverError("the prover accepted the job but named no job id", null, null, "body");
        return job;
    }

    public JSONObject status(String job) throws ProverError {
        Object r = call("prover_status", new JSONArray().put(job));
        if (!(r instanceof JSONObject)) throw new ProverError("the prover's status is not an object", null, null, "body");
        return (JSONObject) r;
    }

    public void cancel(String job) throws ProverError {
        call("prover_cancel", new JSONArray().put(job));
    }

    /**
     * The prover's refusal in the user's words ({@code proverRefusal} in the JS), or null for a
     * transport failure — whether to retry that is the caller's decision.
     */
    public static Refusal refusal(ProverError e) {
        if (e.failure != null) return null;
        int code = e.code == null ? 0 : e.code;
        switch (code) {
            case BUSY: {
                String n = "?";
                if (e.data != null && e.data.has("depth")) {
                    int d = e.data.optInt("depth", -1);
                    if (d >= 0) n = String.valueOf(d);
                }
                return new Refusal("The prover is full (" + n + " waiting). Try again in a few minutes.");
            }
            case UNPAIRED:
                return new Refusal("This prover does not know this pairing. Pair it again in Settings.");
            case WITNESS_KIND:
                return new Refusal("This prover does not accept a spend-key job. Pair your own prover in Settings.");
            case UNKNOWN_JOB:
                return new Refusal("The prover no longer has this proof (it restarted or the job expired). Send again.");
            default: {
                String reason = e.data != null && e.data.opt("reason") instanceof String ? ": " + e.data.optString("reason") : "";
                return new Refusal("The prover refused the job (" + e.getMessage() + reason + ").");
            }
        }
    }

    private static String readAll(InputStream in) throws IOException {
        if (in == null) return "";
        try (InputStream s = in) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[16 * 1024];
            int n;
            while ((n = s.read(chunk)) > 0) buf.write(chunk, 0, n);
            return buf.toString("UTF-8");
        }
    }
}
