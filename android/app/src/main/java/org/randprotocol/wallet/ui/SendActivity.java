package org.randprotocol.wallet.ui;

import android.Manifest;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;
import android.widget.TextView;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AlertDialog;
import androidx.core.content.ContextCompat;

import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;

import org.randprotocol.wallet.R;
import org.randprotocol.wallet.databinding.ActivitySendBinding;
import org.randprotocol.wallet.store.Contacts;
import org.randprotocol.wallet.util.Amounts;
import org.randprotocol.wallet.wallet.ProvingService;
import org.randprotocol.wallet.wallet.SendMonitor;
import org.randprotocol.wallet.wallet.SendState;

import java.math.BigInteger;
import java.util.List;
import java.util.Locale;

/**
 * Send → Review → Proving → Sent, one activity, four pages of a ViewFlipper.
 *
 * <p>The recipient field takes a {@code rand1…} address, a {@code randpay:} link or a contact's
 * name, resolved in that order by {@link SendDraft#resolve} (spec 2026-09-26 §3). A link fills
 * the amount and memo the form leaves empty and a value given both ways and differing blocks
 * Review. A {@code randpay:} VIEW intent — from a browser, a chat, the scanner — lands here and
 * only fills the form: nothing is sent without the user's Review and Confirm.
 */
public class SendActivity extends BaseActivity {
    private static final int FORM = 0, REVIEW = 1, PROVING = 2, RESULT = 3;

    private ActivitySendBinding b;
    private final BigInteger fee = new BigInteger(Amounts.BUNDLE_BASE_FEE);
    /** Fixed at Review: what Confirm sends. */
    private String to;
    private BigInteger amount;
    private String memoToSend = "";
    /** The recipient field, resolved; null while empty or wrong. */
    private SendDraft.Resolved resolved;
    private String recipientError;
    /** Whether this chain carries a memo: only once {@code rand_getLimits} reports an envelope size. */
    private boolean memoSupported;
    private final SendDraft.LinkInbox inbox = new SendDraft.LinkInbox();
    private boolean updating;

