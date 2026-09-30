import Foundation

/// JSON-RPC 2.0 over HTTP to a `rand-node` (`docs/rpc.md` in the fullnode). One request per
/// POST; the node supports no batches.
final class RpcClient {
    struct RpcError: LocalizedError {
        let code: Int
        let message: String
        /// The reply was an HTTP status, not a JSON-RPC answer; `code` is that status.
        var isHTTP = false
        /// The `Retry-After` header an HTTP refusal carried, if any.
        var retryAfter: String?
        var errorDescription: String? { message }
    }

    let url: URL
    private let session: URLSession
    private let pause: (UInt64) async throws -> Void

    /// HTTP 429 is "ask again later": a read is repeated after a wait, on the same node. A first
    /// scan is several hundred reads, and the public endpoint allows a burst of about a hundred
    /// and then about one a second — reported as a failure, the first 429 ended the scan and the
    /// next scan met the same wall. The waits double from one second to eight and stop after about
    /// three quarters of a minute; a `Retry-After` in seconds is taken at its word up to the
    /// longest wait. The same rule as `ui/engine/rpc.js`'s `THROTTLE_WAITS_MS`.
    static let throttleWaitsMs: [UInt64] = [1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000]
    private static let throttleMaxWaitMs: UInt64 = 8000
    /// The two methods that change the chain are never repeated: a 429 on the faucet is its answer
    /// about this wallet's allowance, and one on a send is for the person sending to see at once.
    private static let submits: Set<String> = ["rand_sendTransaction", "rand_mint"]

    /// `pause` is the wait between two attempts, in milliseconds; the tests pass one that records
    /// it instead of sleeping.
    init(url: URL, session: URLSession? = nil, pause: ((UInt64) async throws -> Void)? = nil) {
        self.url = url
        self.pause = pause ?? { ms in try await Task.sleep(nanoseconds: ms * 1_000_000) }
        if let session { self.session = session; return }
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 120
        self.session = URLSession(configuration: cfg)
    }

    func call(_ method: String, _ params: [Any] = []) async throws -> Any {
        var attempt = 0
        while true {
            do {
                return try await callOnce(method, params)
            } catch let e as RpcError {
                guard e.code == 429, e.isHTTP, !Self.submits.contains(method), attempt < Self.throttleWaitsMs.count else { throw e }
                try await pause(Self.throttleWaitMs(attempt: attempt, retryAfter: e.retryAfter))
                attempt += 1
            }
        }
    }

    /// How long to wait before repeating a throttled read: the header's seconds, else the schedule.
    static func throttleWaitMs(attempt: Int, retryAfter: String?) -> UInt64 {
        if let text = retryAfter?.trimmingCharacters(in: .whitespaces), let seconds = UInt64(text), seconds > 0 {
            return seconds > throttleMaxWaitMs / 1000 ? throttleMaxWaitMs : seconds * 1000
        }
        return throttleWaitsMs[attempt]
    }

