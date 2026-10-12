import XCTest
@testable import RandWallet

/// The logic behind the multisig signing screens (SignProposalView): rows to `addr:AMOUNT` entries,
/// when an amount may be left out, the stale tracking that disarms Sign after an edit, the last-four
/// confirmation and how each refusal is shown. The same behavior as ui/screens/signers.js.
final class SignScreenTests: XCTestCase {
    private func fx(_ name: String) throws -> String {
        let url = try XCTUnwrap(Bundle(for: SignScreenTests.self).url(forResource: name, withExtension: "json"))
        return try String(contentsOf: url, encoding: .utf8)
    }
    private let genesis = String(repeating: "aa", count: 32)
    private func summary(_ outputs: [[String: Any]], expected: [[String: Any]] = []) -> MsauthSummary {
        MsauthSummary(json: ["expires_at": 200, "chain_id": 13, "genesis": genesis, "binding_domain": 1, "lines": ["line one", "line two"],
                             "policy_fingerprint": "NFYW-K8E9-E5K9-AAK3", "recipients_checked": true, "fee": "1000000",
                             "outputs": outputs, "expected": expected])
    }
    private func verdict(_ s: MsauthSummary, head: UInt64? = 1, recipients: [String] = ["rand1payee:5"]) -> MsauthVerdict {
        MsauthRules.verdict(summary: s, head: head, chainId: 13, genesis: genesis, url: "http://node", recipients: recipients)
    }
    private let rand5: [String: Any] = ["to_account": false, "amount": "5", "asset": 0, "owner_fingerprint": "G", "matches": "GGGG (5 RAND)"]
    private let token: [String: Any] = ["to_account": false, "amount": "5", "asset": 7, "owner_fingerprint": "F", "matches": "FFFF"]

    // MARK: rows to entries

    func testARowBecomesAddrColonAmountAsTyped() throws {
        XCTAssertEqual(try SignRows.entry(PaymentRow(addr: " rand1a ", amount: " 1.5 "), amountOptional: false), "rand1a:1.5")
        XCTAssertEqual(try SignRows.entry(PaymentRow(addr: "rand1a", amount: ".25"), amountOptional: false), "rand1a:.25")
    }

    func testARowNeedsAnAddressAndAValidPositiveAmount() {
        func reason(_ r: PaymentRow, optional: Bool = false) -> String? {
            do { _ = try SignRows.entry(r, amountOptional: optional); return nil } catch { return error.localizedDescription }
        }
        XCTAssertEqual(reason(PaymentRow(addr: " ", amount: "1")), "Enter the address of every payment.")
        XCTAssertEqual(reason(PaymentRow(addr: "", amount: ""), optional: true), "Enter the address of every payment.")
        XCTAssertEqual(reason(PaymentRow(addr: "rand1a", amount: "")), "Enter the amount of every payment: it is what stops a split or an inflated payment.")
        for bad in ["0", "0.0", "-1", "1.5.2", "abc", "1,5", "0.0000000001"] {
            XCTAssertEqual(reason(PaymentRow(addr: "rand1a", amount: bad)), "An amount is a number of RAND, such as 1.5.", bad)
        }
    }

    func testAnAmountMayBeLeftOutOnlyWhereTheRowIsMarkedOptional() throws {
        XCTAssertEqual(try SignRows.entry(PaymentRow(addr: " rand1f ", amount: ""), amountOptional: true), "rand1f")
        // An amount typed on an optional row is still sent (and checked).
        XCTAssertEqual(try SignRows.entry(PaymentRow(addr: "rand1f", amount: "2"), amountOptional: true), "rand1f:2")
        XCTAssertThrowsError(try SignRows.entry(PaymentRow(addr: "rand1f", amount: "x"), amountOptional: true))
    }

    func testAnAmountlessRowIsOffloadedOnlyForTheOwnerOfANonRandPayingOutput() {
        let s = summary([token, rand5], expected: [["entry": "rand1f", "fingerprint": "F"], ["entry": "rand1g:5", "fingerprint": "G"]])
        XCTAssertTrue(SignRows.amountOptional(PaymentRow(addr: "rand1f", amount: ""), summary: s), "F owns the token output")
        XCTAssertFalse(SignRows.amountOptional(PaymentRow(addr: "rand1g", amount: "5"), summary: s), "G owns RAND only")
        // Not yet fingerprinted (or edited): optional while some paying output is non-RAND, so a check can tell.
        XCTAssertTrue(SignRows.amountOptional(PaymentRow(addr: "rand1new", amount: ""), summary: s))
        XCTAssertFalse(SignRows.amountOptional(PaymentRow(addr: "rand1new", amount: ""), summary: summary([rand5])))
        XCTAssertFalse(SignRows.amountOptional(PaymentRow(addr: "rand1f", amount: ""), summary: nil), "no check yet: always pinned")
        // An expected entry with no fingerprint fails closed.
        let noFp = summary([token], expected: [["entry": "rand1f"]])
        XCTAssertFalse(SignRows.amountOptional(PaymentRow(addr: "rand1f", amount: ""), summary: noFp))
        // A zero amount or change in a token is not a paying output.
        let dust = summary([["to_account": false, "amount": "0", "asset": 7, "owner_fingerprint": "F"], rand5])
        XCTAssertFalse(SignRows.amountOptional(PaymentRow(addr: "rand1new", amount: ""), summary: dust))
        let change = summary([["to_account": true, "amount": "5", "asset": 7, "owner_fingerprint": "F"], rand5])
        XCTAssertFalse(SignRows.amountOptional(PaymentRow(addr: "rand1new", amount: ""), summary: change))
    }

