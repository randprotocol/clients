package org.randprotocol.wallet.wallet;

import org.json.JSONObject;
import org.randprotocol.wallet.R;
import org.randprotocol.wallet.util.L10n;

/**
 * One remote proof — the Java twin of {@code ui/engine/prover.js}'s {@code remoteProve}: submit
 * the sealed job, poll until the prover answers, and hand the reply to the core's
 * {@code finish_proof}, which opens it, checks the digest and the size, and verifies the proof. A
 * reply that fails any of that never reaches the node. Transport failures are retried until
 * {@code maxWaitMs} (the prover may be restarting); a JSON-RPC error stops.
 *
 * <p>No resume on mobile: the job — and the pending transaction, ~2.8 MB of hex on a
 * split-authorisation chain, since the auth proof is already inside it — lives in this call, in
 * memory, on the {@link ProvingService}'s thread. Nothing writes it to preferences or a file. A
 * process the system kills loses it, and nothing is sent.
 */
public final class RemoteProver {
    public interface Finisher {
        JSONObject finish(Object pending, String replyHex) throws Exception;
    }

    /** {@code position} is the queue position while waiting, null while handed over or proving. */
    public interface PhaseListener {
        void phase(Integer position);

        /**
         * On a split-authorisation chain, before the job is sealed: this device is making the auth
         * proof from the spend key (seconds natively) — {@code ui/screens/send/state.js}'s
         * {@code AUTHORISING_LABEL} step. Announced once, before {@code prepare_*}.
         */
        default void authorising() {
        }
    }

    public interface Clock {
        long nowMs();
    }

    public interface Sleeper {
        void sleep(long ms) throws InterruptedException;
    }

    public static final long DEFAULT_POLL_MS = 1_000;
    /** How many times a job is offered when the prover could not be reached at all. */
    public static final int SUBMIT_TRIES = 3;
    /** The waits between those tries. */
    static final long[] SUBMIT_BACKOFF_MS = {1_000, 3_000};
    public static final long DEFAULT_MAX_WAIT_MS = 20 * 60 * 1000L;

    private final ProverClient client;
    public long pollMs = DEFAULT_POLL_MS;
    public long maxWaitMs = DEFAULT_MAX_WAIT_MS;
    public Clock clock = System::currentTimeMillis;
    public Sleeper sleeper = Thread::sleep;

    public RemoteProver(ProverClient client) {
        this.client = client;
    }

    /** The paired prover this carries jobs to; {@link RemoteSend} asks it {@code prover_info} before sealing one. */
    public ProverClient client() {
        return client;
    }

    public JSONObject prove(String sealedHex, Object pending, Finisher finisher, PhaseListener onPhase) throws Exception {
        onPhase.phase(null);
        return poll(submit(sealedHex), pending, finisher, onPhase);
    }

    /**
     * Hands the sealed job over and returns the job id the prover named. Throws {@link
     * ProverClient.Refusal} when it took nothing — its answer (busy included, {@code busy} set) or
     * no answer at all after the transport retries — so a pool can ask its next member.
     */
    public String submit(String sealedHex) throws Exception {
        String job = null;
        for (int attempt = 1; job == null; attempt++) {
            try {
                job = client.submit(sealedHex);
            } catch (ProverClient.ProverError e) {
                // No JSON-RPC reply at all — the connection failed, or an HTTP error page came back
                // — means the prover accepted nothing: the same sealed job is offered again, a
                // bounded number of times. A JSON-RPC error (busy included) is final; a timeout
                // (the prover may have taken it) and a reply naming no job id are never resubmitted.
                boolean transport = "connect".equals(e.failure) || "http".equals(e.failure);
                if (transport && attempt < SUBMIT_TRIES) {
                    sleeper.sleep(SUBMIT_BACKOFF_MS[Math.min(attempt - 1, SUBMIT_BACKOFF_MS.length - 1)]);
                    continue;
                }
                ProverClient.Refusal r = ProverClient.refusal(e);
                throw r != null ? r : new ProverClient.Refusal(L10n.t(R.string.prover_handover_failed, "Could not hand the proof to your prover: %1$s", e.getMessage()));
            }
        }
        return job;
    }

    /** Polls {@code job} on THIS prover until it answers, then opens the reply through the core. */
    public JSONObject poll(String job, Object pending, Finisher finisher, PhaseListener onPhase) throws Exception {
        long started = clock.nowMs();
        long minutes = Math.round(maxWaitMs / 60000.0);
        // What was last reported: null = "proving" (announced before the submit), else a position.
        Integer last = null;
        while (true) {
            if (Thread.currentThread().isInterrupted()) {
                cancel(job);
                throw new InterruptedException();
            }
            JSONObject st;
            try {
                st = client.status(job);
            } catch (ProverClient.ProverError e) {
                ProverClient.Refusal r = ProverClient.refusal(e);
                if (r != null) throw r;
                if (clock.nowMs() - started >= maxWaitMs) {
                    cancel(job);
                    throw new ProverClient.Refusal(L10n.plural(R.plurals.prover_silent_minutes, (int) minutes,
                            "Your prover has not answered for %1$d minute, so nothing was sent. Send again.",
                            "Your prover has not answered for %1$d minutes, so nothing was sent. Send again.", minutes));
                }
                pause(job);
                continue;
            }
            String state = st.optString("state", "");
            switch (state) {
                case "queued": {
                    int p = st.optInt("position", 1);
                    Integer pos = p > 0 ? p : 1;
                    if (!pos.equals(last)) {
                        last = pos;
                        onPhase.phase(pos);
                    }
                    break;
                }
                case "proving":
                    if (last != null) {
                        last = null;
                        onPhase.phase(null);
                    }
                    break;
                case "done": {
                    String reply = st.optString("reply", "");
                    if (reply.isEmpty() || st.isNull("reply")) throw new ProverClient.Refusal(L10n.t(R.string.prover_no_proof, "The prover finished but sent no proof."));
                    try {
                        return finisher.finish(pending, reply);
                    } catch (Exception e) {
                        throw new ProverClient.Refusal(L10n.t(R.string.prover_proof_refused, "The prover's proof was refused by this wallet: %1$s", e.getLocalizedMessage()));
                    }
                }
                case "failed":
                case "expired": {
                    String err = st.optString("error", "");
                    String why = err.isEmpty() || st.isNull("error") ? "" : ": " + err;
                    throw new ProverClient.Refusal(L10n.t(R.string.prover_could_not_prove, "The prover could not make this proof (%1$s).", state + why));
                }
                default:
                    throw new ProverClient.Refusal(L10n.t(R.string.prover_unknown_state, "The prover answered with an unknown state (%1$s).",
                            state.substring(0, Math.min(32, state.length()))));
            }
            if (clock.nowMs() - started >= maxWaitMs) {
                cancel(job);
                throw new ProverClient.Refusal(L10n.plural(R.plurals.prover_unfinished_minutes, (int) minutes,
                        "Your prover has not finished after %1$d minute, so nothing was sent. Send again.",
                        "Your prover has not finished after %1$d minutes, so nothing was sent. Send again.", minutes));

            }
            pause(job);
        }
    }

    private void pause(String job) throws InterruptedException {
        try {
            sleeper.sleep(pollMs);
        } catch (InterruptedException e) {
            cancel(job);
            throw e;
        }
    }

    /** Best effort: the job expires on the prover anyway. */
    private void cancel(String job) {
        try {
            client.cancel(job);
        } catch (Exception ignored) {
        }
    }
}
