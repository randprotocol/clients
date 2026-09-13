package org.randprotocol.wallet.ui;

import android.content.Intent;
import android.os.Bundle;
import android.view.WindowManager;

import org.randprotocol.wallet.core.CoreException;
import org.randprotocol.wallet.databinding.ActivityImportBinding;
import org.randprotocol.wallet.security.Unlock;

public class ImportActivity extends BaseActivity {
    @Override
    protected boolean requiresUnlock() {
        return false;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        ActivityImportBinding b = ActivityImportBinding.inflate(getLayoutInflater());
        setContentView(b.getRoot());
        b.importButton.setOnClickListener(v -> {
            String input = String.valueOf(b.input.getText());
            try {
                wallet().importWallet(input);
                Unlock.markUnlocked();
                startActivity(new Intent(this, HomeActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK | Intent.FLAG_ACTIVITY_NEW_TASK));
                finish();
            } catch (CoreException | IllegalStateException e) {
                b.error.setText(e.getMessage());
            }
        });
    }
}
