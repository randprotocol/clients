import Foundation

// Private multisig signing (spec docs/superpowers/specs/2026-10-11-msauth-signing-design.md §3,
// §4): the core's `msauth_*` replies, the signing rules every app shares (`MsauthRules`, the same
// decisions as ui/engine/signers.js `verdict`) and the order a signature is made in
// (`MsauthSigning`).

/// One output of `msauth_check`'s reply (wallet-core msauth.rs). `amount` is a decimal string;
/// `matches` is the crate's `"<address fp> (<amount> RAND)"` when a named payee matched.
struct MsauthOutput: Equatable {
    let ownerFingerprint: String
    let toAccount: Bool
    let amount: String
    let asset: UInt32
    let memo: String
    let matches: String?
    let needsPayee: Bool
}

/// One intended-payment entry as the caller passed it and its address's owner fingerprint (nil
/// when the address does not parse).
struct MsauthExpected: Equatable {
    let entry: String
    let fingerprint: String?
}

/// `msauth_check`'s reply, kept as the JSON the core gave (`json`) with typed views for a screen.
/// The views are lenient — a field that is missing or of the wrong type reads as nil or is left
/// out — because `MsauthRules.verdict` judges `json` itself and refuses a malformed reply
/// (`.malformedSummary`); nothing here is a reason to sign. `lines` is fullnode's text, shown
/// verbatim, never translated.
struct MsauthSummary {
    let json: Any?

    init(json: Any?) { self.json = json }

    private var object: [String: Any] { json as? [String: Any] ?? [:] }

    var recipientsChecked: Bool { MsauthJSON.bool(object["recipients_checked"]) == true }
    var chainId: UInt64? { MsauthJSON.uint(object["chain_id"]) }
    var expiresAt: UInt64? { MsauthJSON.uint(object["expires_at"]) }
    var bindingDomain: UInt64? { MsauthJSON.uint(object["binding_domain"]) }
    var genesis: String? { object["genesis"] as? String }
    var policyFingerprint: String? { object["policy_fingerprint"] as? String }
    var signingMessage: String? { object["signing_message"] as? String }
    var fee: String? { object["fee"] as? String }
    var lines: [String] { (object["lines"] as? [Any])?.compactMap { $0 as? String } ?? [] }
    var outputs: [MsauthOutput] {
        ((object["outputs"] as? [Any]) ?? []).compactMap { item in
            guard let o = item as? [String: Any], let toAccount = MsauthJSON.bool(o["to_account"]),
                  let amount = MsauthJSON.amount(o["amount"]) else { return nil }
            return MsauthOutput(ownerFingerprint: o["owner_fingerprint"] as? String ?? "", toAccount: toAccount, amount: amount,
                                asset: MsauthJSON.uint(o["asset"]).flatMap { UInt32(exactly: $0) } ?? 0,
                                memo: o["memo"] as? String ?? "", matches: o["matches"] as? String,
                                needsPayee: MsauthJSON.bool(o["needs_payee"]) ?? false)
        }
    }
    var expected: [MsauthExpected] {
        ((object["expected"] as? [Any]) ?? []).compactMap { item in
            guard let x = item as? [String: Any], let entry = x["entry"] as? String else { return nil }
            return MsauthExpected(entry: entry, fingerprint: x["fingerprint"] as? String)
        }
    }
}

struct MsauthSigner: Decodable {
    let seed: String
    let publicKey: String
    let address: String
    let index: Int?
    enum CodingKeys: String, CodingKey { case seed, address, index, publicKey = "public_key" }
}

struct MsauthPolicyInfo: Decodable, Equatable {
    let fingerprint: String
    let threshold: Int
    let signers: Int
    let address: String
    let policyHash: String
    enum CodingKeys: String, CodingKey { case fingerprint, threshold, signers, address, policyHash = "policy_hash" }
}

enum MsauthVerdict: Equatable {
    case signable(blocksLeft: UInt64)
    case malformedSummary
    case uncheckedRecipient
    case noNode(url: String)
    case wrongChain(proposal: UInt64, wallet: UInt64)
    case wrongGenesis
    case expired(head: UInt64, expiresAt: UInt64)
    /// The fee (base units) is over the signer profile's limit (`max`, base units).
    case feeOverLimit(fee: String, max: String)
    /// The fee is over the RAND the proposal pays out (`paid`, base units).
    case feeOverPayout(fee: String, paid: String)

