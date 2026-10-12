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

    /** The private-multisig refusals (Task 5's table, ui/engine/core-errors.js), mapped and unchanged in English. */
    @Test
    public void theMultisigSentencesAreMappedAndEnglishIsTheInput() {
        String[] exact = {
            "the transaction does not hash to the proposal's binding",
            "the proposal's signing_message is not its binding's",
            "the proposal's auth_commit is not this policy's account",
            "the proposal's expected digest is not its bundle's",
            "the transaction carries no bundle",
            "the transaction carries an action; a private multisig proposal is a payment from its bundle alone",
            "the witness's value cannot be checked: its nk or salt is not this proposal's",
            "this key is not one of the policy's signers",
            "a share is index:hex",
            "a signer key is a rand-node keygen file or 64 hex characters",
            "a signer seed is 64 hex characters",
            "expected_recipients must be a list of addresses",
            "the key file's public_key is not the one its seed derives",
            "the key file's address is not the one its seed derives",
            "no expected recipient given: the payee was NOT checked",
        };
        String[] patterned = {
            "this proposal is for another policy: it names ab12, this policy is cd34",
            "output 2 does not open as this account's: refusing to sign value it cannot see",
            "the witness's value does not match the transaction: input 1 does not nullify to the bundle's nullifier",
            "the witness's value does not match the outputs: asset 0 has 25 in and 24 out with the fee and burns",
            "the proposal expires at 9000, outside its bundle's window (100, 2124]",
            "the transaction is for chain 7, the proposal says chain 21",
            "signer 1's signature does not verify over this proposal",
            "signer 4 is not in this policy (it has 3 signers)",
            "expected recipient rand1abc: shielded address is not base58",
            "the policy does not parse: expected value at line 1 column 1",
            "the proposal does not parse: EOF while parsing",
        };
        for (String m : exact) {
            assertEquals(m, true, CoreErrors.knows(m));
            same(m);
        }
        for (String m : patterned) {
            assertEquals(m, true, CoreErrors.knows(m));
            same(m);
        }
        // The crate's payee refusals are shown verbatim, by design (Task 3).
        same("output 2 pays b9856a063c1fb742, not an expected recipient");
    }
}
