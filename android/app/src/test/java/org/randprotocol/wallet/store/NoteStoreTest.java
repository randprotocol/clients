package org.randprotocol.wallet.store;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.io.File;
import java.io.InputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Scanner;

/** The note store's merge, spent and pending rules against a fixture shaped like the core's scan_page reply. */
public class NoteStoreTest {
    private static JSONObject fixture(String name) throws Exception {
        try (InputStream in = NoteStoreTest.class.getResourceAsStream("/" + name)) {
            String text = new Scanner(in, StandardCharsets.UTF_8.name()).useDelimiter("\\A").next();
            return new JSONObject(text);
        }
    }

    @Test
    public void mergeAddsNotesOnceAndAdvancesTheCursor() throws Exception {
        NoteStore s = new NoteStore();
        JSONObject page = fixture("scan_page.json");
        s.merge(page);
        assertEquals(2, s.notes.size());
        assertEquals(1, s.sent.size());
        assertEquals(13, s.scannedIndex);
        // The same page again is idempotent: leaves are keyed by index.
        s.merge(page);
        assertEquals(2, s.notes.size());
        assertEquals(1, s.sent.size());
        assertEquals(new BigInteger("1500000007"), s.balance());
        assertEquals(new BigInteger("1500000000"), s.noteByIndex(10).units());
    }

    @Test
    public void nullifiersMarkSpentAndBalanceFollows() throws Exception {
        NoteStore s = new NoteStore();
        s.merge(fixture("scan_page.json"));
        int changed = s.markSpent(new HashSet<>(Arrays.asList(s.noteByIndex(10).nf, "not-a-nullifier")));
        assertEquals(1, changed);
        assertTrue(s.noteByIndex(10).spent);
        assertFalse(s.noteByIndex(11).spent);
        assertEquals(new BigInteger("7"), s.balance());
        assertEquals(0, s.markSpent(new HashSet<>(Arrays.asList(s.noteByIndex(10).nf))));
    }

    @Test
    public void pendingHoldsNotesUntilTheChainAnswers() throws Exception {
        NoteStore s = new NoteStore();
        s.merge(fixture("scan_page.json"));
        s.markPending(new HashSet<>(Arrays.asList(10L)), 100);
        assertFalse(s.noteByIndex(10).isSpendable());
        assertEquals(new BigInteger("7"), s.balance());
        assertEquals(new BigInteger("1500000000"), s.pendingValue());
        // Within the window: still held.
        s.clearPending(100 + NoteStore.TIME_WINDOW);
        assertEquals(Long.valueOf(100), s.noteByIndex(10).pending);
        // Past the window: the bundle can never be admitted, the note is free again.
        s.clearPending(100 + NoteStore.TIME_WINDOW + 1);
        assertNull(s.noteByIndex(10).pending);
        assertTrue(s.noteByIndex(10).isSpendable());
        // A spend that landed clears immediately.
        s.markPending(new HashSet<>(Arrays.asList(11L)), 200);
        s.markSpent(new HashSet<>(Arrays.asList(s.noteByIndex(11).nf)));
        s.clearPending(201);
        assertNull(s.noteByIndex(11).pending);
        assertFalse(s.noteByIndex(11).isSpendable());
    }

    @Test
    public void scannedHeightNeverGoesBackwards() {
        assertEquals(41, NoteStore.advanceScannedHeight(5, 38, 40));
        assertEquals(50, NoteStore.advanceScannedHeight(50, 38, 40));
        assertEquals(60, NoteStore.advanceScannedHeight(5, 60, 40));
    }

    @Test
    public void submissionsExpireAndRoundTripThroughJson() throws Exception {
        NoteStore s = new NoteStore();
        s.merge(fixture("scan_page.json"));
        Submission sub = new Submission();
        sub.hash = "ab".repeat(32);
        sub.time = 10;
        sub.amount = "5";
        sub.fee = "1000000";
        sub.to = "rand1x";
        sub.txKey = "cd".repeat(32);
        s.submissions.add(sub);
        s.clearPending(10 + NoteStore.TIME_WINDOW + 1);
        assertEquals(Submission.EXPIRED, sub.status);

        NoteStore back = NoteStore.fromJson(s.toJson());
        assertEquals(s.notes.size(), back.notes.size());
        assertEquals(s.scannedIndex, back.scannedIndex);
        assertEquals(Submission.EXPIRED, back.submissionByHash(sub.hash).status);
        assertEquals(sub.txKey, back.submissionByHash(sub.hash).txKey);

        File f = File.createTempFile("notes", ".json");
        s.save(f);
        NoteStore loaded = NoteStore.load(f);
        assertEquals(2, loaded.notes.size());
        assertEquals(1, loaded.submissions.size());
        // Rescanning keeps the user's own submissions, drops chain data.
        loaded.clear();
        assertEquals(0, loaded.notes.size());
        assertEquals(0, loaded.scannedIndex);
        assertEquals(1, loaded.submissions.size());
    }

    @Test
    public void unreadableFileStartsEmpty() throws Exception {
        File f = File.createTempFile("notes", ".json");
        java.nio.file.Files.write(f.toPath(), "not json".getBytes(StandardCharsets.UTF_8));
        NoteStore s = NoteStore.load(f);
        assertEquals(0, s.notes.size());
        assertEquals(0, s.scannedIndex);
    }
}
