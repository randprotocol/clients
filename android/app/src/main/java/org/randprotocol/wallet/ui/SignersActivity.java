package org.randprotocol.wallet.ui;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.LayoutInflater;
import android.view.View;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.TextView;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AlertDialog;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;
import org.randprotocol.wallet.R;
import org.randprotocol.wallet.databinding.ActivitySignersBinding;
import org.randprotocol.wallet.databinding.ItemSignerBinding;
import org.randprotocol.wallet.security.KeystoreSeedCipher;
import org.randprotocol.wallet.security.SignerProfiles;
import org.randprotocol.wallet.security.Unlock;
import org.randprotocol.wallet.util.L10n;
import org.randprotocol.wallet.wallet.MsauthCore;
import org.randprotocol.wallet.wallet.NativeMsauthCore;
import org.randprotocol.wallet.wallet.SignFlow;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;

/**
 * Settings › Multisig signers (spec 2026-10-11-msauth-signing-design.md §4, iOS SignersView): the
 * saved signer profiles, each opening its sign screen, and a form that adds one from the policy and
 * the signer key (files or a paste). The seed is sealed by the profile's own Keystore key, which
 * opens only right after the person authenticates; saving it asks once already.
 */
public class SignersActivity extends BaseActivity {
    private ActivitySignersBinding b;
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private final MsauthCore core = NativeMsauthCore.INSTANCE;
    private ActivityResultLauncher<String[]> openPolicy, openKey;
    /** What the core read from the form, for Save; null until Check, and after any edit. */
    private Preview preview;
    /** One add at a time (the prompt is up, or the seed is being sealed). */
    private boolean saving;
    private int listRun;

    /** What Check found: shown for comparison, and the texts it was found in (Save re-reads them). */
    private static final class Preview {
        final String policy, key, fingerprint, address, policyHash;
        final int threshold, signers, index;

        Preview(String policy, String key, JSONObject info, int index) {
            this.policy = policy;
            this.key = key;
            this.fingerprint = info.optString("fingerprint");
            this.address = info.optString("address");
            this.policyHash = info.optString("policy_hash");
            this.threshold = info.optInt("threshold");
            this.signers = info.optInt("signers");
            this.index = index;
        }
    }

    private SignerProfiles profiles() {
        return wallet().vault().signerProfiles();
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        b = ActivitySignersBinding.inflate(getLayoutInflater());
        setContentView(b.getRoot());

        openPolicy = registerForActivityResult(new ActivityResultContracts.OpenDocument(), uri -> picked(uri, b.policy));
        openKey = registerForActivityResult(new ActivityResultContracts.OpenDocument(), uri -> picked(uri, b.key));
        b.openPolicy.setOnClickListener(v -> openPolicy.launch(new String[] {"application/json", "text/plain"}));
        b.openKey.setOnClickListener(v -> openKey.launch(new String[] {"application/json", "text/plain"}));

        TextWatcher dropPreview = new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int st, int c, int a) {}

            @Override public void onTextChanged(CharSequence s, int st, int bf, int c) {}

