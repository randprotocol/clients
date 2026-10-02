import Foundation

/// A parsed `randpay:` link, exactly as the core's `uri_parse` answers it: every field, absent
/// ones `nil`, and the fingerprint of the address it carries (recomputed by the core, never read
/// off the link). `amount` is decimal text of the asset (`"1.5"`), `asset` an index or token id.
struct PaymentLink: Decodable, Equatable {
    let address: String
    let amount: String?
    let asset: String?
    let memo: String?
    let fingerprint: String
}

extension RandCore {
    /// `XXXX-XXXX-XXXX-XXXX`, sixteen characters computed from the address.
    static func addressFingerprint(_ address: String) throws -> String {
        struct R: Decodable { let fingerprint: String }
        return try call("address_fingerprint", ["address": address], as: R.self).fingerprint
    }

    /// A `randpay:` link. Throws on a link the core refuses. A bare address never comes here:
    /// `SendLinkRules.resolve` sends it down the address path (`parse_address`).
    static func uriParse(_ uri: String) throws -> PaymentLink {
        try call("uri_parse", ["uri": uri.trimmingCharacters(in: .whitespacesAndNewlines)], as: PaymentLink.self)
    }

    /// The core formats and parses back, so this never returns a link another wallet refuses.
    static func uriFormat(address: String, amount: String?, asset: String?, memo: String?) throws -> String {
        var p: [String: Any] = ["address": address]
        if let amount, !amount.isEmpty { p["amount"] = amount }
        if let asset, !asset.isEmpty { p["asset"] = asset }
        if let memo, !memo.isEmpty { p["memo"] = memo }
        struct R: Decodable { let uri: String }
        return try call("uri_format", p, as: R.self).uri
    }
}

/// What a recipient field holds, in the order the CLI's `rand send <to>` tries them.
enum RecipientKind: Equatable {
    case address, link, name

    init(_ text: String) {
        let s = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if s.hasPrefix("rand1") { self = .address }
        else if s.hasPrefix("randpay:") { self = .link }
        else { self = .name }
    }
}

/// The memo: at most 510 bytes of UTF-8 — bytes, not characters (spec 2026-09-26 §2.3).
enum Memo {
    static let maxBytes = 510
    static var noMemoNotice: String { String(localized: "This network doesn't carry memos; the memo will not be sent") }

    static func byteCount(_ text: String) -> Int { text.utf8.count }
    static func counter(_ text: String) -> String { String(localized: "\(byteCount(text))/\(maxBytes) bytes") }
    /// The memo — or any other stranger-chosen text, like a contact name — as it may be shown
    /// (final reviews 1 and 2). Memos are live on chains 14 and 15: anyone can pay a dust note
    /// carrying any memo to any public address, and a link carries any memo. One rule, the same as
    /// the CLI's `memo_display::sanitize`, the shared UI's `displayMemo`, Android's `Memo.display`
    /// and randprotocol.org's `/account`, applied before any truncation, by Unicode scalar (so a
    /// CR LF, one Swift Character, is two): every scalar of category Cc (C0 — tab and newline
    /// too — DEL, C1), Cf (the bidi embeddings, overrides and isolates, LRM/RLM/ALM, zero-width
    /// space and joiners, U+2060–U+2064, U+FEFF, the soft hyphen, …), Zl and Zp (U+2028/U+2029)
    /// is shown as U+FFFD, one for one; every run of Zs space separators (U+3000 and U+2003
    /// included) becomes one U+0020. Display only: the sealed memo is the text itself.
    static func display(_ text: String) -> String {
        let replacement = Unicode.Scalar(UInt32(0xFFFD))!
        var out = String.UnicodeScalarView()
        var inSpace = false
        for s in text.unicodeScalars {
            if s.properties.generalCategory == .spaceSeparator {
                if !inSpace { out.append(" ") }
                inSpace = true
                continue
            }
            inSpace = false
            out.append(neutralised(s) ? replacement : s)
        }
        return String(out)
    }

    static func neutralised(_ s: Unicode.Scalar) -> Bool {
        switch s.properties.generalCategory {
        case .control, .format, .lineSeparator, .paragraphSeparator: return true
        default: return false
        }
    }

    /// The refusal for a memo over the limit, or `nil`.
    static func tooLong(_ text: String) -> String? {
        let n = byteCount(text)
        return n > maxBytes ? String(localized: "The memo is \(n) bytes; the limit is \(maxBytes).") : nil
    }
}

