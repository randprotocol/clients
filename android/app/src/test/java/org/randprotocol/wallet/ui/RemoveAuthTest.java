package org.randprotocol.wallet.ui;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import androidx.biometric.BiometricManager;

import org.junit.Test;

/**
 * How removing a signer asks for the device's authentication ({@link RemoveAuth}): never skipped on
 * a device with a secure lock, whatever BiometricManager answers; a confirm-credential screen
 * where BiometricPrompt cannot ask.
 */
public class RemoveAuthTest {
    static final int WEAK = BiometricManager.Authenticators.BIOMETRIC_WEAK;
    static final int CRED = BiometricManager.Authenticators.DEVICE_CREDENTIAL;
    static final int[] RESULTS = {
            BiometricManager.BIOMETRIC_SUCCESS,
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED,
            BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE,
            BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE,
            BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED,
            BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED,
            BiometricManager.BIOMETRIC_STATUS_UNKNOWN,
    };

    @Test public void theAuthenticatorsAskedForPerApiLevel() {
        assertEquals(WEAK, RemoveAuth.authenticators(28));
        assertEquals(WEAK, RemoveAuth.authenticators(29));
        assertEquals(WEAK | CRED, RemoveAuth.authenticators(30));
        assertEquals(WEAK | CRED, RemoveAuth.authenticators(34));
    }

    @Test public void onlyADeviceWithoutASecureLockSkips() {
        for (int sdk : new int[] {26, 28, 29, 30, 34}) {
            for (int r : RESULTS) {
                assertEquals(RemoveAuth.Kind.NONE, RemoveAuth.choose(sdk, false, r).kind);
                assertNotEquals("sdk " + sdk + " result " + r, RemoveAuth.Kind.NONE, RemoveAuth.choose(sdk, true, r).kind);
            }
        }
    }

    @Test public void belowApi30AWeakBiometricPromptsWithACancelButtonElseTheCredentialScreen() {
        for (int sdk : new int[] {28, 29}) {
            RemoveAuth ok = RemoveAuth.choose(sdk, true, BiometricManager.BIOMETRIC_SUCCESS);
            assertEquals(RemoveAuth.Kind.PROMPT, ok.kind);
            assertEquals(WEAK, ok.authenticators);
            assertTrue(ok.negativeButton);
            for (int r : RESULTS) {
                if (r == BiometricManager.BIOMETRIC_SUCCESS) continue;
                assertEquals("sdk " + sdk + " result " + r, RemoveAuth.Kind.CONFIRM_CREDENTIAL, RemoveAuth.choose(sdk, true, r).kind);
            }
        }
    }

    @Test public void fromApi30ThePromptWithTheCredentialElseTheCredentialScreen() {
        RemoveAuth ok = RemoveAuth.choose(30, true, BiometricManager.BIOMETRIC_SUCCESS);
        assertEquals(RemoveAuth.Kind.PROMPT, ok.kind);
        assertEquals(WEAK | CRED, ok.authenticators);
        assertFalse("DEVICE_CREDENTIAL takes no negative button", ok.negativeButton);
        for (int r : RESULTS) {
            if (r == BiometricManager.BIOMETRIC_SUCCESS) continue;
            assertEquals("result " + r, RemoveAuth.Kind.CONFIRM_CREDENTIAL, RemoveAuth.choose(30, true, r).kind);
        }
    }
}
