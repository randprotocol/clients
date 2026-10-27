package org.randprotocol.wallet.security;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.randprotocol.wallet.R;
import org.randprotocol.wallet.util.L10n;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Signer profiles beside the spend key (spec §3), in {@link KeyVault}'s encrypted file: {@code
 * msauth.index} (the list), {@code msauth.<id>.policy} and {@code msauth.<id>.seed} (the seed sealed
 * by the profile's own Keystore key, {@link KeystoreSeedCipher}, "ivB64:ctB64"). The Keystore key's
 * alias is {@code msauth.<id>}. Every name this class writes or sweeps starts with {@code msauth.};
 * the spend key ({@code spend_key}), the prover's record ({@code prover_pairing}, {@code
 * prover_token}) and the file's own master key are never among them ({@link #isSignerEntry}).
 */
public final class SignerProfiles {
    public static final String PREFIX = "msauth.";
    static final String INDEX = "msauth.index";
    /** Names the sweep must never take, whatever a future change to {@link #PREFIX} does. */
    private static final Set<String> PROTECTED = Set.of("spend_key", "prover_pairing", "prover_token", "_androidx_security_master_key_");
    private static final Pattern ID = Pattern.compile("[0-9a-z-]{1,64}");

    /** The encrypted preferences; put and remove throw when the write does not land. */
    public interface KeyValue {
        String get(String k);

        void put(String k, String v);

        void remove(String k);

        /** Every name in the store, for the sweep that also finds what the index does not list. */
        Set<String> keys();
    }

    /** The Keystore's aliases ({@link KeystoreSeedCipher#keystoreAliases()}); both throw on failure. */
    public interface KeyAliases {
        List<String> list() throws Exception;

        void delete(String alias) throws Exception;
    }

    public static final class Profile {
        public final String id, label, policyHash;
        public final int index;
        /**
         * The highest fee this signer signs, in base units (decimal digits); null for a profile saved
         * before 0.8.2, which {@link #feeLimit} reads as the default, 0.1 RAND.
         */
        public final String maxFee;

        public Profile(String id, String label, int index, String policyHash) {
            this(id, label, index, policyHash, null);
        }

        public Profile(String id, String label, int index, String policyHash, String maxFee) {
            this.id = id;
            this.label = label;
            this.index = index;
            this.policyHash = policyHash;
            this.maxFee = maxFee != null && maxFee.matches("\\d+") ? maxFee : null;
        }

        /** The limit the signing rule applies: this profile's, or {@link org.randprotocol.wallet.wallet.SignFlow#DEFAULT_MAX_FEE_UNITS}. */
        public String feeLimit() {
            return org.randprotocol.wallet.wallet.SignFlow.feeLimit(maxFee);
        }

        JSONObject toJson() throws JSONException {
            JSONObject o = new JSONObject().put("id", id).put("label", label).put("index", index).put("policyHash", policyHash);
            if (maxFee != null) o.put("maxFee", maxFee);
            return o;
        }

        /** null for an entry that is not a whole profile. */
        static Profile of(Object item) {
            if (!(item instanceof JSONObject)) return null;
            JSONObject o = (JSONObject) item;
            Object id = o.opt("id"), label = o.opt("label"), index = o.opt("index"), hash = o.opt("policyHash");
            if (!(id instanceof String) || !(label instanceof String) || !(index instanceof Integer) || !(hash instanceof String)) return null;
            Object max = o.opt("maxFee");
            return new Profile((String) id, (String) label, (Integer) index, (String) hash, max instanceof String ? (String) max : null);
        }
    }

    private final KeyValue kv;
    private final KeyAliases aliases;

    public SignerProfiles(KeyValue kv) {
        this(kv, null);
    }

    /** {@code aliases} non-null: {@link #remove} also deletes the profile's Keystore key. */
    public SignerProfiles(KeyValue kv, KeyAliases aliases) {
        this.kv = kv;
        this.aliases = aliases;
    }

