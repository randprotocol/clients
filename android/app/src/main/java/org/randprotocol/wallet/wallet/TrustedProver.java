package org.randprotocol.wallet.wallet;

import org.json.JSONObject;

/**
 * The prover this build ships the address of — the core's {@code version.trusted_prover}: the
 * RandProtocol validators' pool, viewing-key jobs only, no fee (docs/prover.md §8). What a screen
 * shows beside its one-step action: the name, the URL and the fingerprint the build pins. The
 * pairing link (it carries a token) is package-private: only {@link ProverPairing#pairTrusted}
 * reads it, and it reaches neither a screen nor {@link org.randprotocol.wallet.security.Prefs}.
 * Nothing is paired by reading this — the wallet never pairs a prover by itself.
 */
public final class TrustedProver {
    public final String name;
    public final String url;
    public final String fingerprint;
    final String link;

    TrustedProver(String name, String url, String fingerprint, String link) {
        this.name = name;
        this.url = url;
        this.fingerprint = fingerprint;
        this.link = link;
    }

    /**
     * {@code version.trusted_prover} as the core reports it, or null when this build carries none:
     * no object, or no link to pair (the JS engine's {@code prover.trusted()} rule).
     */
    public static TrustedProver fromJson(JSONObject t) {
        if (t == null) return null;
        String link = t.opt("link") instanceof String ? t.optString("link") : "";
        if (link.isEmpty()) return null;
        String name = t.optString("name", "");
        return new TrustedProver(name.isEmpty() ? "RandProtocol" : name, t.optString("url", ""), t.optString("fingerprint", ""), link);
    }
}