/// Where the form and a link disagree: each field's sentence, or `nil`.
struct LinkConflicts: Equatable {
    var to: String?
    var amount: String?
    var memo: String?
    var any: Bool { to != nil || amount != nil || memo != nil }
}

/// A recipient resolved to the address a send goes to.
struct ResolvedRecipient: Equatable {
    let address: String
    let name: String?
    let fingerprint: String
    let link: PaymentLink?
}

enum SendLinkRules {
    static let symbol = "RAND"
    static var notARecipient: String { String(localized: "That is not a shielded address, a randpay: link, or a saved contact.") }

    /// This app sends RAND only: a link naming no asset, or an index whose value is zero (`0`,
    /// `00`, …), is RAND — the core's `PaymentUri::parse` reads an index as digits, and the CLI
    /// and the shared UI read it by value. `RAND` is not a form the core's parser accepts, so it
    /// is no branch here; an id (`rpl1…`, 64 hex) names a token this app does not hold.
    static func linkIsRand(_ asset: String?) -> Bool {
        guard let a = asset?.trimmingCharacters(in: .whitespaces), !a.isEmpty else { return true }
        return a.allSatisfy { $0 == "0" }
    }

    /// The CLI's merge rule: a value given both ways and differing is refused. Only fields the
    /// link actually carries are compared, amounts by units.
    static func conflicts(link: PaymentLink, typedAmount: String, typedMemo: String) -> LinkConflicts {
        var out = LinkConflicts()
        if (link.asset != nil || link.amount != nil) && !linkIsRand(link.asset) {
            out.to = String(localized: "The link asks for an asset this wallet does not hold (\(link.asset ?? "")).")
        }
        let typed = typedAmount.trimmingCharacters(in: .whitespaces)
        if out.to == nil, let wanted = link.amount, !typed.isEmpty {
            let same: Bool = {
                guard let a = Amount.parse(typed), let b = Amount.parse(wanted) else { return false }
                return a == b
            }()
            if !same { out.amount = String(localized: "The link asks for \(wanted) \(symbol); you typed \(typed) \(symbol).") }
        }
        if let m = link.memo, !m.isEmpty, !typedMemo.isEmpty, typedMemo != m {
            out.memo = String(localized: "The link’s memo is \"\(Memo.display(m))\"; you typed \"\(Memo.display(typedMemo))\".")
        }
        return out
    }

    /// A link fills what the form leaves empty — never what the user typed.
    static func fill(link: PaymentLink, amount: String, memo: String) -> (amount: String, memo: String) {
        var a = amount, m = memo
        if a.trimmingCharacters(in: .whitespaces).isEmpty, let la = link.amount, linkIsRand(link.asset) { a = la }
        if m.isEmpty, let lm = link.memo, !lm.isEmpty { m = lm }
        return (a, m)
    }

    /// The one envelope size that carries a memo: fullnode's `EnvelopeFormat::for_chain` knows
    /// 1860 (a 112-byte note plus the 512-byte memo field, sealed) and nothing else.
    static let memoEnvelopeBytes = 1860

    /// The chain ids whose genesis sets no envelope size (fullnode issue #64): chains 14–17, every
    /// chain that ran a build able to seal the memo form. `rand_getLimits.envelope_bytes` is the
    /// node's word, and on such a chain the ledger admits any envelope up to 2 048 bytes, so a node
    /// answering 1860 there would have this wallet seal 1 860-byte envelopes among everyone else's
    /// 1 348 — a permanent public tag on its transactions. No memo is offered on these chains
    /// whatever the node says; the core (`version.legacy_envelope_chain_ids`, the same list) seals
    /// legacy and refuses a memo there regardless. Chain 18 is cut with `envelope_bytes` 1860.
    static let legacyEnvelopeChainIds: [UInt64] = [14, 15, 16, 17]

    /// The chain's `envelope_bytes` as the memo gate may believe it: `nil` on a chain in
    /// `legacyEnvelopeChainIds`, whatever the node said; the node's answer elsewhere.
    static func believedEnvelopeBytes(_ envelopeBytes: Int?, chainId: UInt64) -> Int? {
        legacyEnvelopeChainIds.contains(chainId) ? nil : envelopeBytes
    }

    /// A chain carries a memo only when its limits report exactly the 1860-byte envelope (final
    /// review, finding 6): any other size, and none, gets no memo field — the shared UI's and
    /// Android's gate.
    static func memoSupported(envelopeBytes: Int?) -> Bool { envelopeBytes == memoEnvelopeBytes }

