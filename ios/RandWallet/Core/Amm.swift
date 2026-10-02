import Foundation

/// The durian.market AMM, as the wallet's own Swap screen reads it: the pool cells, the quote, and
/// the transition handed to `WalletService.invoke`. The Swift twin of `ui/lib/amm.js` (itself a
/// port of durian.market's web/lib/amm and web/lib/rand, twins of its Rust crate durian-core),
/// checked against that crate's own vectors (`AmmTests`, `amm-vectors.json`). Every amount is
/// base units.
///
/// One program serves every pool, and every pool pairs RAND (asset 0) with one token:
///
///     pool        key [1, 0, token, 0,0,0,0,0]
///                 value [rr_lo, rr_hi, rt_lo, rt_hi, s_lo, s_hi, lp_asset, 1]
///
/// rr is the RAND reserve, rt the token reserve, s the share supply. The program never divides: it
/// checks the amounts it is shown with multiplications, so a quote is the LARGEST output its
/// inequality accepts, and the transition is exact — a read is the cell as read, a write the cell
/// after, a pay the quoted amount to the unit. If the pool moves first, the read no longer matches
/// and the chain refuses the transaction (a stale read; the wallet's quote re-reads the cell before
/// any proof is paid for); the screen then quotes again from the new reserves.
///
/// The products (997·dx·rOut) pass 2^128 for amounts near the note bound, so they are computed in
/// `Amm.Wide`, a 256-bit unsigned integer — never in floating point.
enum Amm {
    /// The AMM program durian.market runs (rand_getProgram: deployed at height 1947 on chain 20).
    static let durianProgram = "db2148e6b81a2268b840bbad271068a37b2b75babaf534f1cd5bd6329a532bda"
    static let durianURL = URL(string: "https://durian.market")!

    static let randAsset: UInt32 = 0
    /// The pool's fee: 997/1000 of the amount sold counts toward the price (0.30%).
    static let feeNum: UInt64 = 997
    static let feeDen: UInt64 = 1000
    static let feeBps = 30
    /// Every amount, reserve and supply stays below 2^63, the chain's note bound.
    static let noteBound: UInt64 = 1 << 63
    static let methodSwap: UInt32 = 3
    private static let tagPool: UInt32 = 1
    private static let poolVersion: UInt32 = 1
    private static let words = 8

    // MARK: Word8: eight little-endian u32 words as 64 lowercase hex characters

    static func wordsToHex(_ w: [UInt32]) -> String {
        precondition(w.count <= words, "a Word8 has \(words) words")
        var out = ""
        for i in 0..<words {
            let v = i < w.count ? w[i] : 0
            for b in 0..<4 { out += String(format: "%02x", (v >> (8 * UInt32(b))) & 0xff) }
        }
        return out
    }

    /// The eight words of a Word8, or `nil` for anything that is not 64 lowercase hex characters.
    static func hexToWords(_ hex: String) -> [UInt32]? {
        let bytes = Array(hex.utf8)
        guard bytes.count == 64, bytes.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { return nil }
        func nibble(_ c: UInt8) -> UInt32 { UInt32(c <= 57 ? c - 48 : c - 87) }
        return (0..<words).map { i in
            var w: UInt32 = 0
            for b in (0..<4).reversed() {
                let at = i * 8 + b * 2
                w = w << 8 | (nibble(bytes[at]) << 4 | nibble(bytes[at + 1]))
            }
            return w
        }
    }

    /// Key order as the ledger keeps it: word by word, numerically (not the hex's lexical order).
    static func keyLess(_ a: String, _ b: String) -> Bool {
        guard let x = hexToWords(a), let y = hexToWords(b) else { return a < b }
        for i in 0..<words where x[i] != y[i] { return x[i] < y[i] }
        return false
    }

    // MARK: the pool cell

    struct Pool: Equatable {
        let token: UInt32
        let rr: UInt64
        let rt: UInt64
        let supply: UInt64
        let lpAsset: UInt32
        let key: String
        let value: String
    }

