import XCTest
@testable import RandWallet

/// `Amm` — the durian.market AMM as the Swap screen reads it (`ui/test/amm.test.mjs`, the same
/// cases): the quote matches durian's own crate to the unit (its generated vectors), and the
/// transition is exact — the write is the pool after the trade, the pay is the quote, and the
/// program's inequality holds for it.
final class AmmTests: XCTestCase {
    struct Vectors: Decodable {
        struct Swap: Decodable { let rr, rt, dx, dy: String; let randIn: Bool }
        struct Through: Decodable { let dx, rrA, rtA, rrB, rtB, mid, dz: String }
        let swap: [Swap]
        let swapThrough: [Through]
    }

    private func vectors() throws -> Vectors {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "amm-vectors", withExtension: "json"), "the fixture is in the test bundle")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    private func u(_ s: String) -> UInt64 { UInt64(s)! }

    /// The live chain-20 cell of the RAND/token-2 pool, as rand_getProgramCells answered (2026-10-01).
    static let live = CellHex(key: "0100000000000000020000000000000000000000000000000000000000000000",
                              value: "007e9420310000005f981f6a04000000338ebab90e0000000300000001000000")

    private func pool() throws -> Amm.Pool { try XCTUnwrap(Amm.decodePool(Self.live)) }

    private func built(_ r: Result<Amm.Swap, Amm.Refusal>, file: StaticString = #filePath, line: UInt = #line) throws -> Amm.Swap {
        switch r {
        case .success(let s): return s
        case .failure(let f): XCTFail("refused: \(f.code)", file: file, line: line); throw f
        }
    }

    private func code(_ r: Result<Amm.Swap, Amm.Refusal>) -> String? {
        if case .failure(let f) = r { return f.code }
        return nil
    }

    func testSwapOutMatchesDurianCoreForEverySwapVector() throws {
        let v = try vectors()
        XCTAssertEqual(v.swap.count, 120)
        for t in v.swap {
            let p = Amm.Pool(token: 2, rr: u(t.rr), rt: u(t.rt), supply: 1, lpAsset: 3, key: "", value: "")
            XCTAssertEqual(String(Amm.poolSwapOut(p, randIn: t.randIn, dx: u(t.dx))), t.dy, "\(t)")
        }
    }

    func testATokenToTokenSwapThroughRandMatchesDurianCoreForEveryVector() throws {
        let v = try vectors()
        XCTAssertEqual(v.swapThrough.count, 60)
        for t in v.swapThrough {
            let mid = Amm.swapOut(rIn: u(t.rtA), rOut: u(t.rrA), dx: u(t.dx))
            let dz = mid > 0 ? Amm.swapOut(rIn: u(t.rrB), rOut: u(t.rtB), dx: mid) : 0
            XCTAssertEqual(String(mid), t.mid, "\(t)")
            XCTAssertEqual(String(dz), t.dz, "\(t)")
        }
    }

    func testWord8HexIsEightLittleEndianWordsAndKeysOrderWordByWord() {
        XCTAssertEqual(Amm.wordsToHex([1]), "01000000" + String(repeating: "0", count: 56))
        XCTAssertEqual(Amm.hexToWords(Amm.wordsToHex([1, 0, 2, 0xffff_ffff])), [1, 0, 2, 0xffff_ffff, 0, 0, 0, 0])
        XCTAssertNil(Amm.hexToWords("zz"))
        XCTAssertEqual(Amm.poolKey(2), Self.live.key)
        XCTAssertTrue(Amm.keyLess(Amm.poolKey(2), Amm.poolKey(10)))
        XCTAssertTrue(Amm.keyLess(Amm.poolKey(2), Amm.poolKey(256)), "numeric, not lexicographic on the hex")
        XCTAssertFalse(Amm.keyLess(Amm.poolKey(256), Amm.poolKey(2)))
    }

    func testTheLivePoolCellDecodesAndEncodesBackByteForByte() throws {
        let p = try pool()
        XCTAssertEqual(p.token, 2)
        XCTAssertEqual(p.lpAsset, 3)
        XCTAssertTrue(p.rr > 0 && p.rt > 0 && p.supply > 0)
        XCTAssertEqual(Amm.encodePool(rr: p.rr, rt: p.rt, supply: p.supply, lpAsset: p.lpAsset), Self.live.value)
        // Any other cell — the LP binding the program also keeps, a wrong version — is no pool.
        XCTAssertNil(Amm.decodePool(CellHex(key: "0200000003000000000000000000000000000000000000000000000000000000",
                                            value: "0100000000000000020000000000000000000000000000000000000000000000")))
        XCTAssertNil(Amm.decodePool(CellHex(key: Self.live.key, value: String(Self.live.value.prefix(56)) + "02000000")))
        XCTAssertEqual(Amm.pools(of: [Self.live, CellHex(key: "zz", value: "zz")]).map(\.token), [2])
        XCTAssertEqual(Amm.tradeable(Amm.pools(of: [Self.live])), [0, 2])
    }

    func testRandToTokenWritesThePoolAfterThePaysTheQuoteAndTheProgramAcceptsIt() throws {
        let p = try pool()
        let dx: UInt64 = 1_000_000_000 // 1 RAND
        let s = try built(Amm.buildSwap(route: Amm.findRoute([p], sell: 0, buy: 2), dx: dx, rnd: [7, 8, 9], title: "Swap 1 RAND"))
        let r = s.request
        XCTAssertEqual(r.program, Amm.durianProgram)
        XCTAssertEqual(r.program, "db2148e6b81a2268b840bbad271068a37b2b75babaf534f1cd5bd6329a532bda")
        XCTAssertEqual(r.inputs, [3, 7, 8, 9], "METHOD_SWAP and the three random words")
        XCTAssertEqual(r.reads, [Self.live])
        XCTAssertEqual(r.inflow, .init(rand: "1000000000", asset: 0, amount: "0", kind: "none"), "RAND goes in as the bundle's RAND burn")
        XCTAssertEqual(r.pays, [AssetAmount(asset: 2, amount: String(s.amountOut))])
        XCTAssertEqual(r.mints, [])
        XCTAssertEqual(r.title, "Swap 1 RAND")
        let after = try XCTUnwrap(Amm.decodePool(r.writes[0]))
        XCTAssertEqual(after.rr, p.rr + dx)
        XCTAssertEqual(after.rt, p.rt - s.amountOut)
        XCTAssertEqual(after.supply, p.supply)
        XCTAssertEqual(after.lpAsset, p.lpAsset)
        // The program's own check: dy·(1000·rIn + 997·dx) ≤ 997·dx·rOut, and one unit more fails it.
        func ok(_ dy: UInt64) -> Bool {
            Amm.Wide(dy) * (Amm.Wide(1000) * Amm.Wide(p.rr) + Amm.Wide(997) * Amm.Wide(dx)) <= Amm.Wide(997) * Amm.Wide(dx) * Amm.Wide(p.rt)
        }
        XCTAssertTrue(ok(s.amountOut))
        XCTAssertFalse(ok(s.amountOut + 1), "the quote is the largest the program accepts")
        XCTAssertEqual(s.fee, Amm.swapFee(dx))
        XCTAssertEqual(s.feeAsset, 0)
        XCTAssertEqual(s.sell, 0)
        XCTAssertEqual(s.buy, 2)
    }

    func testTokenToRandDepositsTheTokenAndPaysRand() throws {
        let p = try pool()
        let s = try built(Amm.buildSwap(route: Amm.findRoute([p], sell: 2, buy: 0), dx: 10_000_000_000, rnd: [1, 2, 3]))
        XCTAssertEqual(s.request.inflow, .init(rand: "0", asset: 2, amount: "10000000000", kind: "deposit"))
        XCTAssertEqual(s.request.pays, [AssetAmount(asset: 0, amount: String(s.amountOut))])
        let after = try XCTUnwrap(Amm.decodePool(s.request.writes[0]))
        XCTAssertEqual(after.rt, p.rt + 10_000_000_000)
        XCTAssertEqual(after.rr, p.rr - s.amountOut)
    }

    func testTokenToTokenRunsThroughBothPoolsReadingAndWritingInKeyOrder() throws {
        func cell(_ token: UInt32, rr: UInt64, rt: UInt64, supply: UInt64, lp: UInt32) -> CellHex {
            CellHex(key: Amm.poolKey(token), value: Amm.encodePool(rr: rr, rt: rt, supply: supply, lpAsset: lp))
        }
        let a = cell(5, rr: 9_000_000_000, rt: 4_000_000_000, supply: 6_000_000_000, lp: 6)
        let b = cell(2, rr: 8_000_000_000, rt: 3_000_000_000, supply: 5_000_000_000, lp: 3)
        let pools = Amm.pools(of: [a, b])
        let s = try built(Amm.buildSwap(route: Amm.findRoute(pools, sell: 5, buy: 2), dx: 100_000_000, rnd: [1, 1, 1]))
        XCTAssertEqual(s.hops.count, 2)
        XCTAssertEqual(s.request.reads.map(\.key), [Amm.poolKey(2), Amm.poolKey(5)], "ascending")
        XCTAssertEqual(s.request.writes.map(\.key), [Amm.poolKey(2), Amm.poolKey(5)])
        XCTAssertEqual(s.request.inflow, .init(rand: "0", asset: 5, amount: "100000000", kind: "deposit"))
        let mid = Amm.swapOut(rIn: 4_000_000_000, rOut: 9_000_000_000, dx: 100_000_000)
        XCTAssertEqual(s.amountOut, Amm.swapOut(rIn: 8_000_000_000, rOut: 3_000_000_000, dx: mid))
        XCTAssertEqual(s.request.pays, [AssetAmount(asset: 2, amount: String(s.amountOut))])
    }

    func testWhatCannotBeSwappedIsRefusedBeforeAnythingIsBuilt() throws {
        let p = try pool()
        XCTAssertNil(Amm.findRoute([p], sell: 0, buy: 0))
        XCTAssertNil(Amm.findRoute([p], sell: 0, buy: 9))
        XCTAssertEqual(code(Amm.buildSwap(route: nil, dx: 1)), "no-route")
        XCTAssertEqual(code(Amm.buildSwap(route: Amm.findRoute([p], sell: 0, buy: 2), dx: 0)), "no-amount")
        XCTAssertEqual(code(Amm.buildSwap(route: Amm.findRoute([p], sell: 0, buy: 2), dx: Amm.noteBound)), "over-bound")
        // The pool holds ~11× more RAND than token units, so one base unit of RAND buys no token unit.
        XCTAssertEqual(code(Amm.buildSwap(route: Amm.findRoute([p], sell: 0, buy: 2), dx: 1)), "dust", "one unit buys nothing")
    }

    func testTheSpotRateIsTheReservesRatioInTheBoughtAssetsUnits() throws {
        let p = try pool()
        let want = (Amm.Wide(1_000_000_000) * Amm.Wide(p.rt) / Amm.Wide(p.rr)).uint64
        XCTAssertEqual(Amm.spotRate(Amm.findRoute([p], sell: 0, buy: 2), sellDecimals: 9), want)
        XCTAssertNil(Amm.spotRate(nil, sellDecimals: 9))
    }

    func testTheImpactIsZeroForNothingAndGrowsWithTheTrade() throws {
        let p = try pool()
        let small = try built(Amm.buildSwap(route: Amm.findRoute([p], sell: 0, buy: 2), dx: 1_000_000_000))
        let large = try built(Amm.buildSwap(route: Amm.findRoute([p], sell: 0, buy: 2), dx: p.rr / 2))
        // 1 RAND into a pool of ~211: 997·dx / (1000·rr + 997·dx), under half a percent.
        XCTAssertEqual(Double(small.impactPpm), 1e6 * 0.997 / (Double(p.rr) / 1e9 + 0.997), accuracy: 2)
        XCTAssertGreaterThan(large.impactPpm, 50_000, "half the pool moves the price by far more than 5%")
    }

    func testWideArithmeticIsExactPast128Bits() {
        // (2^63 − 1)·997·(2^63 − 1) is about 2^136.
        let big = Amm.noteBound - 1
        let x = Amm.Wide(big) * Amm.Wide(997) * Amm.Wide(big)
        XCTAssertEqual((x / Amm.Wide(big) / Amm.Wide(big)).uint64, 997)
        XCTAssertEqual((x / (Amm.Wide(997) * Amm.Wide(big))).uint64, big)
        XCTAssertEqual(((x + Amm.Wide(5)) - x).uint64, 5)
        XCTAssertNil(x.uint64)
    }
}
