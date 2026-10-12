import XCTest
@testable import RandWallet

/// One private-multisig signature through `MsauthSigning` (the app's check-then-sign order) and the
/// real RandCore on the simulator, against the devnet scripts/e2e-msauth.sh runs. The script passes
/// the files' contents as TEST_RUNNER_RAND_MSAUTH_* (the runner strips the prefix); without them the
/// test is skipped. The Keychain's `.userPresence` cannot exist on a passcode-less simulator, so the
/// store runs over `FakeSignerSecrets` here; the device check is manual (task-10 report).
@MainActor
final class LiveMsauthTests: XCTestCase {
    func testSignsADevnetProposalThroughTheCore() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let proposal = env["RAND_MSAUTH_PROPOSAL"], let policy = env["RAND_MSAUTH_POLICY"], let key = env["RAND_MSAUTH_KEY"],
              let payment = env["RAND_MSAUTH_PAYEE"], let rpc = env["RAND_MSAUTH_RPC"].flatMap(URL.init(string:)) else {
            throw XCTSkip("run scripts/e2e-msauth.sh")
        }
        let chainId = UInt64(env["RAND_MSAUTH_CHAIN_ID"] ?? "21") ?? 21
        let secrets = FakeSignerSecrets()
        let store = SignerStore(secrets: secrets)
        let profile = try store.add(label: "ios signer", policy: policy, key: key)
        let signing = MsauthSigning(store: store, core: RandMsauthCore(), node: RpcClient(url: rpc), chainId: chainId)

        // No payee, and the payee without its amount: nothing signable.
        let none = try await signing.check(id: profile.id, proposal: proposal, expectedRecipients: [])
        XCTAssertFalse(none.verdict.isSignable, "\(none.verdict)")
        let address = String(payment[..<(payment.lastIndex(of: ":") ?? payment.endIndex)])
        let amountless = try await signing.check(id: profile.id, proposal: proposal, expectedRecipients: [address])
        XCTAssertFalse(amountless.verdict.isSignable, "\(amountless.verdict)")

        let checked = try await signing.check(id: profile.id, proposal: proposal, expectedRecipients: [payment])
        XCTAssertTrue(checked.verdict.isSignable, "\(checked.verdict)")
        XCTAssertEqual(checked.summary?.recipientsChecked, true)

        let share = try await signing.sign(id: profile.id, proposal: proposal, expectedRecipients: [payment], reason: "e2e")
        XCTAssertEqual(share.index, profile.index)
        XCTAssertEqual(secrets.promptedReads.count, 1, "the seed is read once, behind the (fake) prompt")
        XCTAssertNoThrow(try signing.verifyShare(id: profile.id, proposal: proposal, share: share.share))
        print("MSAUTH-SHARE \(share.share)")
    }
}