    func testTheRowKeyTellsEveryEditApart() {
        let a = [PaymentRow(addr: "a", amount: "1"), PaymentRow(addr: "b", amount: "2")]
        XCTAssertEqual(SignRows.key(a), SignRows.key(a))
        XCTAssertNotEqual(SignRows.key(a), SignRows.key([PaymentRow(addr: "a", amount: "1"), PaymentRow(addr: "b", amount: "3")]))
        XCTAssertNotEqual(SignRows.key(a), SignRows.key(Array(a.dropLast())))
        // Moving a character from one field to the next is an edit too.
        XCTAssertNotEqual(SignRows.key([PaymentRow(addr: "ab", amount: "1")]), SignRows.key([PaymentRow(addr: "a", amount: "b1")]))
    }

    // MARK: stale tracking

    func testEditingAnyRowDisarmsSignUntilACheckOfTheCurrentRowsLands() {
        var g = PaymentsGate()
        XCTAssertFalse(g.stale)
        g.rows[0] = PaymentRow(addr: "rand1a", amount: "5")
        g.edited()
        XCTAssertTrue(g.stale)
        // Check payments: the entries adopted, the snapshot taken, the result lands with no edit between.
        g.adopt(entries: ["rand1a:5"])
        let sent = g.sentKey
        g.landed(sentKey: sent)
        XCTAssertFalse(g.stale)
        XCTAssertEqual(g.payees, ["rand1a:5"])
    }

    func testARowEditedWhileTheCheckIsInFlightStaysStale() {
        var g = PaymentsGate()
        g.rows[0] = PaymentRow(addr: "rand1a", amount: "5"); g.edited()
        g.adopt(entries: ["rand1a:5"])
        let sent = g.sentKey
        g.rows[0].amount = "6"; g.edited()          // typed while the request was out
        g.landed(sentKey: sent)
        XCTAssertTrue(g.stale)
    }

    func testTheTopCheckAndRetryCannotReArmSignAfterEdits() {
        var g = PaymentsGate()
        g.rows[0] = PaymentRow(addr: "rand1a", amount: "5"); g.edited()
        g.adopt(entries: ["rand1a:5"]); g.landed(sentKey: g.sentKey)
        XCTAssertFalse(g.stale)
        g.rows[0].amount = "50"; g.edited()
        // Retry / the top Check resend the last adopted payments, whose snapshot predates the edit.
        g.landed(sentKey: g.sentKey)
        XCTAssertTrue(g.stale)
        XCTAssertEqual(g.payees, ["rand1a:5"])
        // Add and Remove are edits as well.
        g.adopt(entries: ["rand1a:50"]); g.landed(sentKey: g.sentKey)
        XCTAssertFalse(g.stale)
        g.rows.append(PaymentRow()); g.edited()
        g.landed(sentKey: g.sentKey)
        XCTAssertTrue(g.stale)
    }

    func testANewProposalStartsOverWithOneEmptyRow() {
        var g = PaymentsGate()
        g.rows = [PaymentRow(addr: "a", amount: "1"), PaymentRow(addr: "b", amount: "2")]; g.edited()
        g.adopt(entries: ["a:1", "b:2"])
        g.reset()
        XCTAssertEqual(g.rows, [PaymentRow()])
        XCTAssertEqual(g.payees, [])
        XCTAssertFalse(g.stale)
    }

    // MARK: the model: lines, confirmation, refusals

