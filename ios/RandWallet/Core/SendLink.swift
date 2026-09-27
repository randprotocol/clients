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
    static let noMemoNotice = "This network doesn't carry memos; the memo will not be sent"

    static func byteCount(_ text: String) -> Int { text.utf8.count }
    static func counter(_ text: String) -> String { "\(byteCount(text))/\(maxBytes) bytes" }
    /// The memo as it may be shown (final review, finding 3). A memo is somebody else's text — the
    /// sender's, or a link's — and a line break in it could draw a second "to … · fingerprint …"
    /// line, a bidi control reorder what is around it. Every scalar of category Cc (C0, DEL, C1),
    /// the bidi controls U+202A–U+202E and U+2066–U+2069, the marks U+200E, U+200F, U+061C, and
    /// the separators U+2028/U+2029 is shown as U+FFFD, one for one — by Unicode scalar, so a
    /// CR LF (one Swift Character) is two. Everything else, ordinary spaces included, is left
    /// alone. The shared UI's `displayMemo` and Android's `Memo.display` replace the same set.
    /// Display only: the sealed memo is the text itself.
    static func display(_ text: String) -> String {
        let replacement = Unicode.Scalar(UInt32(0xFFFD))!
        var out = String.UnicodeScalarView()
        for s in text.unicodeScalars { out.append(neutralised(s.value) ? replacement : s) }
        return String(out)
    }

    static func neutralised(_ c: UInt32) -> Bool {
        c <= 0x1F || (0x7F...0x9F).contains(c)
            || c == 0x061C || c == 0x200E || c == 0x200F
            || c == 0x2028 || c == 0x2029
            || (0x202A...0x202E).contains(c)
            || (0x2066...0x2069).contains(c)
    }

    /// The refusal for a memo over the limit, or `nil`.
    static func tooLong(_ text: String) -> String? {
        let n = byteCount(text)
        return n > maxBytes ? "The memo is \(n) bytes; the limit is \(maxBytes)." : nil
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
    static let notARecipient = "That is not a shielded address, a randpay: link, or a saved contact."

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
            out.to = "The link asks for an asset this wallet does not hold (\(link.asset ?? ""))."
        }
        let typed = typedAmount.trimmingCharacters(in: .whitespaces)
        if out.to == nil, let wanted = link.amount, !typed.isEmpty {
            let same: Bool = {
                guard let a = Amount.parse(typed), let b = Amount.parse(wanted) else { return false }
                return a == b
            }()
            if !same { out.amount = "The link asks for \(wanted) \(symbol); you typed \(typed) \(symbol)." }
        }
        if let m = link.memo, !m.isEmpty, !typedMemo.isEmpty, typedMemo != m {
            out.memo = "The link’s memo is \"\(m)\"; you typed \"\(typedMemo)\"."
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

    /// A chain carries a memo only when its limits report exactly the 1860-byte envelope (final
    /// review, finding 6): any other size, and none, gets no memo field — the shared UI's and
    /// Android's gate.
    static func memoSupported(envelopeBytes: Int?) -> Bool { envelopeBytes == memoEnvelopeBytes }

    /// A memo on a chain that cannot carry one blocks Continue until it is cleared.
    static func memoBlocksContinue(memoSupported: Bool, memo: String) -> Bool { !memoSupported && !memo.isEmpty }

    /// The confirmation every surface shows before a send (spec 2026-09-26 §3), recipient part:
    /// `to <name?> · fingerprint XXXX-XXXX-XXXX-XXXX · <amount> <asset>`. It never carries memo
    /// text (final review, finding 3): a link's memo is somebody else's words, and on this line a
    /// newline or a bidi control in it could draw a fake second recipient line. The memo is
    /// `memoLine`, a line of its own below this one.
    static func confirmationLine(name: String?, fingerprint: String?, amount: String, symbol: String) -> String {
        let who = name.map { "\($0) · " } ?? ""
        let fp = fingerprint.map { "fingerprint \($0)" } ?? "fingerprint unavailable"
        return "to \(who)\(fp) · \(amount) \(symbol)"
    }

    /// The memo's own line on the confirmation: `memo "<text>"`, every control and bidi character
    /// shown as U+FFFD (`Memo.display`), so it is one line that reads as a memo.
    static func memoLine(_ memo: String) -> String { "memo \"\(Memo.display(memo))\"" }

    /// The recipient field resolved in the CLI's order: a `rand1…` address, a `randpay:` link, a
    /// contact name. Throws with the sentence to show on the field.
    static func resolve(_ text: String, contacts: ContactBook) throws -> ResolvedRecipient {
        let s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        switch RecipientKind(s) {
        case .address:
            let info = try RandCore.parseAddress(s)
            guard info.valid else { throw RandCore.CoreError(message: info.error ?? "Not a rand1 address") }
            return ResolvedRecipient(address: s, name: contacts.name(of: s), fingerprint: try RandCore.addressFingerprint(s), link: nil)
        case .link:
            let link = try RandCore.uriParse(s)
            return ResolvedRecipient(address: link.address, name: contacts.name(of: link.address), fingerprint: link.fingerprint, link: link)
        case .name:
            guard let addr = contacts.address(of: s) else { throw RandCore.CoreError(message: notARecipient) }
            return ResolvedRecipient(address: addr, name: s, fingerprint: try RandCore.addressFingerprint(addr), link: nil)
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
