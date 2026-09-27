package org.randprotocol.wallet.ui;

import android.text.Editable;
import android.text.TextWatcher;

/** A {@link TextWatcher} that only cares that the text changed. */
final class Watcher implements TextWatcher {
    private final Runnable onChange;

    Watcher(Runnable onChange) {
        this.onChange = onChange;
    }

    @Override
    public void beforeTextChanged(CharSequence s, int start, int count, int after) {}

    @Override
    public void onTextChanged(CharSequence s, int start, int before, int count) {}

    @Override
    public void afterTextChanged(Editable s) {
        onChange.run();
    }
}
