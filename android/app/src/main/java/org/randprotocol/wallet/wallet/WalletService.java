package org.randprotocol.wallet.wallet;

import android.content.Context;

import androidx.lifecycle.LiveData;
import androidx.lifecycle.MutableLiveData;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.randprotocol.wallet.core.Core;
import org.randprotocol.wallet.core.CoreException;
import org.randprotocol.wallet.rpc.RpcClient;
import org.randprotocol.wallet.rpc.RpcException;
import org.randprotocol.wallet.security.KeyVault;
import org.randprotocol.wallet.security.Prefs;
import org.randprotocol.wallet.store.Contacts;
import org.randprotocol.wallet.store.EncryptedBlob;
import org.randprotocol.wallet.store.NoteStore;
import org.randprotocol.wallet.store.OwnedNote;
import org.randprotocol.wallet.store.Submission;
import org.randprotocol.wallet.ui.Memo;

import java.io.File;
import java.io.IOException;
import java.math.BigInteger;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The wallet: the note store plus the scan, send and faucet flows of the design spec §3.2,
 * mirroring {@code randprotocol_client::wallet}. All chain work runs on one background executor so
 * two scans never interleave; the UI observes {@link #snapshot()}.
 *
 * <p>The spend key is read from the {@link KeyVault} for each operation and dropped afterwards.
 */
public final class WalletService {
    /**
     * Peak memory of a bundle proof: mirrors {@code wallet_core::PROVER_PEAK_MEMORY_BYTES}
     * (measured 2026-09-20, chain 14).
     */
    public static final long PROVER_PEAK_MEMORY_BYTES = 6_200_000_000L;

    /** Android lets a foreground app use well under the whole of RAM; two thirds is generous. */
    public static boolean deviceCanProve(Context c) {
        android.app.ActivityManager am = (android.app.ActivityManager) c.getSystemService(Context.ACTIVITY_SERVICE);
        android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        return mi.totalMem / 3 * 2 >= PROVER_PEAK_MEMORY_BYTES;
    }

    /**
     * Peak memory of the proofs a swap always makes on the phone itself — the program call proof
     * and the authorisation proof — even when a prover makes the bundle: about 1.4 GB, measured
     * on the emulator 2026-10-01 (a 2 GB phone was stopped by Android half-way through).
     */
    public static final long CALL_PROOF_PEAK_MEMORY_BYTES = 1_500_000_000L;

    /** Whether this phone has the memory for a swap's own proofs (the same two-thirds rule). */
    public static boolean deviceCanMakeCallProof(Context c) {
        android.app.ActivityManager am = (android.app.ActivityManager) c.getSystemService(Context.ACTIVITY_SERVICE);
        android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        return mi.totalMem / 3 * 2 >= CALL_PROOF_PEAK_MEMORY_BYTES;
    }

    /** How long a send waits for its bundle to be committed. */
    public static final long COMMIT_TIMEOUT_MS = 180_000;
    private static final long POLL_MS = 1_000;

    private static WalletService instance;

    public static synchronized WalletService get(Context c) {
        if (instance == null) instance = new WalletService(c.getApplicationContext());
        return instance;
    }

    /** What the home screen shows. */
    public static final class Snapshot {
        public final BigInteger balance;
        public final BigInteger pending;
        public final long scannedIndex;
        public final long scannedHeight;
        public final boolean syncing;
        public final String error;
        public final long updatedAtMs;

        Snapshot(BigInteger balance, BigInteger pending, long scannedIndex, long scannedHeight, boolean syncing, String error) {
            this.balance = balance;
            this.pending = pending;
            this.scannedIndex = scannedIndex;
            this.scannedHeight = scannedHeight;
            this.syncing = syncing;
            this.error = error;
            this.updatedAtMs = System.currentTimeMillis();
        }
    }

    private final Context app;
    private final KeyVault vault;
    private final Prefs prefs;
    private final File storeFile;
    private final NoteStore store;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final MutableLiveData<Snapshot> snapshot = new MutableLiveData<>();
    private Contacts contacts;
    private String cachedAddress;
    private String cachedViewingKey;

    private WalletService(Context app) {
        this.app = app;
        this.vault = new KeyVault(app);
        this.prefs = new Prefs(app);
        this.storeFile = new File(app.getFilesDir(), "notes.json");
        this.store = NoteStore.load(storeFile);
        publish(false, null);
    }

    public KeyVault vault() {
        return vault;
    }

    public Prefs prefs() {
        return prefs;
    }

    public NoteStore store() {
        return store;
    }

    /** The contact book, opened on first use (its own EncryptedSharedPreferences file). */
    public synchronized Contacts contacts() {
        if (contacts == null) contacts = Contacts.open(new EncryptedBlob(app, "rand_wallet_contacts"));
        return contacts;
    }

    /**
     * The connected chain's {@code envelope_bytes} as the memo gate may believe it (null: this
     * chain carries no memo) — null on a chain pinned as pre-memo whatever the node claimed
     * (issue #64, {@link Memo#believed}), so Send and Receive offer no memo field there.
     * Blocking; call off the main thread. Throws when the node did not answer.
     */
    public Integer envelopeBytes() throws RpcException {
        return Memo.believed(rpc().envelopeBytes(), prefs.chainId());
    }

    public LiveData<Snapshot> snapshot() {
        return snapshot;
    }

    public RpcClient rpc() {
        return new RpcClient(prefs.rpcUrl());
    }

    public boolean hasWallet() {
        return vault.hasWallet();
    }

    private void publish(boolean syncing, String error) {
        synchronized (store) {
            snapshot.postValue(new Snapshot(store.balance(), store.pendingValue(), store.scannedIndex, store.scannedHeight, syncing, error));
        }
    }

    private void save() {
        synchronized (store) {
            try {
                store.save(storeFile);
            } catch (IOException e) {
                // A cache; the next scan rebuilds whatever was lost.
            }
        }
    }

    // ------------------------------------------------------------------ keys

    /** Create a wallet from a fresh key; returns the core's wallet info (the spend key is in it, shown once). */
    public JSONObject createWallet() throws CoreException {
        JSONObject info = Core.keygen();
        vault.store(info.optString("spend_key"));
        resetCaches();
        return info;
    }

    public JSONObject importWallet(String input) throws CoreException {
        JSONObject info = Core.importKey(input);
        vault.store(info.optString("spend_key"));
        prefs.setBackedUp(true);
        resetCaches();
        return info;
    }

    public void removeWallet() {
        vault.erase(); // the prover's token with it
        prefs.setProver(null);
        prefs.setNoProver(false);
        prefs.setProverNoticeFor(null);
        prefs.setBackedUp(false);
        contacts().clear();
        synchronized (store) {
            store.clear();
            store.submissions.clear();
        }
        save();
        resetCaches();
        publish(false, null);
    }

    private void resetCaches() {
        cachedAddress = null;
        cachedViewingKey = null;
    }

    public JSONObject walletInfo() throws CoreException {
        String sk = vault.spendKey();
        if (sk == null) throw new CoreException("no wallet");
        return Core.walletInfo(sk);
    }

    public String address() {
        if (cachedAddress == null) {
            try {
                JSONObject info = walletInfo();
                cachedAddress = info.optString("address");
                cachedViewingKey = info.optString("viewing_key");
            } catch (CoreException e) {
                return "";
            }
        }
        return cachedAddress;
    }

    public String viewingKey() {
        address();
        return cachedViewingKey == null ? "" : cachedViewingKey;
    }

    // ------------------------------------------------------------------ scanning

    public void scanAsync(Runnable onDone) {
        executor.execute(() -> {
            String err = null;
            try {
                scan();
            } catch (Exception e) {
                err = e.getMessage();
            }
            publish(false, err);
            if (onDone != null) onDone.run();
        });
    }

    /**
     * Trial-decrypt every commitment not seen yet, then mark spent every note whose nullifier
     * the chain has published. Blocking; call from the executor.
     */
    public void scan() throws RpcException, CoreException, JSONException {
        String sk = vault.spendKey();
        if (sk == null) return;
        publish(true, null);
        RpcClient rpc = rpc();

        Deposits found = rebuildableDeposits(rpc, sk);
        Map<String, OwnedNote> deposits = found.notes;

        // Pass 1: the leaves.
        while (true) {
            long from;
            synchronized (store) {
                from = store.scannedIndex;
            }
            JSONArray rows = rpc.commitments(from, RpcClient.PAGE);
            if (rows.length() == 0) break;
            JSONObject result = Core.scanPage(sk, rows);
            synchronized (store) {
                placeDeposits(rows, deposits);
                store.merge(result);
                if (store.scannedIndex <= from) {
                    throw new RpcException(0, "getCommitments returned rows from index " + from + " without advancing past it");
                }
            }
            publish(true, null);
        }
        // A rebuilt deposit whose leaf sits below the cursor: re-offer the leaves from the start.
        long from = 0;
        while (!deposits.isEmpty()) {
            JSONArray rows = rpc.commitments(from, RpcClient.PAGE);
            if (rows.length() == 0) {
                throw new RpcException(0, deposits.size() + " rebuilt deposit(s) match no leaf of the tree");
            }
            long before = from;
            synchronized (store) {
                placeDeposits(rows, deposits);
            }
            for (int i = 0; i < rows.length(); i++) from = Math.max(from, rows.getJSONObject(i).getLong("index") + 1);
            if (from <= before) throw new RpcException(0, "getCommitments did not advance");
        }

        // Every deposit found below `found.next` is on its leaf now, so the cursor may move.
        synchronized (store) {
            store.scannedAttestHeight = Math.max(store.scannedAttestHeight, found.next);
        }

        // The head *before* the nullifier pages: every block at or below it is read by them.
        long headBefore = rpc.headHeight();

        // Pass 2: nullifiers, keyed by height; page back to the highest height seen, not past it.
        long nfFrom;
        synchronized (store) {
            nfFrom = store.scannedHeight;
        }
        long pagedTo = nfFrom;
        while (true) {
            JSONArray rows = rpc.nullifiers(nfFrom, RpcClient.PAGE);
            if (rows.length() == 0) break;
            long maxHeight = -1;
            Set<String> nfs = new HashSet<>();
            for (int i = 0; i < rows.length(); i++) {
                JSONObject r = rows.getJSONObject(i);
                maxHeight = Math.max(maxHeight, r.getLong("height"));
                nfs.add(r.getString("nullifier"));
            }
            synchronized (store) {
                store.markSpent(nfs);
            }
            if (rows.length() < RpcClient.PAGE) {
                pagedTo = maxHeight + 1;
                break;
            }
            if (maxHeight == nfFrom) {
                throw new RpcException(0, "block " + nfFrom + " published more than " + RpcClient.PAGE + " nullifiers");
            }
            nfFrom = maxHeight;
            pagedTo = nfFrom;
        }
        // The chain's proof window (fullnode #118), read only when a note or a submission waits on
        // it; unread, the longest this wallet accepts, so nothing is released early.
        boolean waiting;
        synchronized (store) { waiting = store.hasPending(); }
        long window = NoteStore.TIME_WINDOW;
        if (waiting) {
            try { window = NoteStore.proofWindow(rpc.limits().proofWindowBlocks); }
            catch (RpcException e) { window = NoteStore.MAX_PROOF_WINDOW; }
        }
        synchronized (store) {
            store.scannedHeight = NoteStore.advanceScannedHeight(store.scannedHeight, pagedTo, headBefore);
            store.clearPending(store.scannedHeight - 1, window);
            resolveSubmissions(rpc);
        }
        save();
        publish(false, null);
    }

    /** Mark pending submissions committed once the node reports a block for them. */
    private void resolveSubmissions(RpcClient rpc) {
        for (Submission s : store.submissions) {
            if (!Submission.PENDING.equals(s.status)) continue;
            try {
                JSONObject t = rpc.transaction(s.hash);
                if (t != null) {
                    s.status = Submission.COMMITTED;
                    s.height = t.optLong("height", 0);
                }
            } catch (RpcException ignored) {
            }
        }
    }

    /** A leaf whose commitment is a rebuilt deposit is this wallet's whatever its envelope says. */
    private void placeDeposits(JSONArray rows, Map<String, OwnedNote> deposits) throws JSONException {
        if (deposits.isEmpty()) return;
        for (int i = 0; i < rows.length(); i++) {
            JSONObject r = rows.getJSONObject(i);
            OwnedNote d = deposits.remove(r.getString("cm"));
            if (d != null) {
                d.index = r.getLong("index");
                d.height = r.getLong("height");
                store.addNote(d);
            }
        }
    }

    /** What one scan's search for deposits found, and how far it looked. */
    private static final class Deposits {
        final Map<String, OwnedNote> notes = new HashMap<>();
        /** One past the last height examined: where the cursor may move once the notes are placed. */
        long next;
    }

    /**
     * Deposit notes that committed bridge_attest actions created for this wallet, keyed by
     * commitment, read out of blocks not read yet ({@link DepositWalk}: by header, opening only
     * the blocks that carry a transaction). One getBridgeState on a chain without a bridge.
     *
     * It does not move {@code store.scannedAttestHeight}: {@link #scan()} does, once the deposits
     * found here have been placed on their leaves. Moving it here meant a scan that failed between
     * this and the leaves kept the cursor and dropped the deposits, and a bridge deposit could be
     * missed for good. A node that will not answer leaves the cursor where the walk stopped and
     * does not fail the scan: the notes and the spends are read regardless.
     */
    private Deposits rebuildableDeposits(RpcClient rpc, String sk) throws CoreException, JSONException {
        Deposits out = new Deposits();
        long from;
        synchronized (store) {
            from = store.scannedAttestHeight;
        }
        out.next = from;
        long head;
        JSONObject bridge;
        try {
            head = rpc.headHeight();
            if (from > head) return out;
            bridge = rpc.bridgeState();
        } catch (RpcException e) {
            return out; // the bridge could not be asked: the cursor stands still this scan
        }
        if (!bridge.optBoolean("enabled", false)) {
            out.next = head + 1;
            return out;
        }
        DepositWalk.Node node = new DepositWalk.Node() {
            @Override
            public JSONArray headers(long a, long b) throws RpcException {
                return rpc.blockHeaders(a, b);
            }

            @Override
            public JSONObject block(long height) throws RpcException {
                return rpc.blockByHeight(height);
            }
        };
        // v0.6.8 `bridge.fees`: the chain's fee recipient rebuilds its fee notes too.
        JSONObject fees = bridge.optJSONObject("fees");
        String feeRecipient = fees == null ? null : fees.optString("recipient", null);
        DepositWalk.Result walked = DepositWalk.run(node, from, head, action -> {
            boolean attest = "bridge_attest".equals(action.optString("kind"));
            if (feeRecipient == null) {
                if (!attest) return;
                JSONObject note = Core.rebuiltDeposit(sk, action);
                if (note != null) {
                    OwnedNote n = OwnedNote.fromJson(note);
                    out.notes.put(n.cm, n);
                }
                return;
            }
            JSONArray notes = Core.rebuiltNotes(sk, action, feeRecipient);
            for (int i = 0; i < notes.length(); i++) {
                OwnedNote n = OwnedNote.fromJson(notes.getJSONObject(i));
                out.notes.put(n.cm, n);
            }
        });
        out.next = Math.max(from, walked.through + 1);
        return out;
    }

    // ------------------------------------------------------------------ the prover

    /**
     * Checks the link and the prover's key, then stores the pairing: the vault's record (token, key,
     * URL, {@code own} — what a send seals to, and whether it may ever be a spend-key job) first,
     * then the display copy in {@link Prefs}. Blocking.
     */
    public ProverPairing.Paired pairProver(String link) throws Exception {
        ProverPairing.Paired paired = ProverPairing.pair(ProverCore.NATIVE, link, ProverClient.HTTP);
        vault.setProverSecret(ProverSecret.of(paired.pairing, paired.token));
        prefs.setProver(paired.pairing);
        prefs.setNoProver(false);
        return paired;
    }

    /**
     * The RandProtocol provers this build pins (the core's {@code version.trusted_prover_pool}),
     * or null: what Settings shows and offers in one step. Asking pairs and asks nothing.
     */
    public TrustedProver trustedProver() {
        return ProverCore.NATIVE.trustedProver();
    }

    /**
     * Forget the paired prover: the wallet falls back to the default, the RandProtocol prover
     * (where the build ships one) — the same as {@link #useDefaultProver}.
     */
    public void forgetProver() {
        prefs.setProver(null);
        vault.eraseProverSecret();
    }

    /** Blocking. */
    /** Back to the default: forgets a paired prover and a choice of none. Nothing is asked. */
    public void useDefaultProver() {
        forgetProver();
        prefs.setNoProver(false);
    }

    /** No prover at all: forgets a paired one and turns the default off. */
    public void useNoProver() {
        forgetProver();
        prefs.setNoProver(true);
    }

    /**
     * The RandProtocol provers as the default would use them right now — every member that passes
     * its pins, in a fresh random order per send — or null: the user chose none, or this build
     * ships none. Never paired, never stored.
     */
    public RemoteSend.DefaultProver defaultProver() {
        if (prefs.noProver() || ProverCore.NATIVE.trustedProver() == null) return null;
        return () -> {
            java.util.List<ProverPairing.Paired> members = new java.util.ArrayList<>(ProverPairing.builtInPool(ProverCore.NATIVE));
            java.util.Collections.shuffle(members, new java.security.SecureRandom());
            return members;
        };
    }

    /** Whether proofs this device cannot make go to the RandProtocol prover (nothing paired, none not chosen). */
    public boolean usesDefaultProver() {
        return prefs.prover() == null && defaultProver() != null;
    }

    /** Whether THIS wallet has read the one-time notice about the RandProtocol prover. */
    public boolean defaultNoticeRead() {
        String a = address();
        return a != null && !a.isEmpty() && a.equals(prefs.proverNoticeFor());
    }

    /** The notice was read: remembered for this wallet until it is removed. */
    public void acknowledgeDefaultProver() {
        String a = address();
        if (a != null && !a.isEmpty()) prefs.setProverNoticeFor(a);
    }

    public ProverPairing.Probe probeProver(ProverPairing pairing) {
        return ProverPairing.probe(ProverCore.NATIVE, pairing, ProverClient.HTTP);
    }

    /**
     * Null when this device proves — it has the memory, or no prover is paired (then the review
     * step's memory warning stands, as before). A paired prover — the user's own or not — that
     * does not answer, answers with another key, quotes a fee, or takes no job this wallet can
     * send refuses the send here, before anything is built: nothing is sent. Blocking.
     */
    public RemoteSend.Route proveRoute() throws ProverClient.Refusal {
        return RemoteSend.route(deviceCanProve(app), prefs.prover(), ProverCore.NATIVE, this::probeProver, vault::proverSecret,
                defaultProver());
    }

    // ------------------------------------------------------------------ sending

    /** Amount + fee, for the review screen and for coin selection. */
    public static BigInteger need(BigInteger amount, BigInteger fee) {
        return amount.add(fee);
    }

    /** Coin selection only, for the review screen; throws with the core's message. */
    public JSONObject planTransfer(BigInteger amount, BigInteger fee) throws CoreException, JSONException {
        synchronized (store) {
            return Core.selectInputs(store.notesJson(), 0, need(amount, fee).toString());
        }
    }

    /**
     * The whole send: scan, select, fetch anchor + witnesses, prove, submit, wait, rescan.
     * Blocking and slow (the proof); {@link ProvingService} runs it and progress goes through
     * {@link SendMonitor}.
     */
    public void send(String to, BigInteger amount, BigInteger fee, String memo) {
        if (memo == null) memo = "";
        SendState st = new SendState(SendState.Phase.PREPARING, "Syncing notes", null, null, amount.toString(), to, System.currentTimeMillis());
        SendMonitor.post(st);
        String sk = vault.spendKey();
        if (sk == null) {
            SendMonitor.post(st.with(SendState.Phase.FAILED, "no wallet"));
            return;
        }
        try {
            // Where the bundle proof is made, decided before any work: this device, or the paired
            // prover (delegated proving). On a split-authorisation chain the prover gets the
            // viewing key and a salt, never the spend key — the auth proof is made here.
            RemoteSend.Route route = proveRoute();
            // The RandProtocol prover only once this wallet has read what it sees (Send shows the
            // notice before it starts a send; this is the rule, not the screen).
            if (route != null && route.isDefault && !defaultNoticeRead()) {
                throw new ProverClient.Refusal("Before the first send through the RandProtocol prover, read what it can see: it gets "
                        + "this wallet's viewing key. Send again and read the notice, or pair your own prover in Settings.");
            }
            RpcClient rpc = rpc();
            scan();
            JSONObject selection;
            synchronized (store) {
                selection = Core.selectInputs(store.notesJson(), 0, need(amount, fee).toString());
            }
            JSONArray chosen = selection.getJSONArray("chosen");

            // Anchor and witnesses together; refetch all if the tree moved between the calls.
            JSONObject anchor = null;
            JSONArray inputs = null;
            for (int attempt = 1; attempt <= 3 && inputs == null; attempt++) {
                SendMonitor.post(st.with(SendState.Phase.PREPARING, "Fetching witnesses"));
                anchor = rpc.anchor();
                String root = anchor.getString("root");
                JSONArray candidate = new JSONArray();
                boolean moved = false;
                for (int i = 0; i < chosen.length(); i++) {
                    JSONObject note = chosen.getJSONObject(i);
                    JSONObject w = rpc.witness(note.getLong("index"));
                    if (w == null) throw new RpcException(0, "no leaf at index " + note.getLong("index"));
                    if (!root.equals(w.getString("root"))) {
                        moved = true;
                        break;
                    }
                    JSONObject in = new JSONObject();
                    in.put("note", note);
                    in.put("path", w.getJSONArray("path"));
                    candidate.put(in);
                }
                if (!moved) inputs = candidate;
                else if (attempt == 3) throw new RpcException(0, "the tree moved three times; try again");
            }

            // Read from the node this send talks to, right before proving: every output is sealed
            // at exactly this size, and only the 1860-byte envelope carries a memo. On a chain
            // pinned as pre-memo (issue #64) the node's claim is not believed; the core seals
            // legacy there whatever envelope_bytes says, and refuses the memo first.
            // bundle_gas_limit is chain 18's pin, which the core checks against its own guest.
            RpcClient.ChainLimits limits = rpc.limits();
            Integer envelopeBytes = limits.envelopeBytes;
            if (!Memo.supported(envelopeBytes, prefs.chainId()) && !memo.isEmpty()) throw new RpcException(0, Memo.NO_MEMO_NOTICE);

            JSONObject req = new JSONObject();
            req.put("spend_key", sk);
            req.put("chain_id", prefs.chainId());
            // BIND-1: chains after 19 bind the genesis hash; the core ignores it on 14–19.
            String genesis = rpc.genesisHash();
            if (genesis != null) req.put("genesis", genesis);
            req.put("to", to);
            req.put("amount", amount.toString());
            req.put("fee", fee.toString());
            req.put("anchor_height", anchor.getLong("height"));
            req.put("anchor_root", anchor.getString("root"));
            req.put("inputs", inputs);
            // The chain's two guests (hc_bundle, hc_auth) and FRI profile, read once for either
            // route: a proof on another guest or profile is refused by the chain, whoever makes
            // it. The core refuses, before building, a v3 bundle guest without an auth guest it
            // carries, and an auth guest beside an older bundle guest.
            JSONObject status = null;
            try {
                status = rpc.status();
            } catch (RpcException e) {
                if (e.code != -32601) throw e;
            }
            RemoteSend.applyProofParams(req, status);
            // Sealed with the payment only; null (sent as JSON null, never left out) is the
            // legacy envelope, where the core refuses a non-empty memo before proving.
            req.put("memo", memo);
            req.put("envelope_bytes", envelopeBytes == null ? JSONObject.NULL : envelopeBytes);
            req.put("bundle_gas_limit", limits.bundleGasLimit == null ? JSONObject.NULL : limits.bundleGasLimit);

            JSONObject proved;
            if (route == null) {
                // Locally: the bundle proof and, on a split-authorisation chain, the auth proof
                // before it — one call; the reply's auth_proof_bytes says whether there was one.
                SendMonitor.post(st.with(SendState.Phase.PROVING, "Proving your transfer"));
                proved = Core.proveTransfer(req);
            } else {
                final SendState base = st;
                final String name = route.isDefault && route.poolName != null ? route.poolName + " provers" : route.pairing.name;
                SendMonitor.post(base.remote(name, null));
                Integer maxProofBytes = limits.maxProofBytes;
                RemoteProver.PhaseListener listener = new RemoteProver.PhaseListener() {
                    @Override
                    public void phase(Integer pos) {
                        SendMonitor.post(base.remote(name, pos));
                    }

                    @Override
                    public void authorising() {
                        SendMonitor.post(base.authorising(name));
                    }
                };
                // The RandProtocol provers: one member per job, tried in the route's order.
                proved = route.isDefault
                        ? RemoteSend.provePool(ProverCore.NATIVE, url -> {
                            try {
                                return new RemoteProver(new ProverClient(url));
                            } catch (ProverClient.Refusal e) {
                                throw new IllegalStateException(e);
                            }
                        }, req, route, maxProofBytes, listener)
                        : RemoteSend.prove(ProverCore.NATIVE, new RemoteProver(new ProverClient(route.pairing.url)), req, route,
                        maxProofBytes, listener);
            }
            req = null; // the spend key was in it

            // The receipt's key is the PAYMENT output's own, named by the core — never a slot
            // index: chain 14's four slots put dummies ahead of the payment for a RAND transfer.
            // It is null on a burn; getString would coerce that to the text "null", which looks
            // like a key and opens nothing, so refuse it as loudly as a missing field — BEFORE
            // anything is broadcast, exactly as iOS does.
            if (proved.isNull("payment_tx_key")) {
                throw new CoreException("the core did not name the payment's transaction key");
            }
            String txKey = proved.getString("payment_tx_key");

            SendMonitor.post(st.with(SendState.Phase.SUBMITTING, "Submitting"));
            String hash = rpc.sendTransaction(proved.getString("tx_hex"));
            long time = proved.getLong("time");

            Submission sub = new Submission();
            sub.hash = hash;
            sub.time = time;
            sub.amount = amount.toString();
            sub.fee = fee.toString();
            sub.to = to;
            sub.txKey = txKey;
            sub.createdAtMs = System.currentTimeMillis();
            Set<Long> spentIdx = new HashSet<>();
            JSONArray spent = proved.getJSONArray("spent_indices");
            for (int i = 0; i < spent.length(); i++) spentIdx.add(spent.getLong(i));
            synchronized (store) {
                store.markPending(spentIdx, time);
                store.submissions.add(0, sub);
            }
            save();
            publish(false, null);
            st = st.submitted(hash, txKey);
            SendMonitor.post(st);

            // Wait for the commit; the rescan (not this wallet's belief) marks the inputs spent.
            long deadline = System.currentTimeMillis() + COMMIT_TIMEOUT_MS;
            boolean committed = false;
            while (System.currentTimeMillis() < deadline) {
                JSONObject t = rpc.transaction(hash);
                if (t != null) {
                    committed = true;
                    synchronized (store) {
                        sub.status = Submission.COMMITTED;
                        sub.height = t.optLong("height", 0);
                    }
                    break;
                }
                Thread.sleep(POLL_MS);
            }
            scan();
            SendMonitor.post(st.with(SendState.Phase.DONE, committed ? "Committed" : "Submitted; not yet committed"));
        } catch (Exception e) {
            String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            SendMonitor.post(st.with(SendState.Phase.FAILED, msg));
            publish(false, null);
        }
    }

    // ------------------------------------------------------------------ swaps (RPL-2 invoke)

    /** The words of each step of a swap, as the shared UI's {@code PHASE_LABELS}. */
    public static final String SELECTING = "Selecting notes";
    static final String WITNESS = "Building the witness";
    static final String DEVICE_PROVING = "Proving the bundle";
    static final String SUBMITTING = "Submitting to the node";

    /**
     * Whether this device can swap here, before anything is quoted ({@code backend-shared.js}'s
     * {@code program.canInvoke}): a proof route first, then the chain's {@code program_state}
     * section. Returns the route (null: this device proves). Blocking.
     */
    public RemoteSend.Route canInvoke() throws Invoke.Refusal, RpcException {
        // Said before anything is quoted: otherwise Android stops the app half-way through the
        // proofs and the screen simply disappears (nothing is sent either way).
        if (!deviceCanMakeCallProof(app)) {
            throw new Invoke.Refusal(Invoke.PROVER_UNAVAILABLE, "This phone does not have the memory a swap needs: it makes two of the proofs itself, about 1.5 GB. Nothing was sent. Swap from the desktop app or the browser extension instead.");
        }
        RemoteSend.Route route;
        try {
            route = proveRoute();
        } catch (ProverClient.Refusal e) {
            throw new Invoke.Refusal(Invoke.PROVER_UNAVAILABLE, e.getMessage());
        }
        if (rpc().limits().programState == null) throw new Invoke.Refusal(Invoke.PROGRAMS_UNSUPPORTED, "This chain does not run programs yet.");
        return route;
    }

    /** Every cell of {@code program} ({@code rand_getProgramCells}, page by page), or null on a chain without program state. Blocking. */
    public JSONArray programCells(String program) throws RpcException {
        return rpc().programCellsAll(program);
    }

    /** Scan, then the store's notes: what {@code plan_invoke} chooses from. */
    private JSONArray scannedNotes() throws Exception {
        scan();
        synchronized (store) {
            return store.notesJson();
        }
    }

    /**
     * Every refusal that needs no proof, and the network fee ({@link Invoke#quote}): what the
     * Review step shows. Blocking: reads the node and scans.
     */
    public Invoke.Quote quoteInvoke(JSONObject request) throws Exception {
        return Invoke.quote(rpc(), Invoke.InvokeCore.NATIVE, request, this::scannedNotes);
    }

    /**
     * The whole swap: the route, the quote taken again (time has passed since Review: the pool may
     * have moved, the notes may be spent), the anchor last, the proofs — on this device, or the
     * bundle proof through the RandProtocol provers or the paired one ({@link RemoteSend}, kind
     * {@code invoke}: the call proof and the auth proof are made here) — then submit, record,
     * wait and rescan. Progress and the outcome go through {@link SwapMonitor}; a refusal carries
     * the engine's code ({@link SendState#code}). Blocking and slow; {@link ProvingService} runs it.
     */
    public void invoke(JSONObject request, String amountIn) {
        SendState st = new SendState(SendState.Phase.PREPARING, SELECTING, null, null, amountIn, null, System.currentTimeMillis());
        SwapMonitor.post(st);
        String sk = vault.spendKey();
        if (sk == null) {
            SwapMonitor.post(st.failed(null, "no wallet"));
            return;
        }
        try {
            RemoteSend.Route route;
            try {
                route = proveRoute();
            } catch (ProverClient.Refusal e) {
                throw new Invoke.Refusal(Invoke.PROVER_UNAVAILABLE, e.getMessage());
            }
            if (route != null && route.isDefault && !defaultNoticeRead()) {
                throw new Invoke.Refusal(Invoke.PROVER_NOTICE, "Before the first swap through the RandProtocol provers, read what they can see: "
                        + "they get this wallet's viewing key. Review the swap again and read the notice, or pair your own prover in Settings.");
            }
            RpcClient rpc = rpc();
            Invoke.Quote q = Invoke.quote(rpc, Invoke.InvokeCore.NATIVE, request, this::scannedNotes);

            final SendState base = st;
            Invoke.Phases phases = step -> {
                if ("witness".equals(step)) SwapMonitor.post(base.with(SendState.Phase.PREPARING, WITNESS));
                else if ("prove".equals(step)) SwapMonitor.post(base.with(SendState.Phase.PROVING, DEVICE_PROVING));
                else if ("submit".equals(step)) SwapMonitor.post(base.with(SendState.Phase.SUBMITTING, SUBMITTING));
            };
            Invoke.Prover remote = null;
            if (route != null) {
                final RemoteSend.Route r = route;
                final String name = r.isDefault && r.poolName != null ? r.poolName + " provers" : r.pairing.name;
                RemoteProver.PhaseListener listener = new RemoteProver.PhaseListener() {
                    @Override
                    public void phase(Integer pos) {
                        SwapMonitor.post(base.remote(name, pos));
                    }

                    @Override
                    public void authorising() {
                        SwapMonitor.post(base.authorising(name));
                    }
                };
                // The same pool path a transfer takes, with the job sealed as an invoke.
                remote = (req, maxProofBytes) -> {
                    SwapMonitor.post(base.remote(name, null));
                    return r.isDefault
                            ? RemoteSend.provePool(ProverCore.NATIVE, url -> {
                                try {
                                    return new RemoteProver(new ProverClient(url));
                                } catch (ProverClient.Refusal e) {
                                    throw new IllegalStateException(e);
                                }
                            }, RemoteSend.KIND_INVOKE, req, r, maxProofBytes, listener)
                            : RemoteSend.prove(ProverCore.NATIVE, new RemoteProver(new ProverClient(r.pairing.url)), RemoteSend.KIND_INVOKE,
                            req, r, maxProofBytes, listener);
                };
            }
            JSONObject proved = Invoke.prove(rpc, Invoke.InvokeCore.NATIVE, q, sk, prefs.chainId(), remote, phases);
            String hash = Invoke.submit(rpc, proved, phases);
            long time = proved.optLong("time", 0);

            Submission sub = new Submission();
            sub.kind = Submission.INVOKE;
            sub.hash = hash;
            sub.time = time;
            sub.program = proved.optString("program", "");
            boolean token = proved.optLong("burn_asset", 0) != 0 && !"0".equals(proved.optString("burn_a", "0"));
            sub.asset = token ? proved.optInt("burn_asset", 0) : 0;
            sub.amount = token ? proved.optString("burn_a", "0") : proved.optString("burn_r", "0");
            sub.fee = proved.optString("fee", q.fee);
            sub.to = "";
            sub.txKey = "";
            sub.createdAtMs = System.currentTimeMillis();
            // What the program pays this wallet: the notes the next scan finds by trial decryption.
            JSONArray payouts = proved.optJSONArray("payouts");
            if (payouts != null) {
                for (int i = 0; i < payouts.length(); i++) {
                    JSONObject n = payouts.getJSONObject(i);
                    sub.payouts.put(new JSONObject().put("asset", n.optInt("asset", 0)).put("amount", n.optString("amount", "0")));
                }
            }
            Set<Long> spentIdx = new HashSet<>();
            JSONArray spent = proved.optJSONArray("spent_indices");
            if (spent != null) for (int i = 0; i < spent.length(); i++) spentIdx.add(spent.getLong(i));
            synchronized (store) {
                store.markPending(spentIdx, time);
                store.submissions.add(0, sub);
            }
            save();
            publish(false, null);
            st = st.submitted(hash, null);
            SwapMonitor.post(st);

            long deadline = System.currentTimeMillis() + COMMIT_TIMEOUT_MS;
            boolean committed = false;
            while (System.currentTimeMillis() < deadline) {
                JSONObject t = rpc.transaction(hash);
                if (t != null) {
                    committed = true;
                    synchronized (store) {
                        sub.status = Submission.COMMITTED;
                        sub.height = t.optLong("height", 0);
                    }
                    break;
                }
                Thread.sleep(POLL_MS);
            }
            // A swap pays into the wallet: this scan finds the note.
            scan();
            SwapMonitor.post(st.with(SendState.Phase.DONE, committed ? "Committed" : "Submitted; not yet committed"));
        } catch (Invoke.Refusal e) {
            SwapMonitor.post(st.failed(e.code, e.getMessage()));
            publish(false, null);
        } catch (Exception e) {
            String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            SwapMonitor.post(st.failed(null, msg));
            publish(false, null);
        }
    }

    // ------------------------------------------------------------------ faucet

    /** Ask a validator to mint 100 RAND to this wallet, wait for the commit, rescan. Blocking. */
    public String faucet() throws RpcException, CoreException, JSONException, InterruptedException {
        RpcClient rpc = rpc();
        String hash = rpc.mint(address());
        long deadline = System.currentTimeMillis() + COMMIT_TIMEOUT_MS;
        while (System.currentTimeMillis() < deadline) {
            if (rpc.transaction(hash) != null) break;
            Thread.sleep(POLL_MS);
        }
        scan();
        return hash;
    }

    public void faucetAsync(java.util.function.Consumer<String> onDone, java.util.function.Consumer<String> onError) {
        executor.execute(() -> {
            try {
                String hash = faucet();
                onDone.accept(hash);
            } catch (Exception e) {
                onError.accept(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
            }
        });
    }

    /** Throw the note cache away and read the tree from leaf 0. */
    public void rescanFromZero(Runnable onDone) {
        synchronized (store) {
            store.clear();
        }
        save();
        scanAsync(onDone);
    }

    public void runInBackground(Runnable r) {
        executor.execute(r);
    }

    public Context app() {
        return app;
    }
}
