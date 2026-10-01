package org.randprotocol.wallet.wallet;

import org.json.JSONException;
import org.json.JSONObject;
import org.randprotocol.wallet.rpc.RpcException;

import java.util.List;
import java.util.Locale;

/**
 * The remote path of a send, between the request {@code prove_transfer} would have taken and the
 * ProveResult it would have returned: the core seals the witness to the paired prover's key
 * ({@code prepare_transfer}, the token inside), {@link RemoteProver} carries the job there and
 * back, and the core opens, checks and verifies the reply ({@code finish_proof}). The result is
 * used exactly where a local proof's would be.
 *
 * <p>On a split-authorisation chain (bundle guest v3 beside an auth guest: every chain since 17)
 * the job carries the wallet's VIEWING KEY and a salt, never the spend key: the prover can prove
 * the bundle and read this wallet's history, and cannot spend. The spend authorisation — the auth
 * proof — is made on this device, inside {@code prepare_transfer}, from the spend key. So any
 * paired prover may have such a job, own or not. On an older chain the job carries the spend key
 * and goes only to a prover paired as the user's own. Which it is follows the chain's guests and
 * is the core's decision ({@code chain_guests}), never this shell's.
 */
public final class RemoteSend {
    private RemoteSend() {}

    /**
     * Where a remote send's proof is made, from {@link WalletService#proveRoute}: {@code pairing}'s
     * url, key, fingerprint and {@code own} are the vault record's, only its name the display
     * copy's.
     */
    public static final class Route {
        public final ProverPairing pairing;
        final String token;
        /** The RandProtocol provers as the default (nothing paired): the one-time notice applies. */
        public final boolean isDefault;
        /**
         * The default's members in the order a job tries them — the first is the one that answered
         * the route — each its own key and token ({@link #provePool}). Empty for a paired prover.
         */
        public final List<ProverPairing.Paired> members;
        /** The pool's name ("RandProtocol"), for the screen and the refusals. */
        public final String poolName;

        public Route(ProverPairing pairing, String token) {
            this(pairing, token, false, java.util.Collections.emptyList(), null);
        }

        public Route(ProverPairing pairing, String token, boolean isDefault, List<ProverPairing.Paired> members, String poolName) {
            this.pairing = pairing;
            this.token = token;
            this.isDefault = isDefault;
            this.members = java.util.Collections.unmodifiableList(new java.util.ArrayList<>(members));
            this.poolName = poolName;
        }
    }

    /**
     * The default's members ({@link ProverPairing#builtInPool}) in the order to try them — a fresh
     * random order per send in the app ({@link WalletService#defaultProver}), a fixed one in tests.
     */
    public interface DefaultProver {
        List<ProverPairing.Paired> get() throws Exception;
    }

    /** A member's short name: "a" of "RandProtocol (a)". */
    static String memberOf(ProverPairing p) {
        int i = p.name.lastIndexOf('(');
        return i >= 0 && p.name.endsWith(")") ? p.name.substring(i + 1, p.name.length() - 1) : p.name;
    }

    /** Why one member cannot take a job now, or null: another key, a fee, no viewing-key jobs, a full queue. */
    static String notReady(ProverCore core, ProverPairing m, ProverPairing.Probe answer) {
        String who = memberOf(m);
        if (!answer.ok()) {
            return answer.reason.contains("different key") ? who + " answered with another key than the one this wallet pins" : who + " did not answer";
        }
        String fee = ProverClient.feeRefusal(answer.info.fee, core);
        if (fee != null) return who + ": " + fee;
        if (!answer.info.witnessKinds.contains("viewing_key")) return who + " does not take this wallet's jobs";
        if (answer.info.max > 0 && answer.info.depth >= answer.info.max) return BUSY_MARK + who + " is busy";
        return null;
    }

    private static final String BUSY_MARK = "\u0000busy:";

