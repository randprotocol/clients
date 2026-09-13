package org.randprotocol.wallet.core;

/**
 * The JNI surface of the Rust core (core/crates/wallet-ffi, library {@code shrugg_wallet}).
 * One call: a method name and a JSON object in, a JSON reply out —
 * {@code {"ok":true,"value":…}} or {@code {"ok":false,"error":"…"}}. See {@link Core} for the
 * typed wrapper.
 */
public final class NativeCore {
    private NativeCore() {}

    static {
        System.loadLibrary("shrugg_wallet");
    }

    public static native String call(String method, String paramsJson);
}
