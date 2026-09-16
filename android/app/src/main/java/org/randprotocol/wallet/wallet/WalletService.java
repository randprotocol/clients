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
import org.randprotocol.wallet.store.NoteStore;
import org.randprotocol.wallet.store.OwnedNote;
import org.randprotocol.wallet.store.Submission;

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
        vault.erase();
        prefs.setBackedUp(false);
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

        Map<String, OwnedNote> deposits = rebuildableDeposits(rpc, sk);

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
        synchronized (store) {
            store.scannedHeight = NoteStore.advanceScannedHeight(store.scannedHeight, pagedTo, headBefore);
            store.clearPending(store.scannedHeight - 1);
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

    /**
     * Deposit notes committed bridge_attest actions created for this wallet, keyed by
     * commitment, read out of blocks not read yet. One getBridgeState on a chain without a
     * bridge.
     */
    private Map<String, OwnedNote> rebuildableDeposits(RpcClient rpc, String sk) throws RpcException, CoreException, JSONException {
        Map<String, OwnedNote> out = new HashMap<>();
        long head = rpc.headHeight();
        long from;
        synchronized (store) {
            from = store.scannedAttestHeight;
        }
        if (from > head) return out;
        JSONObject bridge = rpc.bridgeState();
        if (!bridge.optBoolean("enabled", false)) {
            synchronized (store) {
                store.scannedAttestHeight = head + 1;
            }
            return out;
        }
        for (long h = from; h <= head; h++) {
            JSONObject block = rpc.blockByHeight(h);
            if (block == null) continue;
            JSONArray txs = block.optJSONArray("transactions");
            if (txs == null) continue;
            for (int i = 0; i < txs.length(); i++) {
                JSONObject action = txs.getJSONObject(i).optJSONObject("action");
                if (action == null || !"bridge_attest".equals(action.optString("kind"))) continue;
                JSONObject note = Core.rebuiltDeposit(sk, action);
                if (note != null) {
                    OwnedNote n = OwnedNote.fromJson(note);
                    out.put(n.cm, n);
                }
            }
        }
        synchronized (store) {
            store.scannedAttestHeight = head + 1;
        }
        return out;
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
    public void send(String to, BigInteger amount, BigInteger fee) {
        SendState st = new SendState(SendState.Phase.PREPARING, "Syncing notes", null, null, amount.toString(), to, System.currentTimeMillis());
        SendMonitor.post(st);
        String sk = vault.spendKey();
        if (sk == null) {
            SendMonitor.post(st.with(SendState.Phase.FAILED, "no wallet"));
            return;
        }
        try {
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

            JSONObject req = new JSONObject();
            req.put("spend_key", sk);
            req.put("chain_id", prefs.chainId());
            req.put("to", to);
            req.put("amount", amount.toString());
            req.put("fee", fee.toString());
            req.put("anchor_height", anchor.getLong("height"));
            req.put("anchor_root", anchor.getString("root"));
            req.put("inputs", inputs);
            req.put("profile", "production");

            SendMonitor.post(st.with(SendState.Phase.PROVING, "Proving your transfer"));
            JSONObject proved = Core.proveTransfer(req);
            req = null; // the spend key was in it

            SendMonitor.post(st.with(SendState.Phase.SUBMITTING, "Submitting"));
            String hash = rpc.sendTransaction(proved.getString("tx_hex"));
            long time = proved.getLong("time");
            String txKey = proved.getJSONArray("tx_keys").getString(0);

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
