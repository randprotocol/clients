package org.randprotocol.wallet.security;

import org.randprotocol.wallet.R;
import org.randprotocol.wallet.util.L10n;
import org.randprotocol.wallet.wallet.SignFlow;

import javax.crypto.Cipher;

/**
 * A profile's seed, read once per signature: the sealed seed from {@link SignerProfiles}, its
 * profile's Keystore cipher, the system's prompt over that cipher ({@link Authenticator}: a
 * BiometricPrompt with a CryptoObject), then the decrypt. The bytes returned are a fresh buffer
 * the caller zeroes ({@link SignFlow#sign} does); the Keystore's and the Cipher's own copies are
 * out of reach.
 */
public final class KeystoreSeedSource implements SignFlow.SeedSource {
    /** The decrypt cipher for a profile ({@link KeystoreSeedCipher#decryptCipher} on a device). */
    public interface CipherFactory {
        Cipher decryptCipher(String id, byte[] iv) throws Exception;
    }

    /**
     * Shows the prompt with {@code cipher} as its CryptoObject and blocks until it ends: the
     * authenticated cipher, or a throw when the person cancels or fails. Never on the main thread.
     */
    public interface Authenticator {
        Cipher authenticate(Cipher cipher) throws Exception;
    }

    private final SignerProfiles profiles;
    private final CipherFactory ciphers;
    private final Authenticator auth;

    public KeystoreSeedSource(SignerProfiles profiles, Authenticator auth) {
        this(profiles, KeystoreSeedCipher::decryptCipher, auth);
    }

    public KeystoreSeedSource(SignerProfiles profiles, CipherFactory ciphers, Authenticator auth) {
        this.profiles = profiles;
        this.ciphers = ciphers;
        this.auth = auth;
    }

    @Override
    public byte[] seed(String id) throws Exception {
        String sealed = profiles.sealedSeed(id);
        if (sealed == null) {
            throw new IllegalStateException(L10n.t(R.string.msauth_no_seed, "This signer profile has no key on this device: remove it and add it again."));
        }
        byte[][] parts = KeystoreSeedCipher.unseal(sealed);
        Cipher authed = auth.authenticate(ciphers.decryptCipher(id, parts[0]));
        return authed.doFinal(parts[1]);
    }
}
