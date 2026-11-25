package org.randprotocol.wallet.wallet;

import org.randprotocol.wallet.R;
import org.randprotocol.wallet.util.L10n;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * RandProtocol prover keys that were retired (VK-9, randprotocol/monorepo#18) — the Java twin of
 * {@code ui/engine/backend-shared.js}'s {@code RETIRED_PROVER_KEYS}: the key every pool machine
 * shared until wallet 0.6.9, and the four members wallets 0.6.9 to 0.8.0 pinned. A wallet released
 * before a key was retired still pins it and cannot be told otherwise; this list is what every
 * release after the retirement carries. A listed key is never paired, never probed, never sent a
 * job and never used as a pool member, whatever a link, a stored pairing or the pinned descriptor
 * says ({@link ProverPairing}, {@link RemoteSend}).
 *
 * <p>The list is the engine's, entry for entry: {@code ui/test/native-retired-keys.test.mjs} fails
 * when this file, the Swift twin ({@code ios/RandWallet/Services/ProverPairingService.swift}) and
 * the engine disagree. Add an entry — one per line, in exactly this shape — in the change that
 * retires a key; never remove one.
 */
public final class RetiredProverKeys {
    private RetiredProverKeys() {}

    static final String[] FINGERPRINTS = {
        "RGTF-7HKJ-XZFV-GQ1J", // retired 2026-10-01
        "ZEXQ-1JHV-ZT60-KFB5", // retired 2026-10-22
        "D2XV-WXVT-PZRC-D7G8", // retired 2026-10-22
        "SR28-MYT0-GR6A-03DE", // retired 2026-10-22
        "GMNX-Q1QD-FEXG-JHJM", // retired 2026-10-22
    };

    /** What a refusal says, in every shell's words (the engine's {@code retiredProverText}). */
    static final String KEY_RETIRED = "This prover's key was retired and is no longer used. "
            + "Pair another prover in Settings, or update Rand Wallet to the latest version.";

    private static final Set<String> SHIPPED = Collections.unmodifiableSet(new LinkedHashSet<>(Arrays.asList(FINGERPRINTS)));

    /** The keys this build refuses: {@link #FINGERPRINTS}, or a test's own list ({@link #setForTest}). */
    private static volatile Set<String> keys = SHIPPED;

    /** Whether {@code fingerprint} is a retired prover key. */
    public static boolean isRetired(String fingerprint) {
        return fingerprint != null && keys.contains(fingerprint);
    }

    /** The refusal, in the app's language. */
    public static String text() {
        return L10n.t(R.string.prover_key_retired, KEY_RETIRED);
    }

    /** The test seam (the engine's {@code proverOptions.retiredKeys}): no argument restores the shipped list. */
    static void setForTest(String... fingerprints) {
        keys = fingerprints.length == 0 ? SHIPPED : Collections.unmodifiableSet(new LinkedHashSet<>(Arrays.asList(fingerprints)));
    }
}
