package org.randprotocol.wallet.core;

/** An error the core reported ({@code {"ok":false,"error":…}}), with its message verbatim. */
public class CoreException extends Exception {
    public CoreException(String message) {
        super(message);
    }
}
