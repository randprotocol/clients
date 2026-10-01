package org.randprotocol.wallet.wallet;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.randprotocol.wallet.core.Core;
import org.randprotocol.wallet.core.CoreException;
import org.randprotocol.wallet.rpc.RpcClient;
import org.randprotocol.wallet.rpc.RpcException;

import java.math.BigInteger;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * An RPL-2 invoke — the Swap screen's transaction — from the request {@link Amm#buildSwap} makes
 * to the hash the node accepted: {@code ui/engine/wallet.js}'s {@code quoteInvoke}, {@code invoke}
 * and {@code completeInvoke}, in the same order. Everything here is the chain and the core; the
 * note store, the route and the progress are {@link WalletService}'s, handed in, so the order and
 * the refusals are unit tested on the JVM against a scripted node and a stand-in core.
 *
 * <p>Every refusal before a proof is a {@link Refusal} with the engine's string {@code code}, and
 * nothing has left the device when one is thrown.
 */
public final class Invoke {
    private Invoke() {}

    /** The chain does not run programs (no {@code program_state} in {@code rand_getLimits}). */
    public static final String PROGRAMS_UNSUPPORTED = "PROGRAMS_UNSUPPORTED";
    /** No program with that id on this chain. */
    public static final String NO_PROGRAM = "NO_PROGRAM";
    /** A cell the request read is no longer what the chain holds: quote again. */
    public static final String STALE_READ = "STALE_READ";
    /** The program (the emulator, no proof) would not accept the transition. */
    public static final String PROGRAM_REFUSED = "PROGRAM_REFUSED";
    /** The program's vault does not hold what the transition pays out. */
    public static final String VAULT_SHORT = "VAULT_SHORT";
    /** This wallet's notes do not cover the deposit and the network fee. */
    public static final String INSUFFICIENT_FUNDS = "INSUFFICIENT_FUNDS";
    /** No way to make the proof: this device cannot, and no prover can take it. */
    public static final String PROVER_UNAVAILABLE = "PROVER_UNAVAILABLE";
    /** The RandProtocol provers' one-time notice has not been read for this wallet. */
    public static final String PROVER_NOTICE = "PROVER_NOTICE";
    /** The request is not one this wallet can read. */
    public static final String BAD_REQUEST = "BAD_REQUEST";

    /** The vendored {@code gas::MAX_PROOF_BYTES}, for a node that reports a gas section but no {@code max_proof_bytes}. */
    static final int DEFAULT_PROOF_CAP = 2_097_152;
    static final String ZERO_WORD8 = "0".repeat(64);

    static final String NO_PROGRAMS = "This chain does not run programs yet, so Rand Wallet cannot swap here. Nothing was sent.";

    /** A refusal with the engine's code. Nothing was sent. */
    public static final class Refusal extends Exception {
        public final String code;

