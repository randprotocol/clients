import XCTest
@testable import RandWallet

/// The send screen's link rules (spec 2026-09-26 §3), the shared UI's `ui/screens/send/state.js`
/// and `send.js` in Swift: a `randpay:` link fills what the form leaves empty, and a value given
/// both ways and differing is refused, never guessed.
final class SendLinkTests: XCTestCase {
    private let addr = "rand1" + String(repeating: "A", count: 40)

    private func link(amount: String? = nil, asset: String? = nil, memo: String? = nil) -> PaymentLink {
        PaymentLink(address: addr, amount: amount, asset: asset, memo: memo, fingerprint: "1WCV-YC8F-47BY-5RZY")
    }

    func testRecipientKind() {
        XCTAssertEqual(RecipientKind(" rand1abc "), .address)
        XCTAssertEqual(RecipientKind("RAND1abc"), .address)
        XCTAssertEqual(RecipientKind("randpay:rand1abc?amount=1"), .link)
        XCTAssertEqual(RecipientKind("RANDPAY:rand1abc"), .link)
        XCTAssertEqual(RecipientKind("alice"), .name)
    }

    func testALinkFillsAnEmptyAmountAndMemo() {
        let filled = SendLinkRules.fill(link: link(amount: "1.5", memo: "rent"), amount: "", memo: "")
        XCTAssertEqual(filled.amount, "1.5")
        XCTAssertEqual(filled.memo, "rent")
        // Never what the user typed.
        let kept = SendLinkRules.fill(link: link(amount: "1.5", memo: "rent"), amount: "2", memo: "mine")
        XCTAssertEqual(kept.amount, "2")
        XCTAssertEqual(kept.memo, "mine")
        XCTAssertEqual(SendLinkRules.conflicts(link: link(amount: "1.5", memo: "rent"), typedAmount: "1.5", typedMemo: "rent"), LinkConflicts())
    }

    func testAMismatchIsRefused() {
        let c = SendLinkRules.conflicts(link: link(amount: "1", memo: "rent"), typedAmount: "2", typedMemo: "food")
        XCTAssertEqual(c.amount, "The link asks for 1 RAND; you typed 2 RAND.")
        XCTAssertEqual(c.memo, "The link’s memo is \"rent\"; you typed \"food\".")
        XCTAssertTrue(c.any)
    }

    /// Amounts agree by units, not by text: `1` and `1.000` are the same payment.
    func testAmountsCompareByUnits() {
        XCTAssertNil(SendLinkRules.conflicts(link: link(amount: "1"), typedAmount: "1.000", typedMemo: "").amount)
        XCTAssertNotNil(SendLinkRules.conflicts(link: link(amount: "1"), typedAmount: "abc", typedMemo: "").amount)
    }

    /// This app sends RAND only; a link asking for another asset is refused on the recipient. The
    /// asset is read as the core's parser and the shared UI read it: digits by value, so `0` and
    /// `00` are RAND; `RAND` is not a form the core's parser accepts, so it is no RAND branch.
    func testALinkForAnotherAssetIsRefused() {
        XCTAssertNil(SendLinkRules.conflicts(link: link(asset: "0"), typedAmount: "", typedMemo: "").to)
        XCTAssertNil(SendLinkRules.conflicts(link: link(asset: "00"), typedAmount: "", typedMemo: "").to)
        XCTAssertTrue(SendLinkRules.linkIsRand("000"))
        XCTAssertFalse(SendLinkRules.linkIsRand("RAND"))
        XCTAssertFalse(SendLinkRules.linkIsRand("rand"))
        XCTAssertFalse(SendLinkRules.linkIsRand("01"))
        let c = SendLinkRules.conflicts(link: link(amount: "1", asset: "1"), typedAmount: "", typedMemo: "")
        XCTAssertEqual(c.to, "The link asks for an asset this wallet does not hold (1).")
        XCTAssertNil(c.amount)
    }

    func testMemoCountsUtf8Bytes() {
        XCTAssertEqual(Memo.maxBytes, 510)
        XCTAssertEqual(Memo.byteCount("hi"), 2)
        XCTAssertEqual(Memo.byteCount("é"), 2)
        XCTAssertEqual(Memo.byteCount("👋"), 4)
        XCTAssertEqual(Memo.counter("héllo"), "6/510 bytes")
        XCTAssertNil(Memo.tooLong(String(repeating: "x", count: 510)))
        XCTAssertEqual(Memo.tooLong(String(repeating: "é", count: 256)), "The memo is 512 bytes; the limit is 510.")
    }

