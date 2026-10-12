package org.randprotocol.wallet.security;

import android.content.Context;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import androidx.annotation.ChecksSdkIntAtLeast;
import androidx.biometric.BiometricManager;

import org.randprotocol.wallet.R;
import org.randprotocol.wallet.util.L10n;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Base64;
import java.util.Collections;
import java.util.List;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * One Keystore AES-256-GCM key per signer profile (alias {@code msauth.<id>}), usable only right
 * after the person authenticates — spec §3: every signature re-authenticates, and so does saving the
 * seed. The cipher goes through BiometricPrompt's CryptoObject; nothing here prompts.
 *
 * <p>API 30+: a strong biometric or the device credential, per use (timeout 0). API 26–29: a
 * per-use key with a CryptoObject exists only for biometrics (validity -1; the device credential
 * cannot unlock a CryptoObject there), so on those devices a profile needs an enrolled strong
 * biometric ({@link #refusal}).
 */
public final class KeystoreSeedCipher {
    private KeystoreSeedCipher() {}

    private static final String STORE = "AndroidKeyStore";
    private static final String TRANSFORM = "AES/GCM/NoPadding";

    public static String alias(String id) {
        return SignerProfiles.PREFIX + id;
    }

    /** Whether the device credential can authorise a per-use key on {@code sdk}. */
    @ChecksSdkIntAtLeast(parameter = 0)
    public static boolean credentialPerUse(int sdk) {
        return sdk >= Build.VERSION_CODES.R;
    }

    /** BiometricPrompt's authenticators for a signer key's CryptoObject on {@code sdk}. */
    public static int promptAuthenticators(int sdk) {
        return credentialPerUse(sdk)
                ? BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL
                : BiometricManager.Authenticators.BIOMETRIC_STRONG;
    }

    /**
     * Why this device cannot hold a signer key, or null when it can: {@code biometricReady} a strong
     * biometric is enrolled and usable, {@code credentialReady} a screen lock is set.
     */
    public static String refusal(int sdk, boolean biometricReady, boolean credentialReady) {
        boolean ok = credentialPerUse(sdk) ? (biometricReady || credentialReady) : biometricReady;
        return ok ? null : L10n.t(R.string.msauth_needs_device_auth,
                "Set a screen lock (and on Android 10 or older, a fingerprint) first: a signer key is used only right after you authenticate.");
    }

    /** {@link #refusal(int, boolean, boolean)} for this device. */
    public static String refusal(Context c) {
        int sdk = Build.VERSION.SDK_INT;
        BiometricManager m = BiometricManager.from(c);
        boolean bio = m.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS;
        boolean cred = credentialPerUse(sdk) && m.canAuthenticate(BiometricManager.Authenticators.DEVICE_CREDENTIAL) == BiometricManager.BIOMETRIC_SUCCESS;
        return refusal(sdk, bio, cred);
    }

    public static void createKey(String id) throws GeneralSecurityException {
        KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(alias(id), KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) { // credentialPerUse, inlined for lint
            b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL);
        } else {
            b.setUserAuthenticationValidityDurationSeconds(-1);
        }
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE);
        g.init(b.build());
        g.generateKey();
    }

    private static KeyStore keystore() throws GeneralSecurityException {
        KeyStore ks = KeyStore.getInstance(STORE);
        try {
            ks.load(null);
        } catch (IOException e) {
            throw new GeneralSecurityException(e);
        }
        return ks;
    }

    private static SecretKey key(String id) throws GeneralSecurityException {
        SecretKey k = (SecretKey) keystore().getKey(alias(id), null);
        if (k == null) throw new GeneralSecurityException("no Keystore key for this signer");
        return k;
    }

    /** For saving the seed: authenticate it through a CryptoObject, then {@code doFinal(seed)}; the IV is {@code getIV()}. */
    public static Cipher encryptCipher(String id) throws GeneralSecurityException {
        Cipher c = Cipher.getInstance(TRANSFORM);
        c.init(Cipher.ENCRYPT_MODE, key(id));
        return c;
    }

    /** For reading the seed: authenticate it through a CryptoObject, then {@code doFinal(ct)}. */
    public static Cipher decryptCipher(String id, byte[] iv) throws GeneralSecurityException {
        Cipher c = Cipher.getInstance(TRANSFORM);
        c.init(Cipher.DECRYPT_MODE, key(id), new GCMParameterSpec(128, iv));
        return c;
    }

    /** Best effort, for undoing a failed add; the wallet's sweep ({@link SignerProfiles#eraseAll}) throws instead. */
    public static void deleteKey(String id) {
        try {
            keystore().deleteEntry(alias(id));
        } catch (Exception ignored) {
            // nothing to delete, or the sweep takes it
        }
    }

    /** The Keystore's aliases, for {@link SignerProfiles}: listing or deleting throws on failure. */
    public static SignerProfiles.KeyAliases keystoreAliases() {
        return new SignerProfiles.KeyAliases() {
            @Override public List<String> list() throws Exception {
                return Collections.list(keystore().aliases());
            }

            @Override public void delete(String alias) throws Exception {
                keystore().deleteEntry(alias);
            }
        };
    }

    public static String seal(byte[] iv, byte[] ct) {
        return Base64.getEncoder().encodeToString(iv) + ":" + Base64.getEncoder().encodeToString(ct);
    }

    /** {@code {iv, ct}}; IllegalArgumentException for anything but two non-empty base64 halves. */
    public static byte[][] unseal(String s) {
        int i = s == null ? -1 : s.indexOf(':');
        if (i <= 0 || i == s.length() - 1) throw new IllegalArgumentException("a sealed seed is iv:ct");
        byte[] iv = Base64.getDecoder().decode(s.substring(0, i));
        byte[] ct = Base64.getDecoder().decode(s.substring(i + 1));
        if (iv.length == 0 || ct.length == 0) throw new IllegalArgumentException("a sealed seed is iv:ct");
        return new byte[][] {iv, ct};
    }
}
