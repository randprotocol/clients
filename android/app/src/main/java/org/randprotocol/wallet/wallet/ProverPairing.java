package org.randprotocol.wallet.wallet;

import org.json.JSONException;
import org.json.JSONObject;

import java.net.URI;
import java.util.Locale;

/**
 * A paired prover as {@link org.randprotocol.wallet.security.Prefs} keeps it — public fields only,
 * for display; the token, key and URL a job is sealed and sent to are the
 * {@link org.randprotocol.wallet.security.KeyVault}'s {@link ProverSecret} — and the pairing rules,
 * the Java twin of {@code ui/engine/backend-shared.js}'s {@code prover} group. The link is read by
 * the core ({@code parse_prover_link}); the prover's key is asked of the prover itself and must be
 * the one the link names, the fingerprint recomputed by the core from that key (the prover's own
 * {@code kem_fingerprint} is its word, not evidence). Only then is anything stored.
 */
public final class ProverPairing {
    /** Copy, Phase 1 (spec §4.4), shown before a pairing is saved. */
    public static final String WARNING = "This prover will receive your spend key each time it makes a proof. "
            + "Anyone who controls it can spend your funds. Pair only a machine you run yourself.";

    public static final String NOT_OWN_WARNING = "This link does not mark the prover as your own, so this version of the "
            + "wallet will never send it a job: pair only a prover you run yourself, from a link it made with own=1.";

    /** What the proving screen calls it: the prover's host (and port). */
    public final String name;
    public final String url;
    /** The prover's ML-KEM-768 encapsulation key, lowercase hex (1 184 bytes). */
    public final String kemEk;
    public final String fingerprint;
    /** The link was made with {@code own=1}. Phase 1 sends a spend-key job to such a prover only. */
    public final boolean own;

    public ProverPairing(String name, String url, String kemEk, String fingerprint, boolean own) {
        this.name = name;
        this.url = url;
        this.kemEk = kemEk;
        this.fingerprint = fingerprint;
        this.own = own;
    }

    public JSONObject toJson() {
        try {
            return new JSONObject().put("name", name).put("url", url).put("kemEk", kemEk)
                    .put("fingerprint", fingerprint).put("own", own);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Null for anything but a complete pairing: a half-written one is no pairing. */
    public static ProverPairing fromJson(String json) {
        if (json == null || json.isEmpty()) return null;
        try {
            JSONObject o = new JSONObject(json);
            String url = o.optString("url", ""), kemEk = o.optString("kemEk", ""), fp = o.optString("fingerprint", "");
            if (url.isEmpty() || kemEk.isEmpty() || fp.isEmpty()) return null;
            return new ProverPairing(o.optString("name", url), url, kemEk, fp, o.optBoolean("own", false));
        } catch (JSONException e) {
            return null;
        }
    }

    // ------------------------------------------------------------------ the rules

    /** What a link names, without saving it or asking anybody. Never the token. */
    public static final class Preview {
        public final String url;
        public final String fingerprint;
        public final boolean own;
        /** Set when the link is not marked {@code own}: such a pairing is saved but never used. */
        public final String warning;

        Preview(String url, String fingerprint, boolean own) {
            this.url = url;
            this.fingerprint = fingerprint;
            this.own = own;
            this.warning = own ? null : NOT_OWN_WARNING;
        }
    }

    /** A checked pairing and its token, not yet stored. */
    public static final class Paired {
        public final ProverPairing pairing;
        public final String token;

        Paired(ProverPairing pairing, String token) {
            this.pairing = pairing;
            this.token = token;
        }
    }

    /** Whether the prover answers with the pairing's key: {@code info} when it does, else {@code reason}. */
    public static final class Probe {
        public final ProverClient.Info info;
        public final String reason;

        Probe(ProverClient.Info info, String reason) {
            this.info = info;
            this.reason = reason;
        }

        public boolean ok() {
            return info != null;
        }

        /** The one status line Settings shows under the pairing. */
        public String line() {
            if (info != null) {
                return "Answering · " + info.depth + (info.max > 0 ? " of " + info.max : "") + " in its queue.";
            }
            String w = reason == null ? "no reply" : reason;
            if (w.endsWith(".")) w = w.substring(0, w.length() - 1);
            return "Not answering: " + w + ".";
        }
    }

    public static Preview preview(ProverCore core, String link) throws Exception {
        JSONObject p = parse(core, link);
        return new Preview(ProverClient.checkUrl(p.getString("url")), p.getString("fingerprint"), p.optBoolean("own", false));
    }

    public static boolean sameKey(ProverCore core, ProverClient.Info info, String kemEk, String fingerprint) {
        if (info.kemEk.isEmpty() || !info.kemEk.equals(kemEk.toLowerCase(Locale.ROOT))) return false;
        try {
            return fingerprint.equals(core.proverFingerprint(info.kemEk));
        } catch (Exception e) {
            return false;
        }
    }

    /** Asks the prover for its key; returns the pairing and its token. Stores nothing. Blocking. */
    public static Paired pair(ProverCore core, String link, ProverClient.Transport transport) throws Exception {
        JSONObject p = parse(core, link);
        String url = ProverClient.checkUrl(p.getString("url"));
        String kemEk = p.getString("kem_ek").toLowerCase(Locale.ROOT);
        String fp = p.getString("fingerprint");
        ProverClient.Info info;
        try {
            info = new ProverClient(url, transport).info();
        } catch (ProverClient.ProverError e) {
            throw new ProverClient.Refusal("The prover at " + url + " did not answer: " + e.getMessage());
        }
        if (!sameKey(core, info, kemEk, fp)) {
            throw new ProverClient.Refusal("The prover at that address has a different key from the one the link names. Do not pair it.");
        }
        return new Paired(new ProverPairing(nameOf(url), url, kemEk, fp, p.optBoolean("own", false)), p.getString("token"));
    }

    public static Probe probe(ProverCore core, ProverPairing pairing, ProverClient.Transport transport) {
        ProverClient.Info info;
        try {
            info = new ProverClient(pairing.url, transport).info();
        } catch (Exception e) {
            return new Probe(null, "the prover at " + pairing.url + " did not answer (" + e.getMessage() + ")");
        }
        if (!sameKey(core, info, pairing.kemEk, pairing.fingerprint)) {
            return new Probe(null, "the prover at that address now has a different key; pair it again");
        }
        return new Probe(info, null);
    }

    static String nameOf(String url) {
        try {
            URI u = new URI(url);
            return u.getPort() >= 0 ? u.getHost() + ":" + u.getPort() : u.getHost();
        } catch (Exception e) {
            return url;
        }
    }

    private static JSONObject parse(ProverCore core, String link) throws Exception {
        JSONObject p = core.parseProverLink(link == null ? "" : link.trim());
        if (!p.has("kem_ek") || !p.has("url") || !p.has("token") || !p.has("fingerprint")) {
            throw new ProverClient.Refusal("That is not a pairing link.");
        }
        return p;
    }
}
