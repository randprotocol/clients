package org.randprotocol.wallet.security;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import androidx.biometric.BiometricManager;

import org.junit.Test;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Signer profiles beside the spend key (spec §3), the per-use key's API-level rule, wiping them
 * with the wallet, and reading a seed through an authenticated cipher — on the JVM, with a map for
 * the encrypted preferences, a list for the Keystore's aliases and a software AES key for the
 * Keystore's (which a unit test cannot reach).
 */
public class SignerProfilesTest {
    static class MapKv implements SignerProfiles.KeyValue {
        final Map<String, String> m = new HashMap<>();
        String failOn;

        public String get(String k) { return m.get(k); }

        public void put(String k, String v) {
            if (k.equals(failOn)) throw new IllegalStateException("disk full");
            m.put(k, v);
        }

        public void remove(String k) {
            if (k.equals(failOn)) throw new IllegalStateException("disk full");
            m.remove(k);
        }

        public Set<String> keys() { return new LinkedHashSet<>(m.keySet()); }
    }

    static final class FakeAliases implements SignerProfiles.KeyAliases {
        final List<String> aliases = new ArrayList<>();
        final List<String> deleted = new ArrayList<>();
        boolean failList;
        String failDelete;

        public List<String> list() throws Exception {
            if (failList) throw new java.security.KeyStoreException("keystore busy");
            return new ArrayList<>(aliases);
        }

        public void delete(String alias) throws Exception {
            if (alias.equals(failDelete)) throw new java.security.KeyStoreException("cannot delete " + alias);
            aliases.remove(alias);
            deleted.add(alias);
        }
    }

    static SignerProfiles.Profile profile(String id, String label, int index) {
        return new SignerProfiles.Profile(id, label, index, "33".repeat(32));
    }

    @Test public void addListRemoveKeepsBothHalvesUnderTheirNames() throws Exception {
        MapKv kv = new MapKv();
        SignerProfiles p = new SignerProfiles(kv);
        p.add(profile("a1", "treasury", 2), "{policy}", "iv:ct");
        assertEquals(1, p.list().size());
        assertEquals("treasury", p.list().get(0).label);
        assertEquals(2, p.list().get(0).index);
        assertEquals("{policy}", kv.get("msauth.a1.policy"));
        assertEquals("iv:ct", kv.get("msauth.a1.seed"));
        assertEquals("{policy}", p.policy("a1"));
        assertEquals("iv:ct", p.sealedSeed("a1"));
        try {
            p.add(profile("b2", "again", 2), "{policy}", "x:y");
            fail("duplicate");
        } catch (IllegalStateException e) {
            assertEquals("this signer is already saved as treasury", e.getMessage());
        }
        assertNull("a refused add leaves nothing", kv.get("msauth.b2.seed"));
        p.add(profile("c3", "other position", 1), "{policy}", "x:y");
        assertEquals(2, p.list().size());
        p.remove("a1");
        assertNull(kv.get("msauth.a1.policy"));
        assertNull(kv.get("msauth.a1.seed"));
        assertEquals(1, p.list().size());
        assertEquals("c3", p.list().get(0).id);
    }

    /** The fee limit is kept with the profile; a profile saved without one reads as the default. */
    @Test public void theFeeLimitIsKeptWithTheProfile() throws Exception {
        MapKv kv = new MapKv();
        SignerProfiles p = new SignerProfiles(kv);
        p.add(new SignerProfiles.Profile("a1", "treasury", 2, "33".repeat(32), "500000000"), "{policy}", "iv:ct");
        p.add(profile("b2", "ops", 1), "{policy}", "iv:ct");
        List<SignerProfiles.Profile> all = new SignerProfiles(kv).list();
        assertEquals("500000000", all.get(0).maxFee);
        assertEquals("500000000", all.get(0).feeLimit());
        assertNull(all.get(1).maxFee);
        assertEquals("100000000", all.get(1).feeLimit());
        assertNull("an unreadable limit is not kept", new SignerProfiles.Profile("c3", "x", 0, "h", "lots").maxFee);
    }