    static func poolKey(_ token: UInt32) -> String {
        precondition(token > randAsset, "a pool pairs RAND with a token")
        return wordsToHex([tagPool, randAsset, token])
    }

    static func encodePool(rr: UInt64, rt: UInt64, supply: UInt64, lpAsset: UInt32) -> String {
        func split(_ v: UInt64) -> [UInt32] { [UInt32(truncatingIfNeeded: v), UInt32(truncatingIfNeeded: v >> 32)] }
        return wordsToHex(split(rr) + split(rt) + split(supply) + [lpAsset, poolVersion])
    }

    /// A pool cell, or `nil` for any other cell (the LP binding the program also keeps, another
    /// version) and for a pool with an empty side, which cannot price anything.
    static func decodePool(_ cell: CellHex) -> Pool? {
        guard let k = hexToWords(cell.key), let v = hexToWords(cell.value) else { return nil }
        guard k[0] == tagPool, k[1] == randAsset, k[2] != randAsset, k[3...].allSatisfy({ $0 == 0 }) else { return nil }
        guard v[7] == poolVersion else { return nil }
        func join(_ lo: UInt32, _ hi: UInt32) -> UInt64 { UInt64(hi) << 32 | UInt64(lo) }
        let p = Pool(token: k[2], rr: join(v[0], v[1]), rt: join(v[2], v[3]), supply: join(v[4], v[5]),
                     lpAsset: v[6], key: cell.key, value: cell.value)
        return p.rr > 0 && p.rt > 0 ? p : nil
    }

    /// Every live pool among a program's cells, by token.
    static func pools(of cells: [CellHex]) -> [Pool] {
        cells.compactMap(decodePool).sorted { $0.token < $1.token }
    }

    // MARK: the quote

    private static func ltNote(_ v: UInt64) -> Bool { v < noteBound }

    /// What selling `dx` into the side holding `rIn` pays from the side holding `rOut`: the largest
    /// dy ≤ rOut with dy·(1000·rIn + 997·dx) ≤ 997·dx·rOut. Zero when nothing can be bought.
    static func swapOut(rIn: UInt64, rOut: UInt64, dx: UInt64) -> UInt64 {
        let (sum, over) = rIn.addingReportingOverflow(dx)
        guard dx > 0, ltNote(dx), !over, ltNote(sum) else { return 0 }
        let num = Wide(feeNum) * Wide(dx) * Wide(rOut)
        let den = Wide(feeDen) * Wide(rIn) + Wide(feeNum) * Wide(dx)
        let dy = (num / den).uint64 ?? .max
        return min(dy, rOut)
    }

    static func poolSwapOut(_ pool: Pool, randIn: Bool, dx: UInt64) -> UInt64 {
        randIn ? swapOut(rIn: pool.rr, rOut: pool.rt, dx: dx) : swapOut(rIn: pool.rt, rOut: pool.rr, dx: dx)
    }

    /// The fee's share of an amount sold, rounded up so the fee plus the priced part is dx.
    static func swapFee(_ dx: UInt64) -> UInt64 {
        dx == 0 ? 0 : dx - ((Wide(dx) * Wide(feeNum)) / Wide(feeDen)).uint64!
    }

    /// How far a trade moves the price it gets, in parts per million, the fee excluded.
    static func priceImpactPpm(rIn: UInt64, rOut: UInt64, dx: UInt64, dy: UInt64) -> UInt64 {
        guard dx > 0, rIn > 0, rOut > 0 else { return 0 }
        let ideal = Wide(feeNum) * Wide(dx) * Wide(rOut)
        let got = Wide(dy) * Wide(feeDen) * Wide(rIn)
        if got >= ideal { return 0 }
        return ((ideal - got) * Wide(1_000_000) / ideal).uint64 ?? 1_000_000
    }

