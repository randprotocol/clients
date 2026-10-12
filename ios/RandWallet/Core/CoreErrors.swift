import Foundation

/// The Rust core answers every refusal with one English sentence (`{"ok":false,"error":"…"}`,
/// `wallet_core::dispatch`; the texts live in core/crates/wallet-core/src/lib.rs and the crates it
/// vendors). Those sentences reach the screen verbatim — `RandCore.CoreError.errorDescription`,
/// a `parse_address` reply's `error`, the prover-history warning — so the ones a user can meet
/// are listed here, each mapped to the same sentence as a key in `Localizable.xcstrings`: in
/// English nothing changes; in another language the translator's sentence shows. Variable parts
/// (amounts, byte counts, digests, the tail of a nested error) are captured and interpolated.
///
/// A sentence this file does not know passes through unchanged. Rules are matched in order, exact
/// text first, then the patterns; a nested message (`bad address: …`, `proving failed: …`) is
/// mapped again for its tail. See ios/LOCALIZATION.md.
enum CoreErrors {
    static func localized(_ message: String) -> String {
        if let exact = exact[message] { return exact() }
        for rule in patterns {
            if let m = rule.regex.firstMatch(in: message, range: NSRange(message.startIndex..., in: message)) {
                let groups = (1..<m.numberOfRanges).map { i -> String in
                    guard let r = Range(m.range(at: i), in: message) else { return "" }
                    return String(message[r])
                }
                return rule.render(groups)
            }
        }
        return message
    }

    // MARK: exact sentences

    private static let exact: [String: () -> String] = [
        // import_key / wallet_info
        "spend key must be 64 hex characters": { String(localized: "spend key must be 64 hex characters") },
        "spend_key must be 64 hex characters": { String(localized: "spend_key must be 64 hex characters") },
        "a spend key is 64 hex characters, or a wallet.key.json": { String(localized: "a spend key is 64 hex characters, or a wallet.key.json") },
        "key file must be version 2": { String(localized: "key file must be version 2") },
        "key file has no spend_key": { String(localized: "key file has no spend_key") },
        // parse_address / address_fingerprint (ShieldedAddress::parse)
        "shielded address must start with rand1": { String(localized: "shielded address must start with rand1") },
        "shielded address is not base58": { String(localized: "shielded address is not base58") },
        // uri_parse / uri_format (PaymentUri)
        "not a randpay: link": { String(localized: "not a randpay: link") },
        "bad percent-encoding": { String(localized: "bad percent-encoding") },
        // parse_amount
        "too many decimal places (max 9)": { String(localized: "too many decimal places (max 9)") },
        "not a number": { String(localized: "not a number") },
        "amount overflow": { String(localized: "amount overflow") },
        // select_inputs / plan_* / build_*
        "amounts overflow": { String(localized: "amounts overflow") },
        "amount must be greater than zero": { String(localized: "amount must be greater than zero") },
        "the chosen notes do not cover the amount and the burn": { String(localized: "the chosen notes do not cover the amount and the burn") },
        "the chosen RAND notes do not cover the fee": { String(localized: "the chosen RAND notes do not cover the fee") },
        "this chain carries no memo: its envelopes predate it (send again with an empty memo)":
            { String(localized: "this chain carries no memo: its envelopes predate it (send again with an empty memo)") },
        // prepare_* (a paired prover)
        "this chain's bundle witness carries the spend key; only a prover paired as your own (a link made with `rand-prover pair --own`) may receive it":
            { String(localized: "this chain's bundle witness carries the spend key; only a prover paired as your own (a link made with `rand-prover pair --own`) may receive it") },
        // parse_prover_link (PairingLink::parse)
        "not a randprover: link": { String(localized: "not a randprover: link") },
        "the link has no ?url=…&token=… part": { String(localized: "the link has no ?url=…&token=… part") },
        "the link has no url": { String(localized: "the link has no url") },
        "the link has no token": { String(localized: "the link has no token") },
        "the link's url is empty": { String(localized: "the link's url is empty") },
        // version.prover_history_warning (ProverPairingService.warning)
        "This prover will be able to read this wallet's whole history — every payment received and sent, before and after today. It cannot spend. To keep your history private, run your own.":
            { String(localized: "This prover will be able to read this wallet's whole history — every payment received and sent, before and after today. It cannot spend. To keep your history private, run your own.") },
        // msauth_* (private multisig signing, fullnode randprotocol-msig)
        "the transaction does not hash to the proposal's binding": { String(localized: "the transaction does not hash to the proposal's binding") },
        "the proposal's signing_message is not its binding's": { String(localized: "the proposal's signing_message is not its binding's") },
        "the proposal's auth_commit is not this policy's account": { String(localized: "the proposal's auth_commit is not this policy's account") },
        "the proposal's expected digest is not its bundle's": { String(localized: "the proposal's expected digest is not its bundle's") },
        "the transaction carries no bundle": { String(localized: "the transaction carries no bundle") },
        "the transaction carries an action; a private multisig proposal is a payment from its bundle alone": { String(localized: "the transaction carries an action; a private multisig proposal is a payment from its bundle alone") },
        "the witness's value cannot be checked: its nk or salt is not this proposal's": { String(localized: "the witness's value cannot be checked: its nk or salt is not this proposal's") },
        "this key is not one of the policy's signers": { String(localized: "this key is not one of the policy's signers") },
        "a share is index:hex": { String(localized: "a share is index:hex") },
        "a signer key is a rand-node keygen file or 64 hex characters": { String(localized: "a signer key is a rand-node keygen file or 64 hex characters") },
        "a signer seed is 64 hex characters": { String(localized: "a signer seed is 64 hex characters") },
        "expected_recipients must be a list of addresses": { String(localized: "expected_recipients must be a list of addresses") },
        "the key file's public_key is not the one its seed derives": { String(localized: "the key file's public_key is not the one its seed derives") },
        "the key file's address is not the one its seed derives": { String(localized: "the key file's address is not the one its seed derives") },
        "no expected recipient given: the payee was NOT checked": { String(localized: "no expected recipient given: the payee was NOT checked") },
    ]

