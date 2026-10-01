import XCTest
@testable import RandWallet

/// Delegated proving, Phases 1 and 2 (split authorisation): a pairing link read by the real core,
/// the URL rule, the route, the checks made before a job is built (the chain's witness kind from
/// the core, `own`, the prover's fee) and the prover client and poll loop against a stubbed prover
/// (`StubProver`, a `URLProtocol`).
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
        StubProver.hosts = []
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

    func testPreviewHoldsTheURLRuleAndNotesANotOwnLink() throws {
        let seen = try ProverPairingService.preview(Self.link())
        XCTAssertEqual(seen, .init(url: "https://prover.example:8600", fingerprint: Self.fingerprint, own: true, note: nil))
        XCTAssertEqual(try ProverPairingService.preview(Self.link(own: false)).note, ProverPairingService.notOwnNote)
        XCTAssertEqual(ProverPairingService.notOwnNote, "Not marked as your own: it can read this wallet's whole history. It cannot spend.")
        // The warning shown before ANY pairing is saved is the core's sentence, word for word.
        XCTAssertEqual(ProverPairingService.warning, "This prover will be able to read this wallet's whole history — every payment received and sent, before and after today. It cannot spend. To keep your history private, run your own.")
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

    // MARK: the trusted prover — the built-in link (`prover.trusted` / `pairTrusted` in the JS)

    static let trustedURL = "https://prover.randprotocol.org"
    static let trustedFingerprint = "RGTF-7HKJ-XZFV-GQ1J"

    /// The core's `version.trusted_prover` as this build ships it — the link included, which only
    /// the test and the service ever read. A framework built from a core before `trusted_prover`
    /// fails here, by name: rebuild `Frameworks/RandWalletCore.xcframework` from this core.
    static func builtIn() throws -> TrustedProver {
        try XCTUnwrap(try RandCore.constants().trustedProver,
                      "this core ships no trusted prover — the XCFramework predates core `trusted_prover`")
    }

    /// A built-in prover the TEST ships, through the service's seam: the synthetic link above
    /// (key 0x07…, fingerprint `Z254-BQX0-VPMT-8YJR`), never own. What `pairTrusted` does with a
    /// built-in link is the same whichever core answered `version`.
    static func syntheticBuiltIn(fingerprint: String = fingerprint, own: Bool = false, name: String = "RandProtocol") -> TrustedProver {
        TrustedProver(name: name, url: "https://prover.example:8600", fingerprint: fingerprint, link: link(own: false), own: own)
    }

    /// A `prover_info` answering with a link's own key: what the live pool answers for its link.
    static func infoFor(link: String) throws -> [String: Any] {
        let parsed = try ProverPairingService.parse(link)
        return ["kem_ek": parsed.kemEk, "kem_fingerprint": parsed.fingerprint, "witness_kinds": ["viewing_key"],
                "fee": NSNull(), "queue": ["depth": 0, "max": 8, "proving": 0]]
    }

    /// The requests that reached `host` (by the host log alone) — never the whole stub log: another test class's RPC stub
    /// (`node.example`, a deposit walk's retry, say) can still be landing in it while these run.
    static func asked(_ host: String) -> [String] {
        StubProver.hosts.filter { $0 == host }
    }

    /// No prover, built-in or synthetic, was asked anything.
    static var noProverAsked: Bool {
        asked("prover.example").isEmpty && asked("prover.randprotocol.org").isEmpty
    }

    /// `pairTrusted` then `save`, as the Settings button does: nothing is stored unless the
    /// pairing came back.
    @MainActor
    private func pairTrustedAndSave(_ settings: Settings, trusted: TrustedProver?? = nil) async throws {
        let (paired, token) = try await ProverPairingService.pairTrusted(session: StubProver.session(), trusted: trusted)
        try ProverPairingService.save(paired, token: token, settings: settings)
    }

    /// Runs `body` with no pairing stored and restores whatever this simulator had afterwards.
    @MainActor
    private func withCleanPairing(_ body: (Settings) async throws -> Void) async throws {
        let settings = Settings()
        let hadDisplay = settings.prover
        let hadSecret = Keychain.loadProverSecret()
        ProverPairingService.forget(settings: settings)
        defer {
            ProverPairingService.forget(settings: settings)
            if let s = hadSecret { try? Keychain.saveProverSecret(s) }
            settings.prover = hadDisplay
        }
        try await body(settings)
    }

    /// Against the REAL core: the prover this build ships the address of is reported — the name,
    /// URL and fingerprint, never the link — and its link names that key, that URL, not own.
    func testTheTrustedProverIsReportedWithoutItsLink() throws {
        let t = try XCTUnwrap(ProverPairingService.trusted(), "this core ships no trusted prover — the XCFramework predates core `trusted_prover`")
        XCTAssertEqual(t, .init(name: "RandProtocol", url: Self.trustedURL, fingerprint: Self.trustedFingerprint))
        let built = try Self.builtIn()
        XCTAssertEqual(built.name, "RandProtocol")
        XCTAssertEqual(built.url, Self.trustedURL)
        XCTAssertEqual(built.fingerprint, Self.trustedFingerprint)
        XCTAssertFalse(built.own)
        let parsed = try ProverPairingService.parse(built.link)
        XCTAssertEqual(parsed.fingerprint, Self.trustedFingerprint)
        XCTAssertEqual(parsed.url, Self.trustedURL)
        XCTAssertFalse(parsed.own)
    }

    /// What a screen gets never carries the link; a build that ships none offers nothing and
    /// pairs nothing, asking nobody.
    func testTrustedHandsNoLinkToScreensAndABuildWithoutOneOffersNothing() async throws {
        let t = try XCTUnwrap(ProverPairingService.trusted(from: Self.syntheticBuiltIn()))
        XCTAssertEqual(t, .init(name: "RandProtocol", url: "https://prover.example:8600", fingerprint: Self.fingerprint))
        XCTAssertEqual(Mirror(reflecting: t).children.map(\.label), ["name", "url", "fingerprint"], "the link (with its token) is not handed to screens")
        XCTAssertEqual(ProverPairingService.trusted(from: Self.syntheticBuiltIn(name: "  "))?.name, "RandProtocol")
        // Asking pairs nothing and asks nobody.
        XCTAssertTrue(Self.noProverAsked)
        XCTAssertNil(ProverPairingService.trusted(from: .some(nil)))
        let blank = TrustedProver(name: "RandProtocol", url: Self.trustedURL, fingerprint: Self.trustedFingerprint, link: "", own: false)
        XCTAssertNil(ProverPairingService.trusted(from: blank))
        for none in [TrustedProver??.some(nil), .some(blank)] {
            do {
                _ = try await ProverPairingService.pairTrusted(session: StubProver.session(), trusted: none)
                XCTFail("paired with no built-in prover")
            } catch {
                XCTAssertEqual(error.localizedDescription, "This build ships no prover to use.")
            }
        }
        XCTAssertTrue(Self.noProverAsked)
    }

    /// One step: the built-in link through the same `pair` — the prover asked for its key, which
    /// must be the link's — stored NOT own and named RandProtocol; `forget` undoes it like any.
    /// Against the REAL core's link and key, as the live pool would answer.
    @MainActor
    func testPairTrustedStoresANotOwnPairingNamedRandProtocolWhenTheProverAnswersWithTheLinksKey() async throws {
        let built = try Self.builtIn()
        let info = try Self.infoFor(link: built.link)
        StubProver.handler = { method, _ in
            XCTAssertEqual(method, "prover_info")
            return .result(info)
        }
        let parsed = try ProverPairingService.parse(built.link)
        try await withCleanPairing { settings in
            try await pairTrustedAndSave(settings)
            XCTAssertEqual(settings.prover, ProverPairing(name: "RandProtocol", url: Self.trustedURL, kemEk: parsed.kemEk,
                                                          fingerprint: Self.trustedFingerprint, own: false))
            let secret = try XCTUnwrap(Keychain.loadProverSecret())
            XCTAssertEqual(secret, ProverSecret(token: parsed.token, kemEk: parsed.kemEk, url: Self.trustedURL,
                                                fingerprint: Self.trustedFingerprint, own: false))
            XCTAssertEqual(Self.asked("prover.randprotocol.org").count, 1, "the pool itself was asked, once")
            XCTAssertFalse(StubProver.requests.contains { $0.contains(parsed.token) }, "the token is never on the wire in clear")
            // Forget works as for any pairing.
            ProverPairingService.forget(settings: settings)
            XCTAssertNil(settings.prover)
            XCTAssertNil(Keychain.loadProverSecret())
        }
    }

    /// The same, through the seam: the record is named after the built-in prover (not its host,
    /// as a pasted link's is) and never own — whatever the `pair` of the plain link would say.
    @MainActor
    func testPairTrustedNamesTheRecordRandProtocolAndNeverOwn() async throws {
        let built = Self.syntheticBuiltIn()
        let info = try Self.infoFor(link: built.link)
        StubProver.handler = { _, _ in .result(info) }
        // The plain pairing of that link is named after its host.
        let plain = try await ProverPairingService.pair(built.link, session: StubProver.session())
        XCTAssertEqual(plain.pairing.name, "prover.example:8600")
        StubProver.requests = []
        StubProver.hosts = []
        try await withCleanPairing { settings in
            try await pairTrustedAndSave(settings, trusted: built)
            XCTAssertEqual(settings.prover, ProverPairing(name: "RandProtocol", url: "https://prover.example:8600", kemEk: Self.kemEk,
                                                          fingerprint: Self.fingerprint, own: false))
            XCTAssertEqual(Keychain.loadProverSecret(), ProverSecret(token: Self.token, kemEk: Self.kemEk, url: "https://prover.example:8600",
                                                                     fingerprint: Self.fingerprint, own: false))
            XCTAssertFalse(StubProver.requests.contains { $0.contains(Self.token) })
        }
    }

    /// A prover at that address answering with another key — however it names itself — is
    /// refused, and nothing is stored.
    @MainActor
    func testPairTrustedRefusesAProverAnsweringWithAnotherKeyAndStoresNothing() async throws {
        StubProver.handler = { _, _ in
            .result(["kem_ek": String(repeating: "08", count: 1184), "kem_fingerprint": Self.fingerprint, "witness_kinds": ["viewing_key"]])
        }
        try await withCleanPairing { settings in
            do {
                try await pairTrustedAndSave(settings, trusted: Self.syntheticBuiltIn())
                XCTFail("paired a prover with another key")
            } catch {
                XCTAssertEqual(error.localizedDescription, "The prover at that address has a different key from the one the link names. Do not pair it.")
            }
            XCTAssertNil(settings.prover)
            XCTAssertNil(Keychain.loadProverSecret())
            XCTAssertEqual(Self.asked("prover.example").count, 1, "the prover the link names was asked, once")
        }
    }

    /// A build whose pinned fingerprint disagrees with its link — or pins none, or whose link is
    /// marked own — never asks the prover at all.
    @MainActor
    func testABuildWhosePinnedFingerprintDisagreesWithTheLinkIsRefusedBeforeAnyRequest() async throws {
        let info = try Self.infoFor(link: Self.link(own: false))
        StubProver.handler = { _, _ in .result(info) }
        try await withCleanPairing { settings in
            for (built, want) in [
                (Self.syntheticBuiltIn(fingerprint: "ZZZZ-ZZZZ-ZZZZ-ZZZZ"), "The built-in prover link does not name the key this wallet pins; not pairing it."),
                (Self.syntheticBuiltIn(fingerprint: ""), "The built-in prover link does not name the key this wallet pins; not pairing it."),
                (Self.syntheticBuiltIn(own: true), "The built-in prover link is marked as your own, which a shared prover is not; not pairing it."),
            ] {
                do {
                    try await pairTrustedAndSave(settings, trusted: built)
                    XCTFail("paired a built-in link the build should refuse (\(built.fingerprint), own \(built.own))")
                } catch {
                    XCTAssertEqual(error.localizedDescription, want)
                }
                XCTAssertTrue(Self.noProverAsked, "the prover was asked")
                XCTAssertNil(settings.prover)
                XCTAssertNil(Keychain.loadProverSecret())
            }
            // And the link's own flag, not only the build's word, is held: a built-in link that
            // itself says `own=1` is refused the same way, before any request.
            let ownLink = TrustedProver(name: "RandProtocol", url: "https://prover.example:8600", fingerprint: Self.fingerprint, link: Self.link(own: true), own: false)
            do {
                try await pairTrustedAndSave(settings, trusted: ownLink)
                XCTFail("paired a built-in link marked own")
            } catch {
                XCTAssertEqual(error.localizedDescription, "The built-in prover link is marked as your own, which a shared prover is not; not pairing it.")
            }
            XCTAssertTrue(Self.noProverAsked)
            // The same key, the right pin, not own: paired — the one path that asks.
            try await pairTrustedAndSave(settings, trusted: Self.syntheticBuiltIn())
            XCTAssertEqual(settings.prover?.name, "RandProtocol")
            XCTAssertEqual(Self.asked("prover.example").count, 1)
        }
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
        // -32006: the prover wanted a fee this job did not pay — definite, in words.
        StubProver.handler = { _, _ in .error(-32006, "fee", ["reason": "fee output missing"]) }
        do { _ = try await client.submit("00"); XCTFail() } catch {
            XCTAssertEqual(ProverClient.refusal(error).localizedDescription, "This prover charges a fee, which this version of the wallet does not pay. Pair a prover that charges nothing, or send from the rand command-line wallet.")
        }
        StubProver.handler = { _, _ in .error(-32004, "witness kind", ["reason": "spend_key not accepted"]) }
        do { _ = try await client.submit("00"); XCTFail() } catch {
            XCTAssertEqual(ProverClient.refusal(error).localizedDescription, "This prover does not accept this kind of job (spend_key not accepted). Pair another prover in Settings, or send from the rand command-line wallet.")
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

    // MARK: fix round 1 — the chain's parameters, the remote params, the route, redirects

    /// A digest shaped like a guest's, for the wire tests; not a guest the core knows.
    static let v2 = String(repeating: "ab", count: 32)
    /// Chain 17's and 18's guests: bundle guest v3 and the auth guest (split authorisation).
    static let v3 = "60af094acfe65d85fdb18fb3d06cf9085dcf28c96e59e87f1ee527226e6e3fce"
    static let auth = "1e4e347f44cf86750b30a9a4bdf9ec9256efe353d4ff8017451eca7d195639c1"

    /// A bundle guest this core knows that is NOT v3 — v1 or v2, whose witness carries the spend
    /// key — from `version.hc_bundles`; the digest is the core's, never a literal here.
    static func oldGuest() throws -> String {
        guard let v = try RandCore.call("version") as? [String: Any], let all = v["hc_bundles"] as? [String],
              let old = all.first(where: { $0 != v3 }) else { throw XCTSkip("the core names no pre-v3 guest") }
        return old
    }

    static func request(hcBundle: String? = nil, hcAuth: String? = nil) -> ProveRequest {
        ProveRequest(spendKey: "5a", chainId: 16, to: "rand1x", amount: "1", fee: "1", anchorHeight: 1, anchorRoot: "00",
                     inputs: [], profile: "test", memo: "", envelopeBytes: nil, hcBundle: hcBundle, hcAuth: hcAuth)
    }

    static func json(_ r: ProveRequest) throws -> [String: Any] {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: JSONEncoder().encode(r)) as? [String: Any])
    }

    func testTheLocalRequestCarriesTheChainsProfileAndGuests() async throws {
        StubProver.handler = { method, _ in
            XCTAssertEqual(method, "rand_status")
            return .result(["height": 5, "fri_profile": "test", "hc_bundle": Self.v3.uppercased(), "hc_auth": " \(Self.auth.uppercased())"])
        }
        let rpc = RpcClient(url: URL(string: "https://node.example")!, session: StubProver.session())
        let p = try await rpc.proofParams()
        XCTAssertEqual(p, .init(hcBundle: Self.v3, hcAuth: Self.auth, profile: "test"))
        let json = try Self.json(Self.request(hcBundle: p.hcBundle, hcAuth: p.hcAuth))
        XCTAssertEqual(json["profile"] as? String, "test")
        XCTAssertEqual(json["hc_bundle"] as? String, Self.v3)
        XCTAssertEqual(json["hc_auth"] as? String, Self.auth)
        // A node that names a bundle guest and `hc_auth: null` (a pre-v3 chain): `hc_auth` is sent
        // as an explicit null — "this chain names no auth guest" is what the core must hear.
        StubProver.handler = { _, _ in .result(["height": 5, "hc_bundle": Self.v2, "hc_auth": NSNull()]) }
        let pre = try await rpc.proofParams()
        XCTAssertEqual(pre, .init(hcBundle: Self.v2, hcAuth: nil, profile: "production"))
        let preJson = try Self.json(Self.request(hcBundle: pre.hcBundle, hcAuth: pre.hcAuth))
        XCTAssertEqual(preJson["hc_bundle"] as? String, Self.v2)
        XCTAssertTrue(preJson["hc_auth"] is NSNull, "hc_auth must be an explicit null beside a known hc_bundle")
        // A node that reports neither: production, and neither key at all (the core's defaults).
        StubProver.handler = { _, _ in .result(["height": 5]) }
        let none = try await rpc.proofParams()
        XCTAssertEqual(none, .init(hcBundle: nil, hcAuth: nil, profile: "production"))
        let bareJson = try Self.json(Self.request())
        XCTAssertNil(bareJson["hc_bundle"])
        XCTAssertNil(bareJson["hc_auth"])
        // Present but malformed — either field — is a node this wallet cannot read, never the default guest.
        StubProver.handler = { _, _ in .result(["height": 5, "hc_bundle": Self.v3, "hc_auth": "not-a-digest"]) }
        do { _ = try await rpc.proofParams(); XCTFail("a malformed hc_auth was accepted") } catch {
            XCTAssertEqual(error.localizedDescription, "rand_status: hc_auth is not 64 hex characters (not-a-digest)")
        }
        StubProver.handler = { _, _ in .result(["height": 5, "hc_bundle": 7]) }
        do { _ = try await rpc.proofParams(); XCTFail("a malformed hc_bundle was accepted") } catch {
            XCTAssertTrue(error.localizedDescription.hasPrefix("rand_status: hc_bundle is not 64 hex characters"))
        }
    }

    /// `hc_auth` reaches the local prove request exactly as `hc_bundle` does: the request
    /// `RandCore.proveTransfer` encodes is what the core's `chain_guests` reads, and the core
    /// answers split authorisation for chain 18's pair.
    func testHcAuthReachesTheLocalProveRequest() throws {
        let json = try Self.json(Self.request(hcBundle: Self.v3, hcAuth: Self.auth))
        XCTAssertEqual(json["hc_auth"] as? String, Self.auth)
        let guests = try RandCore.chainGuests(hcBundle: json["hc_bundle"] as? String, hcAuth: json["hc_auth"] as? String)
        XCTAssertEqual(guests, ChainGuests(hcBundle: Self.v3, hcAuth: Self.auth, splitAuthorisation: true, witnessKind: "viewing_key"))
        // The real core: v3 named WITHOUT its auth guest is refused before anything is proved —
        // the very refusal an omitted `hc_auth` would silence (`prove_transfer` asks the same
        // `chain_guests` first).
        XCTAssertThrowsError(try RandCore.chainGuests(hcBundle: Self.v3, hcAuth: nil))
        // The reply carries the auth proof's size beside the bundle proof's.
        let reply = #"{"tx_hex":"00","hash":"00","time":1,"amount":"1","change":"0","fee":"1","tier":14,"proof_bytes":10,"tx_bytes":12,"# +
            #""nullifiers":[],"commitments":[],"tx_keys":[],"payment_tx_key":null,"spent_indices":[],"auth_proof_bytes":1366827}"#
        XCTAssertEqual(try JSONDecoder().decode(ProveResult.self, from: Data(reply.utf8)).authProofBytes, 1_366_827)
    }

    private static let route = ProverPairingService.Route(
        pairing: ProverPairing(name: "prover.example:8600", url: "https://prover.example:8600", kemEk: kemEk, fingerprint: fingerprint, own: true),
        token: token)
    private static var notOwnRoute: ProverPairingService.Route {
        var p = route.pairing
        p.own = false
        return .init(pairing: p, token: token)
    }

    func testTheRemoteParamsCarryThePairingTheCapAndTheChainsParameters() throws {
        let req = Self.request(hcBundle: Self.v3, hcAuth: Self.auth)
        let p = try RemoteSendParams.build(request: req, route: Self.route, maxProofBytes: 2_000_000)
        let target = p["prover"] as? [String: Any]
        XCTAssertEqual(target?["kem_ek"] as? String, Self.kemEk)
        XCTAssertEqual(target?["token"] as? String, Self.token)
        // Phase 2: the witness kind is the core's decision from the chain's guest, never named here.
        XCTAssertNil(target?["witness_kind"])
        XCTAssertEqual(target?["own"] as? Bool, true)
        XCTAssertTrue(target?["fee"] is NSNull)
        XCTAssertEqual(target?["hc_bundle"] as? String, Self.v3)
        XCTAssertEqual(p["hc_bundle"] as? String, Self.v3)
        XCTAssertEqual(p["hc_auth"] as? String, Self.auth)
        XCTAssertEqual(p["max_proof_bytes"] as? Int, 2_000_000)
        XCTAssertEqual(p["profile"] as? String, "test")
        XCTAssertEqual(p["spend_key"] as? String, "5a")
        let noCap = try RemoteSendParams.build(request: req, route: Self.route, maxProofBytes: nil)
        XCTAssertNil(noCap["max_proof_bytes"])
        // The fee is passed through as the prover answered it — the core reads it, not the shell.
        let quoted = JSONValue(["amount": "0", "address": "rand1x"])
        let withFee = try RemoteSendParams.build(request: req, route: Self.notOwnRoute, maxProofBytes: nil, fee: quoted)
        XCTAssertEqual((withFee["prover"] as? [String: Any])?["own"] as? Bool, false)
        XCTAssertEqual(JSONValue((withFee["prover"] as? [String: Any])?["fee"]), quoted)
    }

    // MARK: Phase 2 — the job checks made before anything is built (`proveHookFor` in the JS)

    private static func info(_ kinds: [String], fee: Any? = nil) throws -> ProverInfo {
        var o: [String: Any] = ["kem_ek": kemEk, "witness_kinds": kinds, "queue": ["depth": 0, "max": 8]]
        if let fee { o["fee"] = fee }
        return try ProverInfo(o)
    }

    /// A split-authorisation chain (chain 18's `hc_bundle` v3 + `hc_auth`): the job is a
    /// viewing-key job, so a pairing NOT marked as the user's own takes it — `own: false` on the
    /// target, no `witness_kind` — and the real core seals it, making the auth proof here first.
    func testAV3ChainSendsAViewingKeyJobToANotOwnPairing() async throws {
        var asked = 0
        let check = try await ProverPairingService.checkJob(route: Self.notOwnRoute, hcBundle: Self.v3, hcAuth: Self.auth,
                                                            info: { asked += 1; return try Self.info(["viewing_key"]) })
        XCTAssertEqual(asked, 1, "the prover is asked once, at the point the job is built")
        XCTAssertEqual(check.guests.witnessKind, "viewing_key")
        XCTAssertTrue(check.guests.splitAuthorisation, "the auth proof is made on this device first")
        XCTAssertEqual(check.fee, .null)

        var fixture = try XCTUnwrap(try RandCore.call("fixture_prove_request", ["profile": "test"]) as? [String: Any])
        fixture["hc_bundle"] = Self.v3
        fixture["hc_auth"] = Self.auth
        let spendKey = try XCTUnwrap(fixture["spend_key"] as? String)
        let params = RemoteSendParams.build(requestJSON: fixture, route: Self.notOwnRoute, maxProofBytes: nil, fee: check.fee)
        let target = try XCTUnwrap(params["prover"] as? [String: Any])
        XCTAssertEqual(target["own"] as? Bool, false)
        XCTAssertNil(target["witness_kind"])
        // The real core: a viewing-key job for a prover that is not the owner's own, accepted.
        let prepared = try RandCore.prepareTransfer(params)
        let pending = try XCTUnwrap(prepared.pending as? [String: Any])
        XCTAssertEqual(pending["witness_kind"] as? String, "viewing_key")
        XCTAssertEqual(pending["hc_bundle"] as? String, Self.v3)
        let txHex = try XCTUnwrap(pending["tx_hex"] as? String)
        XCTAssertGreaterThan(txHex.count, 100_000, "the pending transaction carries its auth proof")
        XCTAssertFalse(txHex.contains(spendKey))
        XCTAssertFalse(prepared.sealedHex.contains(spendKey))
    }

    /// An older chain (a v1/v2 bundle guest, `hc_auth` null): the job would carry the spend key,
    /// which goes only to a prover paired as the user's own — refused before the prover is asked
    /// and before `prepare_*` (and the core refuses it too, `NOT_OWN`).
    func testAnOldChainRefusesANotOwnPairingBeforeTheJobIsBuilt() async throws {
        let old = try Self.oldGuest()
        XCTAssertEqual(try RandCore.chainGuests(hcBundle: old, hcAuth: nil).witnessKind, "spend_key")
        var asked = 0
        do {
            _ = try await ProverPairingService.checkJob(route: Self.notOwnRoute, hcBundle: old, hcAuth: nil,
                                                        info: { asked += 1; return try Self.info(["viewing_key", "spend_key"]) })
            XCTFail("a spend-key job was allowed to a pairing not marked own")
        } catch {
            XCTAssertEqual(error as? ProverRefusal, ProverRefusal(message: "On this chain a proof needs the spend key, which goes only to a prover paired as your own. Pair your own prover in Settings, or send from the rand command-line wallet."))
        }
        XCTAssertEqual(asked, 0, "refused before the prover was asked")
        // The core says the same of the job itself, whatever the shell forgot to check.
        var fixture = try XCTUnwrap(try RandCore.call("fixture_prove_request", ["profile": "test"]) as? [String: Any])
        fixture["hc_bundle"] = old
        fixture["hc_auth"] = NSNull()
        XCTAssertThrowsError(try RandCore.prepareTransfer(RemoteSendParams.build(requestJSON: fixture, route: Self.notOwnRoute, maxProofBytes: nil)))
        // The same chain with a pairing marked own: the job is a spend-key one and goes.
        let own = try await ProverPairingService.checkJob(route: Self.route, hcBundle: old, hcAuth: nil,
                                                          info: { try Self.info(["viewing_key", "spend_key"]) })
        XCTAssertEqual(own.guests.witnessKind, "spend_key")
        XCTAssertFalse(own.guests.splitAuthorisation)
        // A prover too old for a viewing-key job, on a v3 chain, is refused in those words.
        do {
            _ = try await ProverPairingService.checkJob(route: Self.route, hcBundle: Self.v3, hcAuth: Self.auth, info: { try Self.info(["spend_key"]) })
            XCTFail()
        } catch {
            XCTAssertEqual(error.localizedDescription, "Your prover does not take viewing-key jobs (it is older than this chain). Update it, or pair another.")
        }
        // A prover that moved to another key since pairing is refused here too.
        do {
            _ = try await ProverPairingService.checkJob(route: Self.route, hcBundle: Self.v3, hcAuth: Self.auth,
                                                        info: { try ProverInfo(["kem_ek": String(repeating: "08", count: 1184), "witness_kinds": ["viewing_key"]]) })
            XCTFail()
        } catch {
            XCTAssertEqual(error.localizedDescription, "The prover at that address now has a different key. Pair it again in Settings.")
        }
    }

    /// This build pays no prover fee: a prover quoting one is refused at the route (so the review
    /// step says so) and again at the job (its fee is its own to change), before the auth proof
    /// is made. A fee of zero is no fee.
    func testAProverQuotingAFeeIsRefused() async throws {
        let quote: [String: Any] = ["amount": "1000000", "address": "rand1x"]
        do {
            _ = try await ProverPairingService.checkJob(route: Self.notOwnRoute, hcBundle: Self.v3, hcAuth: Self.auth,
                                                        info: { try Self.info(["viewing_key"], fee: quote) })
            XCTFail("a fee-charging prover was handed a job")
        } catch {
            XCTAssertEqual(error.localizedDescription, "This prover charges a fee, which this version of the wallet does not pay (it charges a fee of 0.001 RAND per proof, which this version of the wallet does not pay). Pair a prover that charges nothing, or send from the rand command-line wallet.")
        }
        XCTAssertNil(ProverPairingService.feeRefusal(.null))
        XCTAssertNil(ProverPairingService.feeRefusal(JSONValue(["amount": "0", "address": "rand1x"])))
        XCTAssertEqual(ProverPairingService.feeRefusal(JSONValue(["amount": "not a number"])), "it charges a fee per proof, which this version of the wallet does not pay")
        let free = try await ProverPairingService.checkJob(route: Self.notOwnRoute, hcBundle: Self.v3, hcAuth: Self.auth,
                                                           info: { try Self.info(["viewing_key"], fee: ["amount": "0", "address": "rand1x"]) })
        XCTAssertEqual(free.fee, JSONValue(["amount": "0", "address": "rand1x"]), "a zero fee is passed through as answered")
        do {
            _ = try await ProverPairingService.route(deviceCanProve: false, pairing: Self.route.pairing,
                                                     probe: { _ in .ok(try! Self.info(["viewing_key"], fee: quote)) }, secret: { Self.secret })
            XCTFail()
        } catch {
            XCTAssertEqual(error.localizedDescription, "This device does not have the memory for this proof. Your paired prover is not available: it charges a fee of 0.001 RAND per proof, which this version of the wallet does not pay.")
        }
    }

    /// The real core seals a real transfer to the pairing's key (the default chain's: v3, so the
    /// auth proof is made here and the job carries the viewing key); what reaches the prover's
    /// wire is the sealed job and job ids — never the spend key, never the token.
    func testTheSpendKeyAndTokenNeverReachTheProversWire() async throws {
        guard var fixture = try RandCore.call("fixture_prove_request", ["profile": "test"]) as? [String: Any],
              let spendKey = fixture["spend_key"] as? String else { return XCTFail("no fixture") }
        fixture.removeValue(forKey: "hc_bundle")
        fixture.removeValue(forKey: "hc_auth")
        let params = RemoteSendParams.build(requestJSON: fixture, route: Self.route, maxProofBytes: nil)
        let prepared = try RandCore.prepareTransfer(params)
        StubProver.handler = { method, _ in
            method == "prover_submit" ? .result(["job": "job-1"]) : .result(["state": "failed", "error": "stub"])
        }
        let client = try ProverClient(url: Self.route.pairing.url, session: StubProver.session())
        do {
            _ = try await RemoteProver(client: client, poll: 0).prove(
                sealedHex: prepared.sealedHex, pending: prepared.pending, finish: { _, _ in 0 }, onPhase: { _ in })
            XCTFail("the stub fails the job")
        } catch {
            XCTAssertEqual(error.localizedDescription, "The prover could not make this proof (failed: stub).")
        }
        XCTAssertEqual(StubProver.requests.count, 2)
        XCTAssertTrue(StubProver.requests[0].contains(prepared.sealedHex))
        for body in StubProver.requests {
            XCTAssertFalse(body.contains(spendKey), "the spend key went on the wire")
            XCTAssertFalse(body.contains(Self.token), "the token went on the wire")
        }
        let pendingText = String(decoding: try JSONSerialization.data(withJSONObject: prepared.pending), as: UTF8.self)
        XCTAssertFalse(pendingText.contains(spendKey), "pending carries no spend key")
    }

    static let secret = ProverSecret(token: token, kemEk: kemEk, url: "https://prover.example:8600", fingerprint: fingerprint, own: true)
    static let notOwnSecret = ProverSecret(token: token, kemEk: kemEk, url: "https://prover.example:8600", fingerprint: fingerprint, own: false)

    /// The route: the device first; then the paired prover, own or not, answering and taking a job
    /// this wallet can send it (a viewing-key job, or a spend-key one for a pairing marked own).
    func testTheRouteTakesAnyPairedProverThatTakesThisWalletsJobs() async throws {
        let own = Self.route.pairing
        var probed = 0
        let okProbe: (ProverPairing) async -> ProverPairingService.Probe = { _ in probed += 1; return .ok(try! Self.info(["viewing_key", "spend_key"])) }

        let device = try await ProverPairingService.route(deviceCanProve: true, pairing: own, probe: okProbe, secret: { Self.secret })
        XCTAssertNil(device)
        XCTAssertEqual(probed, 0, "a device that can prove asks nobody")
        let none = try await ProverPairingService.route(deviceCanProve: false, pairing: nil, probe: okProbe, secret: { Self.secret })
        XCTAssertNil(none)
        XCTAssertEqual(probed, 0)

        // Phase 2: a pairing NOT marked own routes — viewing-key jobs are what a v3 chain sends.
        let notMine = try await ProverPairingService.route(deviceCanProve: false, pairing: own,
                                                           probe: { _ in .ok(try! Self.info(["viewing_key"])) }, secret: { Self.notOwnSecret })
        XCTAssertEqual(notMine?.pairing.own, false, "own comes from the Keychain record, not Settings")
        XCTAssertEqual(notMine?.token, Self.token)
        // A pairing marked own routes on a prover that takes only spend-key jobs (an older prover).
        let mine = try await ProverPairingService.route(deviceCanProve: false, pairing: own,
                                                        probe: { _ in .ok(try! Self.info(["spend_key"])) }, secret: { Self.secret })
        XCTAssertEqual(mine?.pairing.own, true)
        // A pairing not marked own on such a prover has no job this wallet could send it.
        do {
            _ = try await ProverPairingService.route(deviceCanProve: false, pairing: own,
                                                     probe: { _ in .ok(try! Self.info(["spend_key"])) }, secret: { Self.notOwnSecret })
            XCTFail()
        } catch {
            XCTAssertEqual(error as? ProverRefusal, ProverRefusal(message: "This device does not have the memory for this proof. Your paired prover is not available: it does not take this wallet's jobs."))
        }
        do {
            _ = try await ProverPairingService.route(deviceCanProve: false, pairing: own,
                                                     probe: { _ in .unavailable("the prover at x did not answer (down)") }, secret: { Self.secret })
            XCTFail()
        } catch {
            XCTAssertEqual(error.localizedDescription, "This device does not have the memory for this proof. Your paired prover is not available: the prover at x did not answer (down).")
        }
        do {
            _ = try await ProverPairingService.route(deviceCanProve: false, pairing: own, probe: okProbe, secret: { nil })
            XCTFail()
        } catch {
            XCTAssertEqual(error.localizedDescription, "Your prover's pairing could not be opened. Pair the prover again in Settings.")
        }
        let remote = try await ProverPairingService.route(deviceCanProve: false, pairing: own, probe: okProbe, secret: { Self.secret })
        XCTAssertEqual(remote?.pairing, own)
        XCTAssertEqual(remote?.token, Self.token)
    }

    // MARK: final review — the Keychain record decides the seal target

    /// `Settings.prover` is plaintext (UserDefaults): anything that can write it could name another
    /// key and URL. The route, the probe and the sealed job's target all come from the Keychain
    /// record instead; only the name and `own` are read from Settings.
    func testATamperedSettingsKemEkDoesNotMoveTheSealTargetNorOwnTheGate() async throws {
        var tampered = Self.route.pairing
        tampered.kemEk = String(repeating: "66", count: 1184)
        tampered.url = "https://evil.example"
        tampered.fingerprint = "EVIL-EVIL-EVIL-EVIL"
        tampered.own = true // the record says false: a tampered copy cannot promote a pairing
        var probedAt: ProverPairing?
        let route = try await ProverPairingService.route(
            deviceCanProve: false, pairing: tampered,
            probe: { probedAt = $0; return .ok(try! Self.info(["viewing_key", "spend_key"])) },
            secret: { Self.notOwnSecret })
        XCTAssertEqual(probedAt?.url, Self.secret.url, "the probe asked the tampered URL")
        XCTAssertEqual(probedAt?.kemEk, Self.kemEk)
        XCTAssertEqual(route?.pairing.kemEk, Self.kemEk, "the route took the tampered key")
        XCTAssertEqual(route?.pairing.url, Self.secret.url)
        XCTAssertEqual(route?.pairing.own, false, "the route took Settings' own")
        XCTAssertEqual(route?.pairing.name, tampered.name, "the display name is still Settings'")
        let params = try RemoteSendParams.build(request: Self.request(), route: try XCTUnwrap(route), maxProofBytes: nil)
        XCTAssertEqual((params["prover"] as? [String: Any])?["kem_ek"] as? String, Self.kemEk, "the job was sealed to the tampered key")
        XCTAssertEqual((params["prover"] as? [String: Any])?["own"] as? Bool, false)
        // And on an old chain the promoted copy still gets no spend-key job.
        let old = try Self.oldGuest()
        do {
            _ = try await ProverPairingService.checkJob(route: try XCTUnwrap(route), hcBundle: old, hcAuth: nil, info: { try Self.info(["spend_key"]) })
            XCTFail("a tampered own let a spend-key job out")
        } catch {
            XCTAssertTrue(error.localizedDescription.hasPrefix("On this chain a proof needs the spend key"))
        }
    }

    func testTheKeychainRecordRoundTripsAndABareTokenIsNoPairing() throws {
        let json = String(decoding: try JSONEncoder().encode(Self.secret), as: UTF8.self)
        XCTAssertEqual(ProverSecret.decode(json), Self.secret)
        XCTAssertEqual(ProverSecret.decode(json)?.own, true)
        XCTAssertNil(ProverSecret.decode(Self.token), "a pre-release bare token names no seal target")
        XCTAssertNil(ProverSecret.decode(#"{"token":"","kemEk":"a","url":"b","fingerprint":"c"}"#))
        // A record stored before `own` was kept (Phase 1) reads false: viewing-key jobs only.
        let phase1 = ProverSecret.decode(#"{"token":"t","kemEk":"a","url":"b","fingerprint":"c"}"#)
        XCTAssertEqual(phase1, ProverSecret(token: "t", kemEk: "a", url: "b", fingerprint: "c", own: false))
        XCTAssertEqual(phase1?.own, false)
    }

    func testARedirectIsNotFollowed() async throws {
        StubProver.handler = { _, _ in .redirect("https://elsewhere.example/steal") }
        let client = try ProverClient(url: "https://prover.example", session: StubProver.session())
        do {
            _ = try await client.info()
            XCTFail("a redirect was followed to an answer")
        } catch {
            XCTAssertEqual((error as? ProverError)?.failure, .http)
        }
        XCTAssertFalse(StubProver.hosts.contains("elsewhere.example"), "the POST was carried to another host")
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
        case redirect(String)
        case transport
    }

    static var handler: ((String, Any) -> Reply)?
    static var requests: [String] = []
    static var hosts: [String] = []

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
        Self.hosts.append(request.url?.host ?? "")
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
        case .redirect(let to):
            let resp = HTTPURLResponse(url: request.url!, statusCode: 307, httpVersion: "HTTP/1.1", headerFields: ["Location": to])!
            var next = request
            next.url = URL(string: to)
            client?.urlProtocol(self, wasRedirectedTo: next, redirectResponse: resp)
            client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data())
            client?.urlProtocolDidFinishLoading(self)
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