    func testTheModelShowsTheCoreLinesVerbatimOnTheRealVector() throws {
        let policy = try fx("policy")
        let proposalText = try fx("proposal-valid")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try fx("proposal-valid").utf8)) as? [String: Any])
        let line = try XCTUnwrap((json["summary"] as? [String])?.first)
        let payee = try XCTUnwrap(line.split(separator: " ").last.map(String.init))
        let s = try RandCore.msauthCheck(proposal: proposalText, policy: policy, expectedRecipients: [payee + ":10"])
        let m = SignProposalModel(summary: s, verdict: .signable(blocksLeft: 100))
        XCTAssertEqual(m.lines, s.lines)
        XCTAssertFalse(m.lines.isEmpty)
        XCTAssertTrue(m.showsSummary)
        XCTAssertEqual(m.payingTotal, 1)
        XCTAssertEqual(m.payingMatched, 1)
        XCTAssertNil(m.refusal)
    }

    func testSignNeedsTheLastFourOfThePolicyFingerprint() {
        let s = summary([rand5])
        let m = SignProposalModel(summary: s, verdict: .signable(blocksLeft: 100))
        XCTAssertFalse(m.canSign(typed: "", stale: false))
        XCTAssertFalse(m.canSign(typed: "e5k9", stale: false))
        XCTAssertFalse(m.canSign(typed: "aak", stale: false))
        XCTAssertTrue(m.canSign(typed: "AAK3", stale: false))
        XCTAssertTrue(m.canSign(typed: " aak3 ", stale: false))
        XCTAssertTrue(m.canSign(typed: "e5k9-aak3", stale: false) == false, "more than the last four is not the last four")
        XCTAssertTrue(m.canSign(typed: "a-a-k-3", stale: false), "dashes are ignored")
    }

    func testStaleDisarmsSignEvenWhenConfirmed() {
        let m = SignProposalModel(summary: summary([rand5]), verdict: .signable(blocksLeft: 100))
        XCTAssertTrue(m.canSign(typed: "aak3", stale: false))
        XCTAssertFalse(m.canSign(typed: "aak3", stale: true))
    }

    func testARefusedVerdictNeverSigns() {
        let s = summary([rand5])
        for v: MsauthVerdict in [.malformedSummary, .uncheckedRecipient, .noNode(url: "u"), .wrongChain(proposal: 1, wallet: 2), .wrongGenesis, .expired(head: 5, expiresAt: 3)] {
            XCTAssertFalse(SignProposalModel(summary: s, verdict: v).canSign(typed: "aak3", stale: false), "\(v)")
            XCTAssertNotNil(SignProposalModel(summary: s, verdict: v).refusal, "\(v)")
        }
        XCTAssertFalse(SignProposalModel(summary: nil, verdict: .signable(blocksLeft: 1)).canSign(typed: "aak3", stale: false))
    }

    func testEveryRefusalIsShownByItsMessage() {
        let s = summary([rand5])
        let cases: [(MsauthVerdict, String)] = [
            (.malformedSummary, "The proposal check returned an incomplete answer, so this proposal is not signed."),
            (.uncheckedRecipient, "Enter the address of every payee: an output that does not match the address you entered, or whose address is empty, cannot be signed."),
            (.noNode(url: "http://node"), "No node answered at http://node, so the expiry cannot be checked and this proposal is not signed. Retry when the node is reachable."),
            (.wrongChain(proposal: 7, wallet: 13), "This proposal is for chain 7; this wallet is on chain 13."),
            (.wrongGenesis, "This proposal is bound to another genesis than the one this wallet's node serves."),
            (.expired(head: 300, expiresAt: 200), "This proposal expires at height 200 and the chain is at 300: too late to sign. Ask for a new proposal."),
        ]
        for (v, text) in cases { XCTAssertEqual(SignProposalModel(summary: s, verdict: v).refusal, text) }
        XCTAssertTrue(SignProposalModel(summary: s, verdict: .noNode(url: "u")).isRetryable)
        XCTAssertFalse(SignProposalModel(summary: s, verdict: .wrongGenesis).isRetryable)
    }

    func testTheRefusalsComeFromTheRulesOnARealSummary() {
        let s = summary([rand5])
        XCTAssertEqual(SignProposalModel(summary: s, verdict: verdict(s, head: nil)).refusal?.hasPrefix("No node answered at http://node"), true)
        XCTAssertEqual(SignProposalModel(summary: s, verdict: verdict(s, head: 300)).refusal?.contains("too late to sign"), true)
        XCTAssertEqual(SignProposalModel(summary: s, verdict: verdict(s, recipients: [])).refusal?.hasPrefix("Enter the address of every payee"), true)
        XCTAssertEqual(SignProposalModel(summary: s, verdict: verdict(s, head: 1)).blocksLeft, 199)
    }

    func testAMalformedSummaryShowsTheRefusalAndNoLines() {
        for json: Any? in [nil, NSNull(), "text", [1], ["lines": ["x"]], ["outputs": []], ["lines": "x", "outputs": []]] {
            let s = MsauthSummary(json: json)
            let m = SignProposalModel(summary: s, verdict: verdict(s))
            XCTAssertFalse(m.verdict.isSignable)   // malformed, or unchecked first when recipients_checked is absent
            XCTAssertFalse(m.showsSummary)
            XCTAssertNotNil(m.refusal)
            XCTAssertFalse(m.canSign(typed: "aak3", stale: false))
        }
        // A summary refused before the core was asked has none at all.
        XCTAssertFalse(SignProposalModel(summary: nil, verdict: .uncheckedRecipient).showsSummary)
        XCTAssertEqual(SignProposalModel(summary: nil, verdict: .uncheckedRecipient).lines, [])
    }

    func testOnlyPayingOutputsAreCountedAsPayments() {
        let change: [String: Any] = ["to_account": true, "amount": "9", "asset": 0]
        let zero: [String: Any] = ["to_account": false, "amount": "0", "asset": 0]
        let unmatched: [String: Any] = ["to_account": false, "amount": "3", "asset": 0, "matches": ""]
        let m = SignProposalModel(summary: summary([rand5, change, zero, unmatched]), verdict: .uncheckedRecipient)
        XCTAssertEqual(m.payingTotal, 2)
        XCTAssertEqual(m.payingMatched, 1)
    }
}
