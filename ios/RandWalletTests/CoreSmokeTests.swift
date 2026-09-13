import XCTest
@testable import RandWallet

/// The FFI round trip: the Rust core answers, keys derive, addresses parse.
final class CoreSmokeTests: XCTestCase {
    func testVersionReportsChain8Defaults() throws {
        let c = try ShruggCore.constants()
        XCTAssertEqual(c.defaultChainId, 8)
        XCTAssertEqual(c.tokenSymbol, "SHRUGG")
        XCTAssertEqual(c.bundleBaseFee, "1000000")
        XCTAssertEqual(c.timeWindow, NoteStore.timeWindow)
        XCTAssertFalse(ShruggCore.version.isEmpty)
    }

    func testKeygenRoundTripsThroughWalletInfoAndImport() throws {
        let w = try ShruggCore.keygen()
        XCTAssertEqual(w.spendKey.count, 64)
        XCTAssertEqual(w.viewingKey.count, 64)
        XCTAssertTrue(w.address.hasPrefix("shrugg1"))
        XCTAssertEqual(w.address.count, 1668)
        XCTAssertEqual(try ShruggCore.walletInfo(spendKey: w.spendKey), w)
        XCTAssertEqual(try ShruggCore.importKey(w.keyFile), w)
        let a = try ShruggCore.parseAddress(w.address)
        XCTAssertTrue(a.valid)
        XCTAssertEqual(a.pk, w.pk)
        XCTAssertFalse(try ShruggCore.parseAddress("shrugg1nope").valid)
    }

    func testErrorsSurfaceAsThrownMessages() {
        XCTAssertThrowsError(try ShruggCore.walletInfo(spendKey: "zz")) { e in
            XCTAssertTrue(e.localizedDescription.contains("64 hex"))
        }
        XCTAssertThrowsError(try ShruggCore.call("no_such_method"))
    }
}
