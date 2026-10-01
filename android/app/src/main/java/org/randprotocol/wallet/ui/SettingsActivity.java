package org.randprotocol.wallet.ui;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AlertDialog;
import androidx.core.content.ContextCompat;

import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;

import org.json.JSONObject;
import org.randprotocol.wallet.App;
import org.randprotocol.wallet.BuildConfig;
import org.randprotocol.wallet.R;
import org.randprotocol.wallet.core.Core;
import org.randprotocol.wallet.databinding.ActivitySettingsBinding;
import org.randprotocol.wallet.rpc.RpcClient;
import org.randprotocol.wallet.security.Prefs;
import org.randprotocol.wallet.wallet.ProverCore;
import org.randprotocol.wallet.wallet.ProverPairing;
import org.randprotocol.wallet.wallet.TrustedProver;

public class SettingsActivity extends BaseActivity {
    private ActivitySettingsBinding b;
    private ActivityResultLauncher<ScanOptions> proverScanner;
    private ActivityResultLauncher<String> cameraPermission;
    /** One pairing at a time (Save or the built-in prover); the latest probe only may paint. */
    private boolean pairing;
    private int probeRun;
    /** The prover the build ships the address of, or null: then no such action is offered. */
    private TrustedProver trusted;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        b = ActivitySettingsBinding.inflate(getLayoutInflater());
        setContentView(b.getRoot());
        Prefs prefs = wallet().prefs();

        // Network
        b.rpc.setText(prefs.rpcUrl());
        b.chain.setText(String.valueOf(prefs.chainId()));
        b.saveNetwork.setOnClickListener(v -> {
            prefs.setRpcUrl(String.valueOf(b.rpc.getText()));
            try {
                prefs.setChainId(Long.parseLong(String.valueOf(b.chain.getText()).trim()));
            } catch (NumberFormatException ignored) {
            }
            toast(getString(R.string.saved));
        });
        b.test.setOnClickListener(v -> {
            String url = String.valueOf(b.rpc.getText()).trim();
            b.testResult.setText("…");
            wallet().runInBackground(() -> {
                String result;
                try {
                    RpcClient rpc = new RpcClient(url);
                    long chain = rpc.chainId();
                    JSONObject st = rpc.status();
                    result = getString(R.string.settings_test_ok, chain, st.optLong("height", 0), st.optLong("peer_count", 0));
                } catch (Exception e) {
                    result = e.getMessage();
                }
                String r = result;
                runOnUiThread(() -> b.testResult.setText(r));
            });
        });

