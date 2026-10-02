import Foundation

// Delegated proving, Phases 1 and 2 (spec docs/superpowers/specs/2026-09-28-delegated-proving-design.md
// §4–§5, split authorisation): the wallet's side of a paired `rand-prover`, the Swift twin of
// `ui/engine/prover.js`. Nothing here is chain crypto: the core parses the pairing link,
// fingerprints the prover's key, decides what witness the chain's guest takes (`chain_guests`),
// makes the auth proof on this device and seals the job (`prepare_transfer`), and opens and
// verifies the reply (`finish_proof`). On a split-authorisation chain (bundle guest v3: every chain
// since 17) the job carries the viewing key and a salt, never the spend key — the prover can read
// this wallet's whole history and cannot spend. This file is the URL rule, the four JSON-RPC
// methods, their errors in the user's words, and the poll loop.

/// The rule a prover's address is held to — the node's, and `ui/lib/url-rule.js`'s: https to any
/// host, plain http only to this machine. A sealed job is opaque to a network, but its status and
/// its reply are not something a network should be able to see or rewrite.
enum ProverURLRule {
    enum Verdict: Equatable { case ok(String), refused(String) }

    static func check(_ text: String) -> Verdict {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.hasSuffix("/") { value.removeLast() }
        if value.isEmpty { return .refused(String(localized: "The pairing link has no prover address.")) }
        guard let c = URLComponents(string: value), let scheme = c.scheme?.lowercased() else {
            return .refused(String(localized: "The pairing link's prover address is not a URL."))
        }
        let host = (c.host ?? "").lowercased()
        let local = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
        if (scheme == "https" || scheme == "http") && host.isEmpty {
            return .refused(String(localized: "The pairing link's prover address is not a URL."))
        }
        if scheme == "https" { return .ok(value) }
        if scheme == "http" && local { return .ok(value) }
        if scheme == "http" { return .refused(String(localized: "Use https for a prover — plain http is only allowed for a prover on this machine.")) }
        return .refused(String(localized: "A prover address must be https://."))
    }
}

/// A prover's refusal or silence. `failure` is set only where no JSON-RPC reply existed at all.
struct ProverError: LocalizedError {
    enum Failure: String { case connect, timeout, http, body }
    let message: String
    var code: Int?
    var data: [String: Any]?
    var failure: Failure?
    var errorDescription: String? { message }
}

/// A definite failure of a send: nothing reached the node. The message is shown verbatim.
struct ProverRefusal: LocalizedError, Equatable {
    let message: String
    /// The prover answered busy (-32005): its queue is full. Said plainly, never retried in a loop.
    var busy = false
    var errorDescription: String? { message }
    /// Two refusals are the same when they say the same thing.
    static func == (a: ProverRefusal, b: ProverRefusal) -> Bool { a.message == b.message }
}

/// A JSON value held verbatim (Foundation's `JSONSerialization` objects; `NSNull` for `null`),
/// comparable: `prover_info.fee`, which is handed to the core exactly as the prover answered.
struct JSONValue: Equatable {
    let value: Any
    init(_ v: Any?) { value = v ?? NSNull() }
    static let null = JSONValue(nil)
    var isNull: Bool { value is NSNull }
    static func == (a: JSONValue, b: JSONValue) -> Bool { (a.value as AnyObject).isEqual(b.value as AnyObject) }
}

/// `prover_info`, checked just enough to use (`readInfo` in the JS).
struct ProverInfo: Equatable {
    var kemEk: String
    var kemFingerprint: String
    /// `"viewing_key"` and/or `"spend_key"`: what jobs this prover takes.
    var witnessKinds: [String]
    var depth: Int
    var max: Int
    var proving: Int
    /// The prover's fee as it answered: `null` (charges nothing) or `{amount, address}`. Passed to
    /// the core verbatim; this build pays none, so any non-zero fee refuses the job.
    var fee: JSONValue

    init(_ value: Any) throws {
        guard let o = value as? [String: Any] else {
            throw ProverError(message: String(localized: "the prover's info is not an object"), failure: .body)
        }
        func num(_ v: Any?) -> Int { (v as? NSNumber).map { Swift.max(0, $0.intValue) } ?? 0 }
        let q = o["queue"] as? [String: Any] ?? [:]
        kemEk = (o["kem_ek"] as? String ?? "").lowercased()
        kemFingerprint = o["kem_fingerprint"] as? String ?? ""
        witnessKinds = (o["witness_kinds"] as? [Any] ?? []).compactMap { $0 as? String }
        depth = num(q["depth"])
        max = num(q["max"])
        proving = num(q["proving"])
        fee = JSONValue(o["fee"])
    }
}