    @Test public void removingAProfileDeletesItsKeystoreKey() throws Exception {
        MapKv kv = new MapKv();
        FakeAliases ks = new FakeAliases();
        ks.aliases.addAll(List.of("msauth.a1", "msauth.c3"));
        SignerProfiles p = new SignerProfiles(kv, ks);
        p.add(profile("a1", "treasury", 2), "{policy}", "iv:ct");
        p.remove("a1");
        assertEquals(List.of("msauth.a1"), ks.deleted);
        assertEquals(List.of("msauth.c3"), ks.aliases);
    }

    @Test public void aLabelIsOneToSixtyFourCodePoints() throws Exception {
        SignerProfiles p = new SignerProfiles(new MapKv());
        String emoji = "🔐"; // one code point, two chars
        p.add(profile("a1", emoji.repeat(64), 0), "{policy}", "iv:ct");
        assertEquals(64, p.list().get(0).label.codePointCount(0, p.list().get(0).label.length()));
        p.add(profile("a2", "  trimmed  ", 1), "{policy}", "iv:ct");
        assertEquals("trimmed", p.list().get(1).label);
        for (String bad : new String[] {emoji.repeat(65), "x".repeat(65), "", "   ", null}) {
            try {
                p.add(profile("b" + (bad == null ? 0 : bad.length()), bad, 5), "{policy}", "iv:ct");
                fail("label " + bad);
            } catch (IllegalArgumentException e) {
                assertEquals("a signer label is 1-64 characters", e.getMessage());
            }
        }
        assertEquals(2, p.list().size());
    }

    @Test public void anIdIsAKeystoreSafeName() throws Exception {
        SignerProfiles p = new SignerProfiles(new MapKv());
        for (String bad : new String[] {"", "a.b", "A1", "../x", "x".repeat(65)}) {
            try {
                p.add(profile(bad, "l", 0), "{policy}", "iv:ct");
                fail("id " + bad);
            } catch (IllegalArgumentException expected) {
                // refused
            }
        }
        String id = SignerProfiles.newId();
        assertTrue(id.matches("[0-9a-f]{32}"));
        p.add(profile(id, "l", 0), "{policy}", "iv:ct");
    }

    @Test public void aFailedAddLeavesNothingBehind() throws Exception {
        MapKv kv = new MapKv();
        SignerProfiles p = new SignerProfiles(kv);
        kv.failOn = "msauth.index";
        try {
            p.add(profile("a1", "treasury", 2), "{policy}", "iv:ct");
            fail();
        } catch (IllegalStateException expected) {
            // the index could not be written
        }
        kv.failOn = null;
        assertTrue(kv.m.isEmpty());
        assertTrue(p.list().isEmpty());
    }

    @Test public void anUnreadableIndexListsNothing() {
        MapKv kv = new MapKv();
        kv.m.put("msauth.index", "not json");
        assertTrue(new SignerProfiles(kv).list().isEmpty());
    }

    // ------------------------------------------------------------------ forgetting the wallet

    static MapKv walletWithSigners() throws Exception {
        MapKv kv = new MapKv();
        kv.m.put("spend_key", "5a".repeat(32));
        kv.m.put("prover_pairing", "{\"token\":1}");
        kv.m.put("prover_token", "legacy");
        SignerProfiles p = new SignerProfiles(kv);
        p.add(profile("a1", "treasury", 2), "{policy}", "iv:ct");
        p.add(profile("c3", "ops", 1), "{policy}", "iv:ct");
        // A profile the index no longer lists (a crash between the seed's save and the index's).
        kv.m.put("msauth.orphan.seed", "iv:ct");
        kv.m.put("msauth.orphan.policy", "{policy}");
        return kv;
    }

