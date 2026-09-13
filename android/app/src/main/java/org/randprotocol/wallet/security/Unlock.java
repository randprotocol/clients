package org.randprotocol.wallet.security;

import android.content.Context;
import android.os.SystemClock;

import androidx.biometric.BiometricManager;

/**
 * The in-memory lock. The app is "unlocked" for {@link Prefs#autoLockMinutes()} after a
 * successful biometric or device-credential prompt; every screen checks on resume and sends the
 * user to the lock screen when the window has passed. A device without any lock set up cannot
 * be locked and is treated as always unlocked, with a notice on the lock screen.
 */
public final class Unlock {
    private static long unlockedAtMs = 0;
    private static boolean unlocked = false;

    private Unlock() {}

    public static int authenticators() {
        return BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
    }

    public static boolean deviceCanAuthenticate(Context c) {
        return BiometricManager.from(c).canAuthenticate(authenticators()) == BiometricManager.BIOMETRIC_SUCCESS;
    }

    public static void markUnlocked() {
        unlocked = true;
        unlockedAtMs = SystemClock.elapsedRealtime();
    }

    public static void lock() {
        unlocked = false;
        unlockedAtMs = 0;
    }

    public static boolean isUnlocked(Context c) {
        if (!deviceCanAuthenticate(c)) return true;
        if (!unlocked) return false;
        long window = new Prefs(c).autoLockMinutes() * 60_000L;
        if (window <= 0) return true;
        return SystemClock.elapsedRealtime() - unlockedAtMs < window;
    }
}