/// A JSON-RPC client for ONE prover URL: `prover_info`, `prover_submit [sealed_hex]`,
/// `prover_status [job]`, `prover_cancel [job]` (positional params, fullnode spec §3.2). The
/// pairing token is not a parameter: it travels only inside the sealed job, never in clear.
final class ProverClient {
    static let unknownJob = -32001
    static let unpaired = -32003
    static let witnessKind = -32004
    static let busy = -32005
    /// The prover wants a fee this job did not pay (fullnode v0.6.3, `docs/prover.md`).
    static let fee = -32006

    let url: URL
    private let session: URLSession
    private var seq = 0

    /// Throws `ProverRefusal` when `url` breaks the URL rule.
    init(url text: String, session: URLSession? = nil, timeout: TimeInterval = 20) throws {
        switch ProverURLRule.check(text) {
        case .refused(let why): throw ProverRefusal(message: why)
        case .ok(let value):
            guard let u = URL(string: value) else { throw ProverRefusal(message: String(localized: "The pairing link's prover address is not a URL.")) }
            url = u
        }
        if let session {
            self.session = session
        } else {
            let cfg = URLSessionConfiguration.ephemeral
            cfg.timeoutIntervalForRequest = timeout
            cfg.timeoutIntervalForResource = timeout
            self.session = URLSession(configuration: cfg)
        }
    }

    func call(_ method: String, _ params: [Any] = []) async throws -> Any {
        seq += 1
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": seq, "method": method, "params": params])
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req, delegate: NoRedirects.shared)
        } catch let e as URLError where e.code == .cancelled {
            throw CancellationError()
        } catch is CancellationError {
            throw CancellationError()
        } catch let e as URLError where e.code == .timedOut {
            throw ProverError(message: String(localized: "cannot reach the prover at \(url.absoluteString): timed out"), failure: .timeout)
        } catch {
            throw ProverError(message: String(localized: "cannot reach the prover at \(url.absoluteString): \(error.localizedDescription)"), failure: .connect)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            let ok = (200..<300).contains(status)
            throw ProverError(message: String(localized: "the prover at \(url.absoluteString) did not answer with JSON-RPC (HTTP \(status))"), failure: ok ? .body : .http)
        }
        if let e = obj["error"] as? [String: Any] {
            throw ProverError(message: e["message"] as? String ?? String(localized: "prover error"), code: (e["code"] as? NSNumber)?.intValue,
                              data: e["data"] as? [String: Any])
        }
        return obj["result"] ?? NSNull()
    }

    func info() async throws -> ProverInfo { try ProverInfo(await call("prover_info")) }

    /// The job id the prover assigned.
    func submit(_ sealedHex: String) async throws -> String {
        let r = try await call("prover_submit", [sealedHex]) as? [String: Any]
        guard let job = r?["job"] as? String, Self.validJob(job) else {
            throw ProverError(message: String(localized: "the prover accepted the job but named no job id"), failure: .body)
        }
        return job
    }

    func status(_ job: String) async throws -> [String: Any] {
        guard let o = try await call("prover_status", [job]) as? [String: Any] else {
            throw ProverError(message: String(localized: "the prover's status is not an object"), failure: .body)
        }
        return o
    }

    func cancel(_ job: String) async throws { _ = try await call("prover_cancel", [job]) }

    static func validJob(_ s: String) -> Bool {
        (1...128).contains(s.count) && s.unicodeScalars.allSatisfy {
            ("A"..."Z").contains($0) || ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "_" || $0 == "-"
        }
    }

    /// The prover's refusal in the user's words (`proverRefusal` in the JS). Transport failures
    /// are returned unchanged: whether to retry them is the caller's decision.
    static func refusal(_ error: Error) -> Error {
        guard let e = error as? ProverError, e.failure == nil else { return error }
        switch e.code {
        case busy:
            let depth = (e.data?["depth"] as? NSNumber)?.intValue
            let n = depth.map { $0 >= 0 ? String($0) : "?" } ?? "?"
            return ProverRefusal(message: String(localized: "The prover is full (\(n) waiting). Try again in a few minutes."), busy: true)
        case unpaired:
            return ProverRefusal(message: String(localized: "This prover does not know this pairing. Pair it again in Settings."))
        case witnessKind:
            let reason = (e.data?["reason"] as? String).map { " (\(String($0.prefix(200))))" } ?? ""
            return ProverRefusal(message: String(localized: "This prover does not accept this kind of job\(reason). Pair another prover in Settings, or send from the rand command-line wallet."))
        case fee:
            return ProverRefusal(message: String(localized: "This prover charges a fee, which this version of the wallet does not pay. Pair a prover that charges nothing, or send from the rand command-line wallet."))
        case unknownJob:
            return ProverRefusal(message: String(localized: "The prover no longer has this proof (it restarted or the job expired). Send again."))
        default:
            let reason = (e.data?["reason"] as? String).map { ": \($0)" } ?? ""
            return ProverRefusal(message: String(localized: "The prover refused the job (\(e.message)\(reason))."))
        }
    }
}