    /// One POST. The only place bytes leave.
    private func callOnce(_ method: String, _ params: [Any]) async throws -> Any {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": 1, "method": method, "params": params])
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let http = response as? HTTPURLResponse
            throw RpcError(code: http?.statusCode ?? 0, message: "node answered HTTP \(http?.statusCode ?? 0)",
                           isHTTP: true, retryAfter: http?.value(forHTTPHeaderField: "Retry-After"))
        }
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw RpcError(code: 0, message: "node reply is not JSON")
        }
        if let err = obj["error"] as? [String: Any] {
            throw RpcError(code: err["code"] as? Int ?? 0, message: err["message"] as? String ?? "rpc error")
        }
        return obj["result"] ?? NSNull()
    }

    // MARK: typed reads

    /// The three `rand_getLimits` fields a send needs (`ui/engine/wallet.js`'s `chainLimitsOf`):
    /// `envelopeBytes` (spec 2026-09-26 §2.4; `nil` is the legacy envelope and no memo),
    /// `maxProofBytes` (the proof cap a remote prover's proof is held to; `nil` is the core's
    /// own vendored cap, never "unbounded") and `bundleGasLimit` (chain 18, constraint set 8: the
    /// gas every bundle proof must declare on a chain with a `gas` section; `nil` is a chain
    /// without one). Each `nil` where the field is `null` or absent; all three `nil` on a node
    /// that predates the method (`-32601`). Any other failure propagates: a node that did not
    /// answer is not a node that said "no memo".
    struct ChainLimits: Equatable {
        let envelopeBytes: Int?
        let maxProofBytes: Int?
        let bundleGasLimit: Int?
        static let none = ChainLimits(envelopeBytes: nil, maxProofBytes: nil, bundleGasLimit: nil)
    }

    func limits() async throws -> ChainLimits {
        let reply: Any
        do {
            reply = try await call("rand_getLimits")
        } catch let e as RpcError where e.code == -32601 {
            return .none
        }
        return try Self.limits(fromLimits: reply)
    }

    static func limits(fromLimits reply: Any) throws -> ChainLimits {
        guard reply is [String: Any] else { throw RpcError(code: 0, message: "rand_getLimits: not an object") }
        return ChainLimits(envelopeBytes: try envelopeBytes(fromLimits: reply),
                           maxProofBytes: try sizeField("max_proof_bytes", fromLimits: reply, max: 1 << 30),
                           bundleGasLimit: try sizeField("bundle_gas_limit", fromLimits: reply, max: Int.max))
    }

    /// The chain's `envelope_bytes` alone (see `limits`).
    func envelopeBytes() async throws -> Int? { try await limits().envelopeBytes }

    static func envelopeBytes(fromLimits reply: Any) throws -> Int? {
        try sizeField("envelope_bytes", fromLimits: reply, max: 1 << 20)
    }

    /// The chain's proof-size cap alone (see `limits`).
    func maxProofBytes() async throws -> Int? { try await limits().maxProofBytes }

    /// A positive integer field of `rand_getLimits`, `nil` when `null` or absent, refused otherwise.
    private static func sizeField(_ name: String, fromLimits reply: Any, max: Int) throws -> Int? {
        guard let obj = reply as? [String: Any] else {
            throw RpcError(code: 0, message: "rand_getLimits: not an object")
        }
        guard let v = obj[name], !(v is NSNull) else { return nil }
        guard let n = v as? Int, n > 0, n <= max else {
            throw RpcError(code: 0, message: "rand_getLimits: \(name) is not a positive size")
        }
        return n
    }

    /// The chain's proof parameters from `rand_status`: its bundle guest (`hc_bundle`, 64 hex, or
    /// `nil` for this build's default) and its FRI profile (`"test"` only when the node says so).
    func proofParams() async throws -> (hcBundle: String?, profile: String) {
        let st: [String: Any]
        do {
            st = try await status()
        } catch let e as RpcError where e.code == -32601 {
            return (nil, "production")
        }
        let hc = (st["hc_bundle"] as? String ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        let valid = hc.count == 64 && hc.allSatisfy { $0.isHexDigit }
        return (valid ? hc : nil, st["fri_profile"] as? String == "test" ? "test" : "production")
    }

    func chainId() async throws -> UInt64 { try u64(await call("rand_chainId")) }

    func status() async throws -> [String: Any] { try await call("rand_status") as? [String: Any] ?? [:] }

    func headHeight() async throws -> UInt64 {
        let v = try await call("rand_getHead") as? [String: Any]
        return try u64(v?["height"] ?? NSNull())
    }

    func treeInfo() async throws -> (nextIndex: UInt64, root: String) {
        let v = try await call("rand_getTreeInfo") as? [String: Any] ?? [:]
        return (try u64(v["next_index"] ?? NSNull()), v["root"] as? String ?? "")
    }

    /// Raw rows of `rand_getCommitments`, handed to the core unchanged.
    func commitments(from: UInt64, limit: Int) async throws -> [[String: Any]] {
        try await call("rand_getCommitments", [from, limit]) as? [[String: Any]] ?? []
    }

    func nullifiers(fromHeight: UInt64, limit: Int) async throws -> [(height: UInt64, nullifier: String)] {
        let rows = try await call("rand_getNullifiers", [fromHeight, limit]) as? [[String: Any]] ?? []
        return try rows.map { (try u64($0["height"] ?? NSNull()), $0["nullifier"] as? String ?? "") }
    }

    func anchor() async throws -> (height: UInt64, root: String) {
        let v = try await call("rand_getAnchor") as? [String: Any] ?? [:]
        return (try u64(v["height"] ?? NSNull()), v["root"] as? String ?? "")
    }

    func witness(index: UInt64) async throws -> (root: String, path: [String]) {
        let v = try await call("rand_getWitness", [index])
        guard let d = v as? [String: Any], let path = d["path"] as? [String], let root = d["root"] as? String else {
            throw RpcError(code: -32001, message: "no leaf at index \(index)")
        }
        return (root, path)
    }

    func sendTransaction(hex: String) async throws -> String {
        guard let h = try await call("rand_sendTransaction", [hex]) as? String else {
            throw RpcError(code: 0, message: "node returned no transaction hash")
        }
        return h
    }

    /// `nil` until committed; otherwise the block height.
    func transactionHeight(hash: String) async throws -> UInt64? {
        let v = try await call("rand_getTransaction", [hash])
        guard let d = v as? [String: Any] else { return nil }
        return try? u64(d["height"] ?? NSNull())
    }

    func mint(to address: String) async throws -> String {
        guard let h = try await call("rand_mint", [address]) as? String else {
            throw RpcError(code: 0, message: "faucet returned no transaction hash")
        }
        return h
    }

    func bridgeEnabled() async throws -> Bool {
        (try await call("rand_getBridgeState") as? [String: Any])?["enabled"] as? Bool ?? false
    }

    /// `rand_getBlocks(from, to)`: the headers of that range, at most 1024 a call and never past
    /// the node's tip, each with a `tx_count` — raw, for `DepositWalk` to check against the range
    /// it asked for.
    func blockHeaders(from: UInt64, to: UInt64) async throws -> Any {
        try await call("rand_getBlocks", [from, to])
    }

    func blockActions(height: UInt64) async throws -> [Any] {
        let b = try await call("rand_getBlockByHeight", [height]) as? [String: Any]
        let txs = b?["transactions"] as? [[String: Any]] ?? []
        return txs.compactMap { $0["action"] }
    }

    private func u64(_ v: Any) throws -> UInt64 {
        if let n = v as? NSNumber { return n.uint64Value }
        if let s = v as? String, let n = UInt64(s) { return n }
        throw RpcError(code: 0, message: "expected an integer")
    }
}
