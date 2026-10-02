package org.randprotocol.wallet.ui;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** In English (no resources on the JVM) a core message comes back byte for byte, mapped or not. */
public class CoreErrorsTest {
    private static void same(String m) {
        assertEquals(m, CoreErrors.translate(m));
    }

    @Test
    public void englishIsTheInput() {
        same("not a randpay: link");
        same("insufficient balance: have 1 RAND, need 2 RAND");
        same("the RAND fee: insufficient balance: have 0 RAND, need 0.0001 RAND");
        same("shielded address decodes to 12 bytes, expected 64");
        same("memo is 600 bytes, at most 512");
        same("something the table does not know");
        assertEquals(null, CoreErrors.translate(null));
        assertEquals("", CoreErrors.translate(""));
    }
}
