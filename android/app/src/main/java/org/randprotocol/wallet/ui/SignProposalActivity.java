package org.randprotocol.wallet.ui;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.View;
import android.view.WindowManager;
import android.widget.TextView;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;

import org.json.JSONObject;
import org.randprotocol.wallet.R;
import org.randprotocol.wallet.databinding.ActivitySignProposalBinding;
import org.randprotocol.wallet.databinding.ItemPaymentRowBinding;
import org.randprotocol.wallet.rpc.RpcClient;
import org.randprotocol.wallet.security.KeystoreSeedSource;
import org.randprotocol.wallet.security.Prefs;
import org.randprotocol.wallet.security.SignerProfiles;
import org.randprotocol.wallet.util.L10n;
import org.randprotocol.wallet.wallet.NativeMsauthCore;
import org.randprotocol.wallet.wallet.SignFlow;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.Executors;

/**
 * Sign a private-multisig proposal (spec 2026-10-11-msauth-signing-design.md §4; iOS
 * SignProposalView, ui/screens/signers.js): paste or open proposal.json, enter the intended
 * payments, review exactly what the core checked (its lines verbatim), type the fingerprint's last
 * four, authenticate, share. The decisions are {@link CheckSession}'s (JVM-tested); a signature
 * goes only through {@link SignFlow#sign}, which re-checks, prompts, re-reads the head and zeroes
 * the seed. The proposal lives in this activity only and is dropped in onDestroy.
 */
public class SignProposalActivity extends BaseActivity {
    public static final String EXTRA_ID = "id";

    private ActivitySignProposalBinding b;
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private final CheckSession session = new CheckSession();
    private String id;
    private SignerProfiles.Profile profile;
    private int threshold;
    private SignFlow flow;
    private ActivityResultLauncher<String[]> openProposal;

