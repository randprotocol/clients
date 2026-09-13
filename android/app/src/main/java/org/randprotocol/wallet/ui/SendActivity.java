package org.randprotocol.wallet.ui;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;

import androidx.core.content.ContextCompat;

import org.json.JSONObject;
import org.randprotocol.wallet.R;
import org.randprotocol.wallet.core.Core;
import org.randprotocol.wallet.databinding.ActivitySendBinding;
import org.randprotocol.wallet.util.Amounts;
import org.randprotocol.wallet.wallet.ProvingService;
import org.randprotocol.wallet.wallet.SendMonitor;
import org.randprotocol.wallet.wallet.SendState;

import java.math.BigInteger;
import java.util.Locale;

/** Send → Review → Proving → Sent, one activity, four pages of a ViewFlipper. */
public class SendActivity extends BaseActivity {
    private static final int FORM = 0, REVIEW = 1, PROVING = 2, RESULT = 3;

    private ActivitySendBinding b;
    private final BigInteger fee = new BigInteger(Amounts.BUNDLE_BASE_FEE);
    private String to;
    private BigInteger amount;
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
        b = ActivitySendBinding.inflate(getLayoutInflater());
        setContentView(b.getRoot());
        b.fee.setText(Amounts.format(fee) + " SHRUGG");
        b.paste.setOnClickListener(v -> {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = cm.getPrimaryClip();
            if (clip != null && clip.getItemCount() > 0) b.to.setText(String.valueOf(clip.getItemAt(0).coerceToText(this)));
        });
        b.max.setOnClickListener(v -> {
            BigInteger bal = wallet().store().balance().subtract(fee);
            b.amount.setText(bal.signum() > 0 ? Amounts.format(bal) : "0");
        });
        b.review.setOnClickListener(v -> review());
        b.back.setOnClickListener(v -> b.flipper.setDisplayedChild(FORM));
        b.confirm.setOnClickListener(v -> confirm());
        b.done.setOnClickListener(v -> {
            SendMonitor.reset();
            finish();
        });
        b.viewExplorer.setOnClickListener(v -> {
            SendState s = SendMonitor.current();
            if (s.hash != null) open(EXPLORER + "/transactions/" + s.hash);
        });
        b.copyKey.setOnClickListener(v -> {
            SendState s = SendMonitor.current();
            if (s.txKey != null) copy("transaction key", s.txKey, getString(R.string.tx_key_copied));
        });

        SendMonitor.state().observe(this, this::render);
    }

    @Override
    protected void onResume() {
        super.onResume();
        b.available.setText(getString(R.string.send_available, Amounts.format(wallet().store().balance())));
    }

    private void review() {
        to = String.valueOf(b.to.getText()).trim();
        amount = Amounts.parse(String.valueOf(b.amount.getText()));
        if (!Core.isValidAddress(to)) {
            b.formError.setText(R.string.send_bad_address);
            return;
        }
        if (amount == null || amount.signum() <= 0) {
            b.formError.setText(R.string.send_bad_amount);
            return;
        }
        b.formError.setText("");
        try {
            JSONObject plan = wallet().planTransfer(amount, fee);
            b.reviewError.setText("");
            b.confirm.setEnabled(true);
        } catch (Exception e) {
            b.reviewError.setText(e.getMessage());
            b.confirm.setEnabled(false);
        }
        b.rAmount.setText(Amounts.format(amount) + " SHRUGG");
        b.rTo.setText(to);
        b.rFee.setText(Amounts.format(fee) + " SHRUGG");
        b.rTotal.setText(Amounts.format(amount.add(fee)) + " SHRUGG");
        showMemoryWarning();
        b.flipper.setDisplayedChild(REVIEW);
    }

    /** Peak memory of a bundle proof: mirrors {@code wallet_core::PROVER_PEAK_MEMORY_BYTES} (measured 2026-09-13). */
    static final long PROVER_PEAK_MEMORY_BYTES = 5_600_000_000L;

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
                .putExtra(ProvingService.EXTRA_FEE, fee.toString());
        ContextCompat.startForegroundService(this, i);
        b.flipper.setDisplayedChild(PROVING);
    }

    private void render(SendState s) {
        switch (s.phase) {
            case IDLE:
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
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
                b.resultIcon.setImageResource(R.drawable.ic_check);
                b.resultTitle.setText(R.string.sent_title);
                b.resultAmount.setText("−" + Amounts.format(s.amount) + " SHRUGG");
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
                    b.done.setText(R.string.sent_done);
                    b.flipper.setDisplayedChild(FORM);
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
