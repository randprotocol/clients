package org.randprotocol.wallet.ui;

import android.content.Intent;
import android.os.Bundle;

import org.randprotocol.wallet.databinding.ActivityWelcomeBinding;

public class WelcomeActivity extends BaseActivity {
    @Override
    protected boolean requiresUnlock() {
        return false;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (wallet().hasWallet()) {
            startActivity(new Intent(this, LaunchActivity.class));
            finish();
            return;
        }
        ActivityWelcomeBinding b = ActivityWelcomeBinding.inflate(getLayoutInflater());
        setContentView(b.getRoot());
        b.create.setOnClickListener(v -> startActivity(new Intent(this, CreateWalletActivity.class)));
        b.importWallet.setOnClickListener(v -> startActivity(new Intent(this, ImportActivity.class)));
    }
}