    /** A fresh profile id: 32 lowercase hex characters. */
    public static String newId() {
        byte[] b = new byte[16];
        new SecureRandom().nextBytes(b);
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x & 0xff));
        return s.toString();
    }

    private static String policyKey(String id) {
        return PREFIX + id + ".policy";
    }

    private static String seedKey(String id) {
        return PREFIX + id + ".seed";
    }

    public List<Profile> list() {
        List<Profile> out = new ArrayList<>();
        String raw = kv.get(INDEX);
        if (raw == null) return out;
        try {
            JSONArray a = new JSONArray(raw);
            for (int i = 0; i < a.length(); i++) {
                Profile p = Profile.of(a.opt(i));
                if (p != null) out.add(p);
            }
        } catch (JSONException e) {
            // An unreadable index lists nothing; the sweep still finds its entries.
        }
        return out;
    }

    /**
     * Saves a profile: its label (1-64 characters, counted in code points, trimmed), the policy and
     * the sealed seed. Refused for a signer already saved (same policy, same position). Nothing is
     * left behind when a write fails.
     */
    public Profile add(Profile p, String policy, String sealedSeed) throws JSONException {
        String label = p.label == null ? "" : p.label.trim();
        int n = label.codePointCount(0, label.length());
        if (n < 1 || n > 64) throw new IllegalArgumentException(L10n.t(R.string.msauth_label_length, "a signer label is 1-64 characters"));
        if (p.id == null || !ID.matcher(p.id).matches()) throw new IllegalArgumentException("a signer profile id is 1-64 of [0-9a-z-]");
        List<Profile> all = list();
        for (Profile q : all) {
            if (q.policyHash.equals(p.policyHash) && q.index == p.index) {
                throw new IllegalStateException(L10n.t(R.string.msauth_already_saved, "this signer is already saved as %1$s", q.label));
            }
        }
        Profile saved = new Profile(p.id, label, p.index, p.policyHash, p.maxFee);
        try {
            kv.put(policyKey(p.id), policy);
            kv.put(seedKey(p.id), sealedSeed);
            all.add(saved);
            writeIndex(all);
        } catch (RuntimeException | JSONException e) {
            try {
                kv.remove(seedKey(p.id));
                kv.remove(policyKey(p.id));
            } catch (RuntimeException ignored) {
                // the sweep at "remove this wallet" takes what is left
            }
            throw e;
        }
        return saved;
    }

    /** Removes a profile: its Keystore key (when this store was given the aliases), its two entries, its row. */
    public void remove(String id) {
        if (aliases != null) {
            try {
                aliases.delete(KeystoreSeedCipher.alias(id));
            } catch (Exception ignored) {
                // A key without its sealed seed opens nothing; the wallet's sweep removes it later.
            }
        }
        kv.remove(seedKey(id));
        kv.remove(policyKey(id));
        List<Profile> all = list();
        all.removeIf(p -> p.id.equals(id));
        try {
            writeIndex(all);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    public String policy(String id) {
        return kv.get(policyKey(id));
    }

    public String sealedSeed(String id) {
        return kv.get(seedKey(id));
    }

    private void writeIndex(List<Profile> all) throws JSONException {
        JSONArray a = new JSONArray();
        for (Profile p : all) a.put(p.toJson());
        kv.put(INDEX, a.toString());
    }

    /** A preference this class owns: {@code msauth.…}, never a protected name. */
    static boolean isSignerEntry(String name) {
        return name != null && name.startsWith(PREFIX) && !PROTECTED.contains(name);
    }

    /** A Keystore alias this class owns: {@code msauth.<id>}, never a protected name. */
    static boolean isSignerAlias(String alias) {
        return isSignerEntry(alias);
    }

    /**
     * Every profile, listed or not, and the list itself (removing the wallet). The sweep comes
     * first: every Keystore key named {@code msauth.…}, then every entry named so but the index.
     * The index goes last, only after the sweep succeeded: when any step throws, the index is kept
     * so a retry still finds what is left, and the error is thrown — the caller then keeps the
     * wallet (never a half-wipe).
     */
    public static void eraseAll(KeyValue kv, KeyAliases aliases) throws Exception {
        for (String a : aliases.list()) {
            if (isSignerAlias(a)) aliases.delete(a);
        }
        for (String k : new ArrayList<>(kv.keys())) {
            if (isSignerEntry(k) && !k.equals(INDEX)) kv.remove(k);
        }
        kv.remove(INDEX);
    }
}
