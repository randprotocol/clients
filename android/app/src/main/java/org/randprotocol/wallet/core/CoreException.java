package org.randprotocol.wallet.core;

import org.randprotocol.wallet.ui.CoreErrors;

/**
 * An error the core reported ({@code {"ok":false,"error":…}}). {@link #getMessage} is the core's
 * message verbatim (English — what code may match on); {@link #getLocalizedMessage} is that
 * message in the language in force ({@link CoreErrors}), what a screen shows.
 */
public class CoreException extends Exception {
    public CoreException(String message) {
        super(message);
    }

    @Override
    public String getLocalizedMessage() {
        return CoreErrors.translate(getMessage());
    }
}