    var isSignable: Bool { if case .signable = self { return true } else { return false } }

    /// The refusal in the user's language (the same English as ui/engine/signers.js); nil when
    /// signable.
    var message: String? {
        switch self {
        case .signable: return nil
        case .malformedSummary:
            return String(localized: "The proposal check returned an incomplete answer, so this proposal is not signed.")
        case .uncheckedRecipient:
            return String(localized: "Enter the address of every payee: an output that does not match the address you entered, or whose address is empty, cannot be signed.")
        case .noNode(let url):
            let u = url.isEmpty ? "—" : url
            return String(localized: "No node answered at \(u), so the expiry cannot be checked and this proposal is not signed. Retry when the node is reachable.")
        case .wrongChain(let proposal, let wallet):
            return String(localized: "This proposal is for chain \(String(proposal)); this wallet is on chain \(String(wallet)).")
        case .wrongGenesis:
            return String(localized: "This proposal is bound to another genesis than the one this wallet's node serves.")
        case .expired(let head, let expiresAt):
            return String(localized: "This proposal expires at height \(String(expiresAt)) and the chain is at \(String(head)): too late to sign. Ask for a new proposal.")
        case .feeOverLimit(let fee, let max):
            let (f, m) = (MsauthRules.randText(fee), MsauthRules.randText(max))
            return String(localized: "The fee of \(f) RAND is more than this signer allows (\(m) RAND), so this proposal is not signed. Raise the signer's fee limit or ask for a new proposal.")
        case .feeOverPayout(let fee, let paid):
            let (f, p) = (MsauthRules.randText(fee), MsauthRules.randText(paid))
            return String(localized: "The fee of \(f) RAND is more than the \(p) RAND this proposal pays out, so this proposal is not signed.")
        }
    }
}

/// A proposal that may not be signed: the verdict that refused it.
struct MsauthRefusal: LocalizedError, Equatable {
    let verdict: MsauthVerdict
    var errorDescription: String? { verdict.message }
}

/// Reading `JSONSerialization`'s values strictly: a JSON `true` is an `NSNumber` too, so a Bool and
/// a number are told apart by their CoreFoundation type, never by a cast.
enum MsauthJSON {
    /// JavaScript's `Number.MAX_SAFE_INTEGER`, the bound ui/engine/signers.js applies.
    static let maxSafeInteger: Double = 9_007_199_254_740_991

    static func isBool(_ v: Any?) -> Bool {
        guard let n = v as? NSNumber else { return false }
        return CFGetTypeID(n) == CFBooleanGetTypeID()
    }
    static func bool(_ v: Any?) -> Bool? {
        guard isBool(v), let n = v as? NSNumber else { return nil }
        return n.boolValue
    }
    /// A non-negative safe integer: a JSON number, not a Bool, integral, 0...2^53-1.
    static func uint(_ v: Any?) -> UInt64? {
        guard !isBool(v), !(v is String), let n = v as? NSNumber else { return nil }
        let d = n.doubleValue
        guard d.isFinite, d >= 0, d <= maxSafeInteger, d.rounded() == d else { return nil }
        return UInt64(d)
    }
    /// An amount: a string of ASCII digits (whitespace around allowed), or a non-negative safe
    /// integer. Returned trimmed, as text.
    static func amount(_ v: Any?) -> String? {
        if let s = v as? String {
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return !t.isEmpty && t.unicodeScalars.allSatisfy({ ("0"..."9").contains($0) }) ? t : nil
        }
        return uint(v).map { String($0) }
    }
    static func isZeroAmount(_ v: Any?) -> Bool {
        if let s = v as? String {
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return !t.isEmpty && t.allSatisfy { $0 == "0" }
        }
        return uint(v) == 0
    }
    /// An asset id as ui/engine/signers.js reads it (`Number(o.asset)`): a number or digit string.
    static func asset(_ v: Any?) -> UInt64? {
        if let s = v as? String { return amount(s).flatMap { UInt64($0) } }
        return uint(v)
    }
    static func isHex(_ s: String) -> Bool {
        !s.isEmpty && s.unicodeScalars.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) || ("A"..."F").contains($0) }
    }
}

