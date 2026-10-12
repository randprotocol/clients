package org.randprotocol.wallet.security;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.SharedPreferences;

import org.junit.Test;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;

/**
 * The one-time chain-id migration (wallet v0.8.0 runs chain 21 onward): a saved 20 becomes 21 on
 * the first launch, once, and nothing else changes. On the JVM, with a map for the preferences.
 */
public class PrefsMigrationTest {
    /** SharedPreferences over a map: enough for {@link Prefs}. */
    static final class MapPrefs implements SharedPreferences {
        final Map<String, Object> m = new HashMap<>();

        public Map<String, ?> getAll() { return new HashMap<>(m); }
        public String getString(String k, String d) { return m.containsKey(k) ? (String) m.get(k) : d; }
        @SuppressWarnings("unchecked")
        public Set<String> getStringSet(String k, Set<String> d) { return m.containsKey(k) ? (Set<String>) m.get(k) : d; }
        public int getInt(String k, int d) { return m.containsKey(k) ? (Integer) m.get(k) : d; }
        public long getLong(String k, long d) { return m.containsKey(k) ? (Long) m.get(k) : d; }
        public float getFloat(String k, float d) { return m.containsKey(k) ? (Float) m.get(k) : d; }
        public boolean getBoolean(String k, boolean d) { return m.containsKey(k) ? (Boolean) m.get(k) : d; }
        public boolean contains(String k) { return m.containsKey(k); }
        public void registerOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener l) {}
        public void unregisterOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener l) {}

        public Editor edit() {
            Map<String, Object> pending = new HashMap<>();
            Set<String> removed = new java.util.HashSet<>();
            return new Editor() {
                public Editor putString(String k, String v) { pending.put(k, v); return this; }
                public Editor putStringSet(String k, Set<String> v) { pending.put(k, v); return this; }
                public Editor putInt(String k, int v) { pending.put(k, v); return this; }
                public Editor putLong(String k, long v) { pending.put(k, v); return this; }
                public Editor putFloat(String k, float v) { pending.put(k, v); return this; }
                public Editor putBoolean(String k, boolean v) { pending.put(k, v); return this; }
                public Editor remove(String k) { removed.add(k); return this; }
                public Editor clear() { removed.addAll(m.keySet()); return this; }
                public boolean commit() { for (String k : removed) m.remove(k); m.putAll(pending); return true; }
                public void apply() { commit(); }
            };
        }
    }

    @Test
    public void aSavedTwentyBecomesTwentyOneAndNothingElseChanges() {
        MapPrefs sp = new MapPrefs();
        sp.m.put("chain_id", 20L);
        sp.m.put("rpc_url", "http://10.0.0.5:8545");
        sp.m.put("auto_lock_minutes", 5);
        Prefs prefs = new Prefs(sp);
        assertEquals(21L, prefs.chainId());
        assertEquals("the RPC URL is not touched", "http://10.0.0.5:8545", prefs.rpcUrl());
        assertEquals(5, prefs.autoLockMinutes());
        assertTrue(sp.getBoolean(Prefs.CHAIN_MIGRATION_KEY, false));
        assertEquals(4, sp.m.size());
    }

    @Test
    public void itRunsOnce() {
        MapPrefs sp = new MapPrefs();
        sp.m.put("chain_id", 20L);
        new Prefs(sp).setChainId(20); // the user chose 20 again afterwards
        assertEquals("a later launch leaves the user's choice alone", 20L, new Prefs(sp).chainId());
    }

    @Test
    public void otherValuesAndNoValueAreLeftAlone() {
        MapPrefs sp = new MapPrefs();
        sp.m.put("chain_id", 13L);
        assertEquals(13L, new Prefs(sp).chainId());

        MapPrefs empty = new MapPrefs();
        new Prefs(empty);
        assertFalse("no saved chain id: none is written", empty.contains("chain_id"));
        assertEquals(1, empty.m.size());
        assertEquals(Prefs.DEFAULT_CHAIN_ID, new Prefs(empty).chainId());
    }
}
