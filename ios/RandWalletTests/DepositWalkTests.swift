import XCTest
@testable import RandWallet

/// The search for bridge deposits, by header (`ui/test/engine-wallet.test.mjs` and Android's
/// `DepositWalkTest` are the same cases), and the RPC client waiting out an HTTP 429.
///
/// One `rand_getBlockByHeight` per height from zero was a hundred thousand calls for a first scan
/// on a chain that makes a block a second, and the public endpoint refuses after about a hundred:
/// a new wallet never finished its first scan.
final class DepositWalkTests: XCTestCase {
    /// A node of `head` blocks; `busy` are the heights with a transaction in them.
    final class Node {
        let head: UInt64
        let busy: Set<UInt64>
        var pages: [[UInt64]] = []
        var opened: [UInt64] = []
        init(head: UInt64, busy: Set<UInt64> = []) { self.head = head; self.busy = busy }

        func headers(_ from: UInt64, _ to: UInt64) -> Any {
            pages.append([from, to])
            guard from <= min(to, head) else { return [Any]() }
            return (from...min(to, head)).map { ["height": $0, "tx_count": busy.contains($0) ? 1 : 0] as [String: Any] }
        }

        func actions(_ height: UInt64) -> [Any] {
            opened.append(height)
            return [["kind": "bridge_attest", "at": height] as [String: Any]]
        }
    }

    private func walk(_ node: Node, start: UInt64 = 0, seen: inout [UInt64]) async throws -> DepositWalk.Result {
        var found: [UInt64] = []
        let r = try await DepositWalk.run(
            start: start, head: node.head,
            headers: { node.headers($0, $1) },
            actions: { node.actions($0) },
            offer: { found.append(($0 as? [String: Any])?["at"] as? UInt64 ?? 0) })
        seen = found
        return r
    }

    func testItWalksTheHeadersAndOpensOnlyTheBlocksThatCarryATransaction() async throws {
        let node = Node(head: 5000, busy: [7, 2000])
        var seen: [UInt64] = []
        let r = try await walk(node, seen: &seen)
        XCTAssertEqual(node.opened, [7, 2000])
        XCTAssertEqual(seen, [7, 2000])
        XCTAssertEqual(node.pages, [[0, 1023], [1024, 2047], [2048, 3071], [3072, 4095], [4096, 5000]])
        XCTAssertEqual(r, DepositWalk.Result(next: 5001, unknown: false))
    }

    func testNothingToReadIsNothingAsked() async throws {
        let node = Node(head: 100)
        var seen: [UInt64] = []
        let r = try await walk(node, start: 101, seen: &seen)
        XCTAssertEqual(r, DepositWalk.Result(next: 101, unknown: false))
        XCTAssertTrue(node.pages.isEmpty)
    }

    func testTheWalkIsBudgetedInRequestsAndTheNextOneResumesWhereItStopped() async throws {
        let node = Node(head: 400_000, busy: [5, 6])
        var seen: [UInt64] = []
        let r = try await walk(node, seen: &seen)
        let spent = node.pages.count + node.opened.count
        XCTAssertLessThanOrEqual(spent, DepositWalk.maxRequests)
        XCTAssertGreaterThanOrEqual(spent, 64)
        XCTAssertEqual(r.next, node.pages.last![1] + 1)
        XCTAssertLessThan(r.next, node.head)
        XCTAssertFalse(r.unknown, "a spent budget is not an unknown bridge")

        let again = Node(head: 400_000, busy: [5, 6])
        _ = try await walk(again, start: r.next, seen: &seen)
        XCTAssertEqual(again.pages.first![0], r.next)
    }

    func testABudgetSpentMidPageStopsAtTheLastBlockOpenedNotThePageEnd() async throws {
        let node = Node(head: 3000, busy: Set(100..<400))
        var seen: [UInt64] = []
        let r = try await walk(node, seen: &seen)
        XCTAssertEqual(r.next, node.opened.last! + 1, "the cursor moved over a busy block that was never opened")
        XCTAssertLessThan(node.opened.last!, 399)
    }

