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

    /// This app sends RAND only; a link asking for another asset is refused on the recipient.
    func testALinkForAnotherAssetIsRefused() {
        XCTAssertNil(SendLinkRules.conflicts(link: link(asset: "0"), typedAmount: "", typedMemo: "").to)
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
        XCTAssertTrue(SendLinkRules.memoSupported(envelopeBytes: 1024))
        XCTAssertEqual(Memo.noMemoNotice, "This network doesn't carry memos; the memo will not be sent")
        XCTAssertTrue(SendLinkRules.memoBlocksContinue(memoSupported: false, memo: "hi"))
        XCTAssertFalse(SendLinkRules.memoBlocksContinue(memoSupported: false, memo: ""))
        XCTAssertFalse(SendLinkRules.memoBlocksContinue(memoSupported: true, memo: "hi"))
    }

    func testConfirmationLine() {
        XCTAssertEqual(SendLinkRules.confirmationLine(name: "alice", fingerprint: "1WCV-YC8F-47BY-5RZY", amount: "1.5", symbol: "RAND", memo: "rent"),
                       "to alice · fingerprint 1WCV-YC8F-47BY-5RZY · 1.5 RAND · memo \"rent\"")
        XCTAssertEqual(SendLinkRules.confirmationLine(name: nil, fingerprint: "1WCV-YC8F-47BY-5RZY", amount: "2", symbol: "RAND", memo: ""),
                       "to fingerprint 1WCV-YC8F-47BY-5RZY · 2 RAND · memo \"\"")
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
        XCTAssertEqual(try RandCore.uriParse(w.address).address, w.address)
        XCTAssertThrowsError(try RandCore.uriParse("randpay:rand1x"))
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
