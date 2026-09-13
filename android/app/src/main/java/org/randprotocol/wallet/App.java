package org.randprotocol.wallet;

import android.app.Application;

import androidx.appcompat.app.AppCompatDelegate;

import org.randprotocol.wallet.security.Prefs;

public class App extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        applyTheme(new Prefs(this).theme());
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