    func testAHeaderPageThatIsNotTheAnswerToTheRequestMovesNothing() async throws {
        let honest = Node(head: 50)
        let forges: [(String, ([[String: Any]]) -> Any)] = [
            ("starts late", { Array($0.dropFirst()) }),
            ("has a gap", { $0.filter { $0["height"] as? UInt64 != 10 } }),
            ("runs past the range", { $0 + [["height": UInt64(51), "tx_count": 0]] }),
            ("has no tx_count", { $0.map { ["height": $0["height"]!] } }),
            ("has a negative tx_count", { var r = $0; r[3]["tx_count"] = -1; return r }),
            ("has a fractional height", { var r = $0; r[3]["height"] = 3.5; return r }),
            ("has a boolean tx_count", { var r = $0; r[3]["tx_count"] = true; return r }),
            ("has a header that is not an object", { var r: [Any] = $0; r[3] = "header"; return r }),
            ("is not a list", { _ in ["rows": [Any]()] }),
            ("has no header under a tip it named", { _ in [Any]() }),
        ]
        for (why, forge) in forges {
            let r = try await DepositWalk.run(
                start: 0, head: 50,
                headers: { forge(honest.headers($0, $1) as! [[String: Any]]) },
                actions: { _ in XCTFail("a page that \(why) led to a block being opened"); return [] },
                offer: { _ in })
            XCTAssertEqual(r, DepositWalk.Result(next: 0, unknown: true), "a page that \(why)")
        }
    }

    func testABlockTheNodeWillNotOpenStopsTheWalkThereAndKeepsWhatWasFound() async throws {
        let node = Node(head: 3000, busy: [7, 2000])
        var seen: [UInt64] = []
        let r = try await DepositWalk.run(
            start: 0, head: 3000,
            headers: { node.headers($0, $1) },
            actions: { h in
                if h == 2000 { throw RpcClient.RpcError(code: 429, message: "node answered HTTP 429", isHTTP: true) }
                return node.actions(h)
            },
            offer: { seen.append(($0 as? [String: Any])?["at"] as? UInt64 ?? 0) })
        XCTAssertEqual(seen, [7])
        XCTAssertEqual(r, DepositWalk.Result(next: 2000, unknown: true))
    }

    func testANodeWithNoGetBlocksIsReadOneBlockAtATimeAndCapped() async throws {
        let node = Node(head: 5000)
        let r = try await DepositWalk.run(
            start: 0, head: 5000,
            headers: { _, _ in throw RpcClient.RpcError(code: -32601, message: "unknown method rand_getBlocks") },
            actions: { node.actions($0) },
            offer: { _ in })
        XCTAssertEqual(UInt64(node.opened.count), DepositWalk.maxHeightsWithoutHeaders)
        XCTAssertEqual(r, DepositWalk.Result(next: DepositWalk.maxHeightsWithoutHeaders, unknown: false))
    }

    func testAnActionThatIsNotABridgeAttestIsNotOffered() async throws {
        let node = Node(head: 3, busy: [2])
        var seen: [UInt64] = []
        let r = try await DepositWalk.run(
            start: 0, head: 3,
            headers: { node.headers($0, $1) },
            actions: { _ in [["kind": "bundle"], "not an action", ["kind": "bridge_attest", "at": UInt64(2)]] },
            offer: { seen.append(($0 as? [String: Any])?["at"] as? UInt64 ?? 0) })
        XCTAssertEqual(seen, [2])
        XCTAssertEqual(r.next, 4)
    }

    func testWhatTheCoreRefusesIsThrownNotReportedAsUnknown() async throws {
        struct CoreSaidNo: Error {}
        let node = Node(head: 10, busy: [4])
        do {
            _ = try await DepositWalk.run(
                start: 0, head: 10,
                headers: { node.headers($0, $1) },
                actions: { node.actions($0) },
                offer: { _ in throw CoreSaidNo() })
            XCTFail("the core's refusal was swallowed")
        } catch is CoreSaidNo {}
    }

    // MARK: HTTP 429 in the RPC client