    /** Every member busy, or none reachable: plainly, with the way out. */
    static ProverClient.Refusal poolUnavailable(String lead, String pool, List<String> whys) {
        boolean allBusy = !whys.isEmpty();
        StringBuilder reasons = new StringBuilder();
        for (String w : whys) {
            if (!w.startsWith(BUSY_MARK)) allBusy = false;
            if (reasons.length() > 0) reasons.append("; ");
            reasons.append(w.startsWith(BUSY_MARK) ? w.substring(BUSY_MARK.length()) : w);
        }
        if (allBusy) {
            return new ProverClient.Refusal(lead + "The " + pool + " provers are all busy right now; try again in a minute, or pair your own prover in Settings.", true);
        }
        return new ProverClient.Refusal(lead + "The " + pool + " provers cannot be reached right now (" + reasons
                + "). Try again later, or pair your own prover in Settings.");
    }

    /**
     * Where a send's proof is made. Null = this device: it can prove, or no prover is paired. A
     * paired prover — the user's own or not — whose vault record is gone, that does not answer,
     * answers with another key, quotes a fee, or takes no job this wallet can send (a viewing-key
     * job; for a prover paired as own, a spend-key one too) refuses the send here, before anything
     * is built: nothing is sent. Which of the two kinds a given send needs is the chain's, settled
     * by the core when the job is made ({@link #prove}); this only rules out a prover that could
     * take neither. The probe and the route use the vault record's URL, key and {@code own}
     * ({@code secret}), never {@code display}'s — that is the plaintext copy in
     * {@link org.randprotocol.wallet.security.Prefs}.
     */
    public static Route route(boolean deviceCanProve, ProverPairing display, ProverCore core,
                              java.util.function.Function<ProverPairing, ProverPairing.Probe> probe,
                              java.util.function.Supplier<ProverSecret> secret) throws ProverClient.Refusal {
        return route(deviceCanProve, display, core, probe, secret, null);
    }

    /**
     * {@link #route} with the default (wallet 0.6.8): with nothing paired, {@code defaultProver}
     * — null when the user chose no prover or the build ships none — is the RandProtocol prover,
     * asked for its key (it must be the pinned one), its fee (none) and viewing-key jobs. When it
     * is not there the refusal says so plainly and points to Settings; nothing is built.
     */
    public static Route route(boolean deviceCanProve, ProverPairing display, ProverCore core,
                              java.util.function.Function<ProverPairing, ProverPairing.Probe> probe,
                              java.util.function.Supplier<ProverSecret> secret, DefaultProver defaultProver) throws ProverClient.Refusal {
        if (deviceCanProve) return null;
        if (display == null && defaultProver != null) return defaultRoute(core, probe, defaultProver);
        if (display == null) return null;
        ProverSecret s = secret.get();
        if (s == null || s.token == null || s.token.isEmpty()) {
            throw new ProverClient.Refusal("Your prover's pairing could not be opened. Pair the prover again in Settings.");
        }
        ProverPairing p = new ProverPairing(display.name, s.url, s.kemEk, s.fingerprint, s.own);
        String reason = "This device does not have the memory for this proof.";
        ProverPairing.Probe answer = probe.apply(p);
        if (!answer.ok()) throw new ProverClient.Refusal(reason + " Your paired prover is not available: " + answer.reason + ".");
        String fee = ProverClient.feeRefusal(answer.info.fee, core);
        if (fee != null) throw new ProverClient.Refusal(reason + " Your paired prover is not available: " + fee + ".");
        List<String> kinds = answer.info.witnessKinds;
        if (!(kinds.contains("viewing_key") || (s.own && kinds.contains("spend_key")))) {
            throw new ProverClient.Refusal(reason + " Your paired prover is not available: it does not take this wallet's jobs.");
        }
        return new Route(p, s.token);
    }

    /**
     * The default: the members in {@code defaultProver}'s order, each asked {@code prover_info} —
     * ITS pinned key, no fee, viewing-key jobs, room in its queue; the first that can leads the
     * route, the rest follow for {@link #provePool} to fall through on a busy submit. None can:
     * "all busy" or "cannot be reached", plainly, pointing to Settings.
     */
    private static Route defaultRoute(ProverCore core, java.util.function.Function<ProverPairing, ProverPairing.Probe> probe,
                                      DefaultProver defaultProver) throws ProverClient.Refusal {
        String lead = "This device does not have the memory for this proof. ";
        List<ProverPairing.Paired> members;
        try {
            members = defaultProver.get();
        } catch (Exception e) {
            throw new ProverClient.Refusal(lead + (e.getMessage() == null ? "The built-in provers cannot be used." : e.getMessage()));
        }
        String pool = poolNameOf(members);
        List<String> whys = new java.util.ArrayList<>();
        for (int i = 0; i < members.size(); i++) {
            ProverPairing.Paired m = members.get(i);
            String why = notReady(core, m.pairing, probe.apply(m.pairing));
            if (why == null) {
                List<ProverPairing.Paired> ordered = new java.util.ArrayList<>();
                ordered.add(m);
                for (int j = 0; j < members.size(); j++) if (j != i) ordered.add(members.get(j));
                return new Route(m.pairing, m.token, true, ordered, pool);
            }
            whys.add(why);
        }
        throw poolUnavailable(lead, pool, whys);
    }

