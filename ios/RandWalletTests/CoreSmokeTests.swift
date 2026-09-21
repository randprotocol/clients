import XCTest
@testable import RandWallet

/// The FFI round trip: the Rust core answers, keys derive, addresses parse.
final class CoreSmokeTests: XCTestCase {
    func testVersionReportsChainDefaults() throws {
        let c = try RandCore.constants()
        XCTAssertEqual(c.defaultChainId, 14)
        XCTAssertEqual(c.tokenSymbol, "RAND")
        XCTAssertEqual(c.bundleBaseFee, "1000000")
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