    /// `memoSupported(envelopeBytes:)` under the issue-#64 pin: never on a chain in
    /// `legacyEnvelopeChainIds`.
    static func memoSupported(envelopeBytes: Int?, chainId: UInt64) -> Bool {
        memoSupported(envelopeBytes: believedEnvelopeBytes(envelopeBytes, chainId: chainId))
    }

    /// A memo on a chain that cannot carry one blocks Continue until it is cleared.
    static func memoBlocksContinue(memoSupported: Bool, memo: String) -> Bool { !memoSupported && !memo.isEmpty }

    /// The confirmation every surface shows before a send (spec 2026-09-26 §3), recipient part:
    /// `to <name?> · fingerprint XXXX-XXXX-XXXX-XXXX · <amount> <asset>`. It never carries memo
    /// text (final review, finding 3): a link's memo is somebody else's words, and on this line a
    /// newline or a bidi control in it could draw a fake second recipient line. The memo is
    /// `memoLine`, a line of its own below this one.
    static func confirmationLine(name: String?, fingerprint: String?, amount: String, symbol: String) -> String {
        // A contact name is user-entered (and may end in a space): shown through the memo rule,
        // the separator included, so the line never carries a control character or two spaces.
        let who = name.map { Memo.display("\($0) · ") } ?? ""
        let fp = fingerprint.map { String(localized: "fingerprint \($0)") } ?? String(localized: "fingerprint unavailable")
        return String(localized: "to \(who)\(fp) · \(amount) \(symbol)")
    }

    /// The memo's own line on the confirmation: `memo "<text>"`, every control and bidi character
    /// shown as U+FFFD (`Memo.display`), so it is one line that reads as a memo.
    static func memoLine(_ memo: String) -> String { String(localized: "memo \"\(Memo.display(memo))\"") }

    /// The recipient field resolved in the CLI's order: a `rand1…` address, a `randpay:` link, a
    /// contact name. Throws with the sentence to show on the field.
    static func resolve(_ text: String, contacts: ContactBook) throws -> ResolvedRecipient {
        let s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        switch RecipientKind(s) {
        case .address:
            let info = try RandCore.parseAddress(s)
            guard info.valid else { throw RandCore.CoreError(message: info.error ?? String(localized: "Not a rand1 address")) }
            return ResolvedRecipient(address: s, name: contacts.name(of: s), fingerprint: try RandCore.addressFingerprint(s), link: nil)
        case .link:
            let link = try RandCore.uriParse(s)
            return ResolvedRecipient(address: link.address, name: contacts.name(of: link.address), fingerprint: link.fingerprint, link: link)
        case .name:
            // A name is looked up exactly as typed, never trimmed: contact names are saved exactly
            // as entered (the CLI, Android and the shared UI alike — final review 2).
            guard let addr = contacts.address(of: text) else { throw RandCore.CoreError(message: notARecipient) }
            return ResolvedRecipient(address: addr, name: text, fingerprint: try RandCore.addressFingerprint(addr), link: nil)
        }
    }
}

/// Receive's payment-link form (spec 2026-09-26 §3.3, `ui/screens/receive.js`): the memo field and
/// its counter exist only on a chain whose limits report the 1860-byte envelope, and any other
/// chain never gets a memo in the link.
enum ReceiveLinkRules {
    static func showsMemo(envelopeBytes: Int?) -> Bool { SendLinkRules.memoSupported(envelopeBytes: envelopeBytes) }

    /// The memo to put in the link, or `nil`.
    static func linkMemo(_ memo: String, envelopeBytes: Int?) -> String? {
        showsMemo(envelopeBytes: envelopeBytes) && !memo.isEmpty ? memo : nil
    }
}

/// What Send's form becomes when a `randpay:` link arrives from outside the app: the recipient is
/// the link, the amount and memo are emptied for the link to fill, and — when the recipient field
/// already held this very link — `resolveNow`, because `onChange(of: recipient)` does not fire
/// for an unchanged value and nothing would fill the amount and memo back in (final review,
/// finding 9).
struct LinkIntake: Equatable {
    let recipient: String
    let amount: String
    let memo: String
    let resolveNow: Bool

    static func take(link: String, currentRecipient: String) -> LinkIntake {
        LinkIntake(recipient: link, amount: "", memo: "", resolveNow: currentRecipient == link)
    }
}
