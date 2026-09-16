package org.randprotocol.wallet.ui;

import android.os.Bundle;
import android.view.View;

import org.randprotocol.wallet.R;
import org.randprotocol.wallet.databinding.ActivityDetailBinding;
import org.randprotocol.wallet.databinding.ViewDetailRowBinding;
import org.randprotocol.wallet.store.OwnedNote;
import org.randprotocol.wallet.store.SentRow;
import org.randprotocol.wallet.store.Submission;
import org.randprotocol.wallet.util.Amounts;

/** A received note, a sent row, or a submission with its "Disclose this payment" action. */
public class DetailActivity extends BaseActivity {
    public static final String EXTRA_KIND = "kind";
    public static final String EXTRA_REF = "ref";

    private ActivityDetailBinding b;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        b = ActivityDetailBinding.inflate(getLayoutInflater());
        setContentView(b.getRoot());
        String kind = getIntent().getStringExtra(EXTRA_KIND);
        String ref = getIntent().getStringExtra(EXTRA_REF);
        if (kind == null || ref == null) {
            finish();
            return;
        }
        synchronized (wallet().store()) {
            switch (ActivityItem.Kind.valueOf(kind)) {
                case RECEIVED:
                    received(wallet().store().noteByIndex(Long.parseLong(ref)));
                    break;
                case SENT:
                    sent(Long.parseLong(ref));
                    break;
                case SUBMISSION:
                    submission(wallet().store().submissionByHash(ref));
                    break;
            }
        }
    }

    private void row(int label, String value) {
        ViewDetailRowBinding r = ViewDetailRowBinding.inflate(getLayoutInflater(), b.rows, true);
        r.label.setText(label);
        r.value.setText(value);
    }

    private void received(OwnedNote n) {
        if (n == null) {
            finish();
            return;
        }
        b.kind.setText(R.string.detail_received);
        b.amount.setText("+" + Amounts.format(n.amount) + " RAND");
        row(R.string.detail_from, n.from);
        row(R.string.detail_leaf, String.valueOf(n.index));
        row(R.string.detail_height, String.valueOf(n.height));
        String status = n.spent ? getString(R.string.detail_spent) : n.pending != null ? getString(R.string.detail_held) : getString(R.string.detail_unspent);
        row(R.string.detail_status, status);
        b.explorer.setVisibility(View.VISIBLE);
        b.explorer.setOnClickListener(v -> open(EXPLORER + "/notes/" + n.cm));
    }

    private void sent(long index) {
        SentRow found = null;
        for (SentRow s : wallet().store().sent) if (s.index == index) found = s;
        if (found == null) {
            finish();
            return;
        }
        b.kind.setText(R.string.detail_sent);
        b.amount.setText("−" + Amounts.format(found.amount) + " RAND");
        row(R.string.detail_to, found.toPk);
        row(R.string.detail_leaf, String.valueOf(found.index));
        row(R.string.detail_height, String.valueOf(found.height));
    }

    private void submission(Submission s) {
        if (s == null) {
            finish();
            return;
        }
        b.kind.setText(Submission.PENDING.equals(s.status) ? R.string.detail_pending : R.string.detail_sent);
        b.amount.setText("−" + Amounts.format(s.amount) + " RAND");
        row(R.string.detail_to, s.to);
        row(R.string.sent_hash, s.hash);
        row(R.string.review_fee, Amounts.format(s.fee) + " RAND");
        String status;
        if (Submission.COMMITTED.equals(s.status)) status = getString(R.string.status_committed, s.height);
        else if (Submission.EXPIRED.equals(s.status)) status = getString(R.string.status_expired);
        else status = getString(R.string.status_pending);
        row(R.string.detail_status, status);
        b.explorer.setVisibility(View.VISIBLE);
        b.explorer.setOnClickListener(v -> open(EXPLORER + "/transactions/" + s.hash));
        if (s.txKey != null && !s.txKey.isEmpty()) {
            b.discloseNote.setVisibility(View.VISIBLE);
            b.disclose.setVisibility(View.VISIBLE);
            b.disclose.setOnClickListener(v -> {
                copy("transaction key", s.txKey, getString(R.string.tx_key_copied));
                open(EXPLORER + "/transactions/" + s.hash);
            });
        }
    }
}