    static String poolNameOf(List<ProverPairing.Paired> members) {
        if (members.isEmpty()) return "RandProtocol";
        String n = members.get(0).pairing.name;
        int i = n.lastIndexOf(" (");
        return i > 0 ? n.substring(0, i) : n;
    }

    /**
     * A send through the RandProtocol provers: the members in the route's order — for each,
     * {@code prover_info} again ({@link #notReady}), the job sealed by the core to THAT member's key,
     * and submitted to it (the transport retry per member); a member busy (-32005), refusing, or
     * unreachable at submit is skipped for the next, re-sealed for it. Once a member has named a job
     * it is polled to the end — never another member mid-job. Every member out: plainly, never a loop.
     */
    public static JSONObject provePool(ProverCore core, java.util.function.Function<String, RemoteProver> proverFor, JSONObject request,
                                       Route route, Integer maxProofBytes, RemoteProver.PhaseListener onPhase) throws Exception {
        return provePool(core, proverFor, KIND_TRANSFER, request, route, maxProofBytes, onPhase);
    }

    /** What a job is sealed as: {@code prepare_transfer}'s request, or {@code prepare_invoke}'s. */
    public static final String KIND_TRANSFER = "transfer";
    public static final String KIND_INVOKE = "invoke";

    /**
     * {@link #provePool} for a job of {@code kind}: {@link #KIND_TRANSFER}, or {@link #KIND_INVOKE}
     * — an RPL-2 invoke, whose call proof and auth proof the core makes here inside {@code
     * prepare_invoke} before only the bundle's witness is sealed. The member order, the skip on a
     * busy submit and the never-move-mid-job rule are the same for both.
     */
    public static JSONObject provePool(ProverCore core, java.util.function.Function<String, RemoteProver> proverFor, String kind,
                                       JSONObject request, Route route, Integer maxProofBytes, RemoteProver.PhaseListener onPhase) throws Exception {
        JSONObject guests = guestsOf(core, request);
        if (!"viewing_key".equals(guests.optString("witness_kind", ""))) {
            throw new ProverClient.Refusal("On this chain a proof needs the spend key, which goes only to a prover paired as your own. "
                    + "Pair your own prover in Settings, or send from the rand command-line wallet.");
        }
        List<String> whys = new java.util.ArrayList<>();
        for (ProverPairing.Paired m : route.members) {
            RemoteProver prover = proverFor.apply(m.pairing.url);
            ProverPairing.Probe answer;
            try {
                answer = new ProverPairing.Probe(prover.client().info(), null);
            } catch (ProverClient.ProverError e) {
                answer = new ProverPairing.Probe(null, "did not answer");
            }
            if (answer.ok() && !ProverPairing.sameKey(core, answer.info, m.pairing.kemEk, m.pairing.fingerprint)) {
                answer = new ProverPairing.Probe(null, "different key");
            }
            String why = notReady(core, m.pairing, answer);
            if (why != null) {
                whys.add(why);
                continue;
            }
            Sealed s = seal(core, kind, request, m.pairing, m.token, answer.info.fee, maxProofBytes, guests, onPhase);
            onPhase.phase(null);
            String job;
            try {
                job = prover.submit(s.hex);
            } catch (ProverClient.Refusal r) {
                whys.add((r.busy ? BUSY_MARK : "") + memberOf(m.pairing) + ": " + r.getMessage());
                continue;
            }
            return prover.poll(job, s.pending, core::finishProof, onPhase);
        }
        throw poolUnavailable("", route.poolName == null ? "RandProtocol" : route.poolName, whys);
    }

