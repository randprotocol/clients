package org.randprotocol.wallet.ui;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Which payment rows the last check was sent for, and whether editing them since disarmed Sign
 * (iOS {@code PaymentsGate}). Editing any row sets {@link #stale}; only a check whose snapshot of
 * the rows, taken when it was sent, equals the rows when its result lands clears it. The top Check
 * and Retry resend the payments last adopted, with the snapshot those were built from, so they
 * cannot re-arm Sign after an edit.
 */
public final class PaymentsGate {
    private final List<SignRows.Row> rows = new ArrayList<>();
    private List<String> payees = Collections.emptyList();
    private String checkedKey;
    private boolean stale;

    public PaymentsGate() {
        reset();
    }

    /** The rows being edited; a caller that changes one calls {@link #edited}. */
    public List<SignRows.Row> rows() {
        return rows;
    }

    /** The entries last adopted ("Check payments"): what every check sends. */
    public List<String> payees() {
        return payees;
    }

    public boolean stale() {
        return stale;
    }

    public void edited() {
        stale = true;
    }

    public void addRow() {
        rows.add(new SignRows.Row());
        edited();
    }

    public void removeRow(SignRows.Row r) {
        rows.remove(r);
        edited();
    }

    /** "Check payments": the entries built from the rows as they are now. */
    public void adopt(List<String> entries) {
        payees = Collections.unmodifiableList(new ArrayList<>(entries));
        checkedKey = SignRows.key(rows);
    }

    /** A new proposal: its payments are asked again, from one empty row. */
    public void reset() {
        rows.clear();
        rows.add(new SignRows.Row());
        payees = Collections.emptyList();
        checkedKey = SignRows.key(rows);
        stale = false;
    }

    /** The rows a check is being sent for: those the adopted payees were built from. */
    public String sentKey() {
        return checkedKey;
    }

    /** A check's result arrived: stale if the rows moved since its snapshot (or were edited before). */
    public void landed(String sentKey) {
        stale = !sentKey.equals(SignRows.key(rows));
    }
}
