package org.randprotocol.wallet.wallet;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * The RandProtocol provers this build pins — the core's {@code version.trusted_prover_pool}
 * (wallet 0.6.9; audit v7 VK-9): a pool of validator-hosted provers, EACH WITH ITS OWN KEY,
 * viewing-key jobs only, no fee (docs/prover.md §8). What a screen shows: the pool's name and each
 * member's name, URL and fingerprint. A member's pairing link (its public token inside) is
 * package-private: only {@link ProverPairing#builtInPool} reads it, and it reaches neither a screen
 * nor {@link org.randprotocol.wallet.security.Prefs}.
 */
public final class TrustedProver {
    /** One member: its own URL and the fingerprint the build pins for its key. */
    public static final class Member {
        public final String name;
        public final String url;
        public final String fingerprint;
        final String link;

        Member(String name, String url, String fingerprint, String link) {
            this.name = name;
            this.url = url;
            this.fingerprint = fingerprint;
            this.link = link;
        }
    }

    public final String name;
    public final List<Member> members;

    TrustedProver(String name, List<Member> members) {
        this.name = name;
        this.members = Collections.unmodifiableList(members);
    }

    /**
     * {@code version.trusted_prover_pool} as the core reports it, or null when this build carries
     * none: no object, or no member with a link (the JS engine's {@code builtInPool} rule).
     */
    public static TrustedProver fromJson(JSONObject pool) {
        if (pool == null) return null;
        JSONArray arr = pool.optJSONArray("members");
        if (arr == null) return null;
        List<Member> members = new ArrayList<>();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject m = arr.optJSONObject(i);
            if (m == null) continue;
            String link = m.opt("link") instanceof String ? m.optString("link") : "";
            if (link.isEmpty() || m.optString("url", "").isEmpty() || m.optString("fingerprint", "").isEmpty()) continue;
            members.add(new Member(m.optString("name", ""), m.optString("url"), m.optString("fingerprint"), link));
        }
        if (members.isEmpty()) return null;
        String name = pool.optString("name", "");
        return new TrustedProver(name.isEmpty() ? "RandProtocol" : name, members);
    }
}
