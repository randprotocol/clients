import XCTest
@testable import RandWallet

/// Delegated proving, Phase 1: a pairing link read by the real core, the URL rule, and the prover
/// client and poll loop against a stubbed prover (`StubProver`, a `URLProtocol`).
final class ProverTests: XCTestCase {
    /// The vector `web/wallet/test/core.integration.test.mjs` pins: 1 184 bytes of 0x07 (the
    /// parser checks only the length) fingerprint to `Z254-BQX0-VPMT-8YJR`.
    static let kemEk = String(repeating: "07", count: 1184)
    static let fingerprint = "Z254-BQX0-VPMT-8YJR"
    static let token = String(repeating: "3c", count: 32)

    static func link(url: String = "https://prover.example:8600", own: Bool = true) -> String {
        let q = url.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? url
        return "randprover:\(base58([UInt8](repeating: 7, count: 1184)))?url=\(q)&token=\(token)\(own ? "&own=1" : "")"
    }

    /// Base58 (bitcoin alphabet) in the TEST only: the app never encodes one; the core parses.
    static func base58(_ bytes: [UInt8]) -> String {
        let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")
        var num = bytes
        var out: [Character] = []
        while num.contains(where: { $0 != 0 }) {
            var rem = 0
            var next: [UInt8] = []
            for b in num {
                let acc = rem * 256 + Int(b)
                let q = acc / 58
                rem = acc % 58
                if !next.isEmpty || q != 0 { next.append(UInt8(q)) }
            }
            out.append(alphabet[rem])
            num = next
        }
        for b in bytes { if b != 0 { break }; out.append("1") }
        return String(out.reversed())
    }

    override func tearDown() {
        StubProver.handler = nil
        StubProver.requests = []
        super.tearDown()
    }

    // MARK: the link, through the core

    func testTheCoreParsesAPairingLinkAndFingerprintsItsKey() throws {
        let p = try ProverPairingService.parse(Self.link(url: "http://127.0.0.1:8546"))
        XCTAssertEqual(p.kemEk, Self.kemEk)
        XCTAssertEqual(p.url, "http://127.0.0.1:8546")
        XCTAssertEqual(p.token, Self.token)
        XCTAssertTrue(p.own)
        XCTAssertEqual(p.fingerprint, Self.fingerprint)
        XCTAssertEqual(try ProverPairingService.fingerprint(kemEk: Self.kemEk), Self.fingerprint)
        XCTAssertFalse(try ProverPairingService.parse(Self.link(own: false)).own)
        XCTAssertThrowsError(try ProverPairingService.parse("https://127.0.0.1:8546"))
    }

    func testPreviewHoldsTheURLRuleAndWarnsOnANotOwnLink() throws {
        let seen = try ProverPairingService.preview(Self.link())
        XCTAssertEqual(seen, .init(url: "https://prover.example:8600", fingerprint: Self.fingerprint, own: true, warning: nil))
        XCTAssertEqual(try ProverPairingService.preview(Self.link(own: false)).warning, ProverPairingService.notOwnWarning)
        XCTAssertThrowsError(try ProverPairingService.preview(Self.link(url: "http://192.168.1.5:8600"))) { e in
            XCTAssertEqual(e.localizedDescription, "Use https for a prover — plain http is only allowed for a prover on this machine.")
        }
    }

    func testTheURLRule() {
        XCTAssertEqual(ProverURLRule.check(" https://p.example/ "), .ok("https://p.example"))
        XCTAssertEqual(ProverURLRule.check("http://localhost:8600"), .ok("http://localhost:8600"))
        XCTAssertEqual(ProverURLRule.check("http://127.0.0.1:8600"), .ok("http://127.0.0.1:8600"))
        XCTAssertEqual(ProverURLRule.check("http://[::1]:8600"), .ok("http://[::1]:8600"))
        XCTAssertEqual(ProverURLRule.check("http://10.0.0.2:8600"), .refused("Use https for a prover — plain http is only allowed for a prover on this machine."))
        XCTAssertEqual(ProverURLRule.check("ftp://p.example"), .refused("A prover address must be https://."))
        XCTAssertEqual(ProverURLRule.check(""), .refused("The pairing link has no prover address."))
        XCTAssertEqual(ProverURLRule.check("not a url"), .refused("The pairing link's prover address is not a URL."))
    }

