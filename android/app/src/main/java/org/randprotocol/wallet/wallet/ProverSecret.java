package org.randprotocol.wallet.wallet;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * The half of a pairing that decides where the spend key goes — the bearer token and the prover's
 * key and URL — kept together in the {@link org.randprotocol.wallet.security.KeyVault}. A send
 * seals to this {@code kemEk} and posts to this {@code url}; the {@link ProverPairing} in
 * {@link org.randprotocol.wallet.security.Prefs} is only what the screens show, so a tampered copy
 * there cannot redirect a job.
 */
public final class ProverSecret {
    final String token;
    public final String kemEk;
    public final String url;
    public final String fingerprint;

    public ProverSecret(String token, String kemEk, String url, String fingerprint) {
        this.token = token;
        this.kemEk = kemEk;
        this.url = url;
        this.fingerprint = fingerprint;
    }

    /** The record with this pairing's key and URL, and its token. */
    public static ProverSecret of(ProverPairing pairing, String token) {
        return new ProverSecret(token, pairing.kemEk, pairing.url, pairing.fingerprint);
    }

    public String toJson() {
        try {
            return new JSONObject().put("token", token).put("kemEk", kemEk).put("url", url)
                    .put("fingerprint", fingerprint).toString();
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
            return new ProverSecret(t, k, u, f);
        } catch (JSONException e) {
            return null;
        }
    }
}