    private ActivityResultLauncher<ScanOptions> scanner;
    private ActivityResultLauncher<String> cameraPermission;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            SendState s = SendMonitor.current();
            if (s.busy()) {
                long secs = (System.currentTimeMillis() - s.startedAtMs) / 1000;
                b.elapsed.setText(getString(R.string.proving_elapsed, String.format(Locale.US, "%d:%02d", secs / 60, secs % 60)));
                handler.postDelayed(this, 1000);
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (!wallet().hasWallet()) {
            // A link opened before any wallet exists: onboarding first; the link is not kept.
            startActivity(new Intent(this, LaunchActivity.class));
            finish();
            return;
        }
        b = ActivitySendBinding.inflate(getLayoutInflater());
        setContentView(b.getRoot());
        b.fee.setText(Amounts.format(fee) + " RAND");

        // A scanned code goes through the same resolution as a pasted one.
        scanner = registerForActivityResult(new ScanContract(), result -> {
            if (result.getContents() != null) b.to.setText(result.getContents().trim());
        });
        cameraPermission = registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
            if (granted) launchScanner();
            else toast(getString(R.string.send_camera_denied));
        });

        b.paste.setOnClickListener(v -> {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = cm.getPrimaryClip();
            if (clip != null && clip.getItemCount() > 0) b.to.setText(String.valueOf(clip.getItemAt(0).coerceToText(this)).trim());
        });
        b.scan.setOnClickListener(v -> scan());
        b.pickContact.setOnClickListener(v -> pickContact());
        b.max.setOnClickListener(v -> {
            BigInteger bal = wallet().store().balance().subtract(fee);
            b.amount.setText(bal.signum() > 0 ? Amounts.format(bal) : "0");
        });
        b.clearMemo.setOnClickListener(v -> b.memo.setText(""));
        b.to.addTextChangedListener(new Watcher(this::recipientChanged));
        b.amount.addTextChangedListener(new Watcher(this::refreshForm));
        b.memo.addTextChangedListener(new Watcher(this::refreshForm));
        b.review.setOnClickListener(v -> review());
        b.back.setOnClickListener(v -> showForm());
        b.confirm.setOnClickListener(v -> confirm());
        resetDoneButton();
        b.viewExplorer.setOnClickListener(v -> {
            SendState s = SendMonitor.current();
            if (s.hash != null) open(EXPLORER + "/transactions/" + s.hash);
        });
        b.copyKey.setOnClickListener(v -> {
            SendState s = SendMonitor.current();
            if (s.txKey != null) copy("transaction key", s.txKey, getString(R.string.tx_key_copied));
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (b.flipper.getDisplayedChild() == REVIEW) showForm();
                else leave();
            }
        });

        offerLink(getIntent());
        refreshForm();
        loadEnvelopeBytes();
        SendMonitor.state().observe(this, this::render);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // A link arriving while Send is open is taken by this Send — the last one wins.
        offerLink(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        b.available.setText(getString(R.string.send_available, Amounts.format(wallet().store().balance())));
        // Contacts may have changed while away; re-resolve a name.
        recipientChanged();
    }

    // ------------------------------------------------------------------ links

    private void offerLink(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
        Uri data = intent.getData();
        if (data == null || !"randpay".equalsIgnoreCase(data.getScheme())) return;
        inbox.offer(data.toString());
        takeLink();
    }

    /**
     * A waiting link replaces whatever the recipient field held, and fills the form — nothing
     * more: the user still reviews and confirms. Held while a proof runs or a result shows.
     */
    private void takeLink() {
        boolean onForm = b.flipper.getDisplayedChild() == FORM && !SendMonitor.current().busy();
        String link = inbox.take(onForm);
        if (link == null) return;
        updating = true;
        b.amount.setText("");
        b.memo.setText("");
        updating = false;
        b.to.setText(link);
    }

    private void resetDoneButton() {
        b.done.setText(R.string.sent_done);
        b.done.setOnClickListener(v -> {
            SendMonitor.reset();
            // A link that arrived while the last send finished opens a fresh form, not the home screen.
            if (inbox.hasPending()) showForm();
            else leave();
        });
    }

    /** Close Send; opened by a link as the task's root, land on the wallet rather than the launcher. */
    private void leave() {
        if (isTaskRoot()) startActivity(new Intent(this, HomeActivity.class));
        finish();
    }

    private void showForm() {
        b.flipper.setDisplayedChild(FORM);
        takeLink();
    }

    // ------------------------------------------------------------------ recipient

    private void recipientChanged() {
        if (b == null || updating) return;
        String s = String.valueOf(b.to.getText()).trim();
        if (s.isEmpty()) {
            resolved = null;
            recipientError = null;
        } else {
            try {
                resolved = SendDraft.resolve(s, wallet().contacts(), NativeCoreApi.INSTANCE);
                recipientError = null;
                if (resolved.link != null) {
                    SendDraft.Filled f = SendDraft.fill(resolved.link, String.valueOf(b.amount.getText()), String.valueOf(b.memo.getText()));
                    updating = true;
                    if (!f.amount.equals(String.valueOf(b.amount.getText()))) b.amount.setText(f.amount);
                    if (!f.memo.equals(String.valueOf(b.memo.getText()))) b.memo.setText(f.memo);
                    updating = false;
                }
            } catch (SendDraft.RecipientException e) {
                resolved = null;
                recipientError = e.getMessage();
            }
        }
        refreshForm();
    }

    private SendDraft.Conflicts conflicts() {
        if (resolved == null || resolved.link == null) return new SendDraft.Conflicts();
        return SendDraft.conflicts(resolved.link, String.valueOf(b.amount.getText()), String.valueOf(b.memo.getText()));
    }

    private void refreshForm() {
        if (b == null || updating) return;
        SendDraft.Conflicts c = conflicts();
        String memo = String.valueOf(b.memo.getText());

        if (resolved != null) {
            // A resolved contact's name is hostile text exactly as a memo is (final review,
            // finding — this live preview showed it raw; `SendDraft.confirmationLine` already
            // sanitises the same name on the review step below).
            String who = resolved.name != null ? Memo.display(resolved.name + " · ") : "";
            String kind = resolved.link != null ? getString(R.string.send_payment_link) : "";
            b.recipientInfo.setText(kind + who + "fingerprint " + resolved.fingerprint);
            b.recipientInfo.setVisibility(View.VISIBLE);
        } else {
            b.recipientInfo.setVisibility(View.GONE);
        }
        show(b.toError, recipientError != null ? recipientError : c.to);

        BigInteger units = Amounts.parse(String.valueOf(b.amount.getText()));
        String amountError = c.amount;
        if (amountError == null && units != null && units.add(fee).compareTo(wallet().store().balance()) > 0) {
            amountError = getString(R.string.send_over_balance);
        }
        show(b.amountError, amountError);

        // The memo: a field with its byte counter on a chain that carries one; otherwise a memo a
        // link brought is shown as not-sent and blocks Review until it is cleared.
        b.memoGroup.setVisibility(memoSupported ? View.VISIBLE : View.GONE);
        boolean blocked = SendDraft.memoBlocksContinue(memoSupported, memo);
        b.memoNoticeGroup.setVisibility(blocked ? View.VISIBLE : View.GONE);
        b.memoNotice.setText(Memo.NO_MEMO_NOTICE);
        b.memoCounter.setText(Memo.counter(memo));
        b.memoCounter.setTextColor(getColor(Memo.tooLong(memo) == null ? R.color.text_mute : R.color.negative));
        show(b.memoError, Memo.tooLong(memo) != null ? Memo.tooLong(memo) : c.memo);

        boolean valid = resolved != null && recipientError == null && !c.any()
                && units != null && units.signum() > 0 && units.add(fee).compareTo(wallet().store().balance()) <= 0
                && Memo.tooLong(memo) == null && !blocked;
        b.review.setEnabled(valid);
    }

    private static void show(TextView v, String text) {
        v.setText(text == null ? "" : text);
        v.setVisibility(text == null ? View.GONE : View.VISIBLE);
    }

    private void loadEnvelopeBytes() {
        new Thread(() -> {
            Integer bytes;
            try {
                bytes = wallet().envelopeBytes();
            } catch (Exception e) {
                bytes = null; // unknown hides the field, as on iOS
            }
            boolean supported = SendDraft.memoSupported(bytes);
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                memoSupported = supported;
                refreshForm();
            });
        }, "limits").start();
    }

    // ------------------------------------------------------------------ scan and contacts

    private void scan() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            launchScanner();
        } else {
            cameraPermission.launch(Manifest.permission.CAMERA);
        }
    }

    private void launchScanner() {
        ScanOptions o = new ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt(getString(R.string.send_scan_prompt))
                .setBeepEnabled(false)
                .setOrientationLocked(false);
        scanner.launch(o);
    }

    private void pickContact() {
        List<Contacts.Contact> list = wallet().contacts().sorted();
        if (list.isEmpty()) {
            new AlertDialog.Builder(this).setTitle(R.string.contacts_title).setMessage(R.string.send_no_contacts)
                    .setPositiveButton(R.string.ok, null).show();
            return;
        }
        String[] names = new String[list.size()];
        String[] shown = new String[list.size()];
        for (int i = 0; i < names.length; i++) {
            names[i] = list.get(i).name;
            // The dialog shows the sanitised form; picking one still fills the To field with the
            // real name, unchanged, so the later lookup by name still matches (final review,
            // finding — this list showed names raw).
            shown[i] = Memo.display(names[i]);
        }
        new AlertDialog.Builder(this).setTitle(R.string.contacts_title)
                .setItems(shown, (d, which) -> b.to.setText(names[which]))
                .setNegativeButton(R.string.cancel, null).show();
    }

    // ------------------------------------------------------------------ review and send

    private void review() {
        refreshForm();
        if (!b.review.isEnabled() || resolved == null) return;
        amount = Amounts.parse(String.valueOf(b.amount.getText()));
        if (amount == null || amount.signum() <= 0) {
            b.formError.setText(R.string.send_bad_amount);
            return;
        }
        // What Confirm sends is exactly what the confirmation line names: the resolved address and
        // the fingerprint resolved with it.
        to = resolved.address;
        memoToSend = memoSupported ? String.valueOf(b.memo.getText()) : "";
        b.formError.setText("");
        try {
            wallet().planTransfer(amount, fee);
            b.reviewError.setText("");
            b.confirm.setEnabled(true);
        } catch (Exception e) {
            b.reviewError.setText(e.getMessage());
            b.confirm.setEnabled(false);
        }
        b.rAmount.setText(Amounts.format(amount) + " RAND");
        b.rTo.setText(Amounts.shortAddress(to));
        b.rFee.setText(Amounts.format(fee) + " RAND");
        b.rTotal.setText(Amounts.format(amount.add(fee)) + " RAND");
        b.rConfirm.setText(SendDraft.confirmationLine(resolved.name, resolved.fingerprint, Amounts.format(amount), SendDraft.SYMBOL));
        b.rMemo.setText(SendDraft.memoLine(memoToSend));
        showMemoryWarning();
        b.flipper.setDisplayedChild(REVIEW);
    }

    /** Peak memory of a bundle proof: mirrors {@code wallet_core::PROVER_PEAK_MEMORY_BYTES} (measured 2026-09-20, chain 14). */
    static final long PROVER_PEAK_MEMORY_BYTES = 5_700_000_000L;

    /** Android lets a foreground app use well under the whole of RAM; two thirds is generous. */
    private void showMemoryWarning() {
        android.app.ActivityManager am = (android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE);
        android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        boolean enough = mi.totalMem / 3 * 2 >= PROVER_PEAK_MEMORY_BYTES;
        b.memoryWarning.setVisibility(enough ? android.view.View.GONE : android.view.View.VISIBLE);
        if (!enough) {
            b.memoryWarning.setText(getString(R.string.review_memory_warning,
                    String.format(Locale.US, "%.1f", PROVER_PEAK_MEMORY_BYTES / 1e9),
                    String.format(Locale.US, "%.0f", mi.totalMem / 1e9)));
        }
    }

    private void confirm() {
        Intent i = new Intent(this, ProvingService.class)
                .putExtra(ProvingService.EXTRA_TO, to)
                .putExtra(ProvingService.EXTRA_AMOUNT, amount.toString())
                .putExtra(ProvingService.EXTRA_FEE, fee.toString())
                .putExtra(ProvingService.EXTRA_MEMO, memoToSend);
        ContextCompat.startForegroundService(this, i);
        b.flipper.setDisplayedChild(PROVING);
    }

    private void render(SendState s) {
        switch (s.phase) {
            case IDLE:
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                takeLink();
                break;
            case PREPARING:
            case PROVING:
            case SUBMITTING:
            case WAITING_COMMIT:
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                b.flipper.setDisplayedChild(PROVING);
                b.provingPhase.setText(s.message);
                handler.removeCallbacks(tick);
                handler.post(tick);
                break;
            case DONE:
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                b.flipper.setDisplayedChild(RESULT);
                resetDoneButton();
                b.resultIcon.setImageResource(R.drawable.ic_check);
                b.resultTitle.setText(R.string.sent_title);
                b.resultAmount.setText("−" + Amounts.format(s.amount) + " RAND");
                b.resultMessage.setText(s.message);
                b.resultHash.setText(s.hash);
                b.resultDetails.setVisibility(View.VISIBLE);
                b.viewExplorer.setVisibility(View.VISIBLE);
                b.copyKey.setVisibility(View.VISIBLE);
                break;
            case FAILED:
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                b.flipper.setDisplayedChild(RESULT);
                b.resultIcon.setImageResource(R.drawable.ic_arrow_up);
                b.resultTitle.setText(R.string.sent_failed);
                b.resultAmount.setText("");
                b.resultMessage.setText(s.message);
                b.resultDetails.setVisibility(View.GONE);
                b.viewExplorer.setVisibility(View.GONE);
                b.copyKey.setVisibility(View.GONE);
                b.done.setText(R.string.sent_try_again);
                b.done.setOnClickListener(v -> {
                    SendMonitor.reset();
                    resetDoneButton();
                    showForm();
                });
                break;
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        handler.removeCallbacks(tick);
    }
}
