package org.randprotocol.wallet.security;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import org.randprotocol.wallet.R;
import org.randprotocol.wallet.util.L10n;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.util.HashSet;
import java.util.Set;

/**
 * The spend key at rest: an {@link EncryptedSharedPreferences} whose AES-GCM key lives in the
 * Android Keystore. Beside it, and nothing else, a paired prover's record (delegated proving:
 * the token AND the key and URL a job is sealed and sent to, and whether the link marked the
 * prover as the user's own — the one copy a send decides by) — the viewing key and the address
 * are derived from the spend key on demand by the core. And the private-multisig signer profiles
 * ({@link SignerProfiles}, every name {@code msauth.…}): a policy and a seed sealed by the
 * profile's own per-use Keystore key ({@link KeystoreSeedCipher}).
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

    /**
     * Removes the wallet: first every signer profile and every profile's Keystore key, swept by
     * name (also those the index no longer lists); then the spend key and the prover's record.
     * When the sweep fails, nothing else is removed and IllegalStateException says so — the
     * wallet is kept whole and a retry finds what is left (never a half-wipe).
     */
    public void erase() {
        try {
            SignerProfiles.eraseAll(signerStore(), KeystoreSeedCipher.keystoreAliases());
        } catch (Exception e) {
            throw new IllegalStateException(L10n.t(R.string.msauth_forget_failed,
                    "The signer keys on this device could not all be removed, so the wallet was kept. Try again."), e);
        }
        prefs.edit().remove(KEY_SPEND).remove(KEY_PROVER_PAIRING).remove(KEY_LEGACY_PROVER_TOKEN).commit();
    }

    /** The signer profiles' storage, in this same encrypted file (spec §3); a write that does not land throws. */
    public SignerProfiles.KeyValue signerStore() {
        return new SignerProfiles.KeyValue() {
            @Override public String get(String k) {
                return prefs.getString(k, null);
            }

            @Override public void put(String k, String v) {
                if (!prefs.edit().putString(k, v).commit()) throw new IllegalStateException("the key vault could not be written");
            }

            @Override public void remove(String k) {
                if (!prefs.edit().remove(k).commit()) throw new IllegalStateException("the key vault could not be written");
            }

            @Override public Set<String> keys() {
                return new HashSet<>(prefs.getAll().keySet());
            }
        };
    }

    /** The signer profiles, removing a profile's Keystore key with it. */
    public SignerProfiles signerProfiles() {
        return new SignerProfiles(signerStore(), KeystoreSeedCipher.keystoreAliases());
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
