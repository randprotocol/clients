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
        /// Fullnode #118: blocks a bundle's time and anchor stay valid (1024 on chain 20); nil = 256.
        var proofWindowBlocks: Int? = nil
        /// RPL-2 (fullnode v0.6.8): `{cell_fee, max_reads, max_writes, max_payouts}` on a chain
        /// whose genesis carries a `program_state` section; `nil` (`null`, or no key on an older
        /// node) on one without — where every invoke is refused, so the wallet says so first.
        var programState: ProgramState? = nil
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
                           bundleGasLimit: try sizeField("bundle_gas_limit", fromLimits: reply, max: Int.max),
                           proofWindowBlocks: try sizeField("proof_window_blocks", fromLimits: reply, max: 1 << 30),
                           programState: try programState(fromLimits: reply))
    }

    /// `rand_getLimits.program_state`, held to its shape (`validate.js`'s `checkLimits`).
    static func programState(fromLimits reply: Any) throws -> ProgramState? {
        let m = "rand_getLimits"
        guard let obj = reply as? [String: Any] else { throw RpcError(code: 0, message: "\(m): not an object") }
        guard let raw = obj["program_state"], !(raw is NSNull) else { return nil }
        guard let ps = raw as? [String: Any] else { throw RpcError(code: 0, message: "\(m): program_state is not an object") }
        func count(_ name: String) throws -> Int {
            guard let n = ps[name] as? Int, n >= 0, n <= 1024 else {
                throw RpcError(code: 0, message: "\(m): program_state.\(name) is not a count")
            }
            return n
        }
        return ProgramState(cellFee: try units(ps["cell_fee"], "\(m): program_state.cell_fee"),
                            maxReads: try count("max_reads"), maxWrites: try count("max_writes"), maxPayouts: try count("max_payouts"))
    }

    /// A decimal string of base units (at most 30 digits: amounts exceed 2^53), refused otherwise.
    static func units(_ v: Any?, _ what: String) throws -> String {
        guard let s = v as? String, (1...30).contains(s.count), s.allSatisfy({ $0.isASCII && $0.isNumber }) else {
            throw RpcError(code: 0, message: "\(what) is not a decimal amount")
        }
        let trimmed = s.drop { $0 == "0" }
        return trimmed.isEmpty ? "0" : String(trimmed)
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

    /// The chain's proof parameters from ONE `rand_status` (`ui/engine/wallet.js`'s
    /// `proofParamsOf`): its bundle guest (`hc_bundle`), its auth guest (`hc_auth` — split
    /// authorisation, fullnode v0.6.3: a transaction carries an auth proof this device makes from
    /// the spend key beside a bundle proof that needs only the viewing key; `nil` on a chain
    /// without it) and its FRI profile (`"test"` only when the node says so). Absent or `null` is
    /// `nil` (a node that does not report it, or predates `rand_status`, leaves the core on its
    /// defaults); PRESENT but malformed is a node this wallet cannot read, refused up front —
    /// never silently replaced by the default guest, which on a chain that moved guests is a
    /// proof its validators refuse.
    struct ProofParams: Equatable {
        let hcBundle: String?
        let hcAuth: String?
        let profile: String
    }

    func proofParams() async throws -> ProofParams {
        let st: [String: Any]
        do {
            st = try await status()
        } catch let e as RpcError where e.code == -32601 {
            return ProofParams(hcBundle: nil, hcAuth: nil, profile: "production")
        }
        return try Self.proofParams(fromStatus: st)
    }

    static func proofParams(fromStatus st: [String: Any]) throws -> ProofParams {
        ProofParams(hcBundle: try guestDigest("hc_bundle", fromStatus: st),
                    hcAuth: try guestDigest("hc_auth", fromStatus: st),
                    profile: st["fri_profile"] as? String == "test" ? "test" : "production")
    }

    /// A guest digest field of `rand_status`: 64 hex lowercased, `nil` when `null` or absent,
    /// refused otherwise.
    private static func guestDigest(_ field: String, fromStatus st: [String: Any]) throws -> String? {
        guard let raw = st[field], !(raw is NSNull) else { return nil }
        let hc = ((raw as? String) ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        guard hc.count == 64, hc.allSatisfy({ $0.isHexDigit }) else {
            let shown = (raw as? String).map { String($0.prefix(80)) } ?? "\(type(of: raw))"
            throw RpcError(code: 0, message: "rand_status: \(field) is not 64 hex characters (\(shown))")
        }
        return hc
    }

    func chainId() async throws -> UInt64 { try u64(await call("rand_chainId")) }

    func status() async throws -> [String: Any] { try await call("rand_status") as? [String: Any] ?? [:] }

    func headHeight() async throws -> UInt64 {
        let v = try await call("rand_getHead") as? [String: Any]
        return try u64(v?["height"] ?? NSNull())
    }

    /// The chain's genesis hash (64 hex), or nil when the node will not say. A transaction on a
    /// chain after 19 binds it (fullnode BIND-1); a node that lies about it can only make this
    /// wallet's transaction invalid on the real chain, never valid on another.
    func genesisHash() async throws -> String? {
        guard var g = try await call("rand_getGenesisHash") as? String else { return nil }
        if g.hasPrefix("0x") { g.removeFirst(2) }
        return g.count == 64 && g.allSatisfy({ $0.isHexDigit }) ? g.lowercased() : nil
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
        try await bridgeInfo().enabled
    }

    /// `rand_getBridgeState`'s `enabled`, and (v0.6.8 `bridge.fees`) the fee recipient's address —
    /// the wallet whose envelope-less fee notes are rebuilt rather than decrypted.
    func bridgeInfo() async throws -> (enabled: Bool, feeRecipient: String?) {
        let v = try await call("rand_getBridgeState") as? [String: Any]
        let fees = v?["fees"] as? [String: Any]
        return (v?["enabled"] as? Bool ?? false, fees?["recipient"] as? String)
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

    // MARK: RPL-2 program state (fullnode v0.6.8, `docs/rpc.md`)
    //
    // What an invoke reads before it proves anything. None of it is trusted further than its
    // shape (`ui/engine/validate.js`'s checks, the same rules): the core hashes the code and public
    // input against the program id (`dry_run_invoke` refuses a node serving other code), and the
    // cells are re-checked by the chain itself (a stale read is refused there).

    /// `{"enabled": false}`: what every program-state method answers on a chain without the section.
    private static func sectionOff(_ reply: Any) -> Bool {
        (reply as? [String: Any])?["enabled"] as? Bool == false
    }

    private static func word8(_ v: Any?, _ what: String) throws -> String {
        var s = (v as? String ?? "").lowercased()
        if s.hasPrefix("0x") { s.removeFirst(2) }
        guard s.count == 64, s.allSatisfy({ $0.isHexDigit }) else { throw RpcError(code: 0, message: "\(what) is not 64 hex characters") }
        return s
    }

    private static func programId(_ program: String) throws -> String { try word8(program, "the program id") }

    /// One page of `rand_getProgramCells [id, {after, limit}]`: the cells in key order and the key to
    /// pass back as `after` (`nil` on the last page) — or `nil` on a chain without program state.
    func programCells(_ program: String, after: String? = nil, limit: Int = 256) async throws -> (cells: [CellHex], next: String?)? {
        var page: [String: Any] = ["limit": limit]
        if let after { page["after"] = after }
        return try Self.programCells(fromReply: await call("rand_getProgramCells", [try Self.programId(program), page]))
    }

    static func programCells(fromReply reply: Any) throws -> (cells: [CellHex], next: String?)? {
        let m = "rand_getProgramCells"
        if sectionOff(reply) { return nil }
        guard let r = reply as? [String: Any], let rows = r["cells"] as? [Any], rows.count <= 4096 else {
            throw RpcError(code: 0, message: "\(m): not a page of cells")
        }
        let cells = try rows.map { row -> CellHex in
            guard let o = row as? [String: Any] else { throw RpcError(code: 0, message: "\(m): a cell is not an object") }
            return CellHex(key: try word8(o["key"], "\(m): key"), value: try word8(o["value"], "\(m): value"))
        }
        let next = r["next"].flatMap { $0 is NSNull ? nil : $0 }
        return (cells, try next.map { try word8($0, "\(m): next") })
    }

    /// Every cell of `program`, page by page — `nil` on a chain without program state. What the
    /// Swap screen prices from. A cursor that does not move ends the walk rather than loop.
    func allProgramCells(_ program: String) async throws -> [CellHex]? {
        var out: [CellHex] = []
        var after: String? = nil
        for _ in 0..<64 {
            guard let page = try await programCells(program, after: after) else { return nil }
            out += page.cells
            guard let next = page.next, next != after else { break }
            after = next
        }
        return out
    }

    /// `rand_getProgramCell [id, key]`: the cell's value (64 hex; zeros for an absent cell), or
    /// `nil` on a chain without program state. A reply for another key is refused.
    func programCell(_ program: String, key: String) async throws -> String? {
        try Self.programCell(fromReply: await call("rand_getProgramCell", [try Self.programId(program), key]), key: key)
    }

    static func programCell(fromReply reply: Any, key: String) throws -> String? {
        let m = "rand_getProgramCell"
        if sectionOff(reply) { return nil }
        guard let r = reply as? [String: Any] else { throw RpcError(code: 0, message: "\(m): not an object") }
        let got = try word8(r["key"], "\(m): key")
        if got != (try word8(key, "the key asked")) { throw RpcError(code: 0, message: "\(m): the reply is for another key") }
        return try word8(r["value"], "\(m): value")
    }

    /// `rand_getProgramCode [id]`: `{base_pc, words}`, or `nil` for an id no program has.
    func programCode(_ program: String) async throws -> ProgramCode? {
        try Self.programCode(fromReply: await call("rand_getProgramCode", [try Self.programId(program)]))
    }

    static func programCode(fromReply reply: Any) throws -> ProgramCode? {
        let m = "rand_getProgramCode"
        if reply is NSNull { return nil }
        guard let r = reply as? [String: Any], let base = r["base_pc"] as? NSNumber, let raw = r["words"] as? [Any],
              raw.count <= 1 << 20 else {
            throw RpcError(code: 0, message: "\(m): not a program's code")
        }
        let words = try raw.map { w -> UInt32 in
            guard let n = w as? NSNumber, let v = UInt32(exactly: n.uint64Value), n.int64Value >= 0 else {
                throw RpcError(code: 0, message: "\(m): a code word is not a u32")
            }
            return v
        }
        guard let pc = UInt32(exactly: base.uint64Value), base.int64Value >= 0 else { throw RpcError(code: 0, message: "\(m): base_pc is not a u32") }
        return ProgramCode(basePc: pc, words: words)
    }

    /// `rand_getProgramPublic [id]`: the public words as lowercase hex (`""` for none), or `nil`
    /// for no program.
    func programPublic(_ program: String) async throws -> String? {
        try Self.programPublic(fromReply: await call("rand_getProgramPublic", [try Self.programId(program)]))
    }

    static func programPublic(fromReply reply: Any) throws -> String? {
        let m = "rand_getProgramPublic"
        if reply is NSNull { return nil }
        guard var s = reply as? String else { throw RpcError(code: 0, message: "\(m): not a hex string") }
        s = s.lowercased()
        if s.hasPrefix("0x") { s.removeFirst(2) }
        guard s.count % 8 == 0, s.count <= 8 << 20, s.allSatisfy({ $0.isHexDigit }) else {
            throw RpcError(code: 0, message: "\(m): the public input is not whole words of hex")
        }
        return s
    }

    /// `rand_getProgramVault [id]`: `[{asset, amount}]` ascending, or `nil` without the section.
    func programVault(_ program: String) async throws -> [AssetAmount]? {
        try Self.programVault(fromReply: await call("rand_getProgramVault", [try Self.programId(program)]))
    }

    static func programVault(fromReply reply: Any) throws -> [AssetAmount]? {
        let m = "rand_getProgramVault"
        if sectionOff(reply) { return nil }
        guard let rows = reply as? [Any], rows.count <= 4096 else { throw RpcError(code: 0, message: "\(m): not a list") }
        var last: Int64 = -1
        return try rows.map { row in
            guard let o = row as? [String: Any], let a = o["asset"] as? NSNumber, a.int64Value >= 0, a.int64Value <= Int64(UInt32.max) else {
                throw RpcError(code: 0, message: "\(m): a row has no asset index")
            }
            if a.int64Value <= last { throw RpcError(code: 0, message: "\(m): the vault is not in ascending asset order") }
            last = a.int64Value
            return AssetAmount(asset: UInt32(a.int64Value), amount: try units(o["amount"], "\(m): amount"))
        }
    }

    /// `rand_estimateFee [spec]`: the minimum fee in units. For an invoke, `spec` is
    /// `{"kind":"invoke", tier, keccak_log_height, sha256_log_height, created_cells}`, plus `gas` and
    /// `bytes` under a `gas` section.
    func estimateFee(_ spec: [String: Any]) async throws -> String {
        try Self.units(await call("rand_estimateFee", [spec]), "rand_estimateFee: the fee")
    }

    /// `rand_getTokens [from, limit]`, the first page: each listed token's index, symbol and decimals
    /// — what the Swap screen names a pool's token with. A row that does not read is left out.
    func tokens(from: UInt32 = 0, limit: Int = 256) async throws -> [(index: UInt32, symbol: String, decimals: Int)] {
        let r = try await call("rand_getTokens", [from, limit]) as? [String: Any]
        let rows = r?["tokens"] as? [[String: Any]] ?? []
        return rows.compactMap { row in
            guard let i = (row["index"] as? NSNumber)?.uint32Value, i > 0,
                  let d = (row["decimals"] as? NSNumber)?.intValue, (0...9).contains(d) else { return nil }
            let symbol = (row["symbol"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return (i, symbol.isEmpty || symbol.count > 12 ? "#\(i)" : symbol, d)
        }
    }

    private func u64(_ v: Any) throws -> UInt64 {
        if let n = v as? NSNumber { return n.uint64Value }
        if let s = v as? String, let n = UInt64(s) { return n }
        throw RpcError(code: 0, message: "expected an integer")
    }
}