    private static func combinePpm(_ a: UInt64, _ b: UInt64) -> UInt64 {
        let m: UInt64 = 1_000_000
        return m - (m - a) * (m - b) / m
    }

    /// Every asset the pools can swap: RAND, and each pool's token.
    static func tradeable(_ pools: [Pool]) -> [UInt32] {
        pools.isEmpty ? [] : [randAsset] + pools.map(\.token)
    }

    /// The pools a swap runs through: one for RAND ↔ token, two (through RAND) for token → token.
    enum Route: Equatable {
        case direct(pool: Pool, randIn: Bool)
        case through(poolIn: Pool, poolOut: Pool)
    }

    /// The route for selling `sell` for `buy`, or `nil` when there is none.
    static func findRoute(_ pools: [Pool], sell: UInt32, buy: UInt32) -> Route? {
        if sell == buy { return nil }
        func of(_ t: UInt32) -> Pool? { pools.first { $0.token == t } }
        if sell == randAsset { return of(buy).map { .direct(pool: $0, randIn: true) } }
        if buy == randAsset { return of(sell).map { .direct(pool: $0, randIn: false) } }
        guard let a = of(sell), let b = of(buy) else { return nil }
        return .through(poolIn: a, poolOut: b)
    }

    /// Why a swap cannot be built: `code` as `ui/lib/amm.js` names it, `message` for the screen.
    struct Refusal: LocalizedError, Equatable {
        let code: String
        let message: String
        var errorDescription: String? { message }
    }

    private static var tooSmall: String { String(localized: "That amount is too small: it would buy nothing.") }
    private static var tooLarge: String { String(localized: "That amount is more than the pool can hold.") }

    struct Hop: Equatable {
        let pool: Pool
        let randIn: Bool
        let amountIn: UInt64
        let amountOut: UInt64
        let fee: UInt64
        let impactPpm: UInt64
        /// The reserves after the trade.
        let rr: UInt64
        let rt: UInt64
    }

    private static func hop(_ pool: Pool, randIn: Bool, amountIn: UInt64) -> Result<Hop, Refusal> {
        let rIn = randIn ? pool.rr : pool.rt
        let (sum, over) = rIn.addingReportingOverflow(amountIn)
        if over || sum >= noteBound { return .failure(Refusal(code: "over-bound", message: tooLarge)) }
        let out = poolSwapOut(pool, randIn: randIn, dx: amountIn)
        if out == 0 { return .failure(Refusal(code: "dust", message: tooSmall)) }
        let rOut = randIn ? pool.rt : pool.rr
        return .success(Hop(pool: pool, randIn: randIn, amountIn: amountIn, amountOut: out, fee: swapFee(amountIn),
                            impactPpm: priceImpactPpm(rIn: rIn, rOut: rOut, dx: amountIn, dy: out),
                            rr: randIn ? pool.rr + amountIn : pool.rr - out,
                            rt: randIn ? pool.rt - out : pool.rt + amountIn))
    }

    private static func afterCell(_ h: Hop) -> CellHex {
        CellHex(key: h.pool.key, value: encodePool(rr: h.rr, rt: h.rt, supply: h.pool.supply, lpAsset: h.pool.lpAsset))
    }

    /// Three random u32 words, so a call's input digest is never a guessable function of public data.
    static func randomWords() -> [UInt32] {
        var g = SystemRandomNumberGenerator()
        return (0..<3).map { _ in UInt32.random(in: .min ... .max, using: &g) }
    }

    /// The quote, and the exact transition `request` that `WalletService.quoteInvoke/invoke` take.
    struct Swap: Equatable {
        let sell: UInt32
        let buy: UInt32
        let amountIn: UInt64
        let amountOut: UInt64
        let fee: UInt64
        let feeAsset: UInt32
        let impactPpm: UInt64
        let hops: [Hop]
        let request: InvokeRequest
    }

