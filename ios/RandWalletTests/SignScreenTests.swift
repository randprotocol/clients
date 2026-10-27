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

    // MARK: final fix wave: a dust token does not unpin its payee's RAND

    /// The reviewer's probe: X is paid 900 RAND beside 1 unit of asset 5, named with no amount.
    func testADustTokenBesideARandOutputToTheSamePayeeIsRefused() {
        let json: [String: Any] = ["recipients_checked": true, "expires_at": 1000, "chain_id": 21, "binding_domain": 1,
                                   "genesis": String(repeating: "0", count: 64), "lines": ["x"], "fee": "1000000",
                                   "outputs": [["to_account": false, "amount": "900000000000", "asset": 0, "owner_fingerprint": "X", "matches": "AAAA (900 RAND)"],
                                               ["to_account": false, "amount": "1", "asset": 5, "owner_fingerprint": "X", "matches": "AAAA (0.000000001 RAND)"],
                                               ["to_account": true, "amount": "5", "asset": 0, "owner_fingerprint": "self", "matches": NSNull()]],
                                   "expected": [["entry": "rand1payee", "fingerprint": "X"]]]
        let v = MsauthRules.verdict(summary: MsauthSummary(json: json), head: 10, chainId: 21, genesis: String(repeating: "0", count: 64),
                                    url: "u", recipients: ["rand1payee"])
        XCTAssertEqual(v, .uncheckedRecipient)
        // A missing asset counts as RAND (fails closed).
        var noAsset = json
        var outs = json["outputs"] as! [[String: Any]]
        outs[0].removeValue(forKey: "asset")
        noAsset["outputs"] = outs
        XCTAssertEqual(MsauthRules.verdict(summary: MsauthSummary(json: noAsset), head: 10, chainId: 21, genesis: String(repeating: "0", count: 64),
                                           url: "u", recipients: ["rand1payee"]), .uncheckedRecipient)
        // The payee paid the token alone may still go unpinned.
        var tokenOnly = json
        tokenOnly["outputs"] = Array((json["outputs"] as! [[String: Any]])[1...])
        XCTAssertEqual(MsauthRules.verdict(summary: MsauthSummary(json: tokenOnly), head: 10, chainId: 21, genesis: String(repeating: "0", count: 64),
                                           url: "u", recipients: ["rand1payee"]), .signable(blocksLeft: 990))
    }

    func testAPayeePaidRandAndATokenIsNotOfferedTheExceptionAndIsToldWhy() {
        let xRand: [String: Any] = ["to_account": false, "amount": "900", "asset": 0, "owner_fingerprint": "X", "matches": "a"]
        let xTok: [String: Any] = ["to_account": false, "amount": "1", "asset": 5, "owner_fingerprint": "X", "matches": "b"]
        let s = summary([xRand, xTok, token], expected: [["entry": "rand1x", "fingerprint": "X"], ["entry": "rand1f", "fingerprint": "F"]])
        XCTAssertFalse(SignRows.amountOptional(PaymentRow(addr: "rand1x", amount: ""), summary: s))
        XCTAssertTrue(SignRows.mixedPayee(PaymentRow(addr: "rand1x", amount: ""), summary: s))
        XCTAssertTrue(SignRows.amountOptional(PaymentRow(addr: "rand1f", amount: ""), summary: s), "a token-only payee keeps the exception")
        XCTAssertFalse(SignRows.mixedPayee(PaymentRow(addr: "rand1f", amount: ""), summary: s))
        XCTAssertFalse(SignRows.mixedPayee(PaymentRow(addr: "rand1new", amount: ""), summary: s), "unknown rows are not called mixed")
    }

    func testLinesMissingOrNotAllStringsIsMalformed() {
        for lines in [nil, "x", ["x", 1], [NSNull()], ["a": "b"]] as [Any?] {
            var json: [String: Any] = ["expires_at": 200, "chain_id": 13, "genesis": genesis, "binding_domain": 1,
                                       "policy_fingerprint": "NFYW-K8E9-E5K9-AAK3", "recipients_checked": true, "fee": "1000000",
                                       "outputs": [rand5], "expected": []]
            if let lines { json["lines"] = lines }
            XCTAssertEqual(verdict(MsauthSummary(json: json), recipients: ["rand1g:5"]), .malformedSummary, String(describing: lines))
        }
        XCTAssertEqual(verdict(summary([rand5]), recipients: ["rand1g:5"]), .signable(blocksLeft: 199))
    }

    func testTheConfirmationIgnoresInnerWhitespaceAsTheWebDoes() {
        XCTAssertTrue(MsauthRules.confirms(fingerprint: "NFYW-K8E9-E5K9-AAK3", typed: "a a k 3"))
        XCTAssertTrue(MsauthRules.confirms(fingerprint: "NFYW-K8E9-E5K9-AAK3", typed: " A-A\tk3\n"))
        XCTAssertFalse(MsauthRules.confirms(fingerprint: "NFYW-K8E9-E5K9-AAK3", typed: "a a k"))
    }

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

    // MARK: CheckSession (fix round 1)

    private func signable(_ outs: [[String: Any]]? = nil) -> MsauthCheck {
        let s = summary(outs ?? [rand5])
        return MsauthCheck(summary: s, verdict: .signable(blocksLeft: 100))
    }

    func testSignIsDisabledOnceTheEditorTextDiffersFromTheCheckedProposalAndSignsTheCheckedText() {
        var c = CheckSession()
        let t = c.begin(proposal: "A")
        c.land(t, signable())
        c.typed = "aak3"
        XCTAssertTrue(c.canSign(editor: "A"))
        XCTAssertEqual(c.reviewedProposal, "A", "what Sign signs is the checked text")
        // Paste B over A: the review is dropped, and Sign is off even though A's lines were shown.
        c.proposalEdited(to: "B")
        XCTAssertFalse(c.canSign(editor: "B"))
        XCTAssertNil(c.model)
        XCTAssertNil(c.reviewedProposal)
        XCTAssertEqual(c.typed, "")
        // Even a model that survived would not arm Sign for a different editor text.
        var d = CheckSession()
        d.land(d.begin(proposal: "A"), signable()); d.typed = "aak3"
        XCTAssertFalse(d.canSign(editor: "B"))
    }

    func testARefusedCheckKeepsThePaymentRowsEditable() {
        var c = CheckSession()
        c.land(c.begin(proposal: "A"), signable([rand5, token]))
        XCTAssertEqual(c.lastSummary?.outputs.count, 2)
        c.gate.rows = [PaymentRow(addr: "typo", amount: "5")]; c.gate.edited()
        let t = c.begin(proposal: "A")
        XCTAssertEqual(c.gate.rows, [PaymentRow(addr: "typo", amount: "5")], "rows kept for the same proposal")
        c.fail(t, message: "expected recipient typo: bad address")
        XCTAssertNil(c.model)
        XCTAssertEqual(c.error, "expected recipient typo: bad address")
        XCTAssertEqual(c.lastSummary?.outputs.count, 2, "the last good summary still draws the rows")
        // A new proposal text starts over.
        _ = c.begin(proposal: "B")
        XCTAssertNil(c.lastSummary)
        XCTAssertEqual(c.gate.rows, [PaymentRow()])
    }

    func testAnOlderResultLandingLastIsIgnored() {
        var c = CheckSession()
        let old = c.begin(proposal: "A")
        XCTAssertTrue(c.inFlight)
        c.proposalEdited(to: "B")                  // the text moved on: the old check is superseded
        XCTAssertFalse(c.inFlight)
        let new = c.begin(proposal: "B")
        XCTAssertTrue(c.land(new, signable()))
        XCTAssertFalse(c.land(old, MsauthCheck(summary: summary([rand5]), verdict: .wrongGenesis)), "older result ignored")
        XCTAssertFalse(c.fail(old, message: "x"))
        XCTAssertEqual(c.model?.verdict, .signable(blocksLeft: 100))
        XCTAssertEqual(c.reviewedProposal, "B")
        // A result landing while a later request is out does not clear inFlight.
        let a = c.begin(proposal: "B"); let b = c.begin(proposal: "B")
        XCTAssertFalse(c.land(a, signable()))
        XCTAssertTrue(c.inFlight)
        XCTAssertTrue(c.land(b, signable()))
        XCTAssertFalse(c.inFlight)
    }

    func testANewCheckClearsTheTypedConfirmation() {
        var c = CheckSession()
        c.land(c.begin(proposal: "A"), signable()); c.typed = "aak3"
        c.land(c.begin(proposal: "A"), signable())
        XCTAssertEqual(c.typed, "")
    }

    func testRowsKeepIdentityAndCompareByContent() {
        let a = PaymentRow(addr: "x", amount: "1"), b = PaymentRow(addr: "x", amount: "1")
        XCTAssertNotEqual(a.id, b.id)
        XCTAssertEqual(a, b)
    }

    func testAStalePaymentEditThroughTheSessionDisarmsSign() {
        var c = CheckSession()
        c.land(c.begin(proposal: "A"), signable())          // the first check of this proposal
        c.gate.rows[0] = PaymentRow(addr: "a", amount: "5"); c.gate.edited()
        XCTAssertTrue(c.gate.stale)
        c.gate.adopt(entries: ["a:5"])                      // Check payments
        c.land(c.begin(proposal: "A"), signable()); c.typed = "aak3"
        XCTAssertEqual(c.gate.payees, ["a:5"], "the rows survived the second begin")
        XCTAssertFalse(c.gate.stale)
        XCTAssertTrue(c.canSign(editor: "A"))
        c.gate.rows[0].amount = "6"; c.gate.edited()
        XCTAssertFalse(c.canSign(editor: "A"))
        // Retry (the top Check) resends the old payments and cannot re-arm it.
        c.land(c.begin(proposal: "A"), signable()); c.typed = "aak3"
        XCTAssertFalse(c.canSign(editor: "A"))
    }

    func testEditingToAnotherProposalDropsThePaymentsAndTheOldError() {
        var c = CheckSession()
        c.land(c.begin(proposal: "A"), signable([rand5, token]))
        c.gate.rows[0] = PaymentRow(addr: "a", amount: "5"); c.gate.edited(); c.gate.adopt(entries: ["a:5"])
        c.fail(c.begin(proposal: "A"), message: "bad payee")
        XCTAssertEqual(c.error, "bad payee")
        c.proposalEdited(to: "A!")
        XCTAssertNil(c.error)
        XCTAssertNil(c.lastSummary)
        XCTAssertEqual(c.gate.rows, [PaymentRow()])
        XCTAssertEqual(c.gate.payees, [])
        // Typing back the checked text keeps the payments (the text is the one they were asked for).
        var d = CheckSession()
        d.land(d.begin(proposal: "A"), signable([rand5, token]))
        d.proposalEdited(to: "A")
        XCTAssertNotNil(d.lastSummary)
    }

    func testAnOldCheckLandingAfterTheScreenWasLeftIsIgnored() {
        var c = CheckSession()
        let old = c.begin(proposal: "A")
        c.close()
        let fresh = c.begin(proposal: "A")
        XCTAssertNotEqual(old.id, fresh.id, "the counter did not restart")
        XCTAssertFalse(c.land(old, signable()))
        XCTAssertNil(c.model)
        XCTAssertTrue(c.land(fresh, signable()))
        // Even straight after close, with no new request, the old ticket is dead.
        var d = CheckSession()
        let t = d.begin(proposal: "A"); d.close()
        XCTAssertFalse(d.land(t, signable()))
        XCTAssertFalse(d.fail(t, message: "x"))
    }
}