    static FakeAliases keystore() {
        FakeAliases ks = new FakeAliases();
        ks.aliases.addAll(List.of("_androidx_security_master_key_", "msauth.a1", "msauth.c3", "msauth.orphan", "other_app_key"));
        return ks;
    }

    @Test public void eraseSweepsEveryProfileAndKeyByPrefixAndNothingElse() throws Exception {
        MapKv kv = walletWithSigners();
        FakeAliases ks = keystore();
        SignerProfiles.eraseAll(kv, ks);
        assertEquals(Set.of("spend_key", "prover_pairing", "prover_token"), kv.m.keySet());
        assertEquals(List.of("_androidx_security_master_key_", "other_app_key"), ks.aliases);
        assertTrue(new SignerProfiles(kv).list().isEmpty());
    }

    @Test public void theSweepNeverTouchesTheSpendKeyOrTheProverByName() {
        for (String kept : new String[] {"spend_key", "prover_pairing", "prover_token", "_androidx_security_master_key_", "msauth", "msauthx.1"}) {
            assertFalse(kept, SignerProfiles.isSignerEntry(kept));
            assertFalse(kept, SignerProfiles.isSignerAlias(kept));
        }
        assertTrue(SignerProfiles.isSignerEntry("msauth.a1.seed"));
        assertTrue(SignerProfiles.isSignerEntry("msauth.index"));
        assertTrue(SignerProfiles.isSignerAlias("msauth.a1"));
    }

    @Test public void aFailedSweepKeepsTheIndex() throws Exception {
        // The Keystore cannot list: nothing is removed.
        MapKv kv = walletWithSigners();
        FakeAliases ks = keystore();
        ks.failList = true;
        Map<String, String> before = new HashMap<>(kv.m);
        try {
            SignerProfiles.eraseAll(kv, ks);
            fail();
        } catch (Exception expected) {
            assertTrue(expected.getMessage().contains("keystore busy"));
        }
        assertEquals(before, kv.m);
        // One key cannot be deleted: the index stays, so a retry finds what is left.
        kv = walletWithSigners();
        ks = keystore();
        ks.failDelete = "msauth.c3";
        try {
            SignerProfiles.eraseAll(kv, ks);
            fail();
        } catch (Exception expected) {
            // thrown
        }
        assertNotNull(kv.get("msauth.index"));
        assertEquals(2, new SignerProfiles(kv).list().size());
        ks.failDelete = null;
        SignerProfiles.eraseAll(kv, ks);
        assertEquals(Set.of("spend_key", "prover_pairing", "prover_token"), kv.m.keySet());
        // An entry cannot be removed: the index stays.
        kv = walletWithSigners();
        kv.failOn = "msauth.orphan.seed";
        try {
            SignerProfiles.eraseAll(kv, keystore());
            fail();
        } catch (IllegalStateException expected) {
            // thrown
        }
        assertNotNull(kv.get("msauth.index"));
    }

    // ------------------------------------------------------------------ the per-use key

    @Test public void aSealedSeedRoundTrips() {
        byte[][] parts = KeystoreSeedCipher.unseal(KeystoreSeedCipher.seal(new byte[] {1, 2}, new byte[] {3, 4, 5}));
        assertArrayEquals(new byte[] {1, 2}, parts[0]);
        assertArrayEquals(new byte[] {3, 4, 5}, parts[1]);
        for (String bad : new String[] {"", "abc", ":", "AQI=:", ":AQI=", "!!:AQI="}) {
            try {
                KeystoreSeedCipher.unseal(bad);
                fail(bad);
            } catch (IllegalArgumentException expected) {
                // refused
            }
        }
    }

