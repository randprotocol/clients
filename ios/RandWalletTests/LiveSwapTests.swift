import XCTest
@testable import RandWallet

/// One real swap on the live chain, through `WalletService.invoke` and the real core: about 0.2
/// RAND for DUR in the durian.market pool, the bundle proof made by the RandProtocol provers and
/// the call proof and the auth proof made here. Skipped unless asked for, since it spends testnet
/// RAND and takes minutes:
///
///     TEST_RUNNER_RAND_LIVE_SWAP=1 TEST_RUNNER_RAND_LIVE_SPEND_KEY=<64 hex> \
///       xcodebuild test … -only-testing:RandWalletTests/LiveSwapTests
///
/// The key is a testnet test wallet's, given through the environment and never written down here.
/// The test wallet replaces whatever wallet the simulator's app held.
@MainActor
final class LiveSwapTests: XCTestCase {
    func testOneRealSwapThroughTheRandProtocolProvers() async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["RAND_LIVE_SWAP"] == "1", let key = env["RAND_LIVE_SPEND_KEY"], !key.isEmpty else {
            throw XCTSkip("set RAND_LIVE_SWAP=1 and RAND_LIVE_SPEND_KEY to swap on the live chain")
        }
        let dx = UInt64(env["RAND_LIVE_SWAP_UNITS"] ?? "") ?? 200_000_000
        let settings = Settings()
        settings.rpcUrl = env["RAND_LIVE_RPC"] ?? "https://rpc.randprotocol.org"
        settings.chainId = 20
        settings.prover = nil
        settings.noProver = false
        let wallet = WalletService(settings: settings)
        // The simulator reports the Mac's memory; a phone proves this bundle through the provers.
        wallet.deviceCanProve = { false }
        _ = try wallet.importWallet(key)
        // The one-time notice, read: this test is the user who read it.
        wallet.acknowledgeDefaultProver()

        let t0 = Date()
        try await wallet.scan()
        log("scanned in \(Int(Date().timeIntervalSince(t0))) s: \(Amount.format(wallet.balance)) RAND, \(Amount.format(wallet.balance(of: 2), decimals: 6)) DUR")
        XCTAssertGreaterThan(wallet.balance, dx + 10_000_000, "the test wallet holds too little RAND")
        let durBefore = wallet.store.notes.filter { $0.asset == 2 }.map(\.cm)

        guard case .pool = try await wallet.canInvoke() else { return XCTFail("not through the RandProtocol provers") }

        var attempt = 0
        var outcome: WalletService.InvokeOutcome?
        var swap: Amm.Swap?
        while outcome == nil {
            attempt += 1
            let read = try await wallet.programCells(Amm.durianProgram)
            let cells = try XCTUnwrap(read, "chain 20 runs programs")
            let pools = Amm.pools(of: cells)
            guard case .success(let s) = Amm.buildSwap(route: Amm.findRoute(pools, sell: 0, buy: 2), dx: dx) else {
                return XCTFail("no quote for \(dx) units")
            }
            swap = s
            log("quote: \(Amount.format(s.amountIn)) RAND → \(Amount.format(s.amountOut, decimals: 6)) DUR, impact \(s.impactPpm) ppm")
            let q = try await wallet.quoteInvoke(s.request)
            log("network fee \(Amount.format(q.fee)) RAND, tier \(q.dry.tier), gas \(q.dry.gasLimit)")
            let started = Date()
            do {
                outcome = try await wallet.invoke(s.request)
                log("proved and submitted in \(Int(Date().timeIntervalSince(started))) s")
            } catch let e as InvokeFlow.Refusal where e.code == .staleRead && attempt < 3 {
                log("the pool moved (\(e.message)); quoting again")
            }
        }
        let o = try XCTUnwrap(outcome)
        let s = try XCTUnwrap(swap)
        log("LIVE-SWAP tx \(o.hash) committed \(o.committedHeight.map(String.init) ?? "not yet")")
        XCTAssertEqual(o.payouts, [AssetAmount(asset: 2, amount: String(s.amountOut))])

        // The payout is a leaf like any other: a scan finds it by trial decryption.
        var found: OwnedNote?
        for _ in 0..<40 {
            found = wallet.store.notes.first { $0.asset == 2 && !durBefore.contains($0.cm) && $0.units == s.amountOut }
            if found != nil { break }
            try await Task.sleep(nanoseconds: 3_000_000_000)
            try? await wallet.scan()
        }
        let note = try XCTUnwrap(found, "the DUR payout was not found by a scan")
        log("LIVE-SWAP DUR note leaf #\(note.index) block \(note.height): \(Amount.format(note.units, decimals: 6)) DUR")
    }

    private func log(_ s: String) { print("LiveSwap: \(s)") }
}
