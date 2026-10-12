package org.randprotocol.wallet.ui;

import org.json.JSONObject;
import org.randprotocol.wallet.wallet.SignFlow;

import java.util.List;

/**
 * One sign screen's checking state, apart from the activity so its ordering is JVM-tested (iOS
 * {@code CheckSession}): which text the review is of, which check is the latest, the payments, and
 * the last good summary the payment rows are drawn from. Main thread only.
 */
public final class CheckSession {
    /** One check as it was sent: its sequence number, the text, and the payments with their rows' snapshot. */
    public static final class Ticket {
        public final int id;
        public final String proposal;
        public final String sentKey;
        public final List<String> payees;

        Ticket(int id, String proposal, String sentKey, List<String> payees) {
            this.id = id;
            this.proposal = proposal;
            this.sentKey = sentKey;
            this.payees = payees;
        }
    }

    private PaymentsGate gate = new PaymentsGate();
    private SignReview review;
    private JSONObject lastSummary;
    private String typed = "";
    private String error;
    private boolean inFlight;
    private String reviewedProposal;
    private List<String> reviewedPayees = java.util.Collections.emptyList();
    private String sentProposal;
    /** Rises with every check and every edit, and is never reset: only the latest check lands. */
    private int latest;

    public PaymentsGate gate() {
        return gate;
    }

    public SignReview review() {
        return review;
    }

    /** The last summary the core gave, kept when a later check is refused so the rows stay editable. */
    public JSONObject lastSummary() {
        return lastSummary;
    }

    public String typed() {
        return typed;
    }

    public void setTyped(String t) {
        typed = t == null ? "" : t;
    }

    public String error() {
        return error;
    }

    public boolean inFlight() {
        return inFlight;
    }

    /** The exact text the shown review was checked on: the only text Sign signs. */
    public String reviewedProposal() {
        return reviewedProposal;
    }

    /** The intended payments the shown review was checked with: the list Sign sends. */
    public List<String> reviewedPayees() {
        return reviewedPayees;
    }

    /** A check starts for {@code proposal} with the payments last adopted; a new text starts the payments over. */
    public Ticket begin(String proposal) {
        if (!proposal.equals(sentProposal)) {
            gate.reset();
            lastSummary = null;
            sentProposal = proposal;
        }
        latest++;
        inFlight = true;
        error = null;
        return new Ticket(latest, proposal, gate.sentKey(), gate.payees());
    }

    /** A result lands; false when a newer check or an edit has superseded it. */
    public boolean land(Ticket t, JSONObject summary, SignFlow.Judgement j) {
        if (t.id != latest) return false;
        inFlight = false;
        if (summary != null) lastSummary = summary;
        gate.landed(t.sentKey);
        review = new SignReview(summary, j);
        reviewedProposal = t.proposal;
        reviewedPayees = t.payees;
        typed = "";
        return true;
    }

    /** The check threw (the core refused, e.g. a mistyped payee): no review, but the payments stay. */
    public boolean fail(Ticket t, String message) {
        if (t.id != latest) return false;
        inFlight = false;
        review = null;
        reviewedProposal = null;
        reviewedPayees = java.util.Collections.emptyList();
        typed = "";
        error = message;
        return true;
    }

    /**
     * The proposal text was edited: the review no longer describes it, and a check still out is
     * dropped. A text other than the one the payments were asked for also drops them.
     */
    public void proposalEdited(String text) {
        latest++;
        inFlight = false;
        review = null;
        reviewedProposal = null;
        reviewedPayees = java.util.Collections.emptyList();
        typed = "";
        error = null;
        if (!text.equals(sentProposal)) {
            gate.reset();
            lastSummary = null;
            sentProposal = null;
        }
    }

    /** A signature's refusal replaces the verdict on the same summary. */
    public void refused(SignFlow.Judgement j) {
        if (review != null) review = new SignReview(review.summary, j);
        typed = "";
    }

    public void clearError() {
        error = null;
    }

    /** The screen is going: everything dropped, the sequence kept rising so a late result is ignored. */
    public void close() {
        latest++;
        gate = new PaymentsGate();
        review = null;
        lastSummary = null;
        typed = "";
        error = null;
        inFlight = false;
        reviewedProposal = null;
        reviewedPayees = java.util.Collections.emptyList();
        sentProposal = null;
    }

    /** Sign is armed: signable, the last four typed, the payments unchanged since the check, and the editor holds the checked text. */
    public boolean canSign(String editor) {
        if (review == null || reviewedProposal == null || !reviewedProposal.equals(editor)) return false;
        return review.canSign(typed, gate.stale());
    }
}
