package org.randprotocol.wallet.store;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;
import org.randprotocol.wallet.util.Amounts;

import java.math.BigInteger;

public class AmountsTest {
    @Test
    public void formatsAndParsesLikeTheChain() {
        assertEquals("1.5", Amounts.format(new BigInteger("1500000000")));
        assertEquals("0.000000001", Amounts.format(BigInteger.ONE));
        assertEquals("42", Amounts.format(new BigInteger("42000000000")));
        assertEquals("0", Amounts.format(BigInteger.ZERO));
        assertEquals(new BigInteger("1000000000"), Amounts.parse("1"));
        assertEquals(new BigInteger("1500000000"), Amounts.parse("1.5"));
        assertEquals(new BigInteger("250000000"), Amounts.parse(".25"));
        assertEquals(BigInteger.ONE, Amounts.parse("0.000000001"));
        assertNull(Amounts.parse("0.0000000001"));
        assertNull(Amounts.parse("abc"));
        assertNull(Amounts.parse(""));
        assertNull(Amounts.parse("1,5"));
    }

    @Test
    public void shortensAddressesAndHashes() {
        String addr = "shrugg1" + "a".repeat(1661);
        assertEquals("shrugg1aaaaa…aaaaaa", Amounts.shortAddress(addr));
        assertEquals("short", Amounts.shortAddress("short"));
        assertEquals("abcdefgh…abcdef", Amounts.shortHex("abcdefgh0123456789abcdef"));
    }
}
