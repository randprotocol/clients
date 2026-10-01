import Foundation

/// The search for bridge deposits in blocks not read yet, by header.
///
/// A deposit is rebuilt from the `bridge_attest` action that created it, and the only way to find
/// one is to look in the blocks. One `rand_getBlockByHeight` per height did that for a short
/// chain; at a block a second it is a hundred thousand calls for a first scan, and the public
/// endpoint refuses after about a hundred. `rand_getBlocks(from, to)` answers up to 1024 headers
/// a call, each with a `tx_count`, and only a block that carries a transaction can carry an
/// attestation: on the chain this was measured on (2026-09-30: 100 352 blocks, 534 with a
/// transaction) that is 98 + 534 requests instead of 100 352.
///
/// The rules are `ui/engine/wallet.js`'s `depositsByHeader`, to the letter:
///
/// * `next` is one past the last height this wallet asked for, was answered about and checked —
///   a header that says "empty", or a block that was opened. It never moves over a header page
///   that is not the answer to its request (one that starts late, skips a height or runs past the
///   range), nor past a busy block that was not opened.
/// * What the node will not serve stops the walk where it stopped and is reported as `unknown`;
///   it does not fail the scan. The notes and the spends are most of a wallet, and one refused
///   block read used to cost all of them.
/// * One scan spends at most `maxRequests` requests here, header pages and opened blocks
///   together; a longer gap is closed over several scans.
/// * A node with no `rand_getBlocks` is read one block at a time, at most
///   `maxHeightsWithoutHeaders` a scan.
///
/// The core refusing an action it was handed is this wallet's own failure and is thrown, not
/// reported as unknown.
enum DepositWalk {
    /// Headers asked of one `rand_getBlocks` call: the node's own cap.
    static let headerPage: UInt64 = 1024
    /// Requests one scan may spend looking for deposits.
    static let maxRequests = 96
    /// Blocks one scan may open on a node that has no `rand_getBlocks`.
    static let maxHeightsWithoutHeaders: UInt64 = 512

    struct Result: Equatable {
        /// One past the last height examined; `start` when nothing was.
        let next: UInt64
        /// The node could not, or would not, answer for everything up to the tip.
        let unknown: Bool
    }

    /// A header page that is not the answer to the request it was sent for.
    struct BadHeaders: Error {
        let message: String
    }

    /// - Parameters:
    ///   - headers: `rand_getBlocks(from, to)`, raw.
    ///   - actions: the actions of the block at a height (`rand_getBlockByHeight`).
    ///   - offer: where each `bridge_attest` action found goes; what it throws is thrown.
    static func run(
        start: UInt64,
        head: UInt64,
        headers: (UInt64, UInt64) async throws -> Any,
        actions: (UInt64) async throws -> [Any],
        offer: (Any) throws -> Void
    ) async throws -> Result {
        var next = start
        var budget = maxRequests
        while next <= head && budget > 0 {
            let from = next
            let to = min(head, from &+ headerPage - 1)
            let counts: [UInt64]
            do {
                counts = try checkedHeaders(try await headers(from, to), from: from, to: to)
            } catch let e as RpcClient.RpcError where e.code == -32601 && !e.isHTTP && budget == maxRequests {
                // "No such method" as the very first answer is a node that predates it.
                return try await oneByOne(start: start, head: head, actions: actions, offer: offer)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                return Result(next: next, unknown: true)
            }
            budget -= 1
            // The node named a tip at or above `from` and then had no header for it.
            if counts.isEmpty { return Result(next: next, unknown: true) }
            for (i, count) in counts.enumerated() {
                let height = from + UInt64(i)
                if count > 0 {
                    if budget <= 0 { return Result(next: next, unknown: false) } // enough for one scan
                    budget -= 1
                    let found: [Any]
                    do {
                        found = try await actions(height)
                    } catch is CancellationError {
                        throw CancellationError()
                    } catch {
                        return Result(next: next, unknown: true)
                    }
                    try offerAttests(found, offer)
                }
                next = height + 1
            }
            if UInt64(counts.count) < to - from + 1 { break } // the node's own tip is below the one it named
        }
        return Result(next: next, unknown: false)
    }

    /// One call per height, for a node without `rand_getBlocks`.
    private static func oneByOne(
        start: UInt64,
        head: UInt64,
        actions: (UInt64) async throws -> [Any],
        offer: (Any) throws -> Void
    ) async throws -> Result {
        var next = start
        guard start <= head else { return Result(next: next, unknown: false) }
        let last = min(head, start &+ maxHeightsWithoutHeaders - 1)
        for h in start...last {
            let found: [Any]
            do {
                found = try await actions(h)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                return Result(next: next, unknown: true)
            }
            try offerAttests(found, offer)
            next = h + 1
        }
        return Result(next: next, unknown: false)
    }

    /// A header page as `tx_count`s, index `i` being block `from + i` — or `BadHeaders` when the
    /// reply is not the answer to this request: an honest one is a contiguous run from exactly
    /// `from` that never passes `to` (it may be shorter; the node's tip is its own).
    static func checkedHeaders(_ reply: Any, from: UInt64, to: UInt64) throws -> [UInt64] {
        guard let rows = reply as? [Any] else { throw BadHeaders(message: "rand_getBlocks: the reply is not a list") }
        guard UInt64(rows.count) <= to - from + 1 else {
            throw BadHeaders(message: "rand_getBlocks: \(rows.count) headers for a range of \(to - from + 1)")
        }
        var counts: [UInt64] = []
        counts.reserveCapacity(rows.count)
        for (i, row) in rows.enumerated() {
            guard let header = row as? [String: Any] else { throw BadHeaders(message: "rand_getBlocks: header \(i) is not an object") }
            let height = try wholeNumber(header["height"], "height", i)
            guard height == from + UInt64(i) else {
                throw BadHeaders(message: "rand_getBlocks: header \(i) is block \(height), not the \(from + UInt64(i)) the range calls for")
            }
            counts.append(try wholeNumber(header["tx_count"], "tx_count", i))
        }
        return counts
    }

    /// A non-negative integer, accepted as a JSON integer only (not a string, a bool or a fraction).
    private static func wholeNumber(_ v: Any?, _ name: String, _ i: Int) throws -> UInt64 {
        if let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() {
            let d = n.doubleValue
            if d >= 0, d == d.rounded(), d < 9_007_199_254_740_992 { return n.uint64Value }
        }
        throw BadHeaders(message: "rand_getBlocks: header \(i) \(name) is not a non-negative integer")
    }

    private static func offerAttests(_ actions: [Any], _ offer: (Any) throws -> Void) throws {
        for action in actions {
            // A deposit, and a burn — whose fee note is the chain's fee recipient's (v0.6.8); the
            // offer decides which it rebuilds.
            guard let a = action as? [String: Any], let kind = a["kind"] as? String, kind == "bridge_attest" || kind == "bridge_burn" else { continue }
            try offer(action)
        }
    }
}