    // MARK: pairing against a stub

    func testPairingChecksTheProversKeyAgainstTheLink() async throws {
        StubProver.handler = { method, _ in
            XCTAssertEqual(method, "prover_info")
            return .result(["kem_ek": Self.kemEk.uppercased(), "kem_fingerprint": "LIES", "witness_kinds": ["spend_key"],
                            "queue": ["depth": 1, "max": 8, "proving": 1]])
        }
        let (pairing, token) = try await ProverPairingService.pair(Self.link(), session: StubProver.session())
        XCTAssertEqual(pairing, ProverPairing(name: "prover.example:8600", url: "https://prover.example:8600",
                                              kemEk: Self.kemEk, fingerprint: Self.fingerprint, own: true))
        XCTAssertEqual(token, Self.token)
        // The token is never on the wire in clear.
        XCTAssertFalse(StubProver.requests.contains { $0.contains(Self.token) })
        let probe = await ProverPairingService.probe(pairing, session: StubProver.session())
        XCTAssertEqual(ProverPairingService.statusLine(probe), "Answering · 1 of 8 in its queue.")

        // A pairing whose fingerprint is not the one the core computes from the key: refused too.
        var forged = pairing
        forged.fingerprint = "0000-0000-0000-0000"
        let forgedProbe = await ProverPairingService.probe(forged, session: StubProver.session())
        XCTAssertEqual(forgedProbe, .unavailable("the prover at that address now has a different key; pair it again"))

        // Another key at the same address: refused, however it names itself.
        StubProver.handler = { _, _ in .result(["kem_ek": String(repeating: "08", count: 1184), "kem_fingerprint": Self.fingerprint]) }
        do {
            _ = try await ProverPairingService.pair(Self.link(), session: StubProver.session())
            XCTFail("paired a prover with another key")
        } catch {
            XCTAssertEqual(error.localizedDescription, "The prover at that address has a different key from the one the link names. Do not pair it.")
        }
        let moved = await ProverPairingService.probe(pairing, session: StubProver.session())
        XCTAssertEqual(ProverPairingService.statusLine(moved), "Not answering: the prover at that address now has a different key; pair it again.")
    }

    // MARK: the client's errors

    func testRefusalsAreWordedAsTheOtherWallets() async throws {
        let client = try ProverClient(url: "https://prover.example", session: StubProver.session())
        StubProver.handler = { _, _ in .error(-32005, "busy", ["depth": 3]) }
        do { _ = try await client.submit("00"); XCTFail() } catch {
            XCTAssertEqual(ProverClient.refusal(error).localizedDescription, "The prover is full (3 waiting). Try again in a few minutes.")
        }
        StubProver.handler = { _, _ in .error(-32003, "unpaired", nil) }
        do { _ = try await client.submit("00"); XCTFail() } catch {
            XCTAssertEqual(ProverClient.refusal(error).localizedDescription, "This prover does not know this pairing. Pair it again in Settings.")
        }
        StubProver.handler = { _, _ in .result(["job": "../etc"]) }
        do { _ = try await client.submit("00"); XCTFail() } catch {
            XCTAssertEqual((error as? ProverError)?.failure, .body)
        }
        StubProver.handler = { _, _ in .http(502, Data("bad gateway".utf8)) }
        do { _ = try await client.info(); XCTFail() } catch {
            XCTAssertEqual((error as? ProverError)?.failure, .http)
        }
    }

    // MARK: the poll loop

    func testAQueuedJobIsPolledThroughATransportFailureToAVerifiedResult() async throws {
        var polls = 0
        StubProver.handler = { method, params in
            switch method {
            case "prover_submit":
                XCTAssertEqual(params as? [String], ["abcd"])
                return .result(["job": "job-1"])
            case "prover_status":
                polls += 1
                switch polls {
                case 1: return .result(["state": "queued", "position": 2])
                case 2: return .transport
                case 3: return .result(["state": "proving"])
                default: return .result(["state": "done", "reply": "beef"])
                }
            default:
                return .error(-32601, "no", nil)
            }
        }
        let client = try ProverClient(url: "https://prover.example", session: StubProver.session())
        let phases = PhaseLog()
        let result = try await RemoteProver(client: client, poll: 0).prove(
            sealedHex: "abcd", pending: ["kind": "transfer"],
            finish: { pending, reply -> String in
                XCTAssertEqual((pending as? [String: String])?["kind"], "transfer")
                return "opened \(reply)"
            },
            onPhase: { await phases.add($0) })
        XCTAssertEqual(result, "opened beef")
        let seen = await phases.all
        XCTAssertEqual(seen, [.proving, .queued(position: 2), .proving])
    }