/// What `prepare_transfer` takes for a remote proof: the very request `prove_transfer` would
/// (its `profile`, `hc_bundle` and `hc_auth` the chain's, like a local proof's), plus the prover
/// target and the chain's proof-size cap. It carries the spend key and the token — handed to the
/// core, never logged. The target names NO `witness_kind`: which witness the job carries follows
/// the chain's bundle guest and is the core's decision (the viewing key on a split-authorisation
/// chain, the spend key on an older one — a request naming the other is refused, not obeyed). It
/// does name `own` (the Keychain record's, `ProverPairingService.checkJob` having already refused
/// a spend-key job to a pairing not marked so) and `fee` (`prover_info.fee` verbatim, which the
/// core refuses when it is a fee).
enum RemoteSendParams {
    static func build(request: ProveRequest, route: ProverPairingService.Route, maxProofBytes: Int?,
                      fee: JSONValue = .null) throws -> [String: Any] {
        guard let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any] else {
            throw RandCore.CoreError(message: String(localized: "the transfer request did not encode"))
        }
        return build(requestJSON: json, route: route, maxProofBytes: maxProofBytes, fee: fee)
    }

    /// The same, from the request as JSON (`prove_transfer`'s parameters).
    static func build(requestJSON: [String: Any], route: ProverPairingService.Route, maxProofBytes: Int?,
                      fee: JSONValue = .null) -> [String: Any] {
        var params = requestJSON
        var target: [String: Any] = ["kem_ek": route.pairing.kemEk, "token": route.token, "own": route.pairing.own, "fee": fee.value]
        if let hc = requestJSON["hc_bundle"] as? String { target["hc_bundle"] = hc }
        params["prover"] = target
        if let maxProofBytes { params["max_proof_bytes"] = maxProofBytes }
        return params
    }
}

/// What a remote proof is of: the request a local proof would take (`prove_transfer`'s or
/// `prove_invoke`'s JSON — the spend key inside it, never logged), the chain's guests it names, the
/// core call that seals it (`prepare_*`) and the one that opens the reply (`finish_proof`, into the
/// result that local proof would have returned). The pool path and the paired-prover path are the
/// same for every kind; only these differ (`proveHookFor` in the JS branches on `kind` the same way).
struct RemoteJob<R> {
    let kind: String
    let params: [String: Any]
    let hcBundle: String?
    let hcAuth: String?
    let prepare: ([String: Any]) throws -> (sealedHex: String, pending: Any)
    let finish: (Any, String) throws -> R
}

extension RemoteJob where R == ProveResult {
    static func transfer(_ request: ProveRequest) throws -> RemoteJob<ProveResult> {
        guard let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any] else {
            throw RandCore.CoreError(message: String(localized: "the transfer request did not encode"))
        }
        return RemoteJob<ProveResult>(kind: "transfer", params: json, hcBundle: request.hcBundle, hcAuth: request.hcAuth,
                                      prepare: { try RandCore.prepareTransfer($0) },
                                      finish: { try RandCore.finishProof(pending: $0, replyHex: $1) })
    }
}

extension RemoteJob where R == InvokeResult {
    /// An RPL-2 invoke: `prepare_invoke` makes the call proof and the auth proof on this device.
    static func invoke(_ params: [String: Any], hcBundle: String?, hcAuth: String?) -> RemoteJob<InvokeResult> {
        RemoteJob<InvokeResult>(kind: "invoke", params: params, hcBundle: hcBundle, hcAuth: hcAuth,
                                prepare: { try RandCore.prepareInvoke($0) },
                                finish: { try RandCore.finishInvoke(pending: $0, replyHex: $1) })
    }
}

