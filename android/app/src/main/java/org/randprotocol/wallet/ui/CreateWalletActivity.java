package org.randprotocol.wallet.ui;

import android.content.Intent;
import android.os.Bundle;
import android.view.WindowManager;

import org.json.JSONObject;
import org.randprotocol.wallet.core.CoreException;
import org.randprotocol.wallet.databinding.ActivityCreateBinding;
import org.randprotocol.wallet.security.Unlock;

/** Shows the fresh spend key once; the user must confirm they saved it before continuing. */
public class CreateWalletActivity extends BaseActivity {
    @Override
    protected boolean requiresUnlock() {
        return false;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // The spend key is on screen: keep it out of screenshots and the recents thumbnail.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        ActivityCreateBinding b = ActivityCreateBinding.inflate(getLayoutInflater());
        setContentView(b.getRoot());

        JSONObject info;
        try {
            info = wallet().hasWallet() ? wallet().walletInfo() : wallet().createWallet();
        } catch (CoreException e) {
            toast(getString(org.randprotocol.wallet.R.string.error_generic, e.getMessage()));
            finish();
            return;
        }
        String spendKey = info.optString("spend_key");
        b.spendKey.setText(spendKey);
        b.address.setText(info.optString("address"));
        b.copy.setOnClickListener(v -> copy("spend key", spendKey, getString(org.randprotocol.wallet.R.string.copied)));
        b.saved.setOnCheckedChangeListener((cb, checked) -> b.next.setEnabled(checked));
        b.next.setOnClickListener(v -> {
            wallet().prefs().setBackedUp(true);
            Unlock.markUnlocked();
            startActivity(new Intent(this, HomeActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK | Intent.FLAG_ACTIVITY_NEW_TASK));
            finish();
        });
    }
}
