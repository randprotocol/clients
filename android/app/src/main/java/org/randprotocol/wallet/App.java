package org.randprotocol.wallet;

import android.app.Application;
import android.content.res.Configuration;
import android.content.res.Resources;
import android.os.LocaleList;

import androidx.appcompat.app.AppCompatDelegate;

import org.randprotocol.wallet.security.Prefs;
import org.randprotocol.wallet.util.L10n;

public class App extends Application {
    private static App instance;
    private static String localizedTags;
    private static Resources localized;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        // The code with no Context (send and swap rules, the prover client, the contact book)
        // speaks through L10n: the resources of the language in force.
        L10n.install(new L10n.Source() {
            @Override
            public String string(int id, Object... args) {
                Resources r = resources();
                return args == null || args.length == 0 ? r.getString(id) : r.getString(id, args);
            }

            @Override
            public String plural(int id, int count, Object... args) {
                return resources().getQuantityString(id, count, args);
            }
        });
        applyTheme(new Prefs(this).theme());
    }

    /**
     * The app's resources in the language in force: the one chosen in Settings › Language
     * (AppCompatDelegate's application locales), else the system's. From API 33 the platform
     * already applies a per-app language to the application's own resources; below it AppCompat
     * applies it to activities only, so this builds the configuration for everything else (the
     * proving service's notification, the L10n strings).
     */
    public static synchronized Resources resources() {
        App app = instance;
        String tags = AppCompatDelegate.getApplicationLocales().toLanguageTags();
        if (tags.isEmpty()) return app.getResources();
        if (!tags.equals(localizedTags)) {
            Configuration c = new Configuration(app.getResources().getConfiguration());
            c.setLocales(LocaleList.forLanguageTags(tags));
            localized = app.createConfigurationContext(c).getResources();
            localizedTags = tags;
        }
        return localized;
    }

    /** {@code id} with {@code args}, in the language in force ({@link #resources}). */
    public static String text(int id, Object... args) {
        return args == null || args.length == 0 ? resources().getString(id) : resources().getString(id, args);
    }

    public static void applyTheme(String theme) {

        switch (theme) {
            case Prefs.THEME_LIGHT:
                AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_NO);
                break;
            case Prefs.THEME_SYSTEM:
                AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM);
                break;
            default:
                AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_YES);
        }
    }
}
