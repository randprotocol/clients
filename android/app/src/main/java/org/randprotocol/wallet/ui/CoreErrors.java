package org.randprotocol.wallet.ui;

import org.randprotocol.wallet.R;
import org.randprotocol.wallet.util.L10n;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The wallet core's error sentences, in the user's language — {@code ui/engine/core-errors.js} on
 * Android. {@code wallet-core} (core/crates/wallet-core, and the fullnode crates it vendors)
 * refuses in English — "insufficient balance: have 1 RAND, need 2 RAND" — and the core must not
 * know the app's languages: it is one crate for every shell and the CLI. So the translation is
 * here, where a core reply becomes text on a screen: {@link org.randprotocol.wallet.core.CoreException#getLocalizedMessage}
 * runs every core message through {@link #translate}, and the screens show
 * {@code getLocalizedMessage()}.
 *
 * <p>Only sentences a user can meet are mapped — a send, a swap, an import, a pairing link, a
 * pasted payment link, a paired prover's reply. The core's own invariants and parameter-shape
 * complaints stay English. A sentence with a variable part is matched by a regular expression
 * over the core's {@code format!}, its holes passed as {@code %1$s}…; a sentence that composes
 * another ("the RAND fee: insufficient balance …") translates its inner part first. Anything not
 * matched comes back unchanged, and in English the answer is always the input, byte for byte.
 */
public final class CoreErrors {
    private CoreErrors() {}

    private static final Map<String, Integer> EXACT = new HashMap<>();

    private static final class Patterned {
        final Pattern re;
        final int id;
        final String english;
        /** Groups that are themselves core sentences, translated through the whole table again. */
        final int[] inner;

        Patterned(String re, int id, String english, int[] inner) {
            this.re = Pattern.compile(re, Pattern.DOTALL);
            this.id = id;
            this.english = english;
            this.inner = inner;
        }
    }

    private static final List<Patterned> PATTERNED = new ArrayList<>();

    private static void e(int id, String english) {
        EXACT.put(english, id);
    }

    private static void p(String re, int id, String english, int... inner) {
        PATTERNED.add(new Patterned(re, id, english, inner));
    }

    static {
        // ---- importing a key (import_key) ----
        e(R.string.core_err_spend_key_format, "a spend key is 64 hex characters, or a wallet.key.json");
        e(R.string.core_err_key_file_version, "key file must be version 2");
        e(R.string.core_err_key_file_no_spend_key, "key file has no spend_key");
        e(R.string.core_err_spend_key_hex, "spend_key must be 64 hex characters");
        // ---- an address (parse_address, address_fingerprint, a recipient) ----
        e(R.string.core_err_address_prefix, "shielded address must start with rand1");
        e(R.string.core_err_address_base58, "shielded address is not base58");
        // ---- a randpay: link (uri_parse) ----
        e(R.string.core_err_not_randpay, "not a randpay: link");
        e(R.string.core_err_percent_encoding, "bad percent-encoding");
        // ---- an amount (parse_amount) ----
        e(R.string.core_err_not_a_number, "not a number");
        e(R.string.core_err_amount_overflow, "amount overflow");
        e(R.string.core_err_amounts_overflow, "amounts overflow");
        // ---- planning a transfer (plan_transfer) ----
        e(R.string.core_err_amount_zero, "amount must be greater than zero");
        e(R.string.core_err_no_rand_for_fee, "a transfer pays its fee in RAND, and this wallet holds no spendable RAND: receive some RAND (on a testnet, `rand faucet`) and retry");
        // ---- a memo on a chain that carries none ----
        e(R.string.core_err_no_memo_chain, "this chain carries no memo: its envelopes predate it (send again with an empty memo)");
        // ---- a paired prover ----
        e(R.string.core_err_prover_reply_hex, "the prover's reply is not hex");
        // The core's own sentence (version.prover_history_warning), shown before any pairing.
        e(R.string.settings_prover_warning, "This prover will be able to read this wallet's whole history — every payment received and sent, before and after today. It cannot spend. To keep your history private, run your own.");
        e(R.string.core_err_spend_key_own_only,
 "this chain's bundle witness carries the spend key; only a prover paired as your own (a link made with `rand-prover pair --own`) may receive it");
        // ---- a pairing link (parse_prover_link) ----
        e(R.string.core_err_not_randprover, "not a randprover: link");
        e(R.string.core_err_link_no_query, "the link has no ?url=…&token=… part");
        e(R.string.core_err_link_no_url, "the link has no url");
        e(R.string.core_err_link_no_token, "the link has no token");
        e(R.string.core_err_link_url_empty, "the link's url is empty");
        // ---- an RPL-2 invoke (dry_run_invoke, plan_invoke, prove_invoke) ----
        e(R.string.core_err_payout_zero, "a payout of zero creates nothing; the chain refuses it");
        e(R.string.core_err_cells_ascending, "cell keys must be strictly ascending");

        // ---- composed: a prefix the core adds to another error ----
        p("^the RAND fee: (.+)$", R.string.core_err_rand_fee, "the RAND fee: %1$s", 1);
        p("^recipient: (.+)$", R.string.core_err_recipient, "recipient: %1$s", 1);
        p("^address: (.+)$", R.string.core_err_address, "address: %1$s", 1);
        p("^bad address: (.+)$", R.string.core_err_bad_address, "bad address: %1$s", 1);
        p("^not a key file: (.+)$", R.string.core_err_not_key_file, "not a key file: %1$s");
        // ---- an address ----
        p("^shielded address decodes to (\\d+) bytes, expected (\\d+)$", R.string.core_err_address_length, "shielded address decodes to %1$s bytes, expected %2$s");
        // ---- a randpay: link ----
        p("^unknown parameter (.+)$", R.string.core_err_unknown_parameter, "unknown parameter %1$s");
        p("^parameter (.+) given twice$", R.string.core_err_parameter_twice, "parameter %1$s given twice");
        p("^bad amount (.+)$", R.string.core_err_bad_amount, "bad amount %1$s");
        p("^bad asset (.+)$", R.string.core_err_bad_asset, "bad asset %1$s");
        p("^memo is (\\d+) bytes, at most (\\d+)$", R.string.core_err_memo_too_long, "memo is %1$s bytes, at most %2$s");
        // ---- an amount ----
        p("^too many decimal places \\(max (\\d+)\\)$", R.string.core_err_too_many_decimals, "too many decimal places (max %1$s)");
        p("^(\\d+) units of asset (\\d+)$", R.string.core_err_units_of_asset, "%1$s units of asset %2$s");
        // ---- selecting notes (select_inputs, through every plan) ----
        p("^insufficient balance: have (.+), need (.+)$", R.string.core_err_insufficient_balance, "insufficient balance: have %1$s, need %2$s", 1, 2);
        p("^need more than two notes; the largest two hold (.+) — consolidate first by sending to your own address$",
                R.string.core_err_two_notes, "need more than two notes; the largest two hold %1$s — consolidate first by sending to your own address", 1);
        p("^a transfer pays its fee in RAND, and this wallet holds no spendable RAND: (.+) RAND is held by a pending submission — rescan once it commits \\(or expires\\) and retry$",
                R.string.core_err_rand_held_pending, "a transfer pays its fee in RAND, and this wallet holds no spendable RAND: %1$s RAND is held by a pending submission — rescan once it commits (or expires) and retry");
        p("^fee must be at least (.+) RAND \\(the bundle floor\\)$", R.string.core_err_fee_floor, "fee must be at least %1$s RAND (the bundle floor)");
        p("^inputs hold (.+), but amount \\+ fee is (.+)$", R.string.core_err_inputs_short, "inputs hold %1$s, but amount + fee is %2$s");
        p("^inputs hold (.+), but fee \\+ RAND deposit is (.+)$", R.string.core_err_inputs_short_deposit, "inputs hold %1$s, but fee + RAND deposit is %2$s");
        p("^the notes of asset (\\d+) hold (\\d+) units, but the transfer is (\\d+)$", R.string.core_err_asset_notes_transfer, "the notes of asset %1$s hold %2$s units, but the transfer is %3$s");
        p("^the notes of asset (\\d+) hold (\\d+) units, but the deposit is (\\d+)$", R.string.core_err_asset_notes_deposit, "the notes of asset %1$s hold %2$s units, but the deposit is %3$s");
        p("^the RAND notes hold (.+), but the fee is (.+)$", R.string.core_err_rand_notes_fee, "the RAND notes hold %1$s, but the fee is %2$s");
        p("^the RAND notes hold (.+), but fee \\+ RAND deposit is (.+)$", R.string.core_err_rand_notes_deposit, "the RAND notes hold %1$s, but fee + RAND deposit is %2$s");
        // ---- a memo on a chain that carries none ----
        p("^chain (\\d+) carries no memo: its genesis sets no envelope size, whatever the node claims \\(send again with an empty memo\\)$",
                R.string.core_err_chain_no_memo, "chain %1$s carries no memo: its genesis sets no envelope size, whatever the node claims (send again with an empty memo)");
        // ---- the chain's guests and gas, against this build's ----
        p("^this chain pins every bundle at (\\d+) gas, but this wallet's bundle guest declares (\\d+); update the wallet$",
                R.string.core_err_gas_pin, "this chain pins every bundle at %1$s gas, but this wallet's bundle guest declares %2$s; update the wallet");
        p("^this build does not carry the chain's bundle guest ([0-9a-f]+): update the wallet$",
                R.string.core_err_no_bundle_guest, "this build does not carry the chain's bundle guest %1$s: update the wallet");
        p("^this chain's auth guest is ([0-9a-f]+); this wallet carries ([0-9a-f]+) — refusing to prove a v3 bundle it cannot authorise; update the wallet$",
                R.string.core_err_auth_guest, "this chain's auth guest is %1$s; this wallet carries %2$s — refusing to prove a v3 bundle it cannot authorise; update the wallet");
        // ---- proving on this device ----
        p("^proving failed: (.+)$", R.string.core_err_proving_failed, "proving failed: %1$s");
        p("^proving the spend authorisation failed: (.+)$", R.string.core_err_proving_auth_failed, "proving the spend authorisation failed: %1$s");
        p("^proving the call failed: (.+)$", R.string.core_err_proving_call_failed, "proving the call failed: %1$s");
        // ---- a paired prover (prepare_*, finish_proof) ----
        p("^this prover charges (.+) RAND per proof, and this version of the wallet does not pay a prover's fee: pair a prover that charges nothing, or prove on this device$",
                R.string.core_err_prover_fee, "this prover charges %1$s RAND per proof, and this version of the wallet does not pay a prover's fee: pair a prover that charges nothing, or prove on this device");
        p("^the prover quotes a fee this wallet cannot read \\((.+)\\); not sending it a job$",
                R.string.core_err_prover_fee_unreadable, "the prover quotes a fee this wallet cannot read (%1$s); not sending it a job");
        p("^the prover's reply does not open: (.+)$", R.string.core_err_prover_reply_sealed, "the prover's reply does not open: %1$s");
        p("^the prover's bundle proof is (\\d+) bytes, over this chain's (\\d+)-byte cap \\(max_proof_bytes\\); not using it$",
                R.string.core_err_prover_proof_too_big, "the prover's bundle proof is %1$s bytes, over this chain's %2$s-byte cap (max_proof_bytes); not using it");
        p("^the prover's proof: (.+)$", R.string.core_err_prover_proof, "the prover's proof: %1$s", 1);
        p("^the proof does not verify: (.+)$", R.string.core_err_proof_not_verify, "the proof does not verify: %1$s");
        // ---- a pairing link ----
        p("^prover key is not base58: (.+)$", R.string.core_err_prover_key_base58, "prover key is not base58: %1$s");
        p("^prover key is (\\d+) bytes, expected (\\d+)$", R.string.core_err_prover_key_length, "prover key is %1$s bytes, expected %2$s");
        p("^malformed parameter (.+)$", R.string.core_err_malformed_parameter, "malformed parameter %1$s");
        p("^token is not 64 hex digits: (.+)$", R.string.core_err_token_hex, "token is not 64 hex digits: %1$s");
        // ---- an RPL-2 invoke ----
        p("^the program does not accept this transition: (.+)$", R.string.core_err_program_refuses, "the program does not accept this transition: %1$s");
        p("^the call proof is (\\d+) bytes, over this chain's (\\d+)-byte cap \\(max_proof_bytes\\); it would be refused, so nothing was built$",
                R.string.core_err_call_proof_too_big, "the call proof is %1$s bytes, over this chain's %2$s-byte cap (max_proof_bytes); it would be refused, so nothing was built");
    }

    /** The core's {@code message} in the language in force; the message itself when it is not one this table knows. */
    public static String translate(String message) {
        if (message == null || message.isEmpty()) return message;
        Integer id = EXACT.get(message);
        if (id != null) return L10n.t(id, message);
        for (Patterned p : PATTERNED) {
            Matcher m = p.re.matcher(message);
            if (!m.matches()) continue;
            Object[] args = new Object[m.groupCount()];
            for (int g = 1; g <= m.groupCount(); g++) {
                String v = m.group(g);
                for (int inner : p.inner) if (inner == g) v = translate(v);
                args[g - 1] = v;
            }
            return L10n.t(p.id, p.english, args);
        }
        return message;
    }

    /** {@code e}'s message for a screen: a core message translated, anything else as it is (its class name when it has none). */
    public static String of(Throwable e) {
        if (e == null) return "";
        String m = e.getLocalizedMessage();
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m;
    }
}
