package org.randprotocol.wallet.ui;

import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import org.randprotocol.wallet.R;
import org.randprotocol.wallet.security.KeystoreSeedCipher;
import org.randprotocol.wallet.security.KeystoreSeedSource;

import java.util.concurrent.CancellationException;
import java.util.concurrent.CountDownLatch;

import javax.crypto.Cipher;

/**
 * The system's prompt over a signer key's cipher (a BiometricPrompt with a CryptoObject): the
 * fingerprint, face or — on Android 11 and later — the screen lock, once per use. {@link
 * #authenticate} is called off the main thread ({@link org.randprotocol.wallet.wallet.SignFlow#sign}),
 * posts the prompt to the main thread and blocks until it ends; {@link #cancel} dismisses it and
 * releases the caller.
 */
final class CryptoPrompt implements KeystoreSeedSource.Authenticator {
    /** The prompt ended without a cipher: {@link #code} is BiometricPrompt's error code. */
    static final class Failed extends Exception {
        final int code;

        Failed(int code, CharSequence message) {
            super(String.valueOf(message));
            this.code = code;
        }

        /** The person dismissed it (Cancel, back, or the app left): nothing to show. */
        boolean dismissed() {
            return code == BiometricPrompt.ERROR_USER_CANCELED || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON
                    || code == BiometricPrompt.ERROR_CANCELED;
        }
    }

    interface Showing {
        void showing(boolean up);
    }

    private final FragmentActivity activity;
    private final String title;
    private final Showing showing;
    private final Handler main = new Handler(Looper.getMainLooper());
    private BiometricPrompt prompt; // main thread only
    private CountDownLatch pending; // the call waiting, if any
    /** The prompt was asked for and has not yet covered the screen (main thread only). */
    private boolean awaitingUp;
    private volatile boolean cancelled;

    CryptoPrompt(FragmentActivity activity, String title, Showing showing) {
        this.activity = activity;
        this.title = title;
        this.showing = showing;
    }

    /** The prompt for {@code sdk}: BIOMETRIC_STRONG with a Cancel button below API 30, or with the device credential from API 30. */
    static BiometricPrompt.PromptInfo info(String title, String cancel) {
        int sdk = Build.VERSION.SDK_INT;
        BiometricPrompt.PromptInfo.Builder b = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setConfirmationRequired(false)
                .setAllowedAuthenticators(KeystoreSeedCipher.promptAuthenticators(sdk));
        if (!KeystoreSeedCipher.credentialPerUse(sdk)) b.setNegativeButtonText(cancel);
        return b.build();
    }

    @Override
    public Cipher authenticate(Cipher cipher) throws Exception {
        if (Looper.myLooper() == Looper.getMainLooper()) throw new IllegalStateException("the prompt blocks: never on the main thread");
        CountDownLatch done = new CountDownLatch(1);
        Cipher[] result = new Cipher[1];
        Exception[] failure = new Exception[1];
        main.post(() -> {
            pending = done;
            if (cancelled || activity.isFinishing() || activity.isDestroyed()) {
                failure[0] = new CancellationException();
                done.countDown();
                return;
            }
            prompt = new BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult r) {
                    BiometricPrompt.CryptoObject c = r.getCryptoObject();
                    if (c == null || c.getCipher() == null) failure[0] = new IllegalStateException("the prompt returned no cipher");
                    else result[0] = c.getCipher();
                    end(done);
                }

                @Override
                public void onAuthenticationError(int code, @NonNull CharSequence message) {
                    failure[0] = new Failed(code, message);
                    end(done);
                }
                // onAuthenticationFailed (a finger not recognised): the prompt stays up and asks again.
            });
            try {
                prompt.authenticate(info(title, activity.getString(R.string.cancel)), new BiometricPrompt.CryptoObject(cipher));
                // "Showing" only once the prompt has actually taken the window's focus (windowFocus):
                // a prompt that never appears never marks the screen as covered.
                awaitingUp = true;
            } catch (RuntimeException e) {
                failure[0] = e;
                end(done);
            }
        });
        try {
            done.await();
        } catch (InterruptedException e) {
            cancel();
            Thread.currentThread().interrupt();
            throw new CancellationException();
        }
        if (failure[0] != null) throw failure[0];
        if (cancelled) throw new CancellationException();
        return result[0];
    }

    /** The activity's window focus (onWindowFocusChanged): losing it while the prompt is asked for means the prompt is up. */
    void windowFocus(boolean hasFocus) {
        if (!hasFocus && awaitingUp && pending != null) {
            awaitingUp = false;
            showing.showing(true);
        }
    }

    private void end(CountDownLatch done) {
        awaitingUp = false;
        prompt = null;
        pending = null;
        showing.showing(false);
        done.countDown();
    }

    /** Dismisses the prompt if it is up and releases the waiting call; later calls are refused. Any thread. */
    void cancel() {
        cancelled = true;
        main.post(() -> {
            if (prompt != null) prompt.cancelAuthentication();
            CountDownLatch p = pending;
            prompt = null;
            pending = null;
            awaitingUp = false;
            showing.showing(false);
            if (p != null) p.countDown();
        });
    }
}