    /// A client over `StubProver` whose waits are recorded, not slept.
    private func throttled(_ script: [StubProver.Reply]) -> (RpcClient, () -> [UInt64]) {
        var replies = script
        var last = script.last!
        StubProver.requests = []
        StubProver.handler = { _, _ in
            if !replies.isEmpty { last = replies.removeFirst() }
            return last
        }
        let waits = Waits()
        let rpc = RpcClient(url: URL(string: "https://node.example")!, session: StubProver.session(), pause: { waits.add($0) })
        return (rpc, { waits.all })
    }

    final class Waits: @unchecked Sendable {
        private let lock = NSLock()
        private var ms: [UInt64] = []
        func add(_ v: UInt64) { lock.lock(); ms.append(v); lock.unlock() }
        var all: [UInt64] { lock.lock(); defer { lock.unlock() }; return ms }
    }

    private static let busy = StubProver.Reply.http(429, Data("<html>429 Too Many Requests</html>".utf8))

    func testAThrottledReadIsRepeatedAfterAWait() async throws {
        let (rpc, waits) = throttled([Self.busy, Self.busy, .result(["height": 7])])
        let h = try await rpc.headHeight()
        XCTAssertEqual(h, 7)
        XCTAssertEqual(StubProver.requests.count, 3)
        XCTAssertEqual(waits(), [1000, 2000])
    }

    func testTheWaitingIsBounded() async throws {
        let (rpc, waits) = throttled([Self.busy])
        do {
            _ = try await rpc.headHeight()
            XCTFail("an endpoint that only says 429 was waited on for ever")
        } catch let e as RpcClient.RpcError {
            XCTAssertEqual(e.code, 429)
            XCTAssertTrue(e.message.contains("HTTP 429"))
        }
        XCTAssertEqual(StubProver.requests.count, waits().count + 1)
        let total = waits().reduce(0, +)
        XCTAssertTrue((30_000...90_000).contains(total), "\(total) ms")
        XCTAssertLessThanOrEqual(waits().max()!, 8000)
    }

    func testASubmissionIsNeverRepeated() async throws {
        for method in ["rand_sendTransaction", "rand_mint"] {
            let (rpc, waits) = throttled([Self.busy])
            do {
                _ = try await rpc.call(method, ["00"])
                XCTFail("\(method) was retried")
            } catch let e as RpcClient.RpcError {
                XCTAssertEqual(e.code, 429)
            }
            XCTAssertEqual(StubProver.requests.count, 1, method)
            XCTAssertEqual(waits(), [])
        }
    }

    func testAnyOtherStatusIsReportedAtOnce() async throws {
        let (rpc, waits) = throttled([.http(503, Data())])
        do {
            _ = try await rpc.headHeight()
            XCTFail()
        } catch let e as RpcClient.RpcError {
            XCTAssertEqual(e.code, 503)
        }
        XCTAssertEqual(StubProver.requests.count, 1)
        XCTAssertEqual(waits(), [])
    }

    func testAJsonRpcErrorWhoseCodeHappensToBe429IsAnAnswerNotAThrottle() async throws {
        let (rpc, waits) = throttled([.error(429, "an application error", nil)])
        do {
            _ = try await rpc.headHeight()
            XCTFail()
        } catch let e as RpcClient.RpcError {
            XCTAssertEqual(e.message, "an application error")
        }
        XCTAssertEqual(StubProver.requests.count, 1)
        XCTAssertEqual(waits(), [])
    }

    func testRetryAfterIsTakenAtItsWordUpToTheLongestWait() {
        XCTAssertEqual(RpcClient.throttleWaitMs(attempt: 0, retryAfter: "3"), 3000)
        XCTAssertEqual(RpcClient.throttleWaitMs(attempt: 1, retryAfter: "3600"), 8000)
        XCTAssertEqual(RpcClient.throttleWaitMs(attempt: 2, retryAfter: "soon"), 4000)
        XCTAssertEqual(RpcClient.throttleWaitMs(attempt: 2, retryAfter: nil), 4000)
        XCTAssertEqual(RpcClient.throttleWaitMs(attempt: 0, retryAfter: "0"), 1000)
    }
}