    /// The quote and the exact transition for selling `dx` of the route's sell side.
    static func buildSwap(route: Route?, dx: UInt64, rnd: [UInt32] = randomWords(), title: String = "") -> Result<Swap, Refusal> {
        guard let route else { return .failure(Refusal(code: "no-route", message: String(localized: "There is no pool for that pair."))) }
        if dx == 0 { return .failure(Refusal(code: "no-amount", message: String(localized: "Enter an amount."))) }
        if dx >= noteBound { return .failure(Refusal(code: "over-bound", message: tooLarge)) }
        let inputs = [methodSwap] + rnd.prefix(3)
        switch route {
        case .direct(let pool, let randIn):
            let h: Hop
            switch hop(pool, randIn: randIn, amountIn: dx) {
            case .failure(let r): return .failure(r)
            case .success(let v): h = v
            }
            let (sell, buy) = randIn ? (randAsset, pool.token) : (pool.token, randAsset)
            let inflow = randIn
                ? InvokeRequest.Inflow(rand: String(dx), asset: 0, amount: "0", kind: "none")
                : InvokeRequest.Inflow(rand: "0", asset: pool.token, amount: String(dx), kind: "deposit")
            let request = InvokeRequest(program: durianProgram, inputs: inputs,
                                        reads: [CellHex(key: pool.key, value: pool.value)], writes: [afterCell(h)],
                                        inflow: inflow, pays: [.init(asset: buy, amount: String(h.amountOut))], mints: [], title: title)
            return .success(Swap(sell: sell, buy: buy, amountIn: dx, amountOut: h.amountOut, fee: h.fee, feeAsset: sell,
                                 impactPpm: h.impactPpm, hops: [h], request: request))
        case .through(let poolIn, let poolOut):
            let first: Hop, second: Hop
            switch hop(poolIn, randIn: false, amountIn: dx) {
            case .failure(let r): return .failure(r)
            case .success(let v): first = v
            }
            switch hop(poolOut, randIn: true, amountIn: first.amountOut) {
            case .failure(let r): return .failure(r)
            case .success(let v): second = v
            }
            let byKey: ([CellHex]) -> [CellHex] = { $0.sorted { keyLess($0.key, $1.key) } }
            let request = InvokeRequest(program: durianProgram, inputs: inputs,
                                        reads: byKey([CellHex(key: poolIn.key, value: poolIn.value), CellHex(key: poolOut.key, value: poolOut.value)]),
                                        writes: byKey([afterCell(first), afterCell(second)]),
                                        inflow: .init(rand: "0", asset: poolIn.token, amount: String(dx), kind: "deposit"),
                                        pays: [.init(asset: poolOut.token, amount: String(second.amountOut))], mints: [], title: title)
            return .success(Swap(sell: poolIn.token, buy: poolOut.token, amountIn: dx, amountOut: second.amountOut,
                                 fee: first.fee, feeAsset: poolIn.token, impactPpm: combinePpm(first.impactPpm, second.impactPpm),
                                 hops: [first, second], request: request))
        }
    }

    /// What one whole `sell` (10^sellDecimals base units) buys at the pools' current reserves,
    /// before the fee and the trade's own price impact, in `buy`'s base units. `nil` when there is
    /// no route, or the rate does not fit in 64 bits.
    static func spotRate(_ route: Route?, sellDecimals: Int) -> UInt64? {
        guard let route else { return nil }
        var scale = Wide(1)
        for _ in 0..<max(sellDecimals, 0) { scale = scale * Wide(10) }
        let num: Wide, den: Wide
        switch route {
        case .direct(let p, let randIn):
            (num, den) = randIn ? (Wide(p.rt), Wide(p.rr)) : (Wide(p.rr), Wide(p.rt))
        case .through(let a, let b):
            (num, den) = (Wide(a.rr) * Wide(b.rt), Wide(a.rt) * Wide(b.rr))
        }
        return (scale * num / den).uint64
    }

    // MARK: Wide — exact unsigned 256-bit arithmetic for the AMM's products

