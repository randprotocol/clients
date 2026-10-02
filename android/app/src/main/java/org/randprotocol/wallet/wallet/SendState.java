package org.randprotocol.wallet.wallet;

import org.randprotocol.wallet.R;
import org.randprotocol.wallet.util.L10n;

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
    /** The paired prover making this proof (its name), or null when this device proves. */
    public final String prover;
    /** The job's position in the prover's queue while it waits, else null. */
    public final Integer queuePosition;
    /** On a failed swap, the engine's refusal code ({@link Invoke#STALE_READ}, …), else null. */
    public final String code;

    public SendState(Phase phase, String message, String hash, String txKey, String amount, String to, long startedAtMs) {
        this(phase, message, hash, txKey, amount, to, startedAtMs, null, null);
    }

    private SendState(Phase phase, String message, String hash, String txKey, String amount, String to, long startedAtMs,
                      String prover, Integer queuePosition) {
        this(phase, message, hash, txKey, amount, to, startedAtMs, prover, queuePosition, null);
    }

    private SendState(Phase phase, String message, String hash, String txKey, String amount, String to, long startedAtMs,
                      String prover, Integer queuePosition, String code) {
        this.phase = phase;
        this.message = message;
        this.hash = hash;
        this.txKey = txKey;
        this.amount = amount;
        this.to = to;
        this.startedAtMs = startedAtMs;
        this.prover = prover;
        this.queuePosition = queuePosition;
        this.code = code;
    }

    /**
     * On a split-authorisation chain, before a job goes to the paired prover: this device is
     * making the auth proof from the spend key ({@code ui/screens/send/state.js}'s
     * {@code AUTHORISING_LABEL}).
     */
    public static final String AUTHORISING_LABEL = "Authorising the spend on this device…";

    /**
     * Proving on a paired prover: "Waiting at position N on NAME" while the job waits in its
     * queue, "Proving on NAME…" while it is handed over or proved — the shared UI's words.
     */
    public SendState remote(String name, Integer position) {
        String msg = position != null
                ? L10n.t(R.string.phase_waiting_position, "Waiting at position %1$d on %2$s", position, name)
                : L10n.t(R.string.phase_proving_on, "Proving on %1$s…", name);
        return new SendState(Phase.PROVING, msg, hash, txKey, amount, to, startedAtMs, name, position);
    }

    /** The step before {@link #remote}: the spend authorised here, the bundle proof still to come from NAME. */
    public SendState authorising(String name) {
        return new SendState(Phase.PROVING, L10n.t(R.string.phase_authorising, AUTHORISING_LABEL), hash, txKey, amount, to, startedAtMs, name, null);
    }

    public static SendState idle() {
        return new SendState(Phase.IDLE, "", null, null, null, null, 0);
    }

    public SendState with(Phase p, String msg) {
        return new SendState(p, msg, hash, txKey, amount, to, startedAtMs);
    }

    /** Failed with the engine's {@code code} (null for none): the screen branches on it. */
    public SendState failed(String code, String msg) {
        return new SendState(Phase.FAILED, msg, hash, txKey, amount, to, startedAtMs, null, null, code);
    }

    public SendState submitted(String h, String key) {
        return new SendState(Phase.WAITING_COMMIT, L10n.t(R.string.phase_waiting_commit, "Submitted; waiting for the commit"), h, key, amount, to, startedAtMs);

    }

    public boolean busy() {
        return phase == Phase.PREPARING || phase == Phase.PROVING || phase == Phase.SUBMITTING || phase == Phase.WAITING_COMMIT;
    }
}
