package org.randprotocol.wallet.util;

import java.util.Locale;

/**
 * Strings for the code that has no {@link android.content.Context} — the send and swap rules, the
 * prover client, the contact book — and is unit tested on the JVM. Each call names its string
 * resource and carries the English sentence it stands for: on a device the app installs a
 * {@link Source} over the resources of the language in force ({@code App.onCreate}), and the
 * resource is what is shown; on the JVM (no Android, no resources) the English is formatted here,
 * so the tests read exactly the sentence a user of the English UI sees.
 *
 * <p>The English argument must equal the resource's English value ({@code StringsParityTest}
 * checks every literal one). Amounts are passed in already formatted (ASCII digits, the app's own
 * {@code Amounts} rules) as {@code %s}; only counts are {@code %d}.
 */
public final class L10n {
    private L10n() {}

    /** The app's resources in the language in force. */
    public interface Source {
        String string(int id, Object... args);

        String plural(int id, int count, Object... args);
    }

    private static volatile Source source;

    public static void install(Source s) {
        source = s;
    }

    /** {@code id} with {@code args}; {@code english} formatted the same way when there are no resources. */
    public static String t(int id, String english, Object... args) {
        Source s = source;
        if (s != null) {
            try {
                return s.string(id, args);
            } catch (RuntimeException ignored) {
                // A missing or malformed translation falls back to English, never a crash.
            }
        }
        return format(english, args);
    }

    /** The {@code <plurals>} {@code id} for {@code count}; {@code one} or {@code other} in English. */
    public static String plural(int id, int count, String one, String other, Object... args) {
        Source s = source;
        if (s != null) {
            try {
                return s.plural(id, count, args);
            } catch (RuntimeException ignored) {
                // as above
            }
        }
        return format(count == 1 ? one : other, args);
    }

    private static String format(String english, Object... args) {
        return args == null || args.length == 0 ? english : String.format(Locale.ROOT, english, args);
    }
}
