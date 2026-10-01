package org.randprotocol.wallet.security;

import android.content.Context;
import android.content.SharedPreferences;

/** Non-secret settings: network, lock timeout, theme, the paired prover's public fields. */
public final class Prefs {
    private static final String FILE = "rand_wallet_prefs";

    public static final String DEFAULT_RPC_URL = "https://rpc.randprotocol.org";
    public static final long DEFAULT_CHAIN_ID = 20;
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

    /**
     * The paired prover (delegated proving), or null: proofs are made on this device. DISPLAY
     * ONLY — the token, the key and URL a job is sealed and sent to, and the {@code own} a
     * spend-key job is gated on, are the {@link KeyVault}'s record, so a tampered copy here can
     * neither redirect a job nor promote a prover to "own".
     */
    public org.randprotocol.wallet.wallet.ProverPairing prover() {
        return org.randprotocol.wallet.wallet.ProverPairing.fromJson(p.getString("prover", null));
    }

    public void setProver(org.randprotocol.wallet.wallet.ProverPairing pairing) {
        if (pairing == null) p.edit().remove("prover").commit();
        else p.edit().putString("prover", pairing.toJson().toString()).commit();
    }

    /**
     * Whether the user chose NO prover (wallet 0.6.8): then the RandProtocol prover, otherwise the
     * default where this device cannot prove, is not used either. Pairing a prover, or "Use the
     * RandProtocol prover", clears it.
     */
    public boolean noProver() {
        return p.getBoolean("no_prover", false);
    }

    public void setNoProver(boolean none) {
        if (none) p.edit().putBoolean("no_prover", true).commit();
        else p.edit().remove("no_prover").commit();
    }

    /**
     * The address of the wallet that read the one-time notice about the RandProtocol prover, or
     * null. A record naming another wallet counts for nothing; removing the wallet clears it.
     */
    public String proverNoticeFor() {
        return p.getString("prover_notice_for", null);
    }

    public void setProverNoticeFor(String address) {
        if (address == null) p.edit().remove("prover_notice_for").commit();
        else p.edit().putString("prover_notice_for", address).commit();
    }

    /** Set once the user has confirmed they saved the spend key shown at creation. */
    public boolean backedUp() {
        return p.getBoolean("backed_up", false);
    }

    public void setBackedUp(boolean b) {
        p.edit().putBoolean("backed_up", b).apply();
    }
}
