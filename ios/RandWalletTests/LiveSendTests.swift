import XCTest
@testable import RandWallet

/// One real RAND send on the live chain through `WalletService.send` and the RandProtocol provers —
/// the path the Swap work moved onto the shared `RemoteJob` (wallet 0.7.1): a small payment to the
/// wallet's own address, found by the next scan. Skipped unless asked for, like `LiveSwapTests`:
///
///     TEST_RUNNER_RAND_LIVE_SWAP=1 TEST_RUNNER_RAND_LIVE_SPEND_KEY=<64 hex> \
///       xcodebuild test … -only-testing:RandWalletTests/LiveSendTests
@MainActor
final class LiveSendTests: XCTestCase {
    func testOneRealSendThroughTheRandProtocolProvers() async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["RAND_LIVE_SWAP"] == "1", let key = env["RAND_LIVE_SPEND_KEY"], !key.isEmpty else {
            throw XCTSkip("set RAND_LIVE_SWAP=1 and RAND_LIVE_SPEND_KEY to send on the live chain")
        }
        let settings = Settings()
        settings.rpcUrl = env["RAND_LIVE_RPC"] ?? "https://rpc.randprotocol.org"
        settings.chainId = 20
        settings.prover = nil
        settings.noProver = false
        let wallet = WalletService(settings: settings)
        // The simulator reports the Mac's memory; a phone proves this bundle through the provers.
        wallet.deviceCanProve = { false }
        _ = try wallet.importWallet(key)
        wallet.acknowledgeDefaultProver()
        try await wallet.scan()
        // A unique amount, so the scan below finds this payment and no other.
        let amount: UInt64 = 40_000_000 + UInt64.random(in: 0..<9_000_000)
        XCTAssertGreaterThan(wallet.balance, amount + 10_000_000, "the test wallet holds too little RAND")
        let before = Set(wallet.store.notes.map(\.cm))
        let started = Date()
        let o = try await wallet.send(to: wallet.address, amount: amount, fee: 1_000_000)
        print("LiveSend: tx \(o.hash) fee \(o.fee) in \(Int(Date().timeIntervalSince(started))) s")
        var found: OwnedNote?
        for _ in 0..<40 {
            found = wallet.store.notes.first { $0.asset == 0 && !before.contains($0.cm) && $0.units == amount }
            if found != nil { break }
            try await Task.sleep(nanoseconds: 3_000_000_000)
            try? await wallet.scan()
        }
        let note = try XCTUnwrap(found, "the payment was not found by a scan")
        print("LiveSend: received leaf #\(note.index) block \(note.height): \(Amount.format(note.units)) RAND")
    }
}