    /// A chain that declares no envelope size carries no memo: the field is hidden, and a memo a
    /// link brought blocks Continue until it is cleared.
    func testALegacyChainCarriesNoMemo() {
        XCTAssertFalse(SendLinkRules.memoSupported(envelopeBytes: nil))
        XCTAssertFalse(SendLinkRules.memoSupported(envelopeBytes: 0))
        // Exactly 1860 (fullnode's EnvelopeFormat::for_chain): any other size carries no memo.
        XCTAssertFalse(SendLinkRules.memoSupported(envelopeBytes: 1024))
        XCTAssertFalse(SendLinkRules.memoSupported(envelopeBytes: 1861))
        XCTAssertTrue(SendLinkRules.memoSupported(envelopeBytes: 1860))
        XCTAssertEqual(Memo.noMemoNotice, "This network doesn't carry memos; the memo will not be sent")
        XCTAssertTrue(SendLinkRules.memoBlocksContinue(memoSupported: false, memo: "hi"))
        XCTAssertFalse(SendLinkRules.memoBlocksContinue(memoSupported: false, memo: ""))
        XCTAssertFalse(SendLinkRules.memoBlocksContinue(memoSupported: true, memo: "hi"))
    }

    /// Two lines: the recipient, with no memo text on it, and the memo on its own line below
    /// (final review, finding 3).
    func testConfirmationLine() {
        XCTAssertEqual(SendLinkRules.confirmationLine(name: "alice", fingerprint: "1WCV-YC8F-47BY-5RZY", amount: "1.5", symbol: "RAND"),
                       "to alice · fingerprint 1WCV-YC8F-47BY-5RZY · 1.5 RAND")
        XCTAssertEqual(SendLinkRules.confirmationLine(name: nil, fingerprint: "1WCV-YC8F-47BY-5RZY", amount: "2", symbol: "RAND"),
                       "to fingerprint 1WCV-YC8F-47BY-5RZY · 2 RAND")
        XCTAssertEqual(SendLinkRules.memoLine("rent"), "memo \"rent\"")
        XCTAssertEqual(SendLinkRules.memoLine(""), "memo \"\"")
    }

    private func cp(_ points: UInt32...) -> String {
        String(String.UnicodeScalarView(points.map { Unicode.Scalar($0)! }))
    }

    /// A link's memo cannot draw a second recipient line: it never reaches the recipient line, and
    /// its own line is one line with every control and bidi character shown as U+FFFD.
    func testAMemoCannotFakeASecondRecipientLine() {
        let fake = cp(10, 10) + "to alice · fingerprint AAAA-AAAA-AAAA-AAAA · 1 RAND"
        let r = cp(0xFFFD)
        let line = SendLinkRules.memoLine(fake)
        XCTAssertEqual(line, "memo \"" + r + r + "to alice · fingerprint AAAA-AAAA-AAAA-AAAA · 1 RAND\"")
        for lb: UInt32 in [10, 13, 0x2028, 0x2029] { XCTAssertFalse(line.unicodeScalars.contains(Unicode.Scalar(lb)!)) }
        XCTAssertEqual(SendLinkRules.confirmationLine(name: nil, fingerprint: "BBBB", amount: "1", symbol: "RAND"), "to fingerprint BBBB · 1 RAND")
    }

    func testControlAndBidiCharactersAreNeutralised() {
        let r = cp(0xFFFD)
        XCTAssertEqual(Memo.display("a" + cp(13, 9) + "b" + cp(0) + "c" + cp(0x7F) + "d" + cp(0x85) + "e" + cp(0x9F) + "f"),
                       "a" + r + r + "b" + r + "c" + r + "d" + r + "e" + r + "f")
        let bidi: [UInt32] = [0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069, 0x200E, 0x200F, 0x061C, 0x2028, 0x2029]
        let bidiText = String(String.UnicodeScalarView(bidi.map { Unicode.Scalar($0)! }))
        XCTAssertEqual(Memo.display("x" + bidiText + "y"), "x" + String(repeating: r, count: bidi.count) + "y")
        let ordinary = "two  spaces, " + cp(0xE9) + " and " + cp(0x1F600)
        XCTAssertEqual(Memo.display(ordinary), ordinary)
        // "\r\n" is one Character in Swift but two scalars: both are shown.
        XCTAssertEqual(Memo.display("a" + cp(13, 10) + "b"), "a" + r + r + "b")
    }