    @Test public void beforeAndroid11ASignerNeedsABiometric() {
        // API 26-29: per-use auth with a CryptoObject exists only for biometrics.
        for (int sdk = 26; sdk <= 29; sdk++) {
            assertFalse(KeystoreSeedCipher.credentialPerUse(sdk));
            assertEquals(BiometricManager.Authenticators.BIOMETRIC_STRONG, KeystoreSeedCipher.promptAuthenticators(sdk));
            assertNull(KeystoreSeedCipher.refusal(sdk, true, true));
            assertNull(KeystoreSeedCipher.refusal(sdk, true, false));
            assertEquals("a screen lock alone is not enough on API " + sdk,
                    "Set a screen lock (and on Android 10 or older, a fingerprint) first: a signer key is used only right after you authenticate.",
                    KeystoreSeedCipher.refusal(sdk, false, true));
            assertNotNull(KeystoreSeedCipher.refusal(sdk, false, false));
        }
        for (int sdk : new int[] {30, 33, 36}) {
            assertTrue(KeystoreSeedCipher.credentialPerUse(sdk));
            assertEquals(BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL,
                    KeystoreSeedCipher.promptAuthenticators(sdk));
            assertNull(KeystoreSeedCipher.refusal(sdk, false, true));
            assertNull(KeystoreSeedCipher.refusal(sdk, true, false));
            assertNotNull(KeystoreSeedCipher.refusal(sdk, false, false));
        }
    }

    @Test public void aSeedIsReadThroughTheAuthenticatedCipherOnly() throws Exception {
        KeyGenerator g = KeyGenerator.getInstance("AES");
        g.init(256);
        SecretKey key = g.generateKey();
        byte[] seed = new byte[32];
        new SecureRandom().nextBytes(seed);
        Cipher enc = Cipher.getInstance("AES/GCM/NoPadding");
        enc.init(Cipher.ENCRYPT_MODE, key);
        String sealed = KeystoreSeedCipher.seal(enc.getIV(), enc.doFinal(seed));

        MapKv kv = new MapKv();
        SignerProfiles profiles = new SignerProfiles(kv);
        profiles.add(profile("a1", "treasury", 2), "{policy}", sealed);
        List<String> asked = new ArrayList<>();
        KeystoreSeedSource src = new KeystoreSeedSource(profiles, (id, iv) -> {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
            asked.add("cipher " + id);
            return c;
        }, cipher -> {
            asked.add("prompt");
            return cipher;
        });
        assertArrayEquals(seed, src.seed("a1"));
        assertArrayEquals(seed, src.seed("a1"));
        assertEquals("one prompt per read", List.of("cipher a1", "prompt", "cipher a1", "prompt"), asked);
        try {
            src.seed("nope");
            fail();
        } catch (IllegalStateException e) {
            assertEquals("This signer profile has no key on this device: remove it and add it again.", e.getMessage());
        }
        // A prompt that is cancelled or fails: no seed.
        KeystoreSeedSource refused = new KeystoreSeedSource(profiles, (id, iv) -> Cipher.getInstance("AES/GCM/NoPadding"), cipher -> {
            throw new java.util.concurrent.CancellationException("cancelled");
        });
        try {
            refused.seed("a1");
            fail();
        } catch (java.util.concurrent.CancellationException expected) {
            // no seed
        }
        // A sealed seed that does not open under its key (another key, a tampered ct): no seed.
        SignerProfiles other = new SignerProfiles(new MapKv());
        Cipher enc2 = Cipher.getInstance("AES/GCM/NoPadding");
        KeyGenerator g2 = KeyGenerator.getInstance("AES");
        g2.init(256);
        enc2.init(Cipher.ENCRYPT_MODE, g2.generateKey());
        other.add(profile("a1", "treasury", 2), "{policy}", KeystoreSeedCipher.seal(enc2.getIV(), enc2.doFinal(seed)));
        KeystoreSeedSource wrongKey = new KeystoreSeedSource(other, (id, iv) -> {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
            return c;
        }, cipher -> cipher);
        try {
            wrongKey.seed("a1");
            fail();
        } catch (javax.crypto.AEADBadTagException expected) {
            // the tag does not verify
        }
    }
}
