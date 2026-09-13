package org.randprotocol.wallet.security;

import android.content.Context;
import android.content.SharedPreferences;

/** Non-secret settings: network, lock timeout, theme. */
public final class Prefs {
    private static final String FILE = "rand_wallet_prefs";

    public static final String DEFAULT_RPC_URL = "https://rpc.randprotocol.org";
    public static final long DEFAULT_CHAIN_ID = 8;
    public static final int DEFAULT_AUTO_LOCK_MINUTES = 15;

    public static final String THEME_DARK = "dark";
    public static final String THEME_LIGHT = "light";
    public static final String THEME_SYSTEM = "system";

    private final SharedPreferences p;

    public Prefs(Context c) {
        p = c.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    public String rpcUrl() {
        return p.getString("rpc_url", DEFAULT_RPC_URL);
    }

    public void setRpcUrl(String url) {
        p.edit().putString("rpc_url", url.trim()).apply();
    }

    public long chainId() {
        return p.getLong("chain_id", DEFAULT_CHAIN_ID);
    }

    public void setChainId(long id) {
        p.edit().putLong("chain_id", id).apply();
    }

    public int autoLockMinutes() {
        return p.getInt("auto_lock_minutes", DEFAULT_AUTO_LOCK_MINUTES);
    }

    public void setAutoLockMinutes(int m) {
        p.edit().putInt("auto_lock_minutes", m).apply();
    }

    public String theme() {
        return p.getString("theme", THEME_DARK);
    }

    public void setTheme(String t) {
        p.edit().putString("theme", t).apply();
    }

    /** Set once the user has confirmed they saved the spend key shown at creation. */
    public boolean backedUp() {
        return p.getBoolean("backed_up", false);
    }

    public void setBackedUp(boolean b) {
        p.edit().putBoolean("backed_up", b).apply();
    }
}