        // Prover
        proverScanner = registerForActivityResult(new ScanContract(), result -> {
            if (result.getContents() != null) b.proverLink.setText(result.getContents().trim());
        });
        cameraPermission = registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
            if (granted) launchProverScanner();
            else toast(getString(R.string.send_camera_denied));
        });
        b.proverScan.setOnClickListener(v -> {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) launchProverScanner();
            else cameraPermission.launch(Manifest.permission.CAMERA);
        });
        b.proverSave.setOnClickListener(v -> saveProver());
        b.proverForget.setOnClickListener(v -> {
            wallet().forgetProver();
            paintProver();
            b.proverStatus.setText(R.string.settings_prover_forgotten);
        });
        // What a paired prover learns, in the core's own words (version.prover_history_warning),
        // shown before any pairing is saved — own or not; the resource is the fallback.
        b.proverWarning.setText(ProverCore.NATIVE.historyWarning());
        // The one-step pairing of the prover the build ships the address of: offered only once
        // the core names one, under the same warning (it is above, on screen before the button
        // is). Its URL and fingerprint are shown beside it; its link never reaches this screen.
        trusted = wallet().trustedProver();
        if (trusted != null) {
            b.proverTrustedBody.setText(getString(R.string.settings_prover_trusted_body, trusted.url, trusted.fingerprint));
            b.proverUseTrusted.setOnClickListener(v -> useTrustedProver());
            b.proverTrusted.setVisibility(View.VISIBLE);
        }
        paintProver();

        // Keys
        String viewing = wallet().viewingKey();
        b.viewingKey.setText(viewing);
        b.copyViewing.setOnClickListener(v -> copy("viewing key", viewing, getString(R.string.copied)));
        b.openHistory.setOnClickListener(v -> {
            copy("viewing key", viewing, null);
            open(EXPLORER + "/viewing");
        });
        b.exportFile.setOnClickListener(v -> confirmSecret(() -> {
            try {
                String file = wallet().walletInfo().optString("key_file");
                Intent i = new Intent(Intent.ACTION_SEND).setType("application/json").putExtra(Intent.EXTRA_TEXT, file).putExtra(Intent.EXTRA_SUBJECT, "wallet.key.json");
                startActivity(Intent.createChooser(i, getString(R.string.settings_export_file)));
            } catch (Exception e) {
                toast(e.getMessage());
            }
        }));
        b.exportSpend.setOnClickListener(v -> confirmSecret(() -> {
            try {
                String sk = wallet().walletInfo().optString("spend_key");
                new AlertDialog.Builder(this)
                        .setTitle(R.string.settings_export_spend)
                        .setMessage(sk)
                        .setPositiveButton(R.string.create_copy, (d, w) -> copy("spend key", sk, getString(R.string.copied)))
                        .setNegativeButton(R.string.ok, null)
                        .show();
            } catch (Exception e) {
                toast(e.getMessage());
            }
        }));

        // Security
        spinner(b.autolock, R.array.autolock_labels, indexOf(getResources().getIntArray(R.array.autolock_minutes), prefs.autoLockMinutes()),
                i -> prefs.setAutoLockMinutes(getResources().getIntArray(R.array.autolock_minutes)[i]));
        String[] themes = getResources().getStringArray(R.array.theme_values);
        spinner(b.theme, R.array.theme_labels, indexOf(themes, prefs.theme()), i -> {
            prefs.setTheme(themes[i]);
            App.applyTheme(themes[i]);
        });

        // Wallet
        b.rescan.setOnClickListener(v -> {
            wallet().rescanFromZero(null);
            finish();
        });
        b.remove.setOnClickListener(v -> new AlertDialog.Builder(this)
                .setTitle(R.string.settings_remove)
                .setMessage(R.string.settings_remove_warning)
                .setPositiveButton(R.string.settings_remove, (d, w) -> {
                    wallet().removeWallet();
                    startActivity(new Intent(this, WelcomeActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK | Intent.FLAG_ACTIVITY_NEW_TASK));
                    finish();
                })
                .setNegativeButton(R.string.cancel, null)
                .show());

        // About
        String coreVersion = "?", chainBuild = "?";
        try {
            JSONObject c = Core.constants();
            coreVersion = c.optString("version");
            chainBuild = c.optString("chain_build");
        } catch (Exception ignored) {
        }
        b.about.setText(getString(R.string.settings_about_body, BuildConfig.VERSION_NAME, coreVersion, chainBuild));
    }

    private void launchProverScanner() {
        proverScanner.launch(new ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt(getString(R.string.settings_prover_scan_prompt))
                .setBeepEnabled(false)
                .setOrientationLocked(false));
    }

    /**
     * Who makes this wallet's proofs, and — for a pairing — whether the prover answers. "My own"
     * only for a pairing whose link said so: a prover somebody else runs makes the proofs too (the
     * job carries the viewing key), and the line under it says what it sees.
     */
    private void paintProver() {
        ProverPairing p = wallet().prefs().prover();
        int run = ++probeRun;
        if (p == null) {
            b.proverBy.setText(R.string.settings_prover_device);
            b.proverFingerprint.setVisibility(View.GONE);
            b.proverNotOwn.setVisibility(View.GONE);
            b.proverForget.setVisibility(View.GONE);
            b.proverProbe.setText(R.string.settings_prover_device_body);
            return;
        }
        b.proverBy.setText(getString(p.own ? R.string.settings_prover_remote : R.string.settings_prover_remote_paired, p.name));
        b.proverFingerprint.setText(getString(R.string.settings_prover_fingerprint, p.fingerprint));
        b.proverFingerprint.setVisibility(View.VISIBLE);
        b.proverNotOwn.setVisibility(p.own ? View.GONE : View.VISIBLE);
        b.proverForget.setVisibility(View.VISIBLE);
        b.proverProbe.setText(R.string.settings_prover_asking);
        wallet().runInBackground(() -> {
            String line = wallet().probeProver(p).line();
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed() || run != probeRun) return;
                b.proverProbe.setText(line);
            });
        });
    }

    /**
     * Save = the core reads the link (the URL rule) → the prover's own key, which must be the
     * link's → the token, key, URL and {@code own} into the KeyVault, the display copy into Prefs.
     * The link leaves the field once it is paired: it carries the token. A pairing not marked as
     * the user's own is saved and used like any other (a viewing-key job), and said so.
     */
    private void saveProver() {
        if (pairing) return;
        String link = String.valueOf(b.proverLink.getText()).trim();
        if (link.isEmpty()) {
            b.proverStatus.setText(R.string.settings_prover_no_link);
            return;
        }
        pairing = true;
        b.proverSave.setEnabled(false);
        b.proverUseTrusted.setEnabled(false);
        b.proverStatus.setText(R.string.settings_prover_pairing);
        wallet().runInBackground(() -> {
            String status;
            boolean paired = false;
            try {
                ProverPairing.Paired done = wallet().pairProver(link);
                paired = true;
                status = getString(R.string.settings_prover_paired, done.pairing.name, done.pairing.fingerprint)
                        + (done.pairing.own ? "" : " " + getString(R.string.settings_prover_not_own_note));
            } catch (Exception e) {
                status = getString(R.string.settings_prover_not_paired, e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
            }
            String s = status;
            boolean ok = paired;
            runOnUiThread(() -> {
                pairing = false;
                if (isFinishing() || isDestroyed()) return;
                b.proverSave.setEnabled(true);
                b.proverUseTrusted.setEnabled(true);
                if (ok) {
                    b.proverLink.setText(""); // the token goes with it
                    paintProver();
                }
                b.proverStatus.setText(s);
            });
        });
    }

    /**
     * "Use the RandProtocol prover": the built-in link pairs through the same checks as a pasted
     * one ({@code pairTrustedProver}: the pinned fingerprint first, then the prover's own key),
     * stored NOT own and named after the pool. Never run by itself — only from this tap, with the
     * warning above on screen; the status says once more what the prover can then read.
     */
    private void useTrustedProver() {
        if (pairing || trusted == null) return;
        pairing = true;
        b.proverUseTrusted.setEnabled(false);
        b.proverSave.setEnabled(false);
        b.proverStatus.setText(R.string.settings_prover_pairing);
        TrustedProver t = trusted;
        wallet().runInBackground(() -> {
            String status;
            boolean paired = false;
            try {
                ProverPairing.Paired done = wallet().pairTrustedProver();
                paired = true;
                status = getString(R.string.settings_prover_paired_trusted, done.pairing.name, done.pairing.fingerprint,
                        ProverCore.NATIVE.historyWarning());
            } catch (Exception e) {
                status = getString(R.string.settings_prover_not_paired, e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
            }
            String s = status;
            boolean ok = paired;
            runOnUiThread(() -> {
                pairing = false;
                if (isFinishing() || isDestroyed()) return;
                b.proverUseTrusted.setEnabled(true);
                b.proverSave.setEnabled(true);
                if (ok) paintProver();
                b.proverStatus.setText(s);
            });
        });
    }

    private interface Pick {
        void pick(int index);
    }

    private void spinner(android.widget.Spinner s, int labels, int selected, Pick pick) {
        ArrayAdapter<CharSequence> a = ArrayAdapter.createFromResource(this, labels, android.R.layout.simple_spinner_item);
        a.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        s.setAdapter(a);
        s.setSelection(Math.max(0, selected), false);
        s.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                pick.pick(position);
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {
            }
        });
    }

    private static int indexOf(int[] arr, int v) {
        for (int i = 0; i < arr.length; i++) if (arr[i] == v) return i;
        return 0;
    }

    private static int indexOf(String[] arr, String v) {
        for (int i = 0; i < arr.length; i++) if (arr[i].equals(v)) return i;
        return 0;
    }

    private void confirmSecret(Runnable then) {
        new AlertDialog.Builder(this)
                .setTitle(R.string.settings_keys)
                .setMessage(R.string.settings_export_warning)
                .setPositiveButton(R.string.settings_show, (d, w) -> then.run())
                .setNegativeButton(R.string.cancel, null)
                .show();
    }
}
