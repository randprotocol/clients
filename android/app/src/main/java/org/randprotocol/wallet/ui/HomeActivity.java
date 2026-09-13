package org.randprotocol.wallet.ui;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.View;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.recyclerview.widget.LinearLayoutManager;

import org.randprotocol.wallet.R;
import org.randprotocol.wallet.databinding.ActivityHomeBinding;
import org.randprotocol.wallet.databinding.ViewActionBinding;
import org.randprotocol.wallet.util.Amounts;
import org.randprotocol.wallet.wallet.WalletService;

public class HomeActivity extends BaseActivity {
    private ActivityHomeBinding b;
    private ActivityAdapter adapter;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        b = ActivityHomeBinding.inflate(getLayoutInflater());
        setContentView(b.getRoot());

        adapter = new ActivityAdapter(this::openItem);
        b.list.setLayoutManager(new LinearLayoutManager(this));
        b.list.setAdapter(adapter);

        action(b.actionReceive, R.drawable.ic_arrow_down, R.string.home_receive, v -> startActivity(new Intent(this, ReceiveActivity.class)));
        action(b.actionSend, R.drawable.ic_arrow_up, R.string.home_send, v -> startActivity(new Intent(this, SendActivity.class)));
        action(b.actionFaucet, R.drawable.ic_drop, R.string.home_faucet, v -> faucet());
        b.qr.setOnClickListener(v -> startActivity(new Intent(this, ReceiveActivity.class)));
        b.settings.setOnClickListener(v -> startActivity(new Intent(this, SettingsActivity.class)));
        b.addressChip.setOnClickListener(v -> copy("address", wallet().address(), getString(R.string.home_copied)));
        b.refresh.setOnRefreshListener(() -> wallet().scanAsync(null));

        wallet().snapshot().observe(this, s -> {
            b.balance.setText(Amounts.format(s.balance));
            b.refresh.setRefreshing(s.syncing);
            if (s.pending.signum() > 0) {
                b.pending.setVisibility(View.VISIBLE);
                b.pending.setText(getString(R.string.home_pending, Amounts.format(s.pending)));
            } else {
                b.pending.setVisibility(View.GONE);
            }
            if (s.syncing) b.sync.setText(R.string.home_syncing);
            else if (s.scannedHeight > 0) b.sync.setText(getString(R.string.home_synced, s.scannedHeight - 1));
            else b.sync.setText(R.string.home_not_synced);
            b.error.setVisibility(s.error == null ? View.GONE : View.VISIBLE);
            b.error.setText(s.error == null ? "" : s.error);
            refreshList();
        });

        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
    }

    private void action(ViewActionBinding v, int icon, int label, View.OnClickListener l) {
        v.icon.setImageResource(icon);
        v.label.setText(label);
        v.getRoot().setOnClickListener(l);
    }

    @Override
    protected void onResume() {
        super.onResume();
        b.addressShort.setText(Amounts.shortAddress(wallet().address()));
        refreshList();
        wallet().scanAsync(null);
    }

    private void refreshList() {
        WalletService w = wallet();
        java.util.List<ActivityItem> items;
        synchronized (w.store()) {
            items = ActivityItem.build(w.store());
        }
        adapter.submit(items);
        b.empty.setVisibility(items.isEmpty() ? View.VISIBLE : View.GONE);
    }

    private void openItem(ActivityItem item) {
        Intent i = new Intent(this, DetailActivity.class);
        i.putExtra(DetailActivity.EXTRA_KIND, item.kind.name());
        i.putExtra(DetailActivity.EXTRA_REF, item.ref);
        startActivity(i);
    }

    private void faucet() {
        toast(getString(R.string.faucet_started));
        wallet().faucetAsync(
                hash -> runOnUiThread(() -> toast(getString(R.string.faucet_done))),
                err -> runOnUiThread(() -> toast(getString(R.string.error_generic, err))));
    }
}
