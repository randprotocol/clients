package org.randprotocol.wallet.ui;

import android.content.Intent;
import android.os.Bundle;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;

import org.randprotocol.wallet.R;
import org.randprotocol.wallet.databinding.ActivityLockBinding;
import org.randprotocol.wallet.security.Unlock;

/** BiometricPrompt with the device credential as fallback. */
public class LockActivity extends BaseActivity {
    private ActivityLockBinding b;

    @Override
    protected boolean requiresUnlock() {
        return false;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        b = ActivityLockBinding.inflate(getLayoutInflater());
        setContentView(b.getRoot());
        if (!Unlock.deviceCanAuthenticate(this)) {
            b.body.setText(R.string.lock_no_credential);
            b.unlock.setOnClickListener(v -> proceed());
            return;
        }
        b.unlock.setOnClickListener(v -> prompt());
        prompt();
    }

    private void prompt() {
        BiometricPrompt prompt = new BiometricPrompt(this, ContextCompat.getMainExecutor(this), new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                Unlock.markUnlocked();
                proceed();
            }

            @Override
            public void onAuthenticationError(int errorCode, @NonNull CharSequence errString) {
                b.body.setText(errString);
            }
        });
        BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(getString(R.string.lock_prompt_title))
                .setAllowedAuthenticators(Unlock.authenticators())
                .build();
        prompt.authenticate(info);
    }

    private void proceed() {
        if (isTaskRoot()) {
            startActivity(new Intent(this, HomeActivity.class));
        }
        finish();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // Locked means locked: leave the app rather than the lock screen.
        moveTaskToBack(true);
    }
}