    /// Four little-endian 64-bit limbs. Only what the quote needs: +, −, ×, ÷, comparison. A
    /// product past 2^256 cannot arise from amounts below 2^64 (three factors at most, × 10^9).
    struct Wide: Comparable {
        var limbs: [UInt64]

        init(_ v: UInt64) { limbs = [v, 0, 0, 0] }
        private init(limbs: [UInt64]) { self.limbs = limbs }

        /// The value, when it fits in 64 bits.
        var uint64: UInt64? { limbs[1] == 0 && limbs[2] == 0 && limbs[3] == 0 ? limbs[0] : nil }
        var isZero: Bool { limbs.allSatisfy { $0 == 0 } }

        static func < (a: Wide, b: Wide) -> Bool {
            for i in (0..<4).reversed() where a.limbs[i] != b.limbs[i] { return a.limbs[i] < b.limbs[i] }
            return false
        }

        static func + (a: Wide, b: Wide) -> Wide {
            var out = [UInt64](repeating: 0, count: 4)
            var carry: UInt64 = 0
            for i in 0..<4 {
                let (s1, o1) = a.limbs[i].addingReportingOverflow(b.limbs[i])
                let (s2, o2) = s1.addingReportingOverflow(carry)
                out[i] = s2
                carry = (o1 ? 1 : 0) + (o2 ? 1 : 0)
            }
            precondition(carry == 0, "Wide overflow")
            return Wide(limbs: out)
        }

        static func - (a: Wide, b: Wide) -> Wide {
            precondition(a >= b, "Wide underflow")
            var out = [UInt64](repeating: 0, count: 4)
            var borrow: UInt64 = 0
            for i in 0..<4 {
                let (d1, o1) = a.limbs[i].subtractingReportingOverflow(b.limbs[i])
                let (d2, o2) = d1.subtractingReportingOverflow(borrow)
                out[i] = d2
                borrow = (o1 ? 1 : 0) + (o2 ? 1 : 0)
            }
            return Wide(limbs: out)
        }

        static func * (a: Wide, b: Wide) -> Wide {
            var out = [UInt64](repeating: 0, count: 4)
            for i in 0..<4 where a.limbs[i] != 0 {
                var carry: UInt64 = 0
                for j in 0..<(4 - i) {
                    let (hi, lo) = a.limbs[i].multipliedFullWidth(by: b.limbs[j])
                    let (s1, o1) = out[i + j].addingReportingOverflow(lo)
                    let (s2, o2) = s1.addingReportingOverflow(carry)
                    out[i + j] = s2
                    carry = hi &+ (o1 ? 1 : 0) &+ (o2 ? 1 : 0)
                }
                precondition(carry == 0, "Wide overflow")
            }
            for i in 1..<4 {
                for j in (4 - i)..<4 where a.limbs[i] != 0 && b.limbs[j] != 0 { preconditionFailure("Wide overflow") }
            }
            return Wide(limbs: out)
        }

        /// Floor division, by shift and subtract: at most 256 rounds.
        static func / (a: Wide, b: Wide) -> Wide {
            precondition(!b.isZero, "division by zero")
            if a < b { return Wide(0) }
            var q = [UInt64](repeating: 0, count: 4)
            var r = Wide(0)
            for bit in (0..<256).reversed() {
                r = r.shiftedLeftOne()
                if (a.limbs[bit / 64] >> UInt64(bit % 64)) & 1 == 1 { r.limbs[0] |= 1 }
                if r >= b {
                    r = r - b
                    q[bit / 64] |= 1 << UInt64(bit % 64)
                }
            }
            return Wide(limbs: q)
        }

        private func shiftedLeftOne() -> Wide {
            var out = [UInt64](repeating: 0, count: 4)
            for i in 0..<4 { out[i] = limbs[i] << 1 | (i > 0 ? limbs[i - 1] >> 63 : 0) }
            return Wide(limbs: out)
        }
    }
}
