package org.randprotocol.wallet.store;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Contacts: names for the addresses a user pays often (spec 2026-09-26 §3.3).
 *
 * <p>The rules are the CLI's ({@code randprotocol-client/src/contacts.rs}), the shared UI's
 * ({@code ui/lib/contacts.js}) and iOS's ({@code ContactBook}), word for word in the refusals:
 * <ul>
 *   <li>a name is 1–64 characters (Unicode scalars, as Rust counts {@code chars}) and does not
 *       start with {@code rand1} or {@code randpay:} in any case — a name that looked like an
 *       address or a link would make "is this a name or a recipient?" ambiguous in the send field;
 *   <li>a name is unique;
 *   <li>an address lives under one name only, so the confirmation line can never name the wrong one.
 * </ul>
 *
 * <p>This class does not decide what a valid address is — that is the core's
 * ({@code parse_address}); the contacts screen asks it before calling {@link #add}.
 *
 * <p>Persisted as the CLI's file shape {@code {"entries": {name: address}}} through a
 * {@link Backing}: the app's is {@link EncryptedBlob} (EncryptedSharedPreferences), tests use memory.
 */
public final class Contacts {
    public static final String NAME_RULE = "a contact name is 1-64 characters and cannot start with rand1 or randpay:";

    /** Where the JSON lives. */
    public interface Backing {
        /** The stored JSON, or null when nothing is stored. */
        String read();

        void write(String json);
    }

    /** A refusal, with the CLI's sentence. */
    public static final class ContactException extends RuntimeException {
        public ContactException(String message) {
            super(message);
        }
    }

    public static final class Contact {
        public final String name;
        public final String address;

        Contact(String name, String address) {
            this.name = name;
            this.address = address;
        }
    }

    private final Backing backing;
    private final Map<String, String> entries;

    private Contacts(Backing backing, Map<String, String> entries) {
        this.backing = backing;
        this.entries = entries;
    }

    /** Read the book from {@code backing}; garbage reads as an empty book, never a crash. */
    public static Contacts open(Backing backing) {
        Map<String, String> entries = new HashMap<>();
        String json = null;
        try {
            json = backing.read();
        } catch (RuntimeException ignored) {
            // An unreadable store is an empty book.
        }
        if (json != null) {
            try {
                JSONObject e = new JSONObject(json).getJSONObject("entries");
                Iterator<String> keys = e.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    Object v = e.get(k);
                    if (v instanceof String && !((String) v).isEmpty()) entries.put(k, (String) v);
                }
            } catch (JSONException ignored) {
                entries.clear();
            }
        }
        return new Contacts(backing, entries);
    }

    /** Null if {@code name} is a name the CLI would accept, else the CLI's sentence. */
    public static String checkName(String name) {
        if (name == null) return NAME_RULE;
        int chars = name.codePointCount(0, name.length());
        String lower = name.toLowerCase(Locale.ROOT);
        if (chars == 0 || chars > 64 || lower.startsWith("rand1") || lower.startsWith("randpay:")) return NAME_RULE;
        return null;
    }

    public synchronized void add(String name, String address) {
        String bad = checkName(name);
        if (bad != null) throw new ContactException(bad);
        String addr = address == null ? "" : address.trim();
        if (addr.isEmpty()) throw new ContactException("a contact needs an address");
        if (entries.containsKey(name)) throw new ContactException("a contact named " + name + " exists");
        String other = nameOf(addr);
        if (other != null) throw new ContactException("this address is already saved as " + other);
        Map<String, String> next = new HashMap<>(entries);
        next.put(name, addr);
        save(next);
    }

    public synchronized void remove(String name) {
        if (!entries.containsKey(name)) throw new ContactException("no contact named " + name);
        Map<String, String> next = new HashMap<>(entries);
        next.remove(name);
        save(next);
    }

    /** Forget every contact (the wallet was removed). */
    public synchronized void clear() {
        save(new HashMap<>());
    }

    public synchronized String addressOf(String name) {
        return entries.get(name);
    }

    public synchronized String nameOf(String address) {
        if (address == null) return null;
        String addr = address.trim();
        for (Map.Entry<String, String> e : entries.entrySet()) {
            if (e.getValue().equals(addr)) return e.getKey();
        }
        return null;
    }

    /** Sorted by name in UTF-8 byte order (the CLI's BTreeMap order). */
    public synchronized List<Contact> sorted() {
        List<String> names = new ArrayList<>(entries.keySet());
        Collections.sort(names, Contacts::compareUtf8);
        List<Contact> out = new ArrayList<>();
        for (String n : names) out.add(new Contact(n, entries.get(n)));
        return out;
    }

    static int compareUtf8(String a, String b) {
        byte[] x = a.getBytes(StandardCharsets.UTF_8);
        byte[] y = b.getBytes(StandardCharsets.UTF_8);
        int n = Math.min(x.length, y.length);
        for (int i = 0; i < n; i++) {
            int c = (x[i] & 0xff) - (y[i] & 0xff);
            if (c != 0) return c;
        }
        return x.length - y.length;
    }

    /** Write first, then adopt: a failed write leaves the book as it was. */
    private void save(Map<String, String> next) {
        JSONObject e = new JSONObject();
        try {
            for (Map.Entry<String, String> kv : next.entrySet()) e.put(kv.getKey(), kv.getValue());
            backing.write(new JSONObject().put("entries", e).toString());
        } catch (JSONException x) {
            throw new ContactException("could not save contacts: " + x.getMessage());
        }
        entries.clear();
        entries.putAll(next);
    }
}
