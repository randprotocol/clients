package org.randprotocol.wallet.wallet;

import androidx.lifecycle.LiveData;
import androidx.lifecycle.MutableLiveData;

/**
 * The one swap in flight, observable from any screen ({@link SendMonitor}'s twin: the proving
 * service posts here for an invoke). Leaving the Swap screen does not stop it, and coming back
 * shows its progress. {@link #swap} is what was quoted, for the Done step.
 */
public final class SwapMonitor {
    private static final MutableLiveData<SendState> STATE = new MutableLiveData<>(SendState.idle());
    private static volatile Amm.Swap swap;

    private SwapMonitor() {}

    public static LiveData<SendState> state() {
        return STATE;
    }

    public static SendState current() {
        SendState s = STATE.getValue();
        return s == null ? SendState.idle() : s;
    }

    public static void post(SendState s) {
        STATE.postValue(s);
    }

    /** The swap being sent: its amounts are what the Done step shows. */
    public static void started(Amm.Swap s) {
        swap = s;
    }

    public static Amm.Swap swap() {
        return swap;
    }

    public static void reset() {
        swap = null;
        STATE.postValue(SendState.idle());
    }
}