/// The signing rules every app shares (spec §4): the payee named and matched with its amount, the
/// CLI's 16-block margin, no node no signature, the proposal's chain and genesis against this
/// wallet's node, the fingerprint's last four. The same decisions, in the same order, as
/// ui/engine/signers.js `verdict`.
enum MsauthRules {
    /// Blocks a proposal needs before its window closes: the CLI's `EXPIRY_MARGIN`.
    static let expiryMargin: UInt64 = 16

    /// The fee a signer accepts unless its profile says otherwise: 0.1 RAND in base units (1 RAND =
    /// 10^9, the unit the core's summary writes `fee` in) — ui/engine/signers.js
    /// `DEFAULT_MAX_FEE_UNITS`. The binding a signer signs covers the fee, so the rule reads it.
    static let defaultMaxFeeUnits = "100000000"

    /// A profile's fee limit in base units: its own when it is a digit string, else the default.
    static func feeLimit(_ maxFee: String?) -> String {
        guard let m = maxFee, !m.isEmpty, m.unicodeScalars.allSatisfy({ ("0"..."9").contains($0) }) else { return defaultMaxFeeUnits }
        return m
    }

    /// A fee limit typed in RAND ("0.1") → base units as digits; nil for anything but a positive amount.
    static func parseMaxFee(_ text: String) -> String? {
        guard let units = Amount.parse(text.trimmingCharacters(in: .whitespacesAndNewlines)), units > 0 else { return nil }
        return String(units)
    }

    /// Two digit strings compared as whole numbers, whatever their length.
    static func compareUnits(_ a: String, _ b: String) -> ComparisonResult {
        let x = String(a.drop { $0 == "0" }), y = String(b.drop { $0 == "0" })
        if x.count != y.count { return x.count < y.count ? .orderedAscending : .orderedDescending }
        return x == y ? .orderedSame : (x < y ? .orderedAscending : .orderedDescending)
    }

    /// Base units (a digit string of any length) as RAND, 9 decimals, trailing zeros dropped (JS `formatUnits`).
    static func randText(_ units: String) -> String {
        let digits = String(units.drop { $0 == "0" })
        let padded = String(repeating: "0", count: max(0, 10 - digits.count)) + digits
        let whole = String(padded.dropLast(9)).drop { $0 == "0" }
        var frac = String(padded.suffix(9))
        while frac.hasSuffix("0") { frac.removeLast() }
        let w = whole.isEmpty ? "0" : String(whole)
        return frac.isEmpty ? w : "\(w).\(frac)"
    }

