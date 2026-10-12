package org.randprotocol.wallet.ui;

import org.json.JSONArray;
import org.json.JSONObject;
import org.randprotocol.wallet.util.Amounts;
import org.randprotocol.wallet.wallet.SignFlow;

import java.util.List;

/**
 * What the sign screen shows of one check (iOS {@code SignProposalModel}): the core's lines
 * verbatim, the refusal's sentence, and whether Sign may be pressed. Every read of the summary is
 * tolerant: a malformed summary shows its refusal and nothing else, never a crash.
 */
public final class SignReview {
    /** The core's reply; null when it was not a JSON object. */
    public final JSONObject summary;
    public final SignFlow.Judgement judgement;

    public SignReview(JSONObject summary, SignFlow.Judgement judgement) {
        this.summary = summary;
        this.judgement = judgement;
    }

    /** fullnode's lines, verbatim (never translated). */
    public List<String> lines() {
        return SignFlow.lines(summary);
    }

    /** A summary the core did not shape as expected (no list of lines, no list of outputs) is shown as its refusal alone. */
    public boolean showsSummary() {
        if (summary == null || !(summary.opt("lines") instanceof JSONArray) || !(summary.opt("outputs") instanceof JSONArray)) return false;
        JSONArray lines = (JSONArray) summary.opt("lines");
        for (int i = 0; i < lines.length(); i++) if (!(lines.opt(i) instanceof String)) return false;
        return true;
    }

    /** The refusal's sentence in the user's language; null when signable. */
    public String refusal() {
        return judgement.message();
    }

    public static boolean retryable(SignFlow.Verdict v) {
        return v == SignFlow.Verdict.NO_NODE;
    }

    /** No node answered: Retry asks again. */
    public boolean retryable() {
        return retryable(judgement.verdict);
    }

    /** Signable, the payments unchanged since the check, and the fingerprint's last four typed (dashes and case ignored). */
    public boolean canSign(String typed, boolean stale) {
        if (stale || !judgement.signable() || summary == null) return false;
        Object fp = summary.opt("policy_fingerprint");
        return fp instanceof String && SignFlow.confirms((String) fp, typed);
    }

    public long blocksLeft() {
        return judgement.blocksLeft;
    }

    public int payingTotal() {
        return SignRows.payingTotal(summary);
    }

    public int payingMatched() {
        return SignRows.payingMatched(summary);
    }

    /** The fee in RAND ("0.001"); "0" when the summary carries none it can read. */
    public String fee() {
        Object f = summary == null ? null : summary.opt("fee");
        String units = f instanceof Number || f instanceof String ? String.valueOf(f).trim() : "";
        return units.matches("\\d+") ? Amounts.format(units) : "0";
    }

    /** The expiry height as text; "?" when the summary carries none it can read. */
    public String expiresAt() {
        Object e = summary == null ? null : summary.opt("expires_at");
        String t = e instanceof Number ? String.valueOf(e) : "";
        return t.matches("\\d+") ? t : "?";
    }
}
