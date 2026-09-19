import XCTest
@testable import RandWallet

/// The FFI round trip: the Rust core answers, keys derive, addresses parse.
final class CoreSmokeTests: XCTestCase {
    func testVersionReportsChain8Defaults() throws {
        let c = try RandCore.constants()
        XCTAssertEqual(c.defaultChainId, 8)
        XCTAssertEqual(c.tokenSymbol, "RAND")
        XCTAssertEqual(c.bundleBaseFee, "1000000")
        XCTAssertEqual(c.timeWindow, NoteStore.timeWindow)
        XCTAssertFalse(RandCore.version.isEmpty)
    }

    func testKeygenRoundTripsThroughWalletInfoAndImport() throws {
        let w = try RandCore.keygen()
        XCTAssertEqual(w.spendKey.count, 64)
        XCTAssertEqual(w.viewingKey.count, 64)
        XCTAssertTrue(w.address.hasPrefix("shrugg1"))
        XCTAssertEqual(w.address.count, 1668)
        XCTAssertEqual(try RandCore.walletInfo(spendKey: w.spendKey), w)
        XCTAssertEqual(try RandCore.importKey(w.keyFile), w)
        let a = try RandCore.parseAddress(w.address)
        XCTAssertTrue(a.valid)
        XCTAssertEqual(a.pk, w.pk)
        XCTAssertFalse(try RandCore.parseAddress("shrugg1nope").valid)
    }

    func testErrorsSurfaceAsThrownMessages() {
        XCTAssertThrowsError(try RandCore.walletInfo(spendKey: "zz")) { e in
            XCTAssertTrue(e.localizedDescription.contains("64 hex"))
        }
        XCTAssertThrowsError(try RandCore.call("no_such_method"))
    }
}