    func testAReplyTheCoreRefusesNeverComesBackAndAFailedJobIsDefinite() async throws {
        StubProver.handler = { method, _ in
            method == "prover_submit" ? .result(["job": "j"]) : .result(["state": "done", "reply": "00"])
        }
        let client = try ProverClient(url: "https://prover.example", session: StubProver.session())
        do {
            _ = try await RemoteProver(client: client, poll: 0).prove(
                sealedHex: "ab", pending: [:],
                finish: { _, _ -> Int in throw RandCore.CoreError(message: "the proof does not verify") },
                onPhase: { _ in })
            XCTFail()
        } catch {
            XCTAssertEqual(error as? ProverRefusal, ProverRefusal(message: "The prover's proof was refused by this wallet: the proof does not verify"))
        }
        StubProver.handler = { method, _ in
            method == "prover_submit" ? .result(["job": "j"]) : .result(["state": "failed", "error": "out of memory"])
        }
        do {
            _ = try await RemoteProver(client: client, poll: 0).prove(sealedHex: "ab", pending: [:], finish: { _, _ in 0 }, onPhase: { _ in })
            XCTFail()
        } catch {
            XCTAssertEqual(error.localizedDescription, "The prover could not make this proof (failed: out of memory).")
        }
    }

    func testASilentProverIsGivenUpAfterMaxWaitAndTheJobCancelled() async throws {
        StubProver.handler = { method, _ in
            switch method {
            case "prover_submit": return .result(["job": "j"])
            case "prover_cancel": return .result(true)
            default: return .transport
            }
        }
        let client = try ProverClient(url: "https://prover.example", session: StubProver.session())
        let t0 = Date()
        var tick = 0.0
        let prover = RemoteProver(client: client, poll: 0, maxWait: 120, now: { tick += 30; return t0.addingTimeInterval(tick) })
        do {
            _ = try await prover.prove(sealedHex: "ab", pending: [:], finish: { _, _ in 0 }, onPhase: { _ in })
            XCTFail()
        } catch {
            XCTAssertEqual(error.localizedDescription, "Your prover has not answered for 2 minutes, so nothing was sent. Send again.")
        }
        XCTAssertTrue(StubProver.requests.contains { $0.contains("prover_cancel") })
    }
}

actor PhaseLog {
    private(set) var all: [RemoteProofPhase] = []
    func add(_ p: RemoteProofPhase) { all.append(p) }
}

/// A prover on no network: every request is answered by `handler` (method, params).
final class StubProver: URLProtocol {
    enum Reply {
        case result(Any)
        case error(Int, String, [String: Any]?)
        case http(Int, Data)
        case transport
    }

    static var handler: ((String, Any) -> Reply)?
    static var requests: [String] = []

    static func session() -> URLSession {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubProver.self]
        return URLSession(configuration: cfg)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let body = request.httpBody ?? Self.read(request.httpBodyStream)
        Self.requests.append(String(decoding: body, as: UTF8.self))
        let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        let method = obj["method"] as? String ?? ""
        let reply = Self.handler?(method, obj["params"] ?? []) ?? .transport
        let id = obj["id"] ?? 1
        let status: Int
        let data: Data
        switch reply {
        case .transport:
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        case .result(let r):
            status = 200
            data = try! JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": id, "result": r])
        case .error(let code, let message, let extra):
            var e: [String: Any] = ["code": code, "message": message]
            if let extra { e["data"] = extra }
            status = 200
            data = try! JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": id, "error": e])
        case .http(let s, let d):
            status = s
            data = d
        }
        let resp = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    private static func read(_ stream: InputStream?) -> Data {
        guard let stream else { return Data() }
        stream.open()
        defer { stream.close() }
        var out = Data()
        var buf = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buf, maxLength: buf.count)
            if n <= 0 { break }
            out.append(buf, count: n)
        }
        return out
    }
}
