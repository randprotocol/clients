package org.randprotocol.wallet.security;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import java.io.IOException;
import java.security.GeneralSecurityException;

/**
 * The spend key at rest: an {@link EncryptedSharedPreferences} whose AES-GCM key lives in the
 * Android Keystore. Beside it, and nothing else, a paired prover's token (delegated proving,
 * Phase 1) — the viewing key and the address are derived from the spend key on demand by the core.
 */
public final class KeyVault {
    private static final String FILE = "rand_wallet_vault";
    private static final String KEY_SPEND = "spend_key";
    private static final String KEY_PROVER_TOKEN = "prover_token";

    private final SharedPreferences prefs;

    public KeyVault(Context context) {
        try {
            MasterKey master = new MasterKey.Builder(context)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build();
            prefs = EncryptedSharedPreferences.create(
                    context,
                    FILE,
                    master,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
        } catch (GeneralSecurityException | IOException e) {
            throw new IllegalStateException("cannot open the key vault", e);
        }
    }

    public boolean hasWallet() {
        return prefs.contains(KEY_SPEND);
    }

    /** The spend key as 64 hex characters, or null when no wallet exists. */
    public String spendKey() {
        return prefs.getString(KEY_SPEND, null);
    }

    /** Refuses to overwrite: there is no second copy of a spend key. */
    public void store(String spendKeyHex) {
        if (hasWallet()) throw new IllegalStateException("a wallet already exists; remove it first");
        prefs.edit().putString(KEY_SPEND, spendKeyHex).commit();
    }

    public void erase() {
        prefs.edit().remove(KEY_SPEND).remove(KEY_PROVER_TOKEN).commit();
    }

    /**
     * The paired prover's bearer token (64 hex), or null. It travels only inside a job the core
     * sealed to the prover's key; never in {@link Prefs}, never in a log.
     */
    public String proverToken() {
        return prefs.getString(KEY_PROVER_TOKEN, null);
    }

    public void setProverToken(String hex) {
        prefs.edit().putString(KEY_PROVER_TOKEN, hex).commit();
    }

    public void eraseProverToken() {
        prefs.edit().remove(KEY_PROVER_TOKEN).commit();
    }
}
