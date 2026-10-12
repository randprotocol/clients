import XCTest
@testable import RandWallet

/// Private multisig signing on iOS (spec 2026-10-11-msauth-signing-design.md §3, §4): the core
/// wrappers against fullnode's vectors, `MsauthRules` — the same decisions as ui/engine/signers.js
/// `verdict` — the signer store behind user presence, and the order `MsauthSigning.sign` keeps.
final class MsauthTests: XCTestCase {
    private func fx(_ name: String) throws -> String {
        let url = try XCTUnwrap(Bundle(for: MsauthTests.self).url(forResource: name, withExtension: "json"))
        return try String(contentsOf: url, encoding: .utf8)
    }
    private func json(_ name: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try fx(name).utf8)) as? [String: Any])
    }
    /// The valid proposal's real payee, read from its informational summary ("pay 10 RAND to rand1…").
    private func payee() throws -> String {
        let summary = try XCTUnwrap(try json("proposal-valid")["summary"] as? [String])
        return try XCTUnwrap(summary[0].split(separator: " ").last.map(String.init))
    }
    /// The intended payment as the app passes it: the address and its amount, pinned.
    private func payment() throws -> String { try payee() + ":10" }
    private func seeds() throws -> [String] { try XCTUnwrap(try json("signer-seeds")["members"] as? [String]) }

    // MARK: the core, on fullnode's vectors

    func testTheCoreChecksAndSignsTheVectors() throws {
        let s = try RandCore.msauthCheck(proposal: try fx("proposal-valid"), policy: try fx("policy"), expectedRecipients: [try payment()])
        XCTAssertTrue(s.recipientsChecked)
        XCTAssertEqual(s.policyFingerprint, "NFYW-K8E9-E5K9-AAK3")
        XCTAssertEqual(s.chainId, 7)
        XCTAssertEqual(s.expiresAt, 2024)
        XCTAssertEqual(s.bindingDomain, 0)
        XCTAssertEqual(s.outputs.count, 4)
        XCTAssertEqual(s.outputs[2].amount, "10000000000")
        XCTAssertEqual(s.outputs[2].matches, "A5SR-HRMB-SY4M-5ZYF (10 RAND)")
        XCTAssertTrue(s.outputs[2].needsPayee)
        XCTAssertTrue(s.outputs[3].toAccount)
        XCTAssertEqual(s.expected, [MsauthExpected(entry: try payment(), fingerprint: try json("expected")["recipient_owner_fingerprint"] as? String)])
        XCTAssertEqual(s.lines, try json("expected")["lines_expecting_recipient"] as? [String])
        XCTAssertTrue(s.lines[1...4].allSatisfy { $0.contains("owner key verified") })

        let expected = try json("expected")
        let share = try RandCore.msauthSign(proposal: try fx("proposal-valid"), policy: try fx("policy"),
                                            seed: try XCTUnwrap(Data(hex: try seeds()[2])), expectedRecipients: [try payment()])
        XCTAssertEqual(share, expected["share_2"] as? String)
        XCTAssertNoThrow(try RandCore.msauthVerifyShare(proposal: try fx("proposal-valid"), policy: try fx("policy"), share: expected["share_0"] as! String))
        XCTAssertThrowsError(try RandCore.msauthCheck(proposal: try fx("proposal-unbound"), policy: try fx("policy"))) { e in
            XCTAssertTrue((e as! RandCore.CoreError).message.contains("does not hash to the proposal's binding"))
        }
        let info = try RandCore.msauthPolicyInfo(try fx("policy"))
        XCTAssertEqual(info.fingerprint, "NFYW-K8E9-E5K9-AAK3")
        XCTAssertEqual(info.signers, 3)
        XCTAssertEqual(try RandCore.msauthSignerImport(try seeds()[1], policy: try fx("policy")).index, 1)
        XCTAssertNil(try RandCore.msauthSignerImport(try seeds()[1], policy: nil).index)
    }

    func testASubstitutedRecipientIsRefusedByTheCoreInItsOwnSentence() throws {
        let refusal = try XCTUnwrap(try json("expected")["substituted_refusal"] as? String)
        XCTAssertThrowsError(try RandCore.msauthCheck(proposal: try fx("proposal-substituted-recipient"), policy: try fx("policy"), expectedRecipients: [try payment()])) { e in
            XCTAssertEqual((e as! RandCore.CoreError).message, refusal)
        }
        XCTAssertThrowsError(try RandCore.msauthSign(proposal: try fx("proposal-substituted-recipient"), policy: try fx("policy"),
                                                     seed: try XCTUnwrap(Data(hex: try seeds()[0])), expectedRecipients: [try payment()])) { e in
            XCTAssertEqual((e as! RandCore.CoreError).message, refusal)
        }
    }

    func testWithNoPayeeNamedTheCoreSaysUncheckedAndRefusesToSign() throws {
        let none = try RandCore.msauthCheck(proposal: try fx("proposal-valid"), policy: try fx("policy"))
        XCTAssertFalse(none.recipientsChecked)
        XCTAssertEqual(MsauthRules.verdict(summary: none, head: 1, chainId: 7, genesis: nil, url: "u", recipients: []), .uncheckedRecipient)
        XCTAssertThrowsError(try RandCore.msauthSign(proposal: try fx("proposal-valid"), policy: try fx("policy"),
                                                     seed: try XCTUnwrap(Data(hex: try seeds()[2])), expectedRecipients: [])) { e in
            XCTAssertEqual((e as! RandCore.CoreError).message, "no expected recipient given: the payee was NOT checked")
        }
    }

    func testTheExpiryAndChainRulesOnTheVector() throws {
        let s = try RandCore.msauthCheck(proposal: try fx("proposal-valid"), policy: try fx("policy"), expectedRecipients: [try payment()])   // chain 7, domain 0, expires 2024
        let r = [try payment()]
        XCTAssertEqual(MsauthRules.expiryMargin, 16)
        XCTAssertEqual(MsauthRules.verdict(summary: s, head: 2007, chainId: 7, genesis: nil, url: "u", recipients: r), .signable(blocksLeft: 17))
        XCTAssertEqual(MsauthRules.verdict(summary: s, head: 2008, chainId: 7, genesis: nil, url: "u", recipients: r), .expired(head: 2008, expiresAt: 2024))
        XCTAssertEqual(MsauthRules.verdict(summary: s, head: nil, chainId: 7, genesis: nil, url: "http://n", recipients: r), .noNode(url: "http://n"))
        XCTAssertEqual(MsauthRules.verdict(summary: s, head: 1, chainId: 21, genesis: nil, url: "u", recipients: r), .wrongChain(proposal: 7, wallet: 21))
        // The vector pays RAND only: the address alone is not enough, the amount is pinned.
        let bare = try RandCore.msauthCheck(proposal: try fx("proposal-valid"), policy: try fx("policy"), expectedRecipients: [try payee()])
        XCTAssertEqual(MsauthRules.verdict(summary: bare, head: 1, chainId: 7, genesis: nil, url: "u", recipients: [try payee()]), .uncheckedRecipient)
    }

    func testConfirmsAndClean() {
        XCTAssertTrue(MsauthRules.confirms(fingerprint: "NFYW-K8E9-E5K9-AAK3", typed: " aak3"))
        XCTAssertFalse(MsauthRules.confirms(fingerprint: "NFYW-K8E9-E5K9-AAK3", typed: "aak"))
        XCTAssertFalse(MsauthRules.confirms(fingerprint: "NFYW-K8E9-E5K9-AAK3", typed: "e5k9"))
        XCTAssertEqual(MsauthRules.clean("\u{FEFF} {\"a\":1}\r\n"), "{\"a\":1}")
        XCTAssertEqual(MsauthRules.payees([" rand1a:5 ", "rand1b:2\n"]), ["rand1a:5", "rand1b:2"])
    }

    // MARK: MsauthRules.verdict, rule by rule (ui/test/signers-engine.test.mjs's cases)

    private let genesis = String(repeating: "aa", count: 32)
    private func summary(_ changes: [String: Any?] = [:]) -> [String: Any] {
        var s: [String: Any] = ["expires_at": 200, "chain_id": 13, "genesis": genesis, "binding_domain": 1, "lines": ["x"],
                                "policy_fingerprint": "NFYW-K8E9-E5K9-AAK3", "recipients_checked": true,
                                "outputs": [["to_account": false, "amount": "5", "needs_payee": true, "matches": "FP"]]]
        for (k, v) in changes { s[k] = v }   // nil removes the field
        return s
    }
    private func v(_ json: Any?, head: UInt64? = 1, recipients: [String] = ["rand1payee:5"]) -> MsauthVerdict {
        MsauthRules.verdict(summary: MsauthSummary(json: json), head: head, chainId: 13, genesis: genesis, url: "u", recipients: recipients)
    }

    func testAWellFormedCheckedSummaryIsSignable() {
        XCTAssertEqual(v(summary()), .signable(blocksLeft: 199))
    }

    func testAMalformedSummaryIsRefused() {
        let bad: [(String, Any?)] = [
            ("expires_at", nil), ("expires_at", "soon"), ("expires_at", -1), ("expires_at", 1.5), ("expires_at", NSNull()),
            ("expires_at", 9_007_199_254_740_992), ("expires_at", true),
            ("chain_id", nil), ("chain_id", "x"), ("chain_id", -1), ("chain_id", 2.5),
            ("binding_domain", nil), ("binding_domain", "x"), ("binding_domain", 1.5), ("binding_domain", -1),
            ("genesis", nil), ("genesis", ""), ("genesis", "zz"), ("genesis", 7),
            ("outputs", nil), ("outputs", "x"), ("outputs", [1]),
        ]
        for (key, value) in bad {
            XCTAssertEqual(v(summary([key: value])), .malformedSummary, "\(key) = \(String(describing: value))")
        }
        XCTAssertEqual(v(nil), .malformedSummary)
        XCTAssertEqual(v(NSNull()), .malformedSummary)
        XCTAssertEqual(v("a summary"), .malformedSummary)
        XCTAssertEqual(v([summary()]), .malformedSummary, "an array is not an object")
    }

    func testAMalformedOutputIsRefused() {
        let out = { (o: Any) in self.summary(["outputs": [o]]) }
        XCTAssertEqual(v(out(NSNull())), .malformedSummary)
        XCTAssertEqual(v(out(["to_account": false, "matches": NSNull()])), .malformedSummary, "no amount")
        XCTAssertEqual(v(out(["to_account": false, "amount": "", "matches": NSNull()])), .malformedSummary)
        XCTAssertEqual(v(out(["to_account": false, "amount": "abc", "matches": NSNull()])), .malformedSummary)
        XCTAssertEqual(v(out(["to_account": false, "amount": -5, "matches": NSNull()])), .malformedSummary)
        XCTAssertEqual(v(out(["to_account": false, "amount": 1.5, "matches": NSNull()])), .malformedSummary)
        XCTAssertEqual(v(out(["amount": "5", "matches": NSNull()])), .malformedSummary, "to_account missing")
        XCTAssertEqual(v(out(["to_account": 0, "amount": "5", "matches": "FP"])), .malformedSummary, "to_account is a Bool, not a number")
        XCTAssertEqual(v(out(["to_account": "false", "amount": "5", "matches": "FP"])), .malformedSummary)
        for amount: Any in ["0", "00", " 0", 0] {
            XCTAssertEqual(v(out(["to_account": false, "amount": amount, "matches": NSNull()])), .signable(blocksLeft: 199), "\(amount) is zero")
        }
        XCTAssertEqual(v(out(["to_account": false, "amount": 5, "matches": "FP"])), .signable(blocksLeft: 199), "a non-negative integer amount")
    }

    func testAnUncheckedSummaryIsRefusedBeforeAnythingElse() {
        let unchecked = summary(["recipients_checked": false, "outputs": [["to_account": false, "amount": "5", "matches": NSNull()]]])
        XCTAssertEqual(v(unchecked), .uncheckedRecipient)
        XCTAssertEqual(v(unchecked, head: nil), .uncheckedRecipient)
        XCTAssertEqual(v(summary(["recipients_checked": nil])), .uncheckedRecipient)
        XCTAssertEqual(v(summary(["recipients_checked": 1])), .uncheckedRecipient, "only true is true")
        XCTAssertEqual(v(summary(["recipients_checked": "true"])), .uncheckedRecipient)
    }

    func testAPayingOutputWithoutAMatchIsUnchecked() {
        let o = { (x: [String: Any]) in self.v(self.summary(["outputs": [x]])) }
        XCTAssertEqual(o(["to_account": false, "amount": "5", "needs_payee": true, "matches": NSNull()]), .uncheckedRecipient)
        XCTAssertEqual(o(["to_account": false, "amount": "5", "needs_payee": true]), .uncheckedRecipient)
        for m: Any in [false, "", "  ", 0, [String: Any](), NSNull(), true] {
            XCTAssertEqual(o(["to_account": false, "amount": "5", "matches": m]), .uncheckedRecipient, "\(m)")
        }
        XCTAssertEqual(o(["to_account": true, "amount": "5", "matches": NSNull()]), .signable(blocksLeft: 199), "change needs no payee")
        XCTAssertEqual(o(["to_account": false, "amount": "0", "matches": NSNull()]), .signable(blocksLeft: 199), "a zero amount pays nothing")
    }

    func testAnEmptyOrBlankPaymentListIsUnchecked() {
        XCTAssertEqual(v(summary(), recipients: []), .uncheckedRecipient, "a match alone does not make an empty list pass")
        XCTAssertEqual(v(summary(["outputs": [["to_account": true, "amount": "5"]]]), recipients: []), .signable(blocksLeft: 199), "nothing pays: nothing to name")
        XCTAssertEqual(v(summary(), recipients: ["rand1a:5", ""]), .uncheckedRecipient)
        XCTAssertEqual(v(summary(), recipients: ["rand1a:5", "   "]), .uncheckedRecipient)
        XCTAssertEqual(v(summary(), recipients: [":5"]), .uncheckedRecipient, "an entry without its address")
    }

    func testAnAmountIsPinnedOnEveryRandPayment() {
        XCTAssertEqual(v(summary(), recipients: ["rand1a"]), .uncheckedRecipient)
        XCTAssertEqual(v(summary(), recipients: ["rand1a:"]), .uncheckedRecipient)
        XCTAssertEqual(v(summary(), recipients: ["rand1a: "]), .uncheckedRecipient)
        // A RAND output owned by the entry's fingerprint still needs the amount.
        let rand = summary(["outputs": [["to_account": false, "amount": "5", "asset": 0, "owner_fingerprint": "F", "matches": "ABCD"]],
                            "expected": [["entry": "rand1a", "fingerprint": "F"]]])
        XCTAssertEqual(v(rand, recipients: ["rand1a"]), .uncheckedRecipient)
    }

    func testTheAmountlessExceptionIsPerRowForNonRandOutputs() {
        let token = summary(["outputs": [["to_account": false, "amount": "5", "asset": 7, "owner_fingerprint": "F", "matches": "ABCD"]],
                             "expected": [["entry": "rand1a", "fingerprint": "F"]]])
        XCTAssertEqual(v(token, recipients: ["rand1a"]), .signable(blocksLeft: 199))
        let mixed = { (expected: Any?) -> [String: Any] in
            self.summary(["expected": expected,
                          "outputs": [["to_account": false, "amount": "5", "asset": 7, "owner_fingerprint": "F", "matches": "ABCD"],
                                      ["to_account": false, "amount": "9", "asset": 0, "owner_fingerprint": "G", "matches": "EFGH"]]])
        }
        let exp: [[String: Any]] = [["entry": "rand1f", "fingerprint": "F"], ["entry": "rand1g", "fingerprint": "G"]]
        XCTAssertEqual(v(mixed(exp), recipients: ["rand1f", "rand1g:9"]), .signable(blocksLeft: 199), "the non-RAND owner may go unpinned")
        XCTAssertEqual(v(mixed(exp), recipients: ["rand1f:5", "rand1g"]), .uncheckedRecipient, "a RAND payee may not")
        XCTAssertEqual(v(mixed(nil), recipients: ["rand1f"]), .uncheckedRecipient, "expected missing: fail closed")
        XCTAssertEqual(v(mixed("nope"), recipients: ["rand1f"]), .uncheckedRecipient)
        XCTAssertEqual(v(mixed([["entry": "rand1f"]]), recipients: ["rand1f"]), .uncheckedRecipient, "no fingerprint: fail closed")
        XCTAssertEqual(v(mixed([["entry": "rand1f", "fingerprint": ""]]), recipients: ["rand1f"]), .uncheckedRecipient)
        XCTAssertEqual(v(mixed([["entry": " rand1f", "fingerprint": "F"]]), recipients: ["rand1f"]), .uncheckedRecipient, "matched by exact entry")
        XCTAssertEqual(v(mixed([["entry": "rand1f", "fingerprint": "G"]]), recipients: ["rand1f"]), .uncheckedRecipient, "G owns RAND only")
        // A zero-amount non-RAND output is not a paying output: it unpins nothing.
        let dust = summary(["expected": [["entry": "rand1a", "fingerprint": "F"]],
                            "outputs": [["to_account": false, "amount": "0", "asset": 7, "owner_fingerprint": "F", "matches": NSNull()],
                                        ["to_account": false, "amount": "9", "asset": 0, "owner_fingerprint": "G", "matches": "EFGH"]]])
        XCTAssertEqual(v(dust, recipients: ["rand1a"]), .uncheckedRecipient)
        // Change in a token is not a payment either.
        let change = summary(["expected": [["entry": "rand1a", "fingerprint": "F"]],
                              "outputs": [["to_account": true, "amount": "5", "asset": 7, "owner_fingerprint": "F"],
                                          ["to_account": false, "amount": "9", "asset": 0, "owner_fingerprint": "G", "matches": "EFGH"]]])
        XCTAssertEqual(v(change, recipients: ["rand1a"]), .uncheckedRecipient)
    }

    func testTheExpiryChainAndGenesisRules() {
        XCTAssertEqual(v(summary(), head: 183), .signable(blocksLeft: 17))
        XCTAssertEqual(v(summary(), head: 184), .expired(head: 184, expiresAt: 200))
        XCTAssertEqual(v(summary(), head: 500), .expired(head: 500, expiresAt: 200))
        XCTAssertEqual(v(summary(), head: nil), .noNode(url: "u"))
        XCTAssertEqual(v(summary(["chain_id": 21])), .wrongChain(proposal: 21, wallet: 13))
        XCTAssertEqual(v(summary(["genesis": String(repeating: "bb", count: 32)])), .wrongGenesis)
        XCTAssertEqual(v(summary(["genesis": genesis.uppercased()])), .signable(blocksLeft: 199), "hex case does not matter")
        XCTAssertEqual(v(summary(["binding_domain": 0, "genesis": String(repeating: "bb", count: 32)])), .signable(blocksLeft: 199),
                       "a chain-id-bound proposal binds no genesis")
        XCTAssertEqual(MsauthRules.verdict(summary: MsauthSummary(json: summary()), head: 1, chainId: 13, genesis: nil, url: "u", recipients: ["rand1a:5"]),
                       .wrongGenesis, "a node that names no genesis cannot vouch for a genesis-bound proposal")
        XCTAssertNotNil(MsauthVerdict.expired(head: 1, expiresAt: 2).message)
        XCTAssertNil(MsauthVerdict.signable(blocksLeft: 1).message)
    }

    // MARK: the signer store

    func testTheStoreKeepsTheSeedBehindPresenceAndReadsItPerSignature() throws {
        let secrets = FakeSignerSecrets()
        let store = SignerStore(secrets: secrets)
        let p = try store.add(label: " treasury ", policy: try fx("policy"), key: try seeds()[0])
        XCTAssertEqual(p.index, 0)
        XCTAssertEqual(p.label, "treasury")
        XCTAssertEqual(p.fingerprint, "NFYW-K8E9-E5K9-AAK3")
        XCTAssertEqual(secrets.items["msauth.\(p.id).seed"]?.presence, true)
        XCTAssertEqual(secrets.items["msauth.\(p.id).seed"]?.data, Data(hex: try seeds()[0]))
        XCTAssertEqual(secrets.items["msauth.\(p.id).policy"]?.presence, false)
        XCTAssertEqual(secrets.items["msauth.index"]?.presence, false)
        XCTAssertTrue(secrets.promptedReads.isEmpty, "adding asks for nothing")
        XCTAssertEqual(try store.policy(p.id), MsauthRules.clean(try fx("policy")))
        XCTAssertTrue(secrets.promptedReads.isEmpty, "the policy is not behind the prompt")
        for _ in 0..<2 { _ = try store.withSeed(p.id, reason: "sign") { $0.count } }
        XCTAssertEqual(secrets.promptedReads, ["msauth.\(p.id).seed", "msauth.\(p.id).seed"], "one prompted read per signature, nothing cached")
        XCTAssertThrowsError(try store.add(label: "again", policy: try fx("policy"), key: try seeds()[0]))
        XCTAssertEqual(SignerStore(secrets: secrets).profiles, store.profiles, "the list survives a restart")
        store.remove(p.id)
        XCTAssertNil(secrets.items["msauth.\(p.id).seed"])
        XCTAssertNil(secrets.items["msauth.\(p.id).policy"])
        XCTAssertTrue(store.profiles.isEmpty)
        XCTAssertThrowsError(try store.withSeed(p.id, reason: "sign") { $0.count })
    }

    func testAddRefusesABadLabelAKeyOutsideThePolicyAndNoPasscode() throws {
        let secrets = FakeSignerSecrets()
        let store = SignerStore(secrets: secrets)
        XCTAssertThrowsError(try store.add(label: "  ", policy: try fx("policy"), key: try seeds()[0]))
        XCTAssertThrowsError(try store.add(label: String(repeating: "x", count: 65), policy: try fx("policy"), key: try seeds()[0]))
        let outsider = try XCTUnwrap(try json("signer-seeds")["non_member"] as? String)
        XCTAssertThrowsError(try store.add(label: "x", policy: try fx("policy"), key: outsider)) { e in
            XCTAssertEqual((e as? RandCore.CoreError)?.message, "this key is not one of the policy's signers")
        }
        XCTAssertTrue(secrets.items.isEmpty)
        secrets.canRequireUserPresence = false
        XCTAssertThrowsError(try store.add(label: "x", policy: try fx("policy"), key: try seeds()[0]))
        XCTAssertTrue(secrets.items.isEmpty, "no passcode, no profile, nothing written")
    }

    func testAFailedSaveLeavesNothingBehind() throws {
        let secrets = FakeSignerSecrets()
        let store = SignerStore(secrets: secrets)
        secrets.failSaveFor = "msauth.index"
        XCTAssertThrowsError(try store.add(label: "x", policy: try fx("policy"), key: try seeds()[0]))
        XCTAssertTrue(secrets.items.isEmpty, "\(secrets.items.keys)")
        XCTAssertTrue(store.profiles.isEmpty)
    }

    func testRemoveAllForgetsEveryProfile() throws {
        let secrets = FakeSignerSecrets()
        let store = SignerStore(secrets: secrets)
        _ = try store.add(label: "a", policy: try fx("policy"), key: try seeds()[0])
        _ = try store.add(label: "b", policy: try fx("policy"), key: try seeds()[1])
        store.removeAll()
        XCTAssertTrue(store.profiles.isEmpty)
        XCTAssertTrue(secrets.items.isEmpty, "\(secrets.items.keys)")
    }

    func testRemoveAllSweepsOrphansTheIndexDoesNotList() throws {
        let secrets = FakeSignerSecrets()
        let store = SignerStore(secrets: secrets)
        _ = try store.add(label: "a", policy: try fx("policy"), key: try seeds()[0])
        // A crash between the seed and the index, or an index that no longer decodes.
        secrets.items["msauth.orphan.seed"] = (Data([1, 2, 3]), true)
        secrets.items["msauth.orphan.policy"] = (Data("{}".utf8), false)
        secrets.items["spend_key"] = (Data("keep".utf8), false)
        secrets.items["prover_pairing"] = (Data("keep".utf8), false)
        store.removeAll()
        XCTAssertEqual(Set(secrets.items.keys), ["spend_key", "prover_pairing"], "every msauth.* item is gone, nothing else")
        let broken = FakeSignerSecrets()
        broken.items["msauth.index"] = (Data("not json".utf8), false)
        broken.items["msauth.x.seed"] = (Data([9]), true)
        SignerStore(secrets: broken).removeAll()
        XCTAssertTrue(broken.items.isEmpty, "\(broken.items.keys)")
    }

    func testTheLabelLimitCountsCodePoints() throws {
        let store = SignerStore(secrets: FakeSignerSecrets())
        // 33 characters, 66 code points (e + combining acute): over the limit, as in the JS.
        XCTAssertThrowsError(try store.add(label: String(repeating: "e\u{301}", count: 33), policy: try fx("policy"), key: try seeds()[0]))
        XCTAssertNoThrow(try store.add(label: String(repeating: "e\u{301}", count: 32), policy: try fx("policy"), key: try seeds()[0]))
    }

    // MARK: MsauthSigning: check, then sign, in the order the rules need

    private final class FakeNode: MsauthNode {
        var nodeURL = "https://node.test"
        var chain: UInt64 = 13
        var heads: [UInt64] = [100]
        var genesis: String?
        var failHead = false
        func chainId() async throws -> UInt64 { chain }
        func headHeight() async throws -> UInt64 {
            if failHead { throw RpcClient.RpcError(code: -32000, message: "busy") }
            return heads.count > 1 ? heads.removeFirst() : heads[0]
        }
        func genesisHash() async throws -> String? { genesis }
    }
    private final class FakeCore: MsauthCore {
        var summary: Any? = nil
        var calls: [(String, String, [String])] = []
        var seeds: [Data] = []
        func check(proposal: String, policy: String, expectedRecipients: [String]) throws -> MsauthSummary {
            calls.append(("check", proposal, expectedRecipients)); return MsauthSummary(json: summary)
        }
        func sign(proposal: String, policy: String, seed: Data, expectedRecipients: [String]) throws -> String {
            calls.append(("sign", proposal, expectedRecipients)); seeds.append(Data(seed)); return "1:abcd"
        }
    }
    private func signing(_ core: FakeCore, _ node: FakeNode?) throws -> (MsauthSigning, FakeSignerSecrets, SignerProfile) {
        let secrets = FakeSignerSecrets()
        let store = SignerStore(secrets: secrets)
        let p = try store.add(label: "treasury", policy: try fx("policy"), key: try seeds()[1])
        node?.genesis = genesis
        return (MsauthSigning(store: store, core: core, node: node, chainId: 13), secrets, p)
    }

    func testSignHandsTheCoreTheSameCleanedListTheCheckUsed() async throws {
        let core = FakeCore(); core.summary = summary()
        let (m, secrets, p) = try signing(core, FakeNode())
        let share = try await m.sign(id: p.id, proposal: "\u{FEFF}PROP\n", expectedRecipients: [" rand1payee:5 ", "rand1other:2\n"], reason: "sign")
        XCTAssertEqual(share, MsauthShare(share: "1:abcd", index: 1))
        XCTAssertEqual(core.calls.map { $0.0 }, ["check", "sign"])
        XCTAssertEqual(core.calls.map { $0.1 }, ["PROP", "PROP"])
        XCTAssertEqual(core.calls.map { $0.2 }, [["rand1payee:5", "rand1other:2"], ["rand1payee:5", "rand1other:2"]])
        XCTAssertEqual(core.seeds, [try XCTUnwrap(Data(hex: try seeds()[1]))])
        XCTAssertEqual(secrets.promptedReads, ["msauth.\(p.id).seed"])
    }

    func testTheRuleIsReRunAfterDeviceAuthAndARefusalThereSignsNothing() async throws {
        let core = FakeCore(); core.summary = summary()
        let node = FakeNode(); node.heads = [100, 190]
        let (m, secrets, p) = try signing(core, node)
        do {
            _ = try await m.sign(id: p.id, proposal: "P", expectedRecipients: ["rand1payee:5"], reason: "sign")
            XCTFail("signed past the expiry")
        } catch let e as MsauthRefusal {
            XCTAssertEqual(e.verdict, .expired(head: 190, expiresAt: 200))
        }
        XCTAssertEqual(secrets.promptedReads.count, 1, "the head moved during the prompt")
        XCTAssertEqual(core.calls.map { $0.0 }, ["check"], "msauth_sign never ran")

        // The chain moves while the person authenticates: the head read after the prompt decides.
        let node2 = FakeNode()
        let (m2, secrets2, p2) = try signing(core, node2)
        secrets2.duringPrompt = { node2.heads = [184] }
        core.calls = []
        do {
            _ = try await m2.sign(id: p2.id, proposal: "P", expectedRecipients: ["rand1payee:5"], reason: "sign")
            XCTFail("signed past the expiry")
        } catch let e as MsauthRefusal {
            XCTAssertEqual(e.verdict, .expired(head: 184, expiresAt: 200))
        }
        XCTAssertEqual(core.calls.map { $0.0 }, ["check"])

        // Or the node goes away during the prompt.
        let node3 = FakeNode()
        let (m3, secrets3, p3) = try signing(core, node3)
        secrets3.duringPrompt = { node3.failHead = true }
        core.calls = []
        do {
            _ = try await m3.sign(id: p3.id, proposal: "P", expectedRecipients: ["rand1payee:5"], reason: "sign")
            XCTFail("signed with no node")
        } catch let e as MsauthRefusal {
            XCTAssertEqual(e.verdict, .noNode(url: "https://node.test"))
        }
        XCTAssertEqual(core.calls.map { $0.0 }, ["check"])
    }

    func testARefusalBeforeAuthNeverReadsTheSeed() async throws {
        let cases: [(Any?, FakeNode?, [String], MsauthVerdict)] = [
            (summary(), nil, ["rand1payee:5"], .noNode(url: "")),
            (summary(["chain_id": 21]), FakeNode(), ["rand1payee:5"], .wrongChain(proposal: 21, wallet: 13)),
            (summary(["genesis": String(repeating: "bb", count: 32)]), FakeNode(), ["rand1payee:5"], .wrongGenesis),
            (summary(), { let n = FakeNode(); n.heads = [184]; return n }(), ["rand1payee:5"], .expired(head: 184, expiresAt: 200)),
            (summary(["recipients_checked": false]), FakeNode(), ["rand1payee:5"], .uncheckedRecipient),
            (summary(["expires_at": "soon"]), FakeNode(), ["rand1payee:5"], .malformedSummary),
            (summary(), FakeNode(), [], .uncheckedRecipient),
            (summary(), FakeNode(), ["rand1payee"], .uncheckedRecipient),
            (summary(), { let n = FakeNode(); n.failHead = true; return n }(), ["rand1payee:5"], .noNode(url: "https://node.test")),
            (summary(), { let n = FakeNode(); n.chain = 21; return n }(), ["rand1payee:5"], .noNode(url: "https://node.test")),
        ]
        for (i, (s, node, recipients, want)) in cases.enumerated() {
            let core = FakeCore(); core.summary = s
            let (m, secrets, p) = try signing(core, node)
            do {
                _ = try await m.sign(id: p.id, proposal: "P", expectedRecipients: recipients, reason: "sign")
                XCTFail("case \(i) signed")
            } catch let e as MsauthRefusal {
                XCTAssertEqual(e.verdict, want, "case \(i)")
            }
            XCTAssertTrue(secrets.promptedReads.isEmpty, "case \(i): no prompt for a proposal that will not be signed")
            XCTAssertFalse(core.calls.contains { $0.0 == "sign" }, "case \(i)")
        }
    }

    func testABlankEntryIsRefusedAndNeverReachesTheCore() async throws {
        let core = FakeCore(); core.summary = summary()
        let (m, secrets, p) = try signing(core, FakeNode())
        let r = try await m.check(id: p.id, proposal: "P", expectedRecipients: ["rand1a:1", "  "])
        XCTAssertNil(r.summary)
        XCTAssertEqual(r.verdict, .uncheckedRecipient)
        do {
            _ = try await m.sign(id: p.id, proposal: "P", expectedRecipients: ["", "rand1b:1"], reason: "sign")
            XCTFail("signed with a blank entry")
        } catch let e as MsauthRefusal { XCTAssertEqual(e.verdict, .uncheckedRecipient) }
        XCTAssertTrue(core.calls.isEmpty, "nothing was passed on with the blanks removed")
        XCTAssertTrue(secrets.promptedReads.isEmpty)
    }

    func testAHeadPastTheSafeIntegerRangeIsNoNode() async throws {
        let core = FakeCore(); core.summary = summary(["expires_at": 9_007_199_254_740_991])
        let node = FakeNode(); node.heads = [9_007_199_254_740_992]
        let (m, _, p) = try signing(core, node)
        let r = try await m.check(id: p.id, proposal: "P", expectedRecipients: ["rand1payee:5"])
        XCTAssertEqual(r.verdict, .noNode(url: "https://node.test"))
        node.heads = [9_007_199_254_740_991 - 17]
        let ok = try await m.check(id: p.id, proposal: "P", expectedRecipients: ["rand1payee:5"])
        XCTAssertEqual(ok.verdict, .signable(blocksLeft: 17))
    }

    func testWithNoNodeTheCheckStillShowsTheSummary() async throws {
        let core = FakeCore(); core.summary = summary()
        let (m, _, p) = try signing(core, nil)
        let r = try await m.check(id: p.id, proposal: "P", expectedRecipients: ["rand1payee:5"])
        XCTAssertEqual(r.summary?.lines, ["x"])
        XCTAssertEqual(r.verdict, .noNode(url: ""))
        let node = FakeNode(); node.failHead = true
        let (m2, _, p2) = try signing(core, node)
        let r2 = try await m2.check(id: p2.id, proposal: "P", expectedRecipients: ["rand1payee:5"])
        XCTAssertEqual(r2.verdict, .noNode(url: "https://node.test"))
    }

    func testTheRealCoreSignsTheVectorThroughTheStore() async throws {
        let secrets = FakeSignerSecrets()
        let store = SignerStore(secrets: secrets)
        let p = try store.add(label: "two", policy: try fx("policy"), key: try seeds()[2])
        let node = FakeNode(); node.chain = 7; node.heads = [2000]
        let m = MsauthSigning(store: store, core: RandMsauthCore(), node: node, chainId: 7)
        let r = try await m.check(id: p.id, proposal: try fx("proposal-valid"), expectedRecipients: [try payment()])
        XCTAssertEqual(r.verdict, .signable(blocksLeft: 24))
        let share = try await m.sign(id: p.id, proposal: try fx("proposal-valid"), expectedRecipients: [try payment()], reason: "sign")
        XCTAssertEqual(share.share, try json("expected")["share_2"] as? String)
        XCTAssertEqual(share.index, 2)
        XCTAssertNoThrow(try m.verifyShare(id: p.id, proposal: try fx("proposal-valid"), share: "\u{FEFF}" + (try json("expected")["share_0"] as! String) + "\n"))
    }

    // MARK: the core's sentences reach the screen in the user's language

    func testTheMsauthSentencesAreKnown() {
        for s in ["this key is not one of the policy's signers", "a signer seed is 64 hex characters",
                  "no expected recipient given: the payee was NOT checked", "the transaction does not hash to the proposal's binding"] {
            XCTAssertEqual(CoreErrors.localized(s), s, "English passes through")
        }
        XCTAssertEqual(CoreErrors.localized("signer 4 is not in this policy (it has 3 signers)"), "signer 4 is not in this policy (it has 3 signers)")
        XCTAssertEqual(CoreErrors.localized("expected recipient rand1x: shielded address is not base58"), "expected recipient rand1x: shielded address is not base58")
    }
}