            @Override public void afterTextChanged(Editable s) {
                preview = null;
                b.preview.setVisibility(View.GONE);
            }
        };
        b.label.addTextChangedListener(dropPreview);
        b.policy.addTextChangedListener(dropPreview);
        b.key.addTextChangedListener(dropPreview);
        b.check.setOnClickListener(v -> check());
        b.save.setOnClickListener(v -> save());
    }

    @Override
    protected void onResume() {
        super.onResume();
        paintList();
    }

    @Override
    protected void onDestroy() {
        work.shutdownNow();
        // The key text is a secret: it does not outlive the screen.
        if (b != null) b.key.setText("");
        preview = null;
        super.onDestroy();
    }

    // ------------------------------------------------------------------ the list

    private void paintList() {
        int run = ++listRun;
        work.execute(() -> {
            List<SignerProfiles.Profile> list;
            List<JSONObject> infos = new ArrayList<>();
            String error = null;
            try {
                SignerProfiles store = profiles();
                list = store.list();
                for (SignerProfiles.Profile p : list) {
                    JSONObject info;
                    try {
                        info = core.msauthPolicyInfo(store.policy(p.id));
                    } catch (Exception e) {
                        info = new JSONObject();
                    }
                    infos.add(info);
                }
            } catch (Exception e) {
                list = new ArrayList<>();
                error = CoreErrors.of(e);
            }
            List<SignerProfiles.Profile> rows = list;
            String err = error;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed() || run != listRun) return;
                b.list.removeAllViews();
                b.empty.setVisibility(rows.isEmpty() && err == null ? View.VISIBLE : View.GONE);
                show(b.listError, err);
                LayoutInflater inf = getLayoutInflater();
                for (int i = 0; i < rows.size(); i++) {
                    SignerProfiles.Profile p = rows.get(i);
                    JSONObject info = infos.get(i);
                    ItemSignerBinding row = ItemSignerBinding.inflate(inf, b.list, false);
                    row.label.setText(p.label);
                    row.fingerprint.setText(info.optString("fingerprint"));
                    row.position.setText(position(info.optInt("threshold"), info.optInt("signers"), p.index));
                    row.open.setOnClickListener(v -> startActivity(new Intent(this, SignProposalActivity.class).putExtra(SignProposalActivity.EXTRA_ID, p.id)));
                    row.remove.setOnClickListener(v -> confirmRemove(p));
                    b.list.addView(row.getRoot());
                }
            });
        });
    }

    static String position(int threshold, int signers, int index) {
        return L10n.t(R.string.msauth_profile_position, "%1$s of %2$s · signer %3$s", String.valueOf(threshold), String.valueOf(signers), String.valueOf(index));
    }

    /** "Remove Treasury?" naming the label and that the key file is needed to add it back; then the device's authentication. */
    private void confirmRemove(SignerProfiles.Profile p) {
        new AlertDialog.Builder(this)
                .setTitle(getString(R.string.msauth_remove_title, p.label))
                .setMessage(R.string.msauth_remove_body)
                .setPositiveButton(R.string.msauth_remove_signer, (d, w) -> authenticateThenRemove(p))
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    private void authenticateThenRemove(SignerProfiles.Profile p) {
        if (!Unlock.deviceCanAuthenticate(this)) {
            // No screen lock at all: Unlock treats such a device as unlocked, and its signer keys no longer open anyway.
            remove(p);
            return;
        }
        BiometricPrompt prompt = new BiometricPrompt(this, ContextCompat.getMainExecutor(this), new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                remove(p);
            }

            @Override
            public void onAuthenticationError(int code, @NonNull CharSequence message) {
                if (code != BiometricPrompt.ERROR_USER_CANCELED && code != BiometricPrompt.ERROR_NEGATIVE_BUTTON && code != BiometricPrompt.ERROR_CANCELED) {
                    show(b.listError, String.valueOf(message));
                }
            }
        });
        prompt.authenticate(new BiometricPrompt.PromptInfo.Builder()
                .setTitle(getString(R.string.msauth_remove_reason))
                .setAllowedAuthenticators(Unlock.authenticators())
                .build());
    }

    private void remove(SignerProfiles.Profile p) {
        show(b.listError, null);
        work.execute(() -> {
            String err = null;
            try {
                profiles().remove(p.id);
            } catch (Exception e) {
                err = CoreErrors.of(e);
            }
            String m = err;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (m != null) show(b.listError, m);
                paintList();
            });
        });
    }

    // ------------------------------------------------------------------ adding one

    private void picked(Uri uri, EditText into) {
        if (uri == null) return;
        work.execute(() -> {
            String text = null, err = null;
            try (InputStream in = getContentResolver().openInputStream(uri)) {
                text = PickedFile.read(sizeOf(uri), in);
            } catch (IllegalArgumentException e) {
                err = e.getMessage();
            } catch (Exception e) {
                err = PickedFile.unreadable();
            }
            String t = text, m = err;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (t != null) into.setText(t);
                show(b.addError, m);
            });
        });
    }

    /** The provider's size of a picked document, -1 when it does not say. */
    long sizeOf(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, new String[] {OpenableColumns.SIZE}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
        } catch (Exception ignored) {
            // unknown: the read itself stops past the cap
        }
        return -1;
    }

    private void check() {
        show(b.addError, null);
        preview = null;
        b.preview.setVisibility(View.GONE);
        String policy = SignFlow.clean(String.valueOf(b.policy.getText()));
        String key = SignFlow.clean(String.valueOf(b.key.getText()));
        if (policy.isEmpty() || key.isEmpty()) return;
        b.check.setEnabled(false);
        work.execute(() -> {
            Preview p = null;
            String err = null;
            try {
                JSONObject info = core.msauthPolicyInfo(policy);
                JSONObject signer = core.msauthSignerImport(key, policy);
                Object index = signer.opt("index");
                if (!(index instanceof Number)) throw new IllegalStateException(L10n.t(R.string.core_err_msauth_not_signer, "this key is not one of the policy's signers"));
                p = new Preview(policy, key, info, ((Number) index).intValue());
                // The core's reply carries the seed; it is not kept (Save reads it again after the prompt).
                signer.remove("seed");
            } catch (Exception e) {
                err = CoreErrors.of(e);
            }
            Preview found = p;
            String m = err;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                b.check.setEnabled(true);
                // The form changed while the core read it: that answer is not about these texts.
                if (found != null && (!found.policy.equals(SignFlow.clean(String.valueOf(b.policy.getText())))
                        || !found.key.equals(SignFlow.clean(String.valueOf(b.key.getText()))))) return;
                show(b.addError, m);
                preview = found;
                if (found == null) return;
                b.previewFp.setText(found.fingerprint);
                b.previewAddress.setText(found.address);
                b.previewPosition.setText(L10n.t(R.string.msauth_preview_position, "%1$s of %2$s · this key is signer %3$s",
                        String.valueOf(found.threshold), String.valueOf(found.signers), String.valueOf(found.index)));
                b.preview.setVisibility(View.VISIBLE);
            });
        });
    }

    /**
     * Save: the device must be able to hold a per-use key ({@link KeystoreSeedCipher#refusal});
     * the label and "already saved" are checked first so the prompt is not wasted; then a fresh
     * Keystore key, the prompt over its encrypt cipher, and on success the seed sealed by it. The
     * key is deleted again on any failure.
     */
    private void save() {
        Preview p = preview;
        if (p == null || saving) return;
        show(b.addError, null);
        String why = KeystoreSeedCipher.refusal(this);
        if (why != null) {
            show(b.addError, why);
            return;
        }
        String label = String.valueOf(b.label.getText()).trim();
        int n = label.codePointCount(0, label.length());
        if (n < 1 || n > 64) {
            show(b.addError, L10n.t(R.string.msauth_label_length, "a signer label is 1-64 characters"));
            return;
        }
        saving = true;
        b.save.setEnabled(false);
        String id = SignerProfiles.newId();
        work.execute(() -> {
            Cipher cipher = null;
            String err = null;
            try {
                for (SignerProfiles.Profile q : profiles().list()) {
                    if (q.policyHash.equals(p.policyHash) && q.index == p.index) {
                        throw new IllegalStateException(L10n.t(R.string.msauth_already_saved, "this signer is already saved as %1$s", q.label));
                    }
                }
                KeystoreSeedCipher.createKey(id);
                cipher = KeystoreSeedCipher.encryptCipher(id);
            } catch (Exception e) {
                KeystoreSeedCipher.deleteKey(id);
                err = CoreErrors.of(e);
            }
            Cipher c = cipher;
            String m = err;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) {
                    KeystoreSeedCipher.deleteKey(id);
                    return;
                }
                if (c == null) {
                    done(m);
                    return;
                }
                promptToSeal(id, label, p, c);
            });
        });
    }

    private void promptToSeal(String id, String label, Preview p, Cipher cipher) {
        BiometricPrompt prompt = new BiometricPrompt(this, ContextCompat.getMainExecutor(this), new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                BiometricPrompt.CryptoObject co = result.getCryptoObject();
                Cipher authed = co == null ? null : co.getCipher();
                if (authed == null) {
                    KeystoreSeedCipher.deleteKey(id);
                    done(null);
                    return;
                }
                work.execute(() -> seal(id, label, p, authed));
            }

            @Override
            public void onAuthenticationError(int code, @NonNull CharSequence message) {
                KeystoreSeedCipher.deleteKey(id);
                boolean dismissed = code == BiometricPrompt.ERROR_USER_CANCELED || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON || code == BiometricPrompt.ERROR_CANCELED;
                done(dismissed ? null : String.valueOf(message));
            }
        });
        prompt.authenticate(CryptoPrompt.info(getString(R.string.msauth_save_reason), getString(R.string.cancel)), new BiometricPrompt.CryptoObject(cipher));
    }

    /** Off the main thread: the seed read again from the key text, sealed, saved; zeroed whatever happens. */
    private void seal(String id, String label, Preview p, Cipher cipher) {
        byte[] seed = null;
        String err = null;
        boolean ok = false;
        try {
            JSONObject signer = core.msauthSignerImport(p.key, p.policy);
            seed = hex(signer.optString("seed"));
            signer.remove("seed");
            byte[] ct = cipher.doFinal(seed);
            profiles().add(new SignerProfiles.Profile(id, label, p.index, p.policyHash), p.policy, KeystoreSeedCipher.seal(cipher.getIV(), ct));
            ok = true;
        } catch (Exception e) {
            err = CoreErrors.of(e);
        } finally {
            if (seed != null) Arrays.fill(seed, (byte) 0);
            if (!ok) KeystoreSeedCipher.deleteKey(id);
        }
        String m = err;
        boolean saved = ok;
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed()) return;
            if (saved) {
                b.label.setText("");
                b.policy.setText("");
                b.key.setText("");
                preview = null;
                b.preview.setVisibility(View.GONE);
                paintList();
            }
            done(m);
        });
    }

    private void done(String error) {
        saving = false;
        b.save.setEnabled(true);
        show(b.addError, error);
    }

    /** 64 hex characters to 32 bytes; IllegalStateException for anything else. */
    static byte[] hex(String s) {
        if (s == null || s.length() != 64) throw new IllegalStateException(L10n.t(R.string.core_err_msauth_seed_shape, "a signer seed is 64 hex characters"));
        byte[] out = new byte[32];
        for (int i = 0; i < 32; i++) {
            int hi = Character.digit(s.charAt(2 * i), 16), lo = Character.digit(s.charAt(2 * i + 1), 16);
            if (hi < 0 || lo < 0) {
                Arrays.fill(out, (byte) 0);
                throw new IllegalStateException(L10n.t(R.string.core_err_msauth_seed_shape, "a signer seed is 64 hex characters"));
            }
            out[i] = (byte) ((hi << 4) | lo);
        }
        return out;
    }

    static void show(TextView v, String message) {
        v.setText(message == null ? "" : message);
        v.setVisibility(message == null || message.isEmpty() ? View.GONE : View.VISIBLE);
    }
}