    private static final class Sealed {
        final String hex;
        final Object pending;

        Sealed(String hex, Object pending) {
            this.hex = hex;
            this.pending = pending;
        }
    }

    private static JSONObject guestsOf(ProverCore core, JSONObject request) throws Exception {
        String hcBundle = request.has("hc_bundle") && !request.isNull("hc_bundle") ? request.optString("hc_bundle", null) : null;
        String hcAuth = request.has("hc_auth") && !request.isNull("hc_auth") ? request.optString("hc_auth", null) : null;
        try {
            return core.chainGuests(new JSONObject()
                    .put("hc_bundle", hcBundle == null ? JSONObject.NULL : hcBundle)
                    .put("hc_auth", hcAuth == null ? JSONObject.NULL : hcAuth));
        } catch (Exception e) {
            String why = e.getMessage() == null || e.getMessage().isEmpty() ? "This wallet cannot prove for this chain." : e.getMessage();
            throw new ProverClient.Refusal(why);
        }
    }

    /** The job, sealed by the core to {@code pairing}'s key with {@code token} — the auth proof made here first. */
    private static Sealed seal(ProverCore core, String kind, JSONObject request, ProverPairing pairing, String token, Object fee,
                               Integer maxProofBytes, JSONObject guests, RemoteProver.PhaseListener onPhase) throws Exception {
        boolean invoke = KIND_INVOKE.equals(kind);
        String hcBundle = request.has("hc_bundle") && !request.isNull("hc_bundle") ? request.optString("hc_bundle", null) : null;
        JSONObject params = new JSONObject(request.toString());
        JSONObject target = new JSONObject()
                .put("kem_ek", pairing.kemEk)
                .put("token", token)
                .put("own", pairing.own)
                .put("fee", fee);
        if (hcBundle != null) target.put("hc_bundle", hcBundle);
        params.put("prover", target);
        if (maxProofBytes != null) params.put("max_proof_bytes", maxProofBytes);
        // On a split-authorisation chain the core makes the auth proof inside prepare_transfer,
        // from the spend key, on this device: seconds natively. Said before the wait, so it is not
        // a silent one and says what is happening where. An invoke's call proof is made here too.
        if (guests.optBoolean("split_authorisation", false)) onPhase.authorising();
        JSONObject prepared = invoke ? core.prepareInvoke(params) : core.prepareTransfer(params);
        params = null; // the spend key and the token were in it
        String sealed = prepared.optString("sealed_hex", "");
        Object pending = prepared.opt("pending");
        if (sealed.isEmpty() || pending == null) {
            throw new ProverClient.Refusal("The wallet could not seal this " + (invoke ? "swap" : "transfer") + " for the prover.");
        }
        return new Sealed(sealed, pending);
    }

    /**
     * The chain's proof parameters on a {@code prove_transfer} / {@code prepare_transfer} request,
     * for either route ({@code ui/engine/wallet.js}'s {@code proofParamsOf} and {@code
     * guestFields}): {@code profile} from {@code rand_status.fri_profile}; the two guests from
     * {@code rand_status.hc_bundle} and {@code .hc_auth}. Neither guest field when the node names
     * no bundle guest and no auth guest (the core then proves for the chain its defaults describe);
     * otherwise {@code hc_bundle} when named and {@code hc_auth} ALWAYS, as JSON null when the node
     * names none — "this chain names no auth guest" is what the core must hear to refuse a v3
     * bundle guest it could not authorise a spend for. A guest that is there but is not 64 hex
     * is a node this wallet cannot read, refused up front — never silently replaced by the default
     * guest, which on a chain that moved guests is a proof its validators refuse.
     */
    public static void applyProofParams(JSONObject request, JSONObject status) throws JSONException, RpcException {
        request.put("profile", profileOf(status));
        String hc = hcBundleOf(status);
        String auth = hcAuthOf(status);
        if (hc == null && auth == null) {
            request.remove("hc_bundle");
            request.remove("hc_auth");
            return;
        }
        if (hc != null) request.put("hc_bundle", hc);
        else request.remove("hc_bundle");
        request.put("hc_auth", auth == null ? JSONObject.NULL : auth);
    }