        public Refusal(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    /** The core methods an invoke uses ({@code wallet_core::dispatch}); a stand-in in the unit tests. */
    public interface InvokeCore {
        JSONObject dryRunInvoke(JSONObject transition) throws Exception;

        JSONObject planInvoke(JSONObject params) throws Exception;

        /** The device's own proofs: the call proof, the auth proof and the bundle proof. */
        JSONObject proveInvoke(JSONObject request) throws Exception;

        InvokeCore NATIVE = new InvokeCore() {
            @Override
            public JSONObject dryRunInvoke(JSONObject transition) throws CoreException {
                return Core.dryRunInvoke(transition);
            }

            @Override
            public JSONObject planInvoke(JSONObject params) throws CoreException {
                return Core.planInvoke(params);
            }

            @Override
            public JSONObject proveInvoke(JSONObject request) throws CoreException {
                return Core.proveInvoke(request);
            }
        };
    }

    /** This wallet's notes, read after a scan of the node the invoke goes to. */
    public interface Notes {
        JSONArray scanned() throws Exception;
    }

    /** The bundle proof somewhere else (the RandProtocol provers, or a paired one); null is this device. */
    public interface Prover {
        JSONObject prove(JSONObject request, Integer maxProofBytes) throws Exception;
    }

    /** Progress: {@code "witness"}, {@code "prove"} (this device only — a prover reports its own), {@code "submit"}. */
    public interface Phases {
        void phase(String step);
    }

    /** Everything {@link #prove} needs from a quote, and what the Review step shows. */
    public static final class Quote {
        public final JSONObject transition;
        public final JSONObject dry;
        /** RAND units, the network fee the bundle carries. */
        public final String fee;
        /** How many cells the writes create (each pays {@code cell_fee}). */
        public final int cells;
        public final RpcClient.ChainLimits limits;
        public final JSONObject plan;

        Quote(JSONObject transition, JSONObject dry, String fee, int cells, RpcClient.ChainLimits limits, JSONObject plan) {
            this.transition = transition;
            this.dry = dry;
            this.fee = fee;
            this.cells = cells;
            this.limits = limits;
            this.plan = plan;
        }
    }

    /**
     * Everything an invoke can be refused for without proving anything, and its price, in this
     * order, the cheapest question first:
     * <ol>
     *   <li>the chain runs programs at all ({@code rand_getLimits.program_state}) — {@link #PROGRAMS_UNSUPPORTED};</li>
     *   <li>the program's code and public input, which {@code dry_run_invoke} hashes to the id — {@link #NO_PROGRAM};</li>
     *   <li>every cell the request read is still what the chain holds — {@link #STALE_READ} (the
     *       chain would refuse the same transaction after the proofs were paid for);</li>
     *   <li>the cells the writes create;</li>
     *   <li>the program accepts the transition ({@code dry_run_invoke}, the emulator) — its tier and gas;</li>
     *   <li>the fee, {@code rand_estimateFee {"kind":"invoke"}} at that tier and gas, the proof's
     *       bytes quoted at the chain's cap (the fee is in the bundle the call proof commits to,
     *       so it is fixed before the proof exists);</li>
     *   <li>the vault covers what the transition pays out — {@link #VAULT_SHORT} — then this
     *       wallet's notes, after a scan, cover the deposit and the fee ({@code plan_invoke}) —
     *       {@link #INSUFFICIENT_FUNDS}.</li>
     * </ol>
     * Every read comes from {@code rpc}, the node the invoke will be submitted to.
     */
    public static Quote quote(RpcClient rpc, InvokeCore core, JSONObject request, Notes notes) throws Exception {
        RpcClient.ChainLimits limits = rpc.limits();
        if (limits.programState == null) throw new Refusal(PROGRAMS_UNSUPPORTED, NO_PROGRAMS);
        String program = word8(request.opt("program"), "program");
        JSONObject code = rpc.programCode(program);
        if (code == null) {
            throw new Refusal(NO_PROGRAM, "There is no program " + program.substring(0, 12) + "… on this chain. Nothing was sent.");
        }
        String publicHex = rpc.programPublic(program);
        if (publicHex == null) publicHex = "";
        JSONArray reads = cellsOf(request, "reads");
        JSONArray writes = cellsOf(request, "writes");
        Map<String, String> seen = new HashMap<>();
        for (int i = 0; i < reads.length(); i++) {
            JSONObject r = reads.getJSONObject(i);
            String now = live(rpc, program, r.getString("key"));
            if (!now.equals(r.getString("value"))) {
                throw new Refusal(STALE_READ, "The pool changed since it was read. Nothing was sent.");
            }
            seen.put(r.getString("key"), r.getString("value"));
        }
        int cells = 0;
        for (int i = 0; i < writes.length(); i++) {
            JSONObject w = writes.getJSONObject(i);
            if (ZERO_WORD8.equals(w.getString("value"))) continue;
            String key = w.getString("key");
            String now = seen.containsKey(key) ? seen.get(key) : live(rpc, program, key);
            if (ZERO_WORD8.equals(now)) cells++;
        }
        JSONObject inflow = request.optJSONObject("inflow");
        if (inflow == null) throw new Refusal(BAD_REQUEST, "The swap has no inflow. Nothing was sent.");
        JSONArray pays = request.optJSONArray("pays") == null ? new JSONArray() : request.getJSONArray("pays");
        JSONObject transition = new JSONObject()
                .put("program", program)
                .put("program_code", code)
                .put("public_hex", publicHex)
                .put("private_inputs", request.optJSONArray("inputs") == null ? new JSONArray() : request.getJSONArray("inputs"))
                .put("reads", reads)
                .put("writes", writes)
                .put("inflow", inflow)
                .put("pays", pays)
                .put("mints", request.optJSONArray("mints") == null ? new JSONArray() : request.getJSONArray("mints"));
        JSONObject dry;
        try {
            dry = core.dryRunInvoke(transition);
        } catch (Exception e) {
            throw new Refusal(PROGRAM_REFUSED, "The program would not accept this swap, so nothing was sent: " + e.getMessage());
        }
        // Under a gas section (bundle_gas_limit set: chain 18 and later) the call is priced by the
        // gas it declares and every byte of its proof; without one, by tier alone.
        JSONObject spec = new JSONObject()
                .put("kind", "invoke")
                .put("tier", dry.get("tier"))
                .put("keccak_log_height", dry.get("keccak_log_height"))
                .put("sha256_log_height", dry.get("sha256_log_height"))
                .put("created_cells", cells);
        if (limits.bundleGasLimit != null) {
            spec.put("gas", dry.get("gas_limit"));
            spec.put("bytes", limits.maxProofBytes != null ? limits.maxProofBytes : DEFAULT_PROOF_CAP);
        }
        String fee = rpc.estimateFee(spec);
        if (pays.length() > 0) {
            JSONArray vault = rpc.programVault(program);
            if (vaultShortfall(inflow, pays, vault == null ? new JSONArray() : vault) != null) {
                throw new Refusal(VAULT_SHORT, "The pool does not hold enough to pay this out. Nothing was sent.");
            }
        }
        JSONArray owned = notes.scanned();
        boolean burnsToken = !"none".equals(inflow.optString("kind", "none"));
        JSONObject plan;
        try {
            plan = core.planInvoke(new JSONObject()
                    .put("notes", owned)
                    .put("burn_r", inflow.optString("rand", "0"))
                    .put("burn_asset", burnsToken ? inflow.optInt("asset", 0) : 0)
                    .put("burn_a", burnsToken ? inflow.optString("amount", "0") : "0")
                    .put("fee", fee));
        } catch (Exception e) {
            throw new Refusal(INSUFFICIENT_FUNDS, "Rand Wallet does not hold enough to cover this and its network fee: " + e.getMessage());
        }
        return new Quote(transition, dry, plan.optString("fee", fee), cells, limits, plan);
    }

    /**
     * The proofs of a quoted invoke. The anchor is taken LAST, after every other read and right
     * before the proofs: the bundle's {@code time} is the anchor's height, and the chain refuses a
     * bundle too far behind its tip when the transaction arrives. Then {@code prove_invoke} on this
     * device, or {@code remote} — the bundle proof at a prover, the call and auth proofs here
     * ({@code prepare_invoke}). Returns the core's InvokeResult. {@code spendKey} rides the request
     * only; never log it.
     */
    public static JSONObject prove(RpcClient rpc, InvokeCore core, Quote q, String spendKey, long chainId,
                                   Prover remote, Phases phases) throws Exception {
        JSONArray inputs = q.plan.optJSONArray("inputs") == null ? new JSONArray() : q.plan.getJSONArray("inputs");
        JSONArray feeInputs = q.plan.optJSONArray("fee_inputs") == null ? new JSONArray() : q.plan.getJSONArray("fee_inputs");
        phases.phase("witness");
        // The chain's two guests and FRI profile, and its genesis (BIND-1), before the anchor.
        JSONObject status = null;
        try {
            status = rpc.status();
        } catch (RpcException e) {
            if (e.code != -32601) throw e;
        }
        String genesis = rpc.genesisHash();
        JSONArray all = new JSONArray();
        for (int i = 0; i < inputs.length(); i++) all.put(inputs.get(i));
        for (int i = 0; i < feeInputs.length(); i++) all.put(feeInputs.get(i));
        JSONObject anchor = null;
        JSONArray paths = null;
        for (int attempt = 1; paths == null; attempt++) {
            anchor = rpc.anchor();
            String root = anchor.getString("root");
            JSONArray got = new JSONArray();
            boolean moved = false;
            for (int i = 0; i < all.length(); i++) {
                long index = all.getJSONObject(i).getLong("index");
                JSONObject w = rpc.witness(index);
                if (w == null) throw new RpcException(0, "no leaf at index " + index);
                if (!root.equals(w.getString("root"))) {
                    moved = true;
                    break;
                }
                got.put(w.getJSONArray("path"));
            }
            if (!moved) paths = got;
            else if (attempt >= 3) throw new RpcException(0, "the tree moved three times; try again");
        }
        if (remote == null) phases.phase("prove");

        JSONObject req = new JSONObject(q.transition.toString());
        req.put("spend_key", spendKey);
        req.put("chain_id", chainId);
        if (genesis != null) req.put("genesis", genesis);
        req.put("fee", q.fee);
        req.put("tier", q.dry.get("tier"));
        req.put("gas_limit", q.limits.bundleGasLimit != null ? q.dry.get("gas_limit") : JSONObject.NULL);
        req.put("anchor_height", anchor.getLong("height"));
        req.put("anchor_root", anchor.getString("root"));
        req.put("inputs", withPaths(inputs, paths, 0));
        req.put("fee_inputs", withPaths(feeInputs, paths, inputs.length()));
        req.put("envelope_bytes", q.limits.envelopeBytes == null ? JSONObject.NULL : q.limits.envelopeBytes);
        req.put("bundle_gas_limit", q.limits.bundleGasLimit == null ? JSONObject.NULL : q.limits.bundleGasLimit);
        if (q.limits.maxProofBytes != null) req.put("max_proof_bytes", q.limits.maxProofBytes);
        RemoteSend.applyProofParams(req, status);
        return remote == null ? core.proveInvoke(req) : remote.prove(req, q.limits.maxProofBytes);
    }

    /**
     * {@code rand_sendTransaction} of a proved invoke → its hash (64 lowercase hex). A stale read
     * the chain refuses at submit is {@link #STALE_READ}, like one the quote caught.
     */
    public static String submit(RpcClient rpc, JSONObject proved, Phases phases) throws Exception {
        phases.phase("submit");
        String hash;
        try {
            hash = rpc.sendTransaction(proved.getString("tx_hex"));
        } catch (RpcException e) {
            if (isStaleRead(e.getMessage())) {
                throw new Refusal(STALE_READ, "The pool changed while this was being proved. Nothing was sent.");
            }
            throw e;
        }
        String h = hash == null ? "" : hash.replaceFirst("^0x", "").toLowerCase(Locale.ROOT);
        if (!h.matches("[0-9a-f]{64}")) throw new RpcException(0, "rand_sendTransaction: the transaction hash is not 64 hex characters");
        return h;
    }

    /** A refusal from the node at submit that is the chain saying a read was stale. */
    static boolean isStaleRead(String message) {
        return message != null && message.toLowerCase(Locale.ROOT).matches("(?s).*stale ?read.*");
    }

    /**
     * What the vault is short of, or null: it must hold what the transition pays out, counting what
     * this same transition deposits ({@code inflow.rand}, and {@code inflow.amount} when the kind is
     * {@code deposit}) — the CLI's check, so a swap the pool cannot cover costs no proof.
     */
    static String vaultShortfall(JSONObject inflow, JSONArray pays, JSONArray vault) throws JSONException {
        Map<Long, BigInteger> want = new HashMap<>();
        for (int i = 0; i < pays.length(); i++) {
            JSONObject p = pays.getJSONObject(i);
            want.merge(p.getLong("asset"), new BigInteger(p.getString("amount")), BigInteger::add);
        }
        Map<Long, BigInteger> held = new HashMap<>();
        for (int i = 0; i < vault.length(); i++) {
            JSONObject r = vault.getJSONObject(i);
            held.put(r.getLong("asset"), new BigInteger(r.getString("amount")));
        }
        for (Map.Entry<Long, BigInteger> e : want.entrySet()) {
            if (e.getValue().signum() <= 0) continue;
            long asset = e.getKey();
            BigInteger have = held.getOrDefault(asset, BigInteger.ZERO);
            if (asset == 0) have = have.add(new BigInteger(inflow.optString("rand", "0")));
            else if ("deposit".equals(inflow.optString("kind")) && inflow.optLong("asset", 0) == asset) {
                have = have.add(new BigInteger(inflow.optString("amount", "0")));
            }
            if (have.compareTo(e.getValue()) < 0) return "asset " + asset + ": the vault has " + have + ", the swap pays " + e.getValue();
        }
        return null;
    }

    private static String live(RpcClient rpc, String program, String key) throws Exception {
        String v = rpc.programCell(program, key);
        if (v == null) throw new Refusal(PROGRAMS_UNSUPPORTED, NO_PROGRAMS);
        return v;
    }

    private static JSONArray withPaths(JSONArray notes, JSONArray paths, int offset) throws JSONException {
        JSONArray out = new JSONArray();
        for (int i = 0; i < notes.length(); i++) {
            out.put(new JSONObject().put("note", notes.get(i)).put("path", paths.get(offset + i)));
        }
        return out;
    }

    private static String word8(Object v, String what) throws Refusal {
        if (!(v instanceof String) || !((String) v).matches("(0x)?[0-9a-fA-F]{64}")) {
            throw new Refusal(BAD_REQUEST, "This swap cannot be read: " + what + " is not 64 hex characters. Nothing was sent.");
        }
        return ((String) v).replaceFirst("^0x", "").toLowerCase(Locale.ROOT);
    }

    /** The request's cells, held to their shape and lowercased. */
    private static JSONArray cellsOf(JSONObject request, String field) throws Refusal, JSONException {
        JSONArray in = request.optJSONArray(field);
        JSONArray out = new JSONArray();
        if (in == null) return out;
        for (int i = 0; i < in.length(); i++) {
            JSONObject c = in.optJSONObject(i);
            if (c == null) throw new Refusal(BAD_REQUEST, "This swap cannot be read: " + field + " is not a list of cells. Nothing was sent.");
            out.put(new JSONObject().put("key", word8(c.opt("key"), field + " key")).put("value", word8(c.opt("value"), field + " value")));
        }
        return out;
    }
}
