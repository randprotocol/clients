package org.randprotocol.wallet.wallet;

/** Where a send is, for the Proving and Sent screens. Immutable; posted through {@link SendMonitor}. */
public final class SendState {
    public enum Phase { IDLE, PREPARING, PROVING, SUBMITTING, WAITING_COMMIT, DONE, FAILED }

    public final Phase phase;
    public final String message;
    public final String hash;
    public final String txKey;
    public final String amount;
    public final String to;
    public final long startedAtMs;

    public SendState(Phase phase, String message, String hash, String txKey, String amount, String to, long startedAtMs) {
        this.phase = phase;
        this.message = message;
        this.hash = hash;
        this.txKey = txKey;
        this.amount = amount;
        this.to = to;
        this.startedAtMs = startedAtMs;
    }

    public static SendState idle() {
        return new SendState(Phase.IDLE, "", null, null, null, null, 0);
    }

    public SendState with(Phase p, String msg) {
        return new SendState(p, msg, hash, txKey, amount, to, startedAtMs);
    }

    public SendState submitted(String h, String key) {
        return new SendState(Phase.WAITING_COMMIT, "Submitted; waiting for the commit", h, key, amount, to, startedAtMs);
    }

    public boolean busy() {
        return phase == Phase.PREPARING || phase == Phase.PROVING || phase == Phase.SUBMITTING || phase == Phase.WAITING_COMMIT;
    }
}
