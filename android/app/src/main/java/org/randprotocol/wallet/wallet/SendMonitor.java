package org.randprotocol.wallet.wallet;

import androidx.lifecycle.LiveData;
import androidx.lifecycle.MutableLiveData;

/** The one send in flight, observable from any screen (the proving service posts here). */
public final class SendMonitor {
    private static final MutableLiveData<SendState> STATE = new MutableLiveData<>(SendState.idle());

    private SendMonitor() {}

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

    public static void reset() {
        STATE.postValue(SendState.idle());
    }
}
