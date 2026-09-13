package org.randprotocol.wallet.store;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Set;

/**
 * Everything scanning has learned, as JSON in app-private storage. Purely a cache of chain data:
 * every note is recoverable by rescanning from leaf 0 with the spend key, which is why a missing
 * or unreadable file starts from empty rather than failing.
 *
 * <p>The merge and bookkeeping rules mirror the {@code shrugg} CLI's note store
 * ({@code crates/shrugg-client/src/wallet.rs}) and have no Android dependency, so they are unit
 * tested on the JVM.
 */
public final class NoteStore {
    /** {@code TIME_WINDOW} of the ledger: blocks after a bundle's {@code time} in which it can still be admitted. */
    public static final long TIME_WINDOW = 256;

    /** The next leaf index to scan; every leaf below it has been tried against the viewing key. */
    public long scannedIndex;
    /** The next block height to read nullifiers from. */
    public long scannedHeight;
    /** The next block height to read committed bridge_attest transactions from. */
    public long scannedAttestHeight;
    public final List<OwnedNote> notes = new ArrayList<>();
    public final List<SentRow> sent = new ArrayList<>();
    public final List<Submission> submissions = new ArrayList<>();

    // ------------------------------------------------------------------ persistence

    public static NoteStore load(File file) {
        NoteStore store = new NoteStore();
        if (file == null || !file.exists()) return store;
        try {
            String text = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
            return fromJson(new JSONObject(text));
        } catch (IOException | JSONException e) {
            return new NoteStore();
        }
    }

    public void save(File file) throws IOException {
        File tmp = new File(file.getPath() + ".tmp");
        try (Writer w = new OutputStreamWriter(new FileOutputStream(tmp), StandardCharsets.UTF_8)) {
            w.write(toJson().toString());
        } catch (JSONException e) {
            throw new IOException(e);
        }
        if (!tmp.renameTo(file)) {
            Files.move(tmp.toPath(), file.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        }
    }

    public static NoteStore fromJson(JSONObject o) throws JSONException {
        NoteStore s = new NoteStore();
        s.scannedIndex = o.optLong("scanned_index", 0);
        s.scannedHeight = o.optLong("scanned_height", 0);
        s.scannedAttestHeight = o.optLong("scanned_attest_height", 0);
        JSONArray notes = o.optJSONArray("notes");
        if (notes != null) for (int i = 0; i < notes.length(); i++) s.notes.add(OwnedNote.fromJson(notes.getJSONObject(i)));
        JSONArray sent = o.optJSONArray("sent");
        if (sent != null) for (int i = 0; i < sent.length(); i++) s.sent.add(SentRow.fromJson(sent.getJSONObject(i)));
        JSONArray subs = o.optJSONArray("submissions");
        if (subs != null) for (int i = 0; i < subs.length(); i++) s.submissions.add(Submission.fromJson(subs.getJSONObject(i)));
        return s;
    }

    public JSONObject toJson() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("scanned_index", scannedIndex);
        o.put("scanned_height", scannedHeight);
        o.put("scanned_attest_height", scannedAttestHeight);
        JSONArray n = new JSONArray();
        for (OwnedNote x : notes) n.put(x.toJson());
        o.put("notes", n);
        JSONArray s = new JSONArray();
        for (SentRow x : sent) s.put(x.toJson());
        o.put("sent", s);
        JSONArray subs = new JSONArray();
        for (Submission x : submissions) subs.put(x.toJson());
        o.put("submissions", subs);
        return o;
    }

    // ------------------------------------------------------------------ merging a scan page

    /** Add received notes and sent rows from a {@code scan_page} result; a leaf offered twice is the same note. */
    public void merge(JSONObject scanResult) throws JSONException {
        JSONArray received = scanResult.optJSONArray("received");
        if (received != null) {
            for (int i = 0; i < received.length(); i++) addNote(OwnedNote.fromJson(received.getJSONObject(i)));
        }
        JSONArray sentRows = scanResult.optJSONArray("sent");
        if (sentRows != null) {
            for (int i = 0; i < sentRows.length(); i++) addSent(SentRow.fromJson(sentRows.getJSONObject(i)));
        }
        long next = scanResult.optLong("next_index", scannedIndex);
        scannedIndex = Math.max(scannedIndex, next);
    }