    /**
     * {@code request} is the {@code prove_transfer} request (spend key inside — never logged),
     * its {@code profile}, {@code hc_bundle} and {@code hc_auth} already the chain's
     * ({@link #applyProofParams}); {@code maxProofBytes} ({@code rand_getLimits}) may be null: the
     * core's default. In order, all before anything is built: the core says which witness this
     * chain's guest takes ({@code chain_guests}) and refuses a chain it cannot prove for; a
     * spend-key witness is refused for a pairing not marked own; the prover as it is NOW —
     * {@code prover_info} read again: still the key this wallet paired, taking this kind of job,
     * charging nothing (its fee is its own to change at any time, so it is read here, at the one
     * point a job is made, and handed to the core, which refuses any). {@code witness_kind} is
     * never sent: the core decides it, and a request naming {@code "spend_key"} on a
     * split-authorisation chain is refused by it.
     */
    public static JSONObject prove(ProverCore core, RemoteProver prover, JSONObject request, Route route,
                                   Integer maxProofBytes, RemoteProver.PhaseListener onPhase) throws Exception {
        return prove(core, prover, KIND_TRANSFER, request, route, maxProofBytes, onPhase);
    }

    /** {@link #prove} for a job of {@code kind} ({@link #KIND_TRANSFER} or {@link #KIND_INVOKE}). */
    public static JSONObject prove(ProverCore core, RemoteProver prover, String kind, JSONObject request, Route route,
                                   Integer maxProofBytes, RemoteProver.PhaseListener onPhase) throws Exception {
        JSONObject guests = guestsOf(core, request);
        String wants = guests.optString("witness_kind", "");
        if ("spend_key".equals(wants) && !route.pairing.own) {
            throw new ProverClient.Refusal("On this chain a proof needs the spend key, which goes only to a prover paired as your own. "
                    + "Pair your own prover in Settings, or send from the rand command-line wallet.");
        }

        ProverClient.Info info;
        try {
            info = prover.client().info();
        } catch (ProverClient.ProverError e) {
            throw new ProverClient.Refusal("Your prover did not answer: " + e.getMessage());
        }
        if (!ProverPairing.sameKey(core, info, route.pairing.kemEk, route.pairing.fingerprint)) {
            throw new ProverClient.Refusal("The prover at that address now has a different key. Pair it again in Settings.");
        }
        if (!info.witnessKinds.contains(wants)) {
            throw new ProverClient.Refusal("viewing_key".equals(wants)
                    ? "Your prover does not take viewing-key jobs (it is older than this chain). Update it, or pair another."
                    : "Your prover does not take spend-key jobs. Pair your own prover in Settings, or send from the rand command-line wallet.");
        }
        if (ProverClient.feeRefusal(info.fee, core) != null) {
            throw new ProverClient.Refusal(ProverClient.FEE_REFUSAL);
        }

        Sealed s = seal(core, kind, request, route.pairing, route.token, info.fee, maxProofBytes, guests, onPhase);
        return prover.prove(s.hex, s.pending, core::finishProof, onPhase);
    }

    /** {@code rand_status.hc_bundle}: null when absent or null (this build's default guest), else its 64 hex; refused otherwise. */
    public static String hcBundleOf(JSONObject status) throws RpcException {
        return guestOf(status, "hc_bundle");
    }

    /** {@code rand_status.hc_auth}: null when absent or null (a chain without split authorisation), else its 64 hex; refused otherwise. */
    public static String hcAuthOf(JSONObject status) throws RpcException {
        return guestOf(status, "hc_auth");
    }

    private static String guestOf(JSONObject status, String field) throws RpcException {
        if (status == null || !status.has(field) || status.isNull(field)) return null;
        Object v = status.opt(field);
        String hc = v instanceof String ? ((String) v).trim().toLowerCase(Locale.ROOT) : "";
        if (hc.matches("[0-9a-f]{64}")) return hc;
        throw new RpcException(0, "rand_status: " + field + " is not 64 hex characters");
    }

    /** {@code rand_status.fri_profile}: {@code "test"} only when the node says so. */
    public static String profileOf(JSONObject status) {
        return status != null && "test".equals(status.optString("fri_profile")) ? "test" : "production";
    }
}
