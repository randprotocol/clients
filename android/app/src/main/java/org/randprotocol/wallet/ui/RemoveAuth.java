package org.randprotocol.wallet.ui;

import androidx.biometric.BiometricManager;

/**
 * How removing a signer asks for the device's authentication (no CryptoObject: it only confirms the
 * person). The ask is skipped only on a device with no secure lock at all ({@code
 * KeyguardManager.isDeviceSecure()} false); on any other device, whatever BiometricManager answers
 * (UNSUPPORTED on API 28–29 for a biometric-or-credential prompt, no enrolment, no hardware…), the
 * person is asked — by BiometricPrompt where it can, else by the system's confirm-credential screen.
 */
public final class RemoveAuth {
    public enum Kind { NONE, PROMPT, CONFIRM_CREDENTIAL }

    public final Kind kind;
    /** For {@link Kind#PROMPT}: the authenticators to allow. */
    public final int authenticators;
    /** For {@link Kind#PROMPT}: a Cancel button is required (no device credential in the prompt). */
    public final boolean negativeButton;

    private RemoveAuth(Kind kind, int authenticators, boolean negativeButton) {
        this.kind = kind;
        this.authenticators = authenticators;
        this.negativeButton = negativeButton;
    }

    /** What BiometricPrompt is asked for on {@code sdk}: weak biometric or the credential from API 30, weak biometric alone below. */
    public static int authenticators(int sdk) {
        return sdk >= 30
                ? BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL
                : BiometricManager.Authenticators.BIOMETRIC_WEAK;
    }

    /**
     * {@code deviceSecure}: KeyguardManager.isDeviceSecure(); {@code canAuthenticate}: BiometricManager's
     * answer for {@link #authenticators(int)} on this device.
     */
    public static RemoveAuth choose(int sdk, boolean deviceSecure, int canAuthenticate) {
        if (!deviceSecure) return new RemoveAuth(Kind.NONE, 0, false);
        if (canAuthenticate == BiometricManager.BIOMETRIC_SUCCESS) {
            return new RemoveAuth(Kind.PROMPT, authenticators(sdk), sdk < 30);
        }
        return new RemoveAuth(Kind.CONFIRM_CREDENTIAL, 0, false);
    }
}