    // MARK: sentences with a variable part

    private struct Rule {
        let regex: NSRegularExpression
        let render: ([String]) -> String
        init(_ pattern: String, _ render: @escaping ([String]) -> String) {
            regex = try! NSRegularExpression(pattern: "^" + pattern + "$", options: [.dotMatchesLineSeparators])
            self.render = render
        }
    }

    private static let patterns: [Rule] = [
        Rule(#"shielded address decodes to (\d+) bytes, expected (\d+)"#) { g in
            String(localized: "shielded address decodes to \(g[0]) bytes, expected \(g[1])")
        },
        Rule(#"bad address: (.+)"#) { g in String(localized: "bad address: \(localized(g[0]))") },
        Rule(#"address: (.+)"#) { g in String(localized: "address: \(localized(g[0]))") },
        Rule(#"unknown parameter (.+)"#) { g in String(localized: "unknown parameter \(g[0])") },
        Rule(#"parameter (.+) given twice"#) { g in String(localized: "parameter \(g[0]) given twice") },
        Rule(#"bad amount (.*)"#) { g in String(localized: "bad amount \(g[0])") },
        Rule(#"bad asset (.*)"#) { g in String(localized: "bad asset \(g[0])") },
        Rule(#"memo is (\d+) bytes, at most (\d+)"#) { g in String(localized: "memo is \(g[0]) bytes, at most \(g[1])") },
        Rule(#"not a key file: (.+)"#) { g in String(localized: "not a key file: \(g[0])") },
        Rule(#"insufficient balance: have (.+), need (.+)"#) { g in
            String(localized: "insufficient balance: have \(g[0]), need \(g[1])")
        },
        Rule(#"need more than two notes; the largest two hold (.+) — consolidate first by sending to your own address"#) { g in
            String(localized: "need more than two notes; the largest two hold \(g[0]) — consolidate first by sending to your own address")
        },
        Rule(#"inputs hold (.+), but amount \+ fee is (.+)"#) { g in
            String(localized: "inputs hold \(g[0]), but amount + fee is \(g[1])")
        },
        Rule(#"the RAND notes hold (.+), but the fee is (.+)"#) { g in
            String(localized: "the RAND notes hold \(g[0]), but the fee is \(g[1])")
        },
        Rule(#"fee must be at least (.+) RAND \(the bundle floor\)"#) { g in
            String(localized: "fee must be at least \(g[0]) RAND (the bundle floor)")
        },
        Rule(#"fee (\d+) is below the bundle floor (\d+)"#) { g in
            String(localized: "fee \(g[0]) is below the bundle floor \(g[1])")
        },
        Rule(#"chain (\d+) carries no memo: its genesis sets no envelope size, whatever the node claims \(send again with an empty memo\)"#) { g in
            String(localized: "chain \(g[0]) carries no memo: its genesis sets no envelope size, whatever the node claims (send again with an empty memo)")
        },
        Rule(#"this build does not carry the chain's bundle guest ([0-9a-fA-F]+): update the wallet"#) { g in
            String(localized: "this build does not carry the chain's bundle guest \(g[0]): update the wallet")
        },
        Rule(#"this chain pins every bundle at (\d+) gas, but this wallet's bundle guest declares (\d+); update the wallet"#) { g in
            String(localized: "this chain pins every bundle at \(g[0]) gas, but this wallet's bundle guest declares \(g[1]); update the wallet")
        },
        Rule(#"this chain's auth guest is ([0-9a-fA-F]+); this wallet carries ([0-9a-fA-F]+) — refusing to prove a v3 bundle it cannot authorise; update the wallet"#) { g in
            String(localized: "this chain's auth guest is \(g[0]); this wallet carries \(g[1]) — refusing to prove a v3 bundle it cannot authorise; update the wallet")
        },
        Rule(#"this chain's bundle guest is v3 \(split authorisation\) but the node names no auth guest \(rand_status has no hc_auth\); this wallet carries ([0-9a-fA-F]+) — refusing to prove a bundle it cannot authorise"#) { g in
            String(localized: "this chain's bundle guest is v3 (split authorisation) but the node names no auth guest (rand_status has no hc_auth); this wallet carries \(g[0]) — refusing to prove a bundle it cannot authorise")
        },
        Rule(#"this chain names an auth guest but a v1/v2 bundle guest \(([0-9a-fA-F]+)\); the node is misconfigured or lying — refusing to prove"#) { g in
            String(localized: "this chain names an auth guest but a v1/v2 bundle guest (\(g[0])); the node is misconfigured or lying — refusing to prove")
        },
        // msauth_* (private multisig signing)
        Rule(#"this proposal is for another policy: it names ([0-9a-f]+), this policy is ([0-9a-f]+)"#) { g in
            String(localized: "this proposal is for another policy: it names \(g[0]), this policy is \(g[1])")
        },
        Rule(#"output (\d+) does not open as this account's: refusing to sign value it cannot see"#) { g in
            String(localized: "output \(g[0]) does not open as this account's: refusing to sign value it cannot see")
        },
        Rule(#"the witness's value does not match the transaction: input (\d+) does not nullify to the bundle's nullifier"#) { g in
            String(localized: "the witness's value does not match the transaction: input \(g[0]) does not nullify to the bundle's nullifier")
        },
        Rule(#"the witness's value does not match the outputs: asset (\d+) has (\d+) in and (\d+) out with the fee and burns"#) { g in
            String(localized: "the witness's value does not match the outputs: asset \(g[0]) has \(g[1]) in and \(g[2]) out with the fee and burns")
        },
        Rule(#"the proposal expires at (\d+), outside its bundle's window \((\d+), (\d+)\]"#) { g in
            String(localized: "the proposal expires at \(g[0]), outside its bundle's window (\(g[1]), \(g[2])]")
        },
        Rule(#"the transaction is for chain (\d+), the proposal says chain (\d+)"#) { g in
            String(localized: "the transaction is for chain \(g[0]), the proposal says chain \(g[1])")
        },
        Rule(#"signer (\d+)'s signature does not verify over this proposal"#) { g in
            String(localized: "signer \(g[0])'s signature does not verify over this proposal")
        },
        Rule(#"signer (\d+) is not in this policy \(it has (\d+) signers\)"#) { g in
            String(localized: "signer \(g[0]) is not in this policy (it has \(g[1]) signers)")
        },
        Rule(#"expected recipient (\S+): (.+)"#) { g in String(localized: "expected recipient \(g[0]): \(localized(g[1]))") },
        Rule(#"the policy does not parse: (.+)"#) { g in String(localized: "the policy does not parse: \(g[0])") },
        Rule(#"the proposal does not parse: (.+)"#) { g in String(localized: "the proposal does not parse: \(g[0])") },
        Rule(#"proving failed: (.+)"#) { g in String(localized: "proving failed: \(g[0])") },
        Rule(#"proving the spend authorisation failed: (.+)"#) { g in String(localized: "proving the spend authorisation failed: \(g[0])") },
        Rule(#"proving the call failed: (.+)"#) { g in String(localized: "proving the call failed: \(g[0])") },
        Rule(#"the program does not accept this transition: (.+)"#) { g in String(localized: "the program does not accept this transition: \(g[0])") },
        Rule(#"the proof does not verify: (.+)"#) { g in String(localized: "the proof does not verify: \(g[0])") },
        Rule(#"the prover's reply does not open: (.+)"#) { g in String(localized: "the prover's reply does not open: \(g[0])") },
        Rule(#"the prover's bundle proof is (\d+) bytes, over this chain's (\d+)-byte cap \(max_proof_bytes\); not using it"#) { g in
            String(localized: "the prover's bundle proof is \(g[0]) bytes, over this chain's \(g[1])-byte cap (max_proof_bytes); not using it")
        },
        Rule(#"this prover charges (.+) RAND per proof, and this version of the wallet does not pay a prover's fee: pair a prover that charges nothing, or prove on this device"#) { g in
            String(localized: "this prover charges \(g[0]) RAND per proof, and this version of the wallet does not pay a prover's fee: pair a prover that charges nothing, or prove on this device")
        },
        Rule(#"the node served code \((\d+) words\) and a public input \((\d+) words\) that do not hash to program ([0-9a-fA-F]+); not proving against them"#) { g in
            String(localized: "the node served code (\(g[0]) words) and a public input (\(g[1]) words) that do not hash to program \(g[2]); not proving against them")
        },
        Rule(#"prover key is (\d+) bytes, expected (\d+)"#) { g in String(localized: "prover key is \(g[0]) bytes, expected \(g[1])") },
        Rule(#"prover key is not base58: (.+)"#) { g in String(localized: "prover key is not base58: \(g[0])") },
        Rule(#"token is not 64 hex digits: (.+)"#) { g in String(localized: "token is not 64 hex digits: \(g[0])") },
        Rule(#"internal error: (.+)"#) { g in String(localized: "internal error: \(g[0])") },
    ]
}
