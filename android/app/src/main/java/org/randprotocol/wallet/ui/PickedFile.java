package org.randprotocol.wallet.ui;

import org.randprotocol.wallet.R;
import org.randprotocol.wallet.util.L10n;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** A proposal, a policy or a key file the person picked: refused by its size before it is read, and a read failure has its own sentence. */
public final class PickedFile {
    private PickedFile() {}

    /** The JS screen's {@code MAX_FILE_BYTES}. */
    public static final int MAX_BYTES = 1 << 20;

    static String tooLarge() {
        return L10n.t(R.string.msauth_file_too_large, "That file is larger than a proposal, a policy or a key file can be.");
    }

    static String unreadable() {
        return L10n.t(R.string.msauth_file_unreadable, "That file could not be read.");
    }

    /**
     * The file's text. {@code size} is the provider's size (negative when unknown): over the cap,
     * the file is refused before a byte is read; the read itself stops past the cap, so a size that
     * lied still cannot hand over more. IllegalArgumentException carries the sentence.
     */
    public static String read(long size, InputStream in) {
        if (size > MAX_BYTES) throw new IllegalArgumentException(tooLarge());
        if (in == null) throw new IllegalArgumentException(unreadable());
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        try (InputStream s = in) {
            int n;
            while ((n = s.read(buf)) != -1) {
                out.write(buf, 0, n);
                if (out.size() > MAX_BYTES) throw new IllegalArgumentException(tooLarge());
            }
        } catch (IOException | RuntimeException e) {
            if (e instanceof IllegalArgumentException) throw (IllegalArgumentException) e;
            throw new IllegalArgumentException(unreadable());
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }
}