    /// A pasted or opened file: a leading byte-order mark dropped, whitespace trimmed.
    static func clean(_ s: String) -> String {
        var t = s
        if t.hasPrefix("\u{FEFF}") { t.removeFirst() }
        return t.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The intended payments as the core is given them: each entry cleaned, none dropped.
    static func payees(_ list: [String]) -> [String] { list.map(clean) }

    /// An entry that is empty or has no address before its amount.
    static func isBlank(_ entry: String) -> Bool {
        let t = clean(entry)
        return t.isEmpty || t.hasPrefix(":")
    }

    /// An entry without an amount: no `:`, or nothing after the first one.
    static func isAmountless(_ entry: String) -> Bool {
        guard let i = entry.firstIndex(of: ":") else { return true }
        return entry[entry.index(after: i)...].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Of the paying outputs (raw JSON), the owner fingerprints paid a non-RAND asset and those paid
    /// RAND. An output whose asset is missing or unreadable counts as RAND (fails closed).
    static func payeeAssets(_ paying: [[String: Any]]) -> (token: Set<String>, rand: Set<String>) {
        var token = Set<String>(), rand = Set<String>()
        for o in paying {
            guard let fp = o["owner_fingerprint"] as? String, !fp.isEmpty else { continue }
            if let asset = MsauthJSON.asset(o["asset"]), asset != 0 { token.insert(fp) } else { rand.insert(fp) }
        }
        return (token, rand)
    }

    /// Whether a checked proposal may be signed now, on this wallet's chain. `recipients` is the
    /// list the check was given (`payees`), `head` nil when no node answered. `maxFee` is the signer
    /// profile's fee limit in base units (the default when nil or unreadable): the fee rule refuses
    /// a fee over it, and a fee over the RAND the proposal pays out (change is not a payment; a
    /// token is not RAND, so a token-only proposal is bounded by the limit alone). It needs no
    /// node and comes after the payee rule — ui/engine/signers.js `verdict`, the same order.
    static func verdict(summary: MsauthSummary, head: UInt64?, chainId: UInt64, genesis: String?, url: String,
                        recipients: [String], maxFee: String? = nil) -> MsauthVerdict {
        guard let s = summary.json as? [String: Any] else { return .malformedSummary }
        // Never sign on an unchecked payee (a coordinator could pay its own key).
        guard MsauthJSON.bool(s["recipients_checked"]) == true else { return .uncheckedRecipient }
        if recipients.contains(where: isBlank) { return .uncheckedRecipient }
        // The review shows `lines` verbatim: missing, or anything but an array of strings, is malformed.
        guard let lines = s["lines"] as? [Any], lines.allSatisfy({ $0 is String }) else { return .malformedSummary }
        guard let outs = s["outputs"] as? [Any] else { return .malformedSummary }
        var outputs: [[String: Any]] = []
        for item in outs {
            guard let o = item as? [String: Any], MsauthJSON.bool(o["to_account"]) != nil, MsauthJSON.amount(o["amount"]) != nil else {
                return .malformedSummary
            }
            outputs.append(o)
        }
        let paying = outputs.filter { MsauthJSON.bool($0["to_account"]) == false && !MsauthJSON.isZeroAmount($0["amount"]) }
        // No intended payment named at all while something pays out: unchecked, whatever the core said.
        if recipients.isEmpty && !paying.isEmpty { return .uncheckedRecipient }
        // An amount is pinned on every entry, except an entry whose own owner fingerprint owns a
        // paying non-RAND output and NO paying RAND output (the core refuses a pin on a non-RAND
        // output). Per row: one small non-RAND output cannot unpin the RAND rows, nor the RAND paid
        // to its own payee (1 unit of a token beside an inflated RAND output is refused).
        let amountless = recipients.filter(isAmountless)
        if !amountless.isEmpty {
            guard let exp = s["expected"] as? [Any] else { return .uncheckedRecipient }
            let (tokenOwners, randOwners) = payeeAssets(paying)
            let allowed = { (entry: String) -> Bool in
                exp.contains { item in
                    guard let x = item as? [String: Any], x["entry"] as? String == entry,
                          let fp = x["fingerprint"] as? String, !fp.isEmpty else { return false }
                    return tokenOwners.contains(fp) && !randOwners.contains(fp)
                }
            }
            if !amountless.allSatisfy(allowed) { return .uncheckedRecipient }
        }
        let unmatched = paying.contains { o in
            guard let m = o["matches"] as? String else { return true }
            return m.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        if unmatched { return .uncheckedRecipient }
        guard let expiresAt = MsauthJSON.uint(s["expires_at"]), let proposalChain = MsauthJSON.uint(s["chain_id"]),
              let domain = MsauthJSON.uint(s["binding_domain"]),
              let proposalGenesis = s["genesis"] as? String, MsauthJSON.isHex(proposalGenesis),
              let fee = MsauthJSON.amount(s["fee"]) else {
            return .malformedSummary
        }
        let limit = feeLimit(maxFee)
        if compareUnits(fee, limit) == .orderedDescending { return .feeOverLimit(fee: fee, max: limit) }
        // The RAND paid out: paying outputs whose asset is not a token (a missing or unreadable
        // asset is RAND, as in `payeeAssets`). A sum past UInt64 is more than any fee here.
        var paid: UInt64 = 0
        var huge = false
        for o in paying {
            if let asset = MsauthJSON.asset(o["asset"]), asset != 0 { continue }
            guard let a = MsauthJSON.amount(o["amount"]).flatMap({ UInt64($0) }) else { huge = true; break }
            let (sum, overflow) = paid.addingReportingOverflow(a)
            if overflow { huge = true; break }
            paid = sum
        }
        if !huge && paid > 0 && compareUnits(fee, String(paid)) == .orderedDescending {
            return .feeOverPayout(fee: fee, paid: String(paid))
        }
        guard let head else { return .noNode(url: url) }
        if proposalChain != chainId { return .wrongChain(proposal: proposalChain, wallet: chainId) }
        if domain >= 1 && proposalGenesis.lowercased() != (genesis ?? "").lowercased() { return .wrongGenesis }
        // head + 16 >= expires_at, written so it cannot overflow.
        if head >= expiresAt || expiresAt - head <= expiryMargin {
            return .expired(head: head, expiresAt: expiresAt)
        }
        return .signable(blocksLeft: expiresAt - head)
    }

    /// The fingerprint's last four characters, typed: case, dashes and every whitespace ignored (as JS).
    static func confirms(fingerprint: String, typed: String) -> Bool {
        let want = String(fingerprint.replacingOccurrences(of: "-", with: "").suffix(4)).lowercased()
        let got = String(typed.unicodeScalars.filter { $0 != "-" && !CharacterSet.whitespacesAndNewlines.contains($0) }.map(Character.init)).lowercased()
        return want.count == 4 && got == want
    }
}

// MARK: the order a signature is made in

/// What `MsauthSigning` asks of the node this wallet uses. `RpcClient` is one.
protocol MsauthNode {
    var nodeURL: String { get }
    func chainId() async throws -> UInt64
    func headHeight() async throws -> UInt64
    func genesisHash() async throws -> String?
}

extension RpcClient: MsauthNode {
    var nodeURL: String { url.absoluteString }
}

/// The two core calls a signature depends on; `RandMsauthCore` is the real one.
protocol MsauthCore {
    func check(proposal: String, policy: String, expectedRecipients: [String]) throws -> MsauthSummary
    func sign(proposal: String, policy: String, seed: Data, expectedRecipients: [String]) throws -> String
}

struct RandMsauthCore: MsauthCore {
    func check(proposal: String, policy: String, expectedRecipients: [String]) throws -> MsauthSummary {
        try RandCore.msauthCheck(proposal: proposal, policy: policy, expectedRecipients: expectedRecipients)
    }
    func sign(proposal: String, policy: String, seed: Data, expectedRecipients: [String]) throws -> String {
        try RandCore.msauthSign(proposal: proposal, policy: policy, seed: seed, expectedRecipients: expectedRecipients)
    }
}

struct MsauthCheck {
    /// nil when the entries were refused before the core was asked.
    let summary: MsauthSummary?
    let verdict: MsauthVerdict
}

struct MsauthShare: Equatable {
    let share: String
    let index: Int
}

/// Check, then sign, for one signer profile: the proposal is a parameter and never stored (it
/// carries the account's witness). `node` nil is "no node": the proposal is shown, never signed.
struct MsauthSigning {
    let store: SignerStore
    let core: MsauthCore
    let node: MsauthNode?
    /// This wallet's chain (Settings).
    let chainId: UInt64

    /// The node's head, from a node on this wallet's chain; any failure is `.noNode`.
    private func judge(_ summary: MsauthSummary, _ payees: [String], maxFee: String?) async -> MsauthVerdict {
        guard let node else {
            return MsauthRules.verdict(summary: summary, head: nil, chainId: chainId, genesis: nil, url: "", recipients: payees, maxFee: maxFee)
        }
        let url = node.nodeURL
        do {
            guard try await node.chainId() == chainId else {
                return MsauthRules.verdict(summary: summary, head: nil, chainId: chainId, genesis: nil, url: url, recipients: payees, maxFee: maxFee)
            }
            let head = try await node.headHeight()
            // A height past 2^53-1 is no answer a node gives honestly (the JS rule's safe-integer bound).
            guard head <= 9_007_199_254_740_991 else {
                return MsauthRules.verdict(summary: summary, head: nil, chainId: chainId, genesis: nil, url: url, recipients: payees, maxFee: maxFee)
            }
            let genesis = try await node.genesisHash()
            return MsauthRules.verdict(summary: summary, head: head, chainId: chainId, genesis: genesis, url: url, recipients: payees, maxFee: maxFee)
        } catch {
            return MsauthRules.verdict(summary: summary, head: nil, chainId: chainId, genesis: nil, url: url, recipients: payees, maxFee: maxFee)
        }
    }

    /// The signer profile's fee limit (base units), nil when it names none (the default applies).
    private func maxFee(_ id: String) -> String? {
        store.profiles.first { $0.id == id }?.maxFee
    }

    /// The core's check with the intended payments, and the verdict on it now. A blank entry is
    /// refused before the core is asked (it would otherwise be dropped or misread).
    func check(id: String, proposal: String, expectedRecipients: [String]) async throws -> MsauthCheck {
        let policy = try store.policy(id)
        let payees = MsauthRules.payees(expectedRecipients)
        if payees.contains(where: MsauthRules.isBlank) { return MsauthCheck(summary: nil, verdict: .uncheckedRecipient) }
        let summary = try core.check(proposal: MsauthRules.clean(proposal), policy: policy, expectedRecipients: payees)
        return MsauthCheck(summary: summary, verdict: await judge(summary, payees, maxFee: maxFee(id)))
    }

    /// The share, or the refusal (`MsauthRefusal`, or the core's error). The order: check and
    /// judge; read the seed (the system asks for Face ID / Touch ID / the passcode); re-read the
    /// head and judge again, since the prompt can take as long as the person likes; sign with the
    /// same list the check used, so the core re-runs the payee check on exactly what was judged.
    /// The seed buffer is zeroed on every exit (`SignerStore.withSeedAsync`).
    func sign(id: String, proposal: String, expectedRecipients: [String], reason: String) async throws -> MsauthShare {
        let policy = try store.policy(id)
        let text = MsauthRules.clean(proposal)
        let payees = MsauthRules.payees(expectedRecipients)
        if payees.contains(where: MsauthRules.isBlank) { throw MsauthRefusal(verdict: .uncheckedRecipient) }
        let summary = try core.check(proposal: text, policy: policy, expectedRecipients: payees)
        let limit = maxFee(id)
        let first = await judge(summary, payees, maxFee: limit)
        guard first.isSignable else { throw MsauthRefusal(verdict: first) }
        // Leaving the screen cancels this task: stop before the Face ID prompt and before signing.
        try Task.checkCancellation()
        let share = try await store.withSeedAsync(id, reason: reason) { seed in
            let again = await judge(summary, payees, maxFee: limit)
            guard again.isSignable else { throw MsauthRefusal(verdict: again) }
            try Task.checkCancellation()
            return try core.sign(proposal: text, policy: policy, seed: seed, expectedRecipients: payees)
        }
        guard let head = share.split(separator: ":").first, let index = Int(head.trimmingCharacters(in: .whitespaces)) else {
            throw RandCore.CoreError(message: "msauth_sign returned no share")
        }
        return MsauthShare(share: share, index: index)
    }

    /// Whether another signer's share verifies over this proposal; throws the core's refusal.
    func verifyShare(id: String, proposal: String, share: String) throws {
        try RandCore.msauthVerifyShare(proposal: MsauthRules.clean(proposal), policy: try store.policy(id), share: MsauthRules.clean(share))
    }
}

extension Data {
    /// Bytes from hex (an even count of hex digits), or nil.
    init?(hex: String) {
        let scalars = Array(hex.unicodeScalars)
        guard scalars.count % 2 == 0 else { return nil }
        var out = Data(capacity: scalars.count / 2)
        var i = 0
        while i < scalars.count {
            guard let hi = Data.nibble(scalars[i]), let lo = Data.nibble(scalars[i + 1]) else { return nil }
            out.append(hi << 4 | lo)
            i += 2
        }
        self = out
    }
    private static func nibble(_ c: Unicode.Scalar) -> UInt8? {
        switch c.value {
        case 48...57: return UInt8(c.value - 48)
        case 97...102: return UInt8(c.value - 87)
        case 65...70: return UInt8(c.value - 55)
        default: return nil
        }
    }
    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}