    // The signature in progress.
    private boolean signing;
    private Thread signThread;
    /** The signature in progress's own cancel flag: a new signature never un-cancels an old one. */
    private AtomicBoolean signCancel = new AtomicBoolean();
    /** The prompt of the signature in progress (a cancelled prompt stays cancelled, so each signature has its own). */
    private volatile CryptoPrompt prompt;
    private boolean promptUp;
    private SignFlow.Share share;
    private String rowError;
    /** A file's or a signature's failure, shown under the proposal until the next check or edit. */
    private String note;
    private final TreeSet<Integer> inHand = new TreeSet<>();
    /** The review the screen last drew, so a repaint does not rebuild it (and its typed text). */
    private SignReview painted;
    /** Set while the screen writes a field itself: its watcher is not an edit. */
    private boolean writing;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        b = ActivitySignProposalBinding.inflate(getLayoutInflater());
        setContentView(b.getRoot());
        id = getIntent().getStringExtra(EXTRA_ID);
        SignerProfiles profiles = wallet().vault().signerProfiles();
        for (SignerProfiles.Profile p : profiles.list()) if (p.id.equals(id)) profile = p;
        if (profile == null) {
            b.profileLabel.setText(L10n.t(R.string.msauth_no_profile, "No such signer profile."));
            b.checkProposal.setEnabled(false);
            b.openFile.setEnabled(false);
            b.checkShare.setEnabled(false);
            return;
        }
        b.profileLabel.setText(profile.label);
        String policy = profiles.policy(id);
        work.execute(() -> {
            JSONObject info;
            try {
                info = NativeMsauthCore.INSTANCE.msauthPolicyInfo(policy);
            } catch (Exception e) {
                info = new JSONObject();
            }
            JSONObject i = info;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                threshold = i.optInt("threshold");
                b.profileFp.setText(i.optString("fingerprint"));
                b.profilePosition.setText(SignersActivity.position(threshold, i.optInt("signers"), profile.index));
            });
        });

        Prefs prefs = wallet().prefs();
        flow = new SignFlow(profiles, NativeMsauthCore.INSTANCE, SignFlow.node(new RpcClient(prefs.rpcUrl())), prefs.chainId(),
                new KeystoreSeedSource(profiles, cipher -> {
                    CryptoPrompt p = prompt;
                    if (p == null) throw new CancellationException();
                    return p.authenticate(cipher);
                }));

        openProposal = registerForActivityResult(new ActivityResultContracts.OpenDocument(), this::picked);
        b.openFile.setOnClickListener(v -> openProposal.launch(new String[] {"application/json", "text/plain"}));
        b.proposal.addTextChangedListener(watcher(() -> {
            // The review describes the text that was checked: editing the text drops it until a new check.
            session.proposalEdited(editor());
            share = null;
            note = null;
            rowError = null;
            paintRows();
            paint();
        }));
        b.checkProposal.setOnClickListener(v -> startCheck());
        b.retry.setOnClickListener(v -> startCheck());
        b.addPayment.setOnClickListener(v -> {
            if (signing) return;
            session.gate().addRow();
            paintRows();
            paint();
        });
        b.checkPayments.setOnClickListener(v -> checkPayments());
        b.confirm.addTextChangedListener(watcher(() -> {
            session.setTyped(String.valueOf(b.confirm.getText()));
            paint();
        }));
        b.sign.setOnClickListener(v -> sign());
        b.copyShare.setOnClickListener(v -> {
            if (share != null) copy(getString(R.string.msauth_share_subject), share.share, getString(R.string.copied));
        });
        b.sendShare.setOnClickListener(v -> {
            if (share == null) return;
            Intent i = new Intent(Intent.ACTION_SEND).setType("text/plain")
                    .putExtra(Intent.EXTRA_TEXT, share.share)
                    .putExtra(Intent.EXTRA_SUBJECT, getString(R.string.msauth_share_subject));
            startActivity(Intent.createChooser(i, getString(R.string.msauth_share)));
        });
        b.checkShare.setOnClickListener(v -> verifyShare());
        paintRows();
        paint();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        CryptoPrompt p = prompt;
        if (p != null) p.windowFocus(hasFocus);
    }

    @Override
    protected void onStop() {
        super.onStop();
        // Leaving the screen stops a signature in progress. While the system's prompt is up the
        // screen can be stopped by the prompt itself (the screen-lock entry on some devices): the
        // prompt is then the one that ends, and a dismissed prompt stops the signature.
        if (signing && (!promptUp || isFinishing())) cancelSign();
    }

    @Override
    protected void onDestroy() {
        cancelSign();
        work.shutdownNow();
        // The proposal carries the account's witness: it is never stored and goes with the screen.
        session.close();
        share = null;
        if (b != null) {
            writing = true;
            b.proposal.setText("");
            b.shareText.setText("");
            writing = false;
        }
        super.onDestroy();
    }

    private void cancelSign() {
        signCancel.set(true);
        CryptoPrompt p = prompt;
        if (p != null) p.cancel();
        Thread t = signThread;
        if (t != null) t.interrupt();
    }

    private String editor() {
        return String.valueOf(b.proposal.getText());
    }

    private interface Edit {
        void edited();
    }

    private TextWatcher watcher(Edit e) {
        return new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int st, int c, int a) {}

            @Override public void onTextChanged(CharSequence s, int st, int bf, int c) {}

            @Override public void afterTextChanged(Editable s) {
                if (!writing) e.edited();
            }
        };
    }

    // ------------------------------------------------------------------ files

    private void picked(Uri uri) {
        if (uri == null) return;
        work.execute(() -> {
            String text = null, err = null;
            try (InputStream in = getContentResolver().openInputStream(uri)) {
                text = PickedFile.read(sizeOf(uri), in);
            } catch (IllegalArgumentException e) {
                err = e.getMessage();
            } catch (Exception e) {
                err = PickedFile.unreadable();
            }
            String t = text, m = err;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (t != null && !signing) b.proposal.setText(t);
                if (m != null) showError(m);
            });
        });
    }

    private long sizeOf(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, new String[] {OpenableColumns.SIZE}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
        } catch (Exception ignored) {
            // unknown: the read itself stops past the cap
        }
        return -1;
    }

    // ------------------------------------------------------------------ checking

    /** "Check payments": the entries from the rows (each with its own amount rule), then a check with them. */
    private void checkPayments() {
        if (session.inFlight() || signing) return;
        try {
            List<String> entries = SignRows.entries(session.gate().rows(), session.lastSummary());
            rowError = null;
            session.gate().adopt(entries);
        } catch (IllegalArgumentException e) {
            rowError = e.getMessage();
            paint();
            return;
        }
        startCheck();
    }

    /**
     * The top Check and Retry send the payments last adopted, with the rows' snapshot those came
     * from, so edits since keep Sign off. Only the latest check's result is applied.
     */
    private void startCheck() {
        if (session.inFlight() || signing || flow == null || editor().isEmpty()) return;
        share = null;
        note = null;
        CheckSession.Ticket t = session.begin(editor());
        // A new proposal text started the payments over.
        paintRows();
        paint();
        work.execute(() -> {
            try {
                SignFlow.Check c = flow.check(id, t.proposal, t.payees);
                runOnUiThread(() -> {
                    if (session.land(t, c.summary, c.judgement)) landed();
                });
            } catch (Exception e) {
                String m = CoreErrors.of(e);
                runOnUiThread(() -> {
                    if (session.fail(t, m)) landed();
                });
            }
        });
    }

    private void landed() {
        if (isFinishing() || isDestroyed()) return;
        paintRows();
        paint();
    }

    // ------------------------------------------------------------------ signing

    private void sign() {
        String text = session.reviewedProposal();
        if (signing || session.inFlight() || text == null || !session.canSign(editor())) return;
        List<String> payees = session.reviewedPayees();
        signing = true;
        paintRows();
        AtomicBoolean cancel = new AtomicBoolean();
        signCancel = cancel;
        prompt = new CryptoPrompt(this, getString(R.string.msauth_sign_reason), up -> promptUp = up);
        session.clearError();
        note = null;
        paint();
        signThread = new Thread(() -> {
            SignFlow.Share made = null;
            SignFlow.Judgement refusal = null;
            String error = null;
            try {
                made = flow.sign(id, text, payees, cancel::get);
            } catch (SignFlow.Refusal r) {
                refusal = r.judgement;
            } catch (CancellationException e) {
                // left the screen, or the prompt was dismissed: nothing to show
            } catch (CryptoPrompt.Failed f) {
                if (!f.dismissed()) error = f.getMessage();
            } catch (KeyPermanentlyInvalidatedException e) {
                error = L10n.t(R.string.msauth_key_invalidated, "This signer's key no longer opens: the phone's fingerprints or screen lock changed since it was saved. Remove the signer and add it again from its key file.");
            } catch (Exception e) {
                error = CoreErrors.of(e);
            }
            SignFlow.Share s = made;
            SignFlow.Judgement r = refusal;
            String m = error;
            runOnUiThread(() -> {
                signThread = null;
                signing = false;
                prompt = null;
                if (!isDestroyed()) paintRows();
                if (isFinishing() || isDestroyed() || cancel.get()) {
                    paintIfAlive();
                    return;
                }
                if (s != null) {
                    share = s;
                    writing = true;
                    b.confirm.setText("");
                    writing = false;
                    session.setTyped("");
                } else if (r != null) {
                    session.refused(r);
                } else if (m != null) {
                    note = m;
                }
                paint();
            });
        }, "msauth-sign");
        signThread.start();
    }

    private void paintIfAlive() {
        if (!isFinishing() && !isDestroyed()) paint();
    }

    private void verifyShare() {
        if (profile == null) return;
        String proposal = session.reviewedProposal() != null ? session.reviewedProposal() : editor();
        String given = String.valueOf(b.shareIn.getText());
        work.execute(() -> {
            Integer index = null;
            String error = null;
            try {
                index = flow.verifyShare(id, proposal, given);
            } catch (Exception e) {
                error = CoreErrors.of(e);
            }
            Integer i = index;
            String m = error;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (i == null) {
                    b.verifyOut.setText(m);
                    return;
                }
                inHand.add(i);
                List<String> list = new ArrayList<>();
                for (Integer n : inHand) list.add(String.valueOf(n));
                b.verifyOut.setText(L10n.t(R.string.msauth_share_verifies, "Signer %1$s's share verifies. %2$s of %3$s in hand: signers %4$s.",
                        String.valueOf(i), String.valueOf(inHand.size()), String.valueOf(threshold), String.join(", ", list)));
            });
        });
    }

    // ------------------------------------------------------------------ painting

    private void showError(String m) {
        note = m;
        paint();
    }

    /** The row objects the views below were built for, and their views, in order. */
    private final List<SignRows.Row> paintedRows = new ArrayList<>();
    private final List<ItemPaymentRowBinding> rowViews = new ArrayList<>();

    /**
     * The payment rows' fields: rebuilt only when the gate's rows are other row objects than those
     * drawn (a row added or removed, the payments started over), so a landing check never
     * interrupts typing; otherwise only each row's note and enabled state are refreshed.
     */
    private void paintRows() {
        List<SignRows.Row> rows = session.gate().rows();
        boolean same = rows.size() == paintedRows.size();
        for (int k = 0; same && k < rows.size(); k++) same = rows.get(k) == paintedRows.get(k);
        if (!same) {
            b.paymentRows.removeAllViews();
            paintedRows.clear();
            rowViews.clear();
            for (SignRows.Row row : rows) {
                ItemPaymentRowBinding r = ItemPaymentRowBinding.inflate(getLayoutInflater(), b.paymentRows, false);
                r.addr.setText(row.addr);
                r.amount.setText(row.amount);
                r.addr.addTextChangedListener(watcher(() -> {
                    row.addr = String.valueOf(r.addr.getText());
                    session.gate().edited();
                    r.nonrandNote.setVisibility(SignRows.amountOptional(row, session.lastSummary()) ? View.VISIBLE : View.GONE);
                    paint();
                }));
                r.amount.addTextChangedListener(watcher(() -> {
                    row.amount = String.valueOf(r.amount.getText());
                    session.gate().edited();
                    paint();
                }));
                r.remove.setOnClickListener(v -> {
                    if (signing) return;
                    session.gate().removeRow(row);
                    paintRows();
                    paint();
                });
                b.paymentRows.addView(r.getRoot());
                paintedRows.add(row);
                rowViews.add(r);
            }
        }
        for (int k = 0; k < rows.size(); k++) {
            ItemPaymentRowBinding r = rowViews.get(k);
            r.nonrandNote.setVisibility(SignRows.amountOptional(rows.get(k), session.lastSummary()) ? View.VISIBLE : View.GONE);
            r.addr.setEnabled(!signing);
            r.amount.setEnabled(!signing);
            r.remove.setEnabled(!signing);
        }
    }

    /** Every state the screen shows, from the session and the signature in progress. */
    private void paint() {
        boolean busy = session.inFlight() || signing;
        boolean hasProfile = profile != null;
        b.proposal.setEnabled(!signing);
        b.openFile.setEnabled(!signing && hasProfile);
        b.checkProposal.setEnabled(!busy && hasProfile && !editor().isEmpty());
        b.checkProposal.setText(session.inFlight() ? R.string.msauth_checking : R.string.msauth_check_proposal);
        SignersActivity.show(b.error, session.error() != null ? session.error() : note);

        // Payments: while the last good summary has something to pay for.
        b.payments.setVisibility(SignRows.showsPayments(session.lastSummary()) ? View.VISIBLE : View.GONE);
        b.checkPayments.setEnabled(!busy);
        b.addPayment.setEnabled(!signing);
        SignersActivity.show(b.rowError, rowError);

        SignReview r = session.review();
        b.review.setVisibility(r == null ? View.GONE : View.VISIBLE);
        if (r != painted) {
            painted = r;
            if (r != null) paintReview(r);
        }
        if (r != null) {
            boolean refused = r.refusal() != null;
            b.refused.setVisibility(refused ? View.VISIBLE : View.GONE);
            b.signable.setVisibility(refused ? View.GONE : View.VISIBLE);
            b.retry.setEnabled(!busy);
            b.staleNote.setVisibility(session.gate().stale() ? View.VISIBLE : View.GONE);
            b.confirm.setEnabled(!signing);
            b.sign.setEnabled(!busy && session.canSign(editor()));
            b.sign.setText(signing ? R.string.msauth_signing : R.string.msauth_sign);
        }

        b.shareBox.setVisibility(share == null ? View.GONE : View.VISIBLE);
        b.shareText.setText(share == null ? "" : share.share);
    }

    private void paintReview(SignReview r) {
        b.summary.setVisibility(r.showsSummary() ? View.VISIBLE : View.GONE);
        b.lines.removeAllViews();
        if (r.showsSummary()) {
            for (String line : r.lines()) {
                TextView t = new TextView(this);
                t.setTextAppearance(R.style.Text_Mono);
                t.setTextSize(12);
                t.setTextIsSelectable(true);
                t.setText(line); // verbatim
                t.setPadding(0, 2, 0, 2);
                b.lines.addView(t);
            }
            b.fee.setText(L10n.t(R.string.msauth_fee_line, "Fee: %1$s RAND · expires at height %2$s", r.fee(), r.expiresAt()));
            b.matched.setText(L10n.t(R.string.msauth_matched, "%1$s of %2$s payments matched.", String.valueOf(r.payingMatched()), String.valueOf(r.payingTotal())));
        }
        b.refusal.setText(r.refusal() == null ? "" : r.refusal());
        b.blocksLeft.setText(r.refusal() == null ? L10n.t(R.string.msauth_blocks_left, "%1$s blocks left to prove it.", String.valueOf(r.blocksLeft())) : "");
        writing = true;
        b.confirm.setText(session.typed());
        writing = false;
    }
}
