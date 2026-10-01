package org.randprotocol.wallet.ui;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AlertDialog;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.randprotocol.wallet.R;
import org.randprotocol.wallet.databinding.ActivitySwapBinding;
import org.randprotocol.wallet.databinding.ViewDetailRowBinding;
import org.randprotocol.wallet.store.NoteStore;
import org.randprotocol.wallet.util.Amounts;
import org.randprotocol.wallet.wallet.Amm;
import org.randprotocol.wallet.wallet.Invoke;
import org.randprotocol.wallet.wallet.ProvingService;
import org.randprotocol.wallet.wallet.RemoteSend;
import org.randprotocol.wallet.wallet.SendState;
import org.randprotocol.wallet.wallet.SwapMonitor;
import org.randprotocol.wallet.wallet.TrustedProver;
import org.randprotocol.wallet.wallet.WalletService;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Swap: trade RAND and listed tokens through the durian.market AMM, from inside the wallet
 * ({@code ui/screens/swap.js} on Android). The pools are read from the chain, the quote and the
 * exact transition are this wallet's own ({@link Amm}, checked against durian's vectors), and the
 * swap is an RPL-2 invoke: {@link org.randprotocol.wallet.wallet.WalletService#quoteInvoke}
 * (every refusal that needs no proof, and the network fee) on Review, then the proving service on
 * Swap. Nothing is sent to durian.market itself.
 *
 * <p>Steps: form → review → running → done | failed. A pool that moved between the quote and the
 * chain (STALE_READ) is re-read and quoted again — the program pays exact amounts, so there is no
 * slippage setting: a moved pool means a new quote the user sees, never a worse fill. A swap in
 * flight lives in {@link SwapMonitor}: leaving the screen does not stop it, and coming back shows it.
 */
public class SwapActivity extends BaseActivity {
    private static final int WAIT = 0, FORM = 1, REVIEW = 2, RUNNING = 3, RESULT = 4;

    private ActivitySwapBinding b;
    private List<Amm.Pool> pools = new ArrayList<>();
    private Map<Integer, SwapForm.Asset> assets = new HashMap<>();
    private int sell = Amm.RAND_ASSET;
    private Integer buy;
    private SwapForm.State form;
    /** Fixed at Review: what Swap sends. */
    private Amm.Swap built;
    private boolean updating;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            SendState s = SwapMonitor.current();
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
        b = ActivitySwapBinding.inflate(getLayoutInflater());
        setContentView(b.getRoot());

        label(b.dRate, R.string.swap_rate);
        label(b.dImpact, R.string.swap_impact);
        label(b.dFee, R.string.swap_pool_fee);
        label(b.dRoute, R.string.swap_route);
        label(b.rPay, R.string.swap_pay);
        label(b.rReceive, R.string.swap_receive);
        label(b.rPoolFee, R.string.swap_pool_fee);
        label(b.rNetworkFee, R.string.swap_network_fee);
        label(b.rProgram, R.string.swap_program);
        label(b.resPaid, R.string.swap_paid);

        b.amount.addTextChangedListener(new Watcher(this::requote));
        b.sell.setOnClickListener(v -> pick(true));
        b.buy.setOnClickListener(v -> pick(false));
        b.flip.setOnClickListener(v -> {
            if (buy == null) return;
            int was = sell;
            sell = buy;
            buy = was;
            setAmount("");
            showForm(null);
        });
        b.max.setOnClickListener(v -> {
            String max = SwapForm.maxAmount(SwapForm.infoOf(assets, sell));
            setAmount(max == null ? "" : max);
            requote();
        });
        b.review.setOnClickListener(v -> review());
        b.edit.setOnClickListener(v -> showForm(null));
        b.swap.setOnClickListener(v -> run());
        b.acknowledge.setOnClickListener(v -> {
            wallet().acknowledgeDefaultProver();
            showNotice(false);
        });
        b.useOwn.setOnClickListener(v -> startActivity(new Intent(this, SettingsActivity.class)));
        b.openDurian.setOnClickListener(v -> open(Amm.DURIAN_URL));
        b.unavailableHome.setOnClickListener(v -> finish());
        b.resultHome.setOnClickListener(v -> {
            SwapMonitor.reset();
            finish();
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (b.flipper.getDisplayedChild() == REVIEW) showForm(null);
                else finish();
            }
        });

        // A swap already running (or just finished) from an earlier visit: show it.
        SendState now = SwapMonitor.current();
        if (now.phase == SendState.Phase.IDLE) refreshAndForm(null);
        SwapMonitor.state().observe(this, this::render);
    }

    private static void label(ViewDetailRowBinding row, int text) {
        row.label.setText(text);
    }

    private void setAmount(String s) {
        updating = true;
        b.amount.setText(s);
        updating = false;
    }

    // ------------------------------------------------------------------ the pools

    /** Read the pools and the token names off the main thread, then the form (with {@code notice}). */
    private void refreshAndForm(String notice) {
        b.loading.setVisibility(View.VISIBLE);
        b.unavailableIcon.setVisibility(View.GONE);
        b.unavailableMessage.setText("");
        b.openDurian.setVisibility(View.GONE);
        b.unavailableHome.setVisibility(View.GONE);
        b.flipper.setDisplayedChild(WAIT);
        new Thread(() -> {
            JSONArray cells;
            String error = null;
            try {
                cells = wallet().programCells(Amm.DURIAN_PROGRAM);
            } catch (Exception e) {
                cells = null;
                error = e.getMessage() == null ? "the node did not answer" : e.getMessage();
            }
            JSONArray tokens;
            try {
                tokens = wallet().rpc().tokens();
            } catch (Exception e) {
                tokens = new JSONArray(); // amounts show by index then
            }
            final JSONArray c = cells;
            final JSONArray t = tokens;
            final String err = error;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (err != null) {
                    unavailable(getString(R.string.swap_pools_unread, err));
                    return;
                }
                if (c == null) {
                    unavailable(getString(R.string.swap_no_programs_here));
                    return;
                }
                pools = Amm.poolsOf(c);
                loadAssets(t);
                if (pools.isEmpty()) unavailable(getString(R.string.swap_no_pools));
                else showForm(notice);
            });
        }, "swap-pools").start();
    }

    private JSONArray lastTokens = new JSONArray();

    /** Names, decimals and this wallet's balances of every asset the pools trade. */
    private void loadAssets(JSONArray tokens) {
        lastTokens = tokens;
        Map<Integer, BigInteger> balances = new HashMap<>();
        NoteStore store = wallet().store();
        synchronized (store) {
            for (Integer a : Amm.tradeable(pools)) balances.put(a, store.balanceOf(a));
        }
        assets = SwapForm.assets(tokens, balances, Memo::display);
    }

    private void unavailable(String message) {
        b.loading.setVisibility(View.GONE);
        b.unavailableIcon.setVisibility(View.VISIBLE);
        b.unavailableMessage.setText(message);
        b.openDurian.setVisibility(View.VISIBLE);
        b.unavailableHome.setVisibility(View.VISIBLE);
        b.flipper.setDisplayedChild(WAIT);
    }

    // ------------------------------------------------------------------ the form

    private void showForm(String notice) {
        List<Integer> list = Amm.tradeable(pools);
        buy = SwapForm.pickBuy(list, sell, buy);
        b.notice.setText(notice == null ? "" : notice);
        b.notice.setVisibility(notice == null ? View.GONE : View.VISIBLE);
        SwapForm.Asset s = SwapForm.infoOf(assets, sell);
        b.sell.setText(s.symbol);
        b.buy.setText(buy == null ? "—" : SwapForm.infoOf(assets, buy).symbol);
        b.available.setText(getString(R.string.swap_available, SwapForm.formatUnits(s.balance, 6, s.decimals), s.symbol));
        b.flipper.setDisplayedChild(FORM);
        requote();
    }

    private void pick(boolean selling) {
        List<Integer> list = Amm.tradeable(pools);
        String[] names = new String[list.size()];
        for (int i = 0; i < names.length; i++) names[i] = SwapForm.infoOf(assets, list.get(i)).symbol;
        new AlertDialog.Builder(this).setTitle(R.string.swap_pick).setItems(names, (d, which) -> {
            int chosen = list.get(which);
            if (selling) {
                sell = chosen;
                if (buy != null && sell == buy) buy = SwapForm.pickBuy(list, sell, null);
            } else {
                buy = chosen;
                if (buy == sell) {
                    Integer other = SwapForm.pickBuy(list, buy, null);
                    sell = other == null ? Amm.RAND_ASSET : other;
                }
            }
            showForm(null);
        }).setNegativeButton(R.string.cancel, null).show();
    }

    private void requote() {
        if (b == null || updating) return;
        form = SwapForm.evaluate(pools, assets, sell, buy, String.valueOf(b.amount.getText()));
        b.amountError.setText(form.error == null ? "" : form.error);
        b.amountError.setVisibility(form.error == null ? View.GONE : View.VISIBLE);
        b.out.setText(form.out);
        Amm.Swap q = form.quote;
        boolean ok = q != null && q.ok;
        b.details.setVisibility(ok ? View.VISIBLE : View.GONE);
        if (ok) {
            b.dRate.value.setText(SwapForm.rateLine(assets, q, form.route));
            b.dImpact.value.setText(SwapForm.impactText(q.impactPpm));
            b.dImpact.value.setTextColor(getColor(SwapForm.impactNegative(q.impactPpm) ? R.color.negative : R.color.text));
            b.dFee.value.setText(SwapForm.amountOf(assets, q.feeAsset, q.fee, 6));
            String via = SwapForm.via(assets, q);
            b.dRoute.getRoot().setVisibility(via == null ? View.GONE : View.VISIBLE);
            b.dRoute.value.setText(via == null ? "" : via);
        }
        b.review.setEnabled(form.canReview);
    }

    // ------------------------------------------------------------------ review

    private void review() {
        requote();
        if (form == null || !form.canReview) return;
        final Amm.Swap swap = form.quote;
        b.loading.setVisibility(View.VISIBLE);
        b.unavailableIcon.setVisibility(View.GONE);
        b.unavailableMessage.setText(R.string.swap_checking);
        b.openDurian.setVisibility(View.GONE);
        b.unavailableHome.setVisibility(View.GONE);
        b.flipper.setDisplayedChild(WAIT);
        new Thread(() -> {
            RemoteSend.Route route = null;
            Invoke.Quote quote = null;
            Exception failure = null;
            try {
                route = wallet().canInvoke();
                quote = wallet().quoteInvoke(swap.request);
            } catch (Exception e) {
                failure = e;
            }
            final RemoteSend.Route r = route;
            final Invoke.Quote q = quote;
            final Exception f = failure;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (f instanceof Invoke.Refusal && SwapForm.isStale(((Invoke.Refusal) f).code)) {
                    refreshAndForm(SwapForm.STALE);
                    return;
                }
                if (f != null) {
                    failed(f.getMessage() == null ? getString(R.string.swap_cannot_check) : f.getMessage());
                    return;
                }
                // Balances moved with the scan the quote made.
                loadAssets(lastTokens);
                showReview(swap, q, r);
            });
        }, "swap-quote").start();
    }

    private void showReview(Amm.Swap swap, Invoke.Quote q, RemoteSend.Route route) {
        built = swap;
        b.rPay.value.setText(SwapForm.amountOf(assets, swap.sell, swap.amountIn, 9));
        b.rReceive.value.setText(SwapForm.amountOf(assets, swap.buy, swap.amountOut, 9));
        b.rPoolFee.value.setText(SwapForm.amountOf(assets, swap.feeAsset, swap.fee, 9));
        b.rNetworkFee.value.setText(SwapForm.amountOf(assets, Amm.RAND_ASSET, new BigInteger(q.fee), 9));
        b.rProgram.value.setText(Amounts.shortHex(Amm.DURIAN_PROGRAM));
        int prover = route == null ? R.string.swap_prove_device : route.isDefault ? R.string.swap_prove_default : R.string.swap_prove_paired;
        b.rCaption.setText(getString(R.string.swap_review_caption, getString(prover)));
        // The RandProtocol provers' one-time notice comes before the first send through them.
        showNotice(route != null && route.isDefault && !wallet().defaultNoticeRead());
        b.flipper.setDisplayedChild(REVIEW);
    }

    private void showNotice(boolean show) {
        TrustedProver pool = wallet().trustedProver();
        b.rNotice.setText(show ? getString(R.string.prover_notice_title) + "\n\n" + getString(R.string.prover_notice_body, pool == null ? 0 : pool.members.size()) : "");
        b.rNotice.setVisibility(show ? View.VISIBLE : View.GONE);
        b.acknowledge.setVisibility(show ? View.VISIBLE : View.GONE);
        b.useOwn.setVisibility(show ? View.VISIBLE : View.GONE);
        b.swap.setVisibility(show ? View.GONE : View.VISIBLE);
    }

    // ------------------------------------------------------------------ run

    private void run() {
        if (built == null) return;
        if (SwapMonitor.current().busy()) return;
        SwapMonitor.started(built);
        Intent i = new Intent(this, ProvingService.class)
                .putExtra(ProvingService.EXTRA_KIND, ProvingService.KIND_INVOKE)
                .putExtra(ProvingService.EXTRA_REQUEST, built.request.toString())
                .putExtra(ProvingService.EXTRA_AMOUNT, built.amountIn.toString());
        ContextCompat.startForegroundService(this, i);
        b.phase.setText(WalletService.SELECTING);
        b.flipper.setDisplayedChild(RUNNING);
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
                b.flipper.setDisplayedChild(RUNNING);
                b.phase.setText(s.message);
                handler.removeCallbacks(tick);
                handler.post(tick);
                break;
            case DONE:
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                done(s);
                break;
            case FAILED:
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                if (SwapForm.isStale(s.code)) {
                    SwapMonitor.reset();
                    refreshAndForm(SwapForm.STALE);
                } else {
                    failed(s.message);
                }
                break;
        }
    }

    private void done(SendState s) {
        Amm.Swap swap = SwapMonitor.swap();
        b.resultIcon.setImageResource(R.drawable.ic_check);
        b.resultTitle.setText(R.string.swap_done_title);
        b.resultAmount.setText(swap == null ? "" : SwapForm.amountOf(assets, swap.buy, swap.amountOut, 9));
        b.resultMessage.setText(s.message);
        b.resPaid.value.setText(swap == null ? "" : SwapForm.amountOf(assets, swap.sell, swap.amountIn, 9));
        b.resPaid.getRoot().setVisibility(swap == null ? View.GONE : View.VISIBLE);
        b.resultHash.setText(s.hash);
        b.resultDetails.setVisibility(View.VISIBLE);
        b.copyHash.setVisibility(View.VISIBLE);
        b.viewExplorer.setVisibility(View.VISIBLE);
        b.copyHash.setOnClickListener(v -> copy("transaction hash", s.hash, getString(R.string.swap_hash_copied)));
        b.viewExplorer.setOnClickListener(v -> open(EXPLORER + "/transactions/" + s.hash));
        b.done.setText(R.string.sent_done);
        b.done.setOnClickListener(v -> {
            // Shown is seen: the next visit starts a new swap.
            SwapMonitor.reset();
            finish();
        });
        b.flipper.setDisplayedChild(RESULT);
    }

    private void failed(String message) {
        b.resultIcon.setImageResource(R.drawable.ic_swap);
        b.resultTitle.setText(R.string.swap_failed_title);
        b.resultAmount.setText(R.string.swap_nothing_sent);
        b.resultMessage.setText(message);
        b.resultDetails.setVisibility(View.GONE);
        b.copyHash.setVisibility(View.GONE);
        b.viewExplorer.setVisibility(View.GONE);
        b.done.setText(R.string.swap_try_again);
        b.done.setOnClickListener(v -> {
            SwapMonitor.reset();
            refreshAndForm(null);
        });
        b.flipper.setDisplayedChild(RESULT);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        handler.removeCallbacks(tick);
    }
}
