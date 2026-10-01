import XCTest
@testable import RandWallet

/// The FFI round trip: the Rust core answers, keys derive, addresses parse.
final class CoreSmokeTests: XCTestCase {
    func testVersionReportsChainDefaults() throws {
        let c = try RandCore.constants()
        XCTAssertEqual(c.defaultChainId, 20)
        XCTAssertEqual(c.chainBuild, "806ed34", "fullnode v0.7.0, on chain 20 (cut on v0.6.8, c9c9bd3)")
        XCTAssertEqual(c.tokenSymbol, "RAND")
        XCTAssertEqual(c.bundleBaseFee, "1000000")
        // Constraint set 8: the gas every bundle proof declares — chain 18's genesis pin.
        XCTAssertEqual(c.bundleGasLimit, 20479)
        XCTAssertEqual(c.legacyEnvelopeChainIds, [14, 15, 16, 17])
        // Split authorisation (fullnode v0.6.3): bundle guest v3 and the auth guest, chain 17's and
        // 18's `hc_bundle` / `hc_auth` — the pair `prove_*` and `prepare_*` default to.
        XCTAssertEqual(c.hcBundle, "60af094acfe65d85fdb18fb3d06cf9085dcf28c96e59e87f1ee527226e6e3fce")
        XCTAssertEqual(c.hcAuth, "1e4e347f44cf86750b30a9a4bdf9ec9256efe353d4ff8017451eca7d195639c1")
        XCTAssertEqual(c.splitAuthorisation, true)
        XCTAssertEqual(c.proverHistoryWarning, ProverPairingService.historyWarningFallback)
        XCTAssertEqual(ProverPairingService.warning, ProverPairingService.historyWarningFallback)
        // The RandProtocol provers (wallet 0.6.9): a pool of members, each pinned to its own key at
        // its own URL, nobody's own — never the 0.6.8 shared key.
        let pool = try XCTUnwrap(c.trustedProverPool)
        XCTAssertEqual(pool.name, "RandProtocol")
        XCTAssertEqual(pool.members.map { $0.fingerprint }, ["ZEXQ-1JHV-ZT60-KFB5", "D2XV-WXVT-PZRC-D7G8", "SR28-MYT0-GR6A-03DE", "GMNX-Q1QD-FEXG-JHJM"])
        XCTAssertEqual(pool.members.map { $0.url }, ["a", "archive2", "nyc3", "sfo3"].map { "https://prover.randprotocol.org/m/\($0)" })
        XCTAssertTrue(pool.members.allSatisfy { !$0.own && $0.link.hasPrefix("randprover:") })
        XCTAssertEqual(c.timeWindow, NoteStore.timeWindow)
        XCTAssertFalse(RandCore.version.isEmpty)
    }

    func testKeygenRoundTripsThroughWalletInfoAndImport() throws {
        let w = try RandCore.keygen()
        XCTAssertEqual(w.spendKey.count, 64)
        XCTAssertEqual(w.viewingKey.count, 64)
        XCTAssertTrue(w.address.hasPrefix("rand1"))
        // `rand1` + base58(32-byte pk || 1184-byte ML-KEM encapsulation key). base58 of 1216
        // bytes is 1661 characters unless the leading bytes happen to be small, which costs one
        // (~8% of keys), so a freshly generated address is 1665 or 1666 — never a fixed number.
        XCTAssertTrue((1665...1666).contains(w.address.count), "address length \(w.address.count)")
        XCTAssertEqual(try RandCore.walletInfo(spendKey: w.spendKey), w)
        XCTAssertEqual(try RandCore.importKey(w.keyFile), w)
        let a = try RandCore.parseAddress(w.address)
        XCTAssertTrue(a.valid)
        XCTAssertEqual(a.pk, w.pk)
        XCTAssertFalse(try RandCore.parseAddress("rand1nope").valid)
    }

    func testErrorsSurfaceAsThrownMessages() {
        XCTAssertThrowsError(try RandCore.walletInfo(spendKey: "zz")) { e in
            XCTAssertTrue(e.localizedDescription.contains("64 hex"))
        }
        XCTAssertThrowsError(try RandCore.call("no_such_method"))
    }
}
