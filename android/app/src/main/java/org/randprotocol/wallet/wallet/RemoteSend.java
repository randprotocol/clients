package org.randprotocol.wallet.wallet;

import org.json.JSONObject;

/**
 * The remote path of a send, between the request {@code prove_transfer} would have taken and the
 * ProveResult it would have returned: the core seals the witness to the paired prover's key
 * ({@code prepare_transfer}, the token inside), {@link RemoteProver} carries the job there and
 * back, and the core opens, checks and verifies the reply ({@code finish_proof}). The spend key
 * leaves this process only inside the sealed job; the result is used exactly where a local
 * proof's would be.
 */
public final class RemoteSend {
    private RemoteSend() {}

    /** Where a remote send's proof is made, from {@link WalletService#proveRoute}. */
    public static final class Route {
        public final ProverPairing pairing;
        final String token;

        public Route(ProverPairing pairing, String token) {
            this.pairing = pairing;
            this.token = token;
        }
    }

    /**
     * Where a send's proof is made. Null = this device: it can prove, or no prover is paired as
     * the user's own (Phase 1 sends a spend-key job nowhere else). A paired own prover that does
     * not answer, answers with another key, or takes no spend-key job — or whose token is gone —
     * refuses the send here, before anything is built: nothing is sent.
     */
    public static Route route(boolean deviceCanProve, ProverPairing p,
                              java.util.function.Function<ProverPairing, ProverPairing.Probe> probe,
                              java.util.function.Supplier<String> token) throws ProverClient.Refusal {
        if (deviceCanProve) return null;
        if (p == null || !p.own) return null;
        String reason = "This device does not have the memory for this proof.";
        ProverPairing.Probe answer = probe.apply(p);
        if (!answer.ok()) throw new ProverClient.Refusal(reason + " Your paired prover is not available: " + answer.reason + ".");
        if (!answer.info.witnessKinds.contains("spend_key")) {
            throw new ProverClient.Refusal(reason + " Your paired prover is not available: it does not take a spend-key job.");
        }
        String t = token.get();
        if (t == null || t.isEmpty()) {
            throw new ProverClient.Refusal("Your prover's pairing could not be opened. Pair the prover again in Settings.");
        }
        return new Route(p, t);
    }

    /**
     * The chain's proof parameters on a {@code prove_transfer} request, for either route:
     * {@code profile} from {@code rand_status.fri_profile} and {@code hc_bundle} when the node
     * reports a valid one (else left out: this build's default guest).
     */
    public static void applyProofParams(JSONObject request, JSONObject status) throws org.json.JSONException {
        request.put("profile", profileOf(status));
        String hc = hcBundleOf(status);
        if (hc != null) request.put("hc_bundle", hc);
        else request.remove("hc_bundle");
    }

    /**
     * {@code request} is the {@code prove_transfer} request (spend key inside — never logged),
     * its {@code profile} and {@code hc_bundle} already the chain's ({@link #applyProofParams});
     * {@code maxProofBytes} ({@code rand_getLimits}) may be null: the core's default.
     */
    public static JSONObject prove(ProverCore core, RemoteProver prover, JSONObject request, Route route,
                                   Integer maxProofBytes, RemoteProver.PhaseListener onPhase) throws Exception {
        JSONObject params = new JSONObject(request.toString());
        String hcBundle = request.has("hc_bundle") ? request.optString("hc_bundle", null) : null;
        JSONObject target = new JSONObject()
                .put("kem_ek", route.pairing.kemEk)
                .put("token", route.token)
                .put("witness_kind", "spend_key");
        if (hcBundle != null) target.put("hc_bundle", hcBundle);
        params.put("prover", target);
        if (maxProofBytes != null) params.put("max_proof_bytes", maxProofBytes);
        JSONObject prepared = core.prepareTransfer(params);
        params = null; // the spend key and the token were in it
        String sealed = prepared.optString("sealed_hex", "");
        Object pending = prepared.opt("pending");
        if (sealed.isEmpty() || pending == null) throw new ProverClient.Refusal("The wallet could not seal this transfer for the prover.");
        return prover.prove(sealed, pending, core::finishProof, onPhase);
    }

    /** {@code rand_status.hc_bundle} when it is 64 hex, else null (this build's default guest). */
    public static String hcBundleOf(JSONObject status) {
        String hc = status == null ? "" : status.optString("hc_bundle", "").trim().toLowerCase(java.util.Locale.ROOT);
        return hc.matches("[0-9a-f]{64}") ? hc : null;
    }

    /** {@code rand_status.fri_profile}: {@code "test"} only when the node says so. */
    public static String profileOf(JSONObject status) {
        return status != null && "test".equals(status.optString("fri_profile")) ? "test" : "production";
    }
}