/// Refuses every HTTP redirect: a 307 would carry the POST to a host the URL rule never saw.
final class NoRedirects: NSObject, URLSessionTaskDelegate {
    static let shared = NoRedirects()
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Where a remote proof is, for the proving screen.
enum RemoteProofPhase: Equatable {
    /// Handed over, or proving: "Proving on <name>…".
    case proving
    /// Waiting in the prover's queue: "Waiting at position N on <name>".
    case queued(position: Int)
}

/// One remote proof: submit the sealed job, poll until the prover answers, hand the reply to the
/// core's `finish_proof` (which opens it, checks the digest and the size, and verifies the proof).
/// A reply that fails any of that never reaches the node. Transport failures are retried until
/// `maxWait` (the prover may be restarting); a JSON-RPC error stops. There is no resume on mobile:
/// the job — and `pending`, which on a split-authorisation chain holds the transaction with its
/// auth proof, some 2.8 MB of hex — lives in this call, in memory, and an app the system kills
/// loses it (nothing is sent).
struct RemoteProver {
    let client: ProverClient
    var poll: TimeInterval = 1
    var maxWait: TimeInterval = 20 * 60
    var now: () -> Date = Date.init
    /// How many times a job is offered when the prover could not be reached at all, and the waits
    /// between those tries; `sleep` is the test seam.
    static let submitTries = 3
    var submitBackoff: [TimeInterval] = [1, 3]
    var sleep: (TimeInterval) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64(max($0, 0) * 1e9)) }

    /// `finish(pending, replyHex)` is the core's `finish_proof`; `onPhase` is told each change.
    func prove<Result: Sendable>(sealedHex: String, pending: Any,
                       finish: @escaping (Any, String) throws -> Result,
                       onPhase: @escaping (RemoteProofPhase) async -> Void) async throws -> Result {
        await onPhase(.proving)
        let job = try await submit(sealedHex)
        return try await poll(job: job, pending: pending, finish: finish, onPhase: onPhase)
    }

    /// Hands the sealed job over and returns the job id the prover named. Throws a `ProverRefusal`
    /// when it took nothing — its answer (busy included, `busy` set) or no answer at all after the
    /// transport retries — so a pool can ask its next member.
    func submit(_ sealedHex: String) async throws -> String {
        var submitted: String?
        var attempt = 1
        while submitted == nil {
            do {
                submitted = try await client.submit(sealedHex)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                // No JSON-RPC reply at all — the connection failed, or an HTTP error page came back
                // — means the prover accepted nothing: the same sealed job is offered again, a
                // bounded number of times. A JSON-RPC error (busy included) is final; a timeout
                // (the prover may have taken it) and a reply naming no job id are never resubmitted.
                if let e = error as? ProverError, e.failure == .connect || e.failure == .http, attempt < Self.submitTries {
                    try await sleep(submitBackoff[min(attempt - 1, submitBackoff.count - 1)])
                    attempt += 1
                    continue
                }
                let r = ProverClient.refusal(error)
                if r is ProverRefusal { throw r }
                throw ProverRefusal(message: String(localized: "Could not hand the proof to your prover: \(error.localizedDescription)"))
            }
        }
        return submitted!
    }

    /// Polls `job` on THIS prover until it answers, then opens the reply through `finish`.
    func poll<Result: Sendable>(job: String, pending: Any,
                                finish: @escaping (Any, String) throws -> Result,
                                onPhase: @escaping (RemoteProofPhase) async -> Void) async throws -> Result {
        let started = now()
        var last: RemoteProofPhase = .proving
        func say(_ p: RemoteProofPhase) async {
            if p != last { last = p; await onPhase(p) }
        }
        func cancelJob() async { try? await client.cancel(job) }
        func pause() async throws {
            do { try await Task.sleep(nanoseconds: UInt64(max(poll, 0) * 1e9)) } catch { await cancelJob(); throw CancellationError() }
        }
        let minutes = Int((maxWait / 60).rounded())

        while true {
            if Task.isCancelled { await cancelJob(); throw CancellationError() }
            let st: [String: Any]
            do {
                st = try await client.status(job)
            } catch is CancellationError {
                await cancelJob(); throw CancellationError()
            } catch let e as ProverError where e.failure != nil {
                if now().timeIntervalSince(started) >= maxWait {
                    await cancelJob()
                    throw ProverRefusal(message: String(localized: "Your prover has not answered for \(minutes) minutes, so nothing was sent. Send again."))
                }
                try await pause()
                continue
            } catch {
                throw ProverClient.refusal(error)
            }
            let state = st["state"] as? String ?? ""
            switch state {
            case "queued":
                let p = (st["position"] as? NSNumber)?.intValue ?? 1
                await say(.queued(position: p > 0 ? p : 1))
            case "proving":
                await say(.proving)
            case "done":
                guard let reply = st["reply"] as? String, !reply.isEmpty else {
                    throw ProverRefusal(message: String(localized: "The prover finished but sent no proof."))
                }
                do {
                    // Off the calling actor, as the local proof is: `finish_proof` verifies a STARK.
                    return try await Task.detached(priority: .userInitiated) { try finish(pending, reply) }.value
                } catch {
                    throw ProverRefusal(message: String(localized: "The prover's proof was refused by this wallet: \(error.localizedDescription)"))
                }
            case "failed", "expired":
                let why = (st["error"] as? String).flatMap { $0.isEmpty ? nil : ": \($0)" } ?? ""
                throw ProverRefusal(message: String(localized: "The prover could not make this proof (\(state)\(why))."))
            default:
                throw ProverRefusal(message: String(localized: "The prover answered with an unknown state (\(String(state.prefix(32))))."))
            }
            if now().timeIntervalSince(started) >= maxWait {
                await cancelJob()
                throw ProverRefusal(message: String(localized: "Your prover has not finished after \(minutes) minutes, so nothing was sent. Send again."))
            }
            try await pause()
        }
    }
}
