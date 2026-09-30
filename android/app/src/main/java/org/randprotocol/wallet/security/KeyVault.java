package org.randprotocol.wallet.security;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import java.io.IOException;
import java.security.GeneralSecurityException;

/**
 * The spend key at rest: an {@link EncryptedSharedPreferences} whose AES-GCM key lives in the
 * Android Keystore. Beside it, and nothing else, a paired prover's record (delegated proving:
 * the token AND the key and URL a job is sealed and sent to, and whether the link marked the
 * prover as the user's own — the one copy a send decides by) — the viewing key and the address
 * are derived from the spend key on demand by the core.
 */
public final class KeyVault {
    private static final String FILE = "rand_wallet_vault";
    private static final String KEY_SPEND = "spend_key";
    private static final String KEY_PROVER_PAIRING = "prover_pairing";
    /** A pre-release build's bare token: never read (it names no seal target), removed with the pairing. */
    private static final String KEY_LEGACY_PROVER_TOKEN = "prover_token";

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
        prefs.edit().remove(KEY_SPEND).remove(KEY_PROVER_PAIRING).remove(KEY_LEGACY_PROVER_TOKEN).commit();
    }

    /**
     * The paired prover's record — token, key, URL, fingerprint, {@code own} — or null. The token
     * travels only inside a job the core sealed to this record's key, which (not {@link Prefs}'
     * display copy) decides where the job goes and whether it may carry the spend key; never in
     * {@link Prefs}, never in a log.
     */
    public org.randprotocol.wallet.wallet.ProverSecret proverSecret() {
        return org.randprotocol.wallet.wallet.ProverSecret.fromJson(prefs.getString(KEY_PROVER_PAIRING, null));
    }

    public void setProverSecret(org.randprotocol.wallet.wallet.ProverSecret secret) {
        prefs.edit().putString(KEY_PROVER_PAIRING, secret.toJson()).remove(KEY_LEGACY_PROVER_TOKEN).commit();
    }

    public void eraseProverSecret() {
        prefs.edit().remove(KEY_PROVER_PAIRING).remove(KEY_LEGACY_PROVER_TOKEN).commit();
    }
}
