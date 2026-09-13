package org.randprotocol.wallet.ui;

import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;

import androidx.appcompat.app.AlertDialog;

import org.json.JSONObject;
import org.randprotocol.wallet.App;
import org.randprotocol.wallet.BuildConfig;
import org.randprotocol.wallet.R;
import org.randprotocol.wallet.core.Core;
import org.randprotocol.wallet.databinding.ActivitySettingsBinding;
import org.randprotocol.wallet.rpc.RpcClient;
import org.randprotocol.wallet.security.Prefs;

public class SettingsActivity extends BaseActivity {
    private ActivitySettingsBinding b;

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