    public boolean addNote(OwnedNote n) {
        for (OwnedNote existing : notes) if (existing.index == n.index) return false;
        notes.add(n);
        return true;
    }

    public boolean addSent(SentRow s) {
        for (SentRow existing : sent) if (existing.index == s.index) return false;
        sent.add(s);
        return true;
    }

    public OwnedNote noteByCommitment(String cm) {
        for (OwnedNote n : notes) if (n.cm.equals(cm)) return n;
        return null;
    }

    public OwnedNote noteByIndex(long index) {
        for (OwnedNote n : notes) if (n.index == index) return n;
        return null;
    }

    // ------------------------------------------------------------------ nullifiers and pending

    /** Mark every note whose nullifier the chain published as spent. Returns how many changed. */
    public int markSpent(Collection<String> nullifiers) {
        int changed = 0;
        for (OwnedNote n : notes) {
            if (!n.spent && nullifiers.contains(n.nf)) {
                n.spent = true;
                changed++;
            }
        }
        return changed;
    }

    /** Hold the notes a submission spends until the chain answers. */
    public void markPending(Set<Long> indices, long time) {
        for (OwnedNote n : notes) if (indices.contains(n.index)) n.pending = time;
    }

    /**
     * Clear {@code pending} on every note the chain has answered for: its spend landed, or the
     * blocks read reach past {@code time + TIME_WINDOW}, after which the bundle can never be
     * admitted. {@code readThrough} is the last block height whose nullifiers have been read.
     */
    public void clearPending(long readThrough) {
        for (OwnedNote n : notes) {
            if (n.pending != null && (n.spent || readThrough > n.pending + TIME_WINDOW)) {
                n.pending = null;
            }
        }
        for (Submission s : submissions) {
            if (Submission.PENDING.equals(s.status) && readThrough > s.time + TIME_WINDOW) {
                s.status = Submission.EXPIRED;
            }
        }
    }

    /**
     * Where a scan has read through after paging nullifiers: never behind where the pages
     * stopped, and never behind the head read before them.
     */
    public static long advanceScannedHeight(long previous, long pagedTo, long headBefore) {
        return Math.max(previous, Math.max(pagedTo, headBefore + 1));
    }

    // ------------------------------------------------------------------ balances

    /** Spendable SHRUGG in units. */
    public BigInteger balance() {
        return balanceOf(0);
    }

    public BigInteger balanceOf(int asset) {
        BigInteger sum = BigInteger.ZERO;
        for (OwnedNote n : notes) if (n.isSpendable() && n.asset == asset) sum = sum.add(n.units());
        return sum;
    }

    /** Value held back by unconfirmed submissions, so the UI can say "pending". */
    public BigInteger pendingValue() {
        BigInteger sum = BigInteger.ZERO;
        for (OwnedNote n : notes) if (!n.spent && n.pending != null && n.asset == 0) sum = sum.add(n.units());
        return sum;
    }

    public List<OwnedNote> spendableOf(int asset) {
        List<OwnedNote> out = new ArrayList<>();
        for (OwnedNote n : notes) if (n.isSpendable() && n.asset == asset) out.add(n);
        return out;
    }

    public JSONArray notesJson() throws JSONException {
        JSONArray a = new JSONArray();
        for (OwnedNote n : notes) a.put(n.toJson());
        return a;
    }

    public Submission submissionByHash(String hash) {
        for (Submission s : submissions) if (s.hash.equals(hash)) return s;
        return null;
    }

    public void clear() {
        scannedIndex = 0;
        scannedHeight = 0;
        scannedAttestHeight = 0;
        notes.clear();
        sent.clear();
        // Submissions are the user's own history, not chain data: kept across a rescan.
    }
}
