package org.randprotocol.wallet.store;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import java.io.IOException;
import java.security.GeneralSecurityException;

/**
 * One JSON string in its own {@link EncryptedSharedPreferences} file (AES-GCM, key in the
 * Android Keystore) — beside the key vault's file, never inside it, so the vault keeps holding
 * the spend key and nothing else. The contact list lives here.
 */
public final class EncryptedBlob implements Contacts.Backing {
    private static final String VALUE = "json";

    private final SharedPreferences prefs;

    public EncryptedBlob(Context context, String file) {
        try {
            MasterKey master = new MasterKey.Builder(context)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build();
            prefs = EncryptedSharedPreferences.create(
                    context,
                    file,
                    master,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
        } catch (GeneralSecurityException | IOException e) {
            throw new IllegalStateException("cannot open " + file, e);
        }
    }

    @Override
    public String read() {
        return prefs.getString(VALUE, null);
    }

    @Override
    public void write(String json) {
        if (!prefs.edit().putString(VALUE, json).commit()) {
            throw new Contacts.ContactException(org.randprotocol.wallet.util.L10n.t(org.randprotocol.wallet.R.string.contacts_save_failed, "could not save contacts"));
        }
    }
}
