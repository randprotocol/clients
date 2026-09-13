package org.randprotocol.wallet.ui;

import org.randprotocol.wallet.core.Core;
import org.randprotocol.wallet.store.NoteStore;
import org.randprotocol.wallet.store.OwnedNote;
import org.randprotocol.wallet.store.SentRow;
import org.randprotocol.wallet.store.Submission;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** One row of the home screen's activity list: a received note, a sent payment, or a submission. */
public final class ActivityItem {
    public enum Kind { RECEIVED, SENT, SUBMISSION }

    public final Kind kind;
    public final String amount;
    public final long height;
    public final long sortKey;
    public final boolean pending;
    public final boolean spent;
    /** Leaf index for a note or sent row; the hash for a submission. */
    public final String ref;

    private ActivityItem(Kind kind, String amount, long height, long sortKey, boolean pending, boolean spent, String ref) {
        this.kind = kind;
        this.amount = amount;
        this.height = height;
        this.sortKey = sortKey;
        this.pending = pending;
        this.spent = spent;
        this.ref = ref;
    }

    /**
     * The list, newest first. A sent row the scan found for a payment this app submitted itself
     * is folded into the submission (matched on time, amount and recipient pk), so one transfer
     * is one row.
     */
    public static List<ActivityItem> build(NoteStore store) {
        List<ActivityItem> out = new ArrayList<>();
        Set<String> covered = new HashSet<>();
        for (Submission s : store.submissions) {
            String pk = pkOf(s.to);
            covered.add(s.time + "/" + s.amount + "/" + pk);
            long sort = s.height > 0 ? s.height * 1000 + 999 : Long.MAX_VALUE - 1;
            out.add(new ActivityItem(Kind.SUBMISSION, s.amount, s.height, sort, Submission.PENDING.equals(s.status), false, s.hash));
        }
        for (SentRow r : store.sent) {
            if (covered.contains(r.time + "/" + r.amount + "/" + r.toPk)) continue;
            out.add(new ActivityItem(Kind.SENT, r.amount, r.height, r.height * 1000 + (r.index % 1000), false, false, String.valueOf(r.index)));
        }
        for (OwnedNote n : store.notes) {
            if (n.units().signum() == 0) continue; // a zero change note is a leaf, not an event
            out.add(new ActivityItem(Kind.RECEIVED, n.amount, n.height, n.height * 1000 + (n.index % 1000), n.pending != null, n.spent, String.valueOf(n.index)));
        }
        Collections.sort(out, (a, b) -> Long.compare(b.sortKey, a.sortKey));
        return out;
    }

    private static String pkOf(String address) {
        try {
            return Core.parseAddress(address).optString("pk", "");
        } catch (Exception e) {
            return "";
        }
    }
}
