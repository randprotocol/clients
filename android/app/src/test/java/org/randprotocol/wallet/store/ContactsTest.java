package org.randprotocol.wallet.store;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

/**
 * The contact rules (spec 2026-09-26 §3.3), word for word the CLI's, the shared UI's
 * ({@code ui/lib/contacts.js}) and iOS's ({@code ContactBook}): a name is 1–64 characters, never
 * starts with {@code rand1} or {@code randpay:} in any case, is unique, and an address lives
 * under one name only.
 */
public class ContactsTest {
    private static final String A1 = "rand1" + "A".repeat(40);
    private static final String A2 = "rand1" + "B".repeat(40);

    /** In memory, for tests; the app's backing is EncryptedSharedPreferences. */
    static final class MemoryBlob implements Contacts.Backing {
        String data;

        @Override
        public String read() {
            return data;
        }

        @Override
        public void write(String json) {
            data = json;
        }
    }

    private static void refused(Runnable r, String message) {
        try {
            r.run();
            fail("expected a refusal: " + message);
        } catch (Contacts.ContactException e) {
            assertEquals(message, e.getMessage());
        }
    }

    @Test
    public void nameRules() {
        String rule = Contacts.NAME_RULE;
        assertEquals("a contact name is 1-64 characters and cannot start with rand1 or randpay:", rule);
        assertEquals(rule, Contacts.checkName(""));
        assertEquals(rule, Contacts.checkName("x".repeat(65)));
        assertNull(Contacts.checkName("x".repeat(64)));
        assertEquals(rule, Contacts.checkName("rand1alice"));
        assertEquals(rule, Contacts.checkName("RAND1alice"));
        assertEquals(rule, Contacts.checkName("RandPay:alice"));
        assertNull(Contacts.checkName("randy"));
        assertNull(Contacts.checkName("alice"));
        // Characters as the CLI counts them (Unicode scalars), not UTF-16 units or bytes.
        assertNull(Contacts.checkName("é".repeat(64)));
        assertEquals(rule, Contacts.checkName("é".repeat(65)));
        assertNull(Contacts.checkName("👋".repeat(64)));
        assertEquals(rule, Contacts.checkName("👋".repeat(65)));
    }

    @Test
    public void addRefusesADuplicateNameAndASecondNameForOneAddress() {
        Contacts book = Contacts.open(new MemoryBlob());
        book.add("alice", A1);
        refused(() -> book.add("alice", A2), "a contact named alice exists");
        refused(() -> book.add("al", "  " + A1 + "\n"), "this address is already saved as alice");
        refused(() -> book.add("randpay:bob", A2), Contacts.NAME_RULE);
        refused(() -> book.add("bob", "  "), "a contact needs an address");
        book.add("bob", A2);
        List<String> names = new ArrayList<>();
        for (Contacts.Contact c : book.sorted()) names.add(c.name);
        assertEquals(List.of("alice", "bob"), names);
        assertEquals(A2, book.addressOf("bob"));
        assertEquals("alice", book.nameOf(A1));
        assertEquals("alice", book.nameOf(" " + A1 + " "));
        assertNull(book.nameOf("rand1nobody"));
    }

    /** Sorted by name in UTF-8 byte order, the CLI's BTreeMap order — not UTF-16 order. */
    @Test
    public void sortedIsByteOrder() {
        Contacts book = Contacts.open(new MemoryBlob());
        book.add("Ａ", A1);        // FULLWIDTH A: EF BC A1
        book.add("👋", A2);            // F0 9F 91 8B (a surrogate pair in UTF-16, sorts before U+FF21 there)
        book.add("Zed", "rand1" + "C".repeat(40));
        List<String> names = new ArrayList<>();
        for (Contacts.Contact c : book.sorted()) names.add(c.name);
        assertEquals(List.of("Zed", "Ａ", "👋"), names);
    }

    @Test
    public void remove() {
        Contacts book = Contacts.open(new MemoryBlob());
        book.add("alice", A1);
        book.remove("alice");
        assertNull(book.addressOf("alice"));
        refused(() -> book.remove("alice"), "no contact named alice");
    }

    /** The stored form is the CLI's file shape, {"entries": {name: address}}, and survives a reload. */
    @Test
    public void storePersistsTheCliShape() throws Exception {
        MemoryBlob backing = new MemoryBlob();
        Contacts store = Contacts.open(backing);
        store.add("alice", A1);
        JSONObject json = new JSONObject(backing.data);
        JSONObject entries = json.getJSONObject("entries");
        assertEquals(1, entries.length());
        assertEquals(A1, entries.getString("alice"));
        Contacts reloaded = Contacts.open(backing);
        assertEquals(A1, reloaded.addressOf("alice"));
        reloaded.remove("alice");
        assertTrue(Contacts.open(backing).sorted().isEmpty());
    }

    /** A failed add changes neither the book nor the store. */
    @Test
    public void aRefusedAddLeavesTheStoreAlone() {
        MemoryBlob backing = new MemoryBlob();
        Contacts store = Contacts.open(backing);
        store.add("alice", A1);
        String before = backing.data;
        refused(() -> store.add("alice", A2), "a contact named alice exists");
        assertEquals(before, backing.data);
    }

    /** Garbage in the store reads as an empty book, never a crash. */
    @Test
    public void aCorruptStoreReadsEmpty() {
        MemoryBlob backing = new MemoryBlob();
        backing.data = "not json";
        assertTrue(Contacts.open(backing).sorted().isEmpty());
        backing.data = "{\"entries\": {\"x\": 5, \"y\": \"\"}}";
        assertTrue(Contacts.open(backing).sorted().isEmpty());
    }
}
