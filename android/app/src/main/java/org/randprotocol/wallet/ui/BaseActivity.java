package org.randprotocol.wallet.ui;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.PersistableBundle;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import org.randprotocol.wallet.security.Unlock;
import org.randprotocol.wallet.wallet.WalletService;

/** Every wallet screen: sends the user to the lock screen when the unlock window has passed. */
public abstract class BaseActivity extends AppCompatActivity {
    public static final String EXPLORER = "https://randscan.org";

    protected WalletService wallet() {
        return WalletService.get(this);
    }

    /** Whether this screen requires an unlocked wallet (the lock and onboarding screens do not). */
    protected boolean requiresUnlock() {
        return true;
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (requiresUnlock() && wallet().hasWallet() && !Unlock.isUnlocked(this)) {
            startActivity(new Intent(this, LockActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP));
        }
    }

    protected void copy(String label, String text, String toast) {
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        ClipData clip = ClipData.newPlainText(label, text);
        // Keys are sensitive: keep them out of the clipboard preview on Android 13+.
        PersistableBundle extras = new PersistableBundle();
        extras.putBoolean("android.content.extra.IS_SENSITIVE", true);
        clip.getDescription().setExtras(extras);
        cm.setPrimaryClip(clip);
        if (toast != null) Toast.makeText(this, toast, Toast.LENGTH_SHORT).show();
    }

    protected void open(String url) {
        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
    }

    protected void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_LONG).show();
    }
}
