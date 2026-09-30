package org.randprotocol.wallet.wallet;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * The half of a pairing that decides where a witness goes — the bearer token, the prover's key
 * and URL, and whether the link marked the prover as the user's OWN — kept together in the
 * {@link org.randprotocol.wallet.security.KeyVault}. A send seals to this {@code kemEk}, posts to
 * this {@code url}, and may send a spend-key job (an older chain, without split authorisation)
 * only when this {@code own} is set; the {@link ProverPairing} in
 * {@link org.randprotocol.wallet.security.Prefs} is only what the screens show, so a tampered copy
 * there can neither redirect a job nor promote a prover to "own".
 */
public final class ProverSecret {
    final String token;
    public final String kemEk;
    public final String url;
    public final String fingerprint;
    /**
     * The pairing link carried {@code own=1}. A record stored before this field was kept (Phase 1
     * builds) reads false: such a prover still takes viewing-key jobs, never a spend-key one.
     */
    public final boolean own;

    public ProverSecret(String token, String kemEk, String url, String fingerprint) {
        this(token, kemEk, url, fingerprint, false);
    }

    public ProverSecret(String token, String kemEk, String url, String fingerprint, boolean own) {
        this.token = token;
        this.kemEk = kemEk;
        this.url = url;
        this.fingerprint = fingerprint;
        this.own = own;
    }

    /** The record with this pairing's key, URL and {@code own}, and its token. */
    public static ProverSecret of(ProverPairing pairing, String token) {
        return new ProverSecret(token, pairing.kemEk, pairing.url, pairing.fingerprint, pairing.own);
    }

    public String toJson() {
        try {
            return new JSONObject().put("token", token).put("kemEk", kemEk).put("url", url)
                    .put("fingerprint", fingerprint).put("own", own).toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Null for anything but a complete record — a pre-release bare token included (pair again). */
    public static ProverSecret fromJson(String json) {
        if (json == null || json.isEmpty()) return null;
        try {
            JSONObject o = new JSONObject(json);
            String t = o.optString("token", ""), k = o.optString("kemEk", ""), u = o.optString("url", ""), f = o.optString("fingerprint", "");
            if (t.isEmpty() || k.isEmpty() || u.isEmpty() || f.isEmpty()) return null;
            return new ProverSecret(t, k, u, f, o.optBoolean("own", false));
        } catch (JSONException e) {
            return null;
        }
    }
}
