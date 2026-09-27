package org.randprotocol.wallet.ui;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Bundle;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.appcompat.app.AlertDialog;

import org.randprotocol.wallet.R;
import org.randprotocol.wallet.core.Core;
import org.randprotocol.wallet.core.CoreException;
import org.randprotocol.wallet.databinding.ActivityContactsBinding;
import org.randprotocol.wallet.store.Contacts;
import org.randprotocol.wallet.util.Amounts;

/**
 * Names for the addresses this wallet pays often (spec 2026-09-26 §3.3). The list lives in its
 * own EncryptedSharedPreferences file on this device only; the rules are the CLI's
 * ({@link Contacts}). A name can be typed in Send's To field instead of the address.
 */
public class ContactsActivity extends BaseActivity {
    private ActivityContactsBinding b;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        b = ActivityContactsBinding.inflate(getLayoutInflater());
        setContentView(b.getRoot());
        b.paste.setOnClickListener(v -> {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = cm.getPrimaryClip();
            if (clip != null && clip.getItemCount() > 0) b.address.setText(String.valueOf(clip.getItemAt(0).coerceToText(this)).trim());
        });
        b.name.addTextChangedListener(new Watcher(this::refreshForm));
        b.address.addTextChangedListener(new Watcher(this::refreshForm));
        b.save.setOnClickListener(v -> save());
        refreshList();
    }

    /** A pasted {@code randpay:} link saves the address it carries; null for anything else that is not an address. */
    private String resolvedAddress() {
        String s = String.valueOf(b.address.getText()).trim();
        if (s.isEmpty()) return null;
        try {
            if (SendDraft.RecipientKind.of(s) == SendDraft.RecipientKind.LINK) return Core.uriParse(s).getString("address");
            return Core.isValidAddress(s) ? s : null;
        } catch (Exception e) {
            return null;
        }
    }

    private void refreshForm() {
        String addr = resolvedAddress();
        String fp = addr == null ? null : fingerprint(addr);
        b.fingerprint.setVisibility(fp == null ? View.GONE : View.VISIBLE);
        b.fingerprint.setText(fp == null ? "" : getString(R.string.contacts_fingerprint, fp));
        b.error.setText("");
        b.save.setEnabled(b.name.getText() != null && b.name.getText().length() > 0
                && b.address.getText() != null && b.address.getText().length() > 0);
    }

    private static String fingerprint(String address) {
        try {
            return Core.addressFingerprint(address);
        } catch (CoreException e) {
            return null;
        }
    }

    private void save() {
        String addr = resolvedAddress();
        if (addr == null) {
            b.error.setText(R.string.contacts_bad_address);
            return;
        }
        try {
            wallet().contacts().add(String.valueOf(b.name.getText()), addr);
        } catch (Contacts.ContactException e) {
            b.error.setText(e.getMessage());
            return;
        }
        b.name.setText("");
        b.address.setText("");
        refreshList();
    }

    private void refreshList() {
        b.list.removeAllViews();
        java.util.List<Contacts.Contact> all = wallet().contacts().sorted();
        b.empty.setVisibility(all.isEmpty() ? View.VISIBLE : View.GONE);
        int pad = (int) (12 * getResources().getDisplayMetrics().density);
        for (Contacts.Contact c : all) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.VERTICAL);
            row.setPadding(pad, pad, pad, pad);
            row.setBackgroundResource(R.drawable.bg_surface_card);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            lp.topMargin = pad / 2;
            row.setLayoutParams(lp);
            row.addView(text(c.name, R.style.Text_Body, true));
            String fp = fingerprint(c.address);
            row.addView(text(fp == null ? getString(R.string.contacts_fingerprint_unavailable) : getString(R.string.contacts_fingerprint, fp), R.style.Text_Mono, false));
            row.addView(text(Amounts.shortAddress(c.address), R.style.Text_Caption, false));
            row.setOnClickListener(v -> options(c));
            b.list.addView(row);
        }
    }

    private TextView text(String s, int style, boolean bold) {
        TextView t = new TextView(this);
        t.setTextAppearance(style);
        if (bold) t.setTypeface(t.getTypeface(), android.graphics.Typeface.BOLD);
        t.setText(s);
        return t;
    }

    private void options(Contacts.Contact c) {
        String[] items = {getString(R.string.contacts_copy_address), getString(R.string.contacts_remove)};
        new AlertDialog.Builder(this).setTitle(c.name).setItems(items, (d, which) -> {
            if (which == 0) copy("address", c.address, getString(R.string.home_copied));
            else confirmRemove(c);
        }).show();
    }

    private void confirmRemove(Contacts.Contact c) {
        new AlertDialog.Builder(this)
                .setTitle(getString(R.string.contacts_remove_title, c.name))
                .setPositiveButton(R.string.contacts_remove, (d, w) -> {
                    try {
                        wallet().contacts().remove(c.name);
                    } catch (Contacts.ContactException e) {
                        toast(e.getMessage());
                    }
                    refreshList();
                })
                .setNegativeButton(R.string.cancel, null)
                .show();
    }
}
