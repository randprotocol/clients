package org.randprotocol.wallet.ui;

import android.content.Intent;
import android.os.Bundle;

import androidx.appcompat.app.AppCompatActivity;

import org.randprotocol.wallet.security.Unlock;
import org.randprotocol.wallet.wallet.WalletService;

/** Routes to onboarding, the lock screen or home. */
public class LaunchActivity extends AppCompatActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WalletService w = WalletService.get(this);
        Class<?> next;
        if (!w.hasWallet()) next = WelcomeActivity.class;
        else if (!Unlock.isUnlocked(this)) next = LockActivity.class;
        else next = HomeActivity.class;
        startActivity(new Intent(this, next));
        finish();
    }
}