    /// `rand_getLimits`: the field's value, `null` when absent or null.
    func testEnvelopeBytesFromLimits() throws {
        XCTAssertEqual(try RpcClient.envelopeBytes(fromLimits: ["envelope_bytes": 1024]), 1024)
        XCTAssertNil(try RpcClient.envelopeBytes(fromLimits: ["envelope_bytes": NSNull()]))
        XCTAssertNil(try RpcClient.envelopeBytes(fromLimits: [String: Any]()))
        XCTAssertThrowsError(try RpcClient.envelopeBytes(fromLimits: ["envelope_bytes": 0]))
        XCTAssertThrowsError(try RpcClient.envelopeBytes(fromLimits: "nope"))
    }

    /// Through the real core: a link it formats parses back, with the fingerprint recomputed; a
    /// bare address parses as a link with no parameters; a bad link is an error.
    func testLinksThroughTheCore() throws {
        let w = try RandCore.keygen()
        let fp = try RandCore.addressFingerprint(w.address)
        XCTAssertEqual(fp.count, 19)
        let uri = try RandCore.uriFormat(address: w.address, amount: "1", asset: nil, memo: "hi")
        XCTAssertTrue(uri.hasPrefix("randpay:rand1"))
        let p = try RandCore.uriParse(uri)
        XCTAssertEqual(p, PaymentLink(address: w.address, amount: "1", asset: nil, memo: "hi", fingerprint: fp))
        XCTAssertEqual(try RandCore.uriParse("randpay:\(w.address)").address, w.address)
        XCTAssertThrowsError(try RandCore.uriParse("randpay:rand1x"))
    }

    /// Receive's payment-link form: the memo field (and its counter) exists only on a chain whose
    /// limits report an envelope size, and a memo never reaches a link for a chain without one.
    func testReceiveMemoIsGatedOnEnvelopeBytes() {
        XCTAssertFalse(ReceiveLinkRules.showsMemo(envelopeBytes: nil))
        XCTAssertFalse(ReceiveLinkRules.showsMemo(envelopeBytes: 0))
        XCTAssertFalse(ReceiveLinkRules.showsMemo(envelopeBytes: 1024))
        XCTAssertTrue(ReceiveLinkRules.showsMemo(envelopeBytes: 1860))
        XCTAssertNil(ReceiveLinkRules.linkMemo("hi", envelopeBytes: nil))
        XCTAssertNil(ReceiveLinkRules.linkMemo("hi", envelopeBytes: 0))
        XCTAssertNil(ReceiveLinkRules.linkMemo("hi", envelopeBytes: 1024))
        XCTAssertNil(ReceiveLinkRules.linkMemo("", envelopeBytes: 1860))
        XCTAssertEqual(ReceiveLinkRules.linkMemo("hi", envelopeBytes: 1860), "hi")
    }

    /// Resolution in the CLI's order: address, link, contact name.
    func testResolveRecipient() throws {
        let w = try RandCore.keygen()
        var book = ContactBook()
        try book.add(name: "alice", address: w.address)
        let byName = try SendLinkRules.resolve("alice", contacts: book)
        XCTAssertEqual(byName.address, w.address)
        XCTAssertEqual(byName.name, "alice")
        XCTAssertNil(byName.link)
        let byAddress = try SendLinkRules.resolve(w.address, contacts: book)
        XCTAssertEqual(byAddress.name, "alice")
        XCTAssertEqual(byAddress.fingerprint, try RandCore.addressFingerprint(w.address))
        let byLink = try SendLinkRules.resolve("randpay:\(w.address)?amount=2", contacts: book)
        XCTAssertEqual(byLink.link?.amount, "2")
        XCTAssertEqual(byLink.name, "alice")
        XCTAssertThrowsError(try SendLinkRules.resolve("bob", contacts: book)) { e in
            XCTAssertEqual(e.localizedDescription, SendLinkRules.notARecipient)
        }
    }
}
