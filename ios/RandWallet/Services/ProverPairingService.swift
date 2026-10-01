import Foundation

/// The half of a pairing that decides where a job goes — the bearer token, the prover's key and
/// URL, and whether the link marked it the owner's own — kept together in the Keychain
/// (`Keychain.saveProverSecret`). A send seals to this `kemEk` and posts to this `url`, and
/// `own` here (never the display copy's) is what lets a spend-key job go out on a chain without
/// split authorisation; `Settings.prover` is only what the screens show.
struct ProverSecret: Codable, Equatable {
    var token: String
    var kemEk: String
    var url: String
    var fingerprint: String
    /// The link carried `own=1`. A record stored before this field was kept reads `false`: such a
    /// pairing still takes every viewing-key job, and never a spend-key one until paired again.
    var own: Bool = false

    init(token: String, kemEk: String, url: String, fingerprint: String, own: Bool = false) {
        self.token = token
        self.kemEk = kemEk
        self.url = url
        self.fingerprint = fingerprint
        self.own = own
    }

    enum CodingKeys: String, CodingKey { case token, kemEk, url, fingerprint, own }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        token = try c.decode(String.self, forKey: .token)
        kemEk = try c.decode(String.self, forKey: .kemEk)
        url = try c.decode(String.self, forKey: .url)
        fingerprint = try c.decode(String.self, forKey: .fingerprint)
        own = try c.decodeIfPresent(Bool.self, forKey: .own) ?? false
    }

    /// The record as stored, or `nil` for anything else (a pre-release bare token included).
    static func decode(_ text: String) -> ProverSecret? {
        guard let s = try? JSONDecoder().decode(ProverSecret.self, from: Data(text.utf8)),
              ![s.token, s.kemEk, s.url, s.fingerprint].contains(where: \.isEmpty) else { return nil }
        return s
    }
}

/// A paired prover as Settings keeps it: public fields only, for display. The token — and the key,
/// URL and `own` a job is actually sealed to, sent to and gated on — are in the Keychain
/// (`ProverSecret`).
struct ProverPairing: Codable, Equatable {
    /// What the proving screen calls it: the prover's host (and port).
    var name: String
    var url: String
    /// The prover's ML-KEM-768 encapsulation key, lowercase hex (1 184 bytes).
    var kemEk: String
    var fingerprint: String
    /// The link was made with `own=1`: the user says this prover is a machine of theirs. On a
    /// split-authorisation chain (every chain since 17) any paired prover makes the proofs — the
    /// job carries the viewing key and a salt, never the spend key — and this only decides what
    /// Settings calls it; on an older chain, whose job carries the spend key, only such a prover
    /// is sent one. For display: the route reads the Keychain record's copy.
    var own: Bool
}

/// Pairing, probing and forgetting a prover — the Swift twin of `ui/engine/backend-shared.js`'s
/// `prover` group. The link is read by the core (`parse_prover_link`); the prover's key is asked of
/// the prover itself and must be the one the link names, the fingerprint recomputed by the core
/// from that key (the prover's own `kem_fingerprint` is its word, not evidence). Only then is
/// anything stored.
enum ProverPairingService {
    /// What a prover learns from a viewing-key job (delegated proving, Phase 2 — split
    /// authorisation): the core's sentence, `version`'s `prover_history_warning`, so every shell
    /// says the same thing; this string is its fallback, word for word. Shown before ANY pairing
    /// is saved, the user's own or not (a prover of the user's own learns exactly as much; it is
    /// theirs).
    static let historyWarningFallback = "This prover will be able to read this wallet's whole history — every payment received and sent, before and after today. It cannot spend. To keep your history private, run your own."
    static var warning: String {
        let w = (try? RandCore.constants())?.proverHistoryWarning?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return w.isEmpty ? historyWarningFallback : w
    }

    /// Under a pairing that is not the user's own: what that prover can do, in one line
    /// (`ui/screens/settings.js`'s `PROVER_NOT_OWN_NOTE`).
    static let notOwnNote = "Not marked as your own: it can read this wallet's whole history. It cannot spend."

    struct ParsedLink {
        let kemEk: String
        let url: String
        let token: String
        let own: Bool
        let fingerprint: String
    }

    struct Preview: Equatable {
        let url: String
        let fingerprint: String
        let own: Bool
        /// Set when the link is not marked `own`: `notOwnNote`, for the line under the pairing.
        let note: String?
    }

    enum Probe: Equatable {
        case ok(ProverInfo)
        case unavailable(String)
    }

    static func parse(_ link: String) throws -> ParsedLink {
        guard let v = try RandCore.call("parse_prover_link", ["link": link.trimmingCharacters(in: .whitespacesAndNewlines)]) as? [String: Any],
              let kemEk = v["kem_ek"] as? String, let url = v["url"] as? String,
              let token = v["token"] as? String, let fp = v["fingerprint"] as? String else {
            throw ProverRefusal(message: "That is not a pairing link.")
        }
        return ParsedLink(kemEk: kemEk.lowercased(), url: url, token: token, own: v["own"] as? Bool == true, fingerprint: fp)
    }

    static func fingerprint(kemEk: String) throws -> String {
        guard let fp = try RandCore.call("prover_fingerprint", ["kem_ek": kemEk]) as? String else {
            throw RandCore.CoreError(message: "prover_fingerprint returned no string")
        }
        return fp
    }

    /// What a link names, read through the core and held to the URL rule, without saving it or
    /// asking anybody. Never the token.
    static func preview(_ link: String) throws -> Preview {
        let p = try parse(link)
        let url = try checkedURL(p.url)
        return Preview(url: url, fingerprint: p.fingerprint, own: p.own, note: p.own ? nil : notOwnNote)
    }

    /// Whether the prover's reported key is the pairing's.
    static func sameKey(_ info: ProverInfo, kemEk: String, fingerprint: String) -> Bool {
        guard !info.kemEk.isEmpty, info.kemEk == kemEk.lowercased() else { return false }
        return (try? self.fingerprint(kemEk: info.kemEk)) == fingerprint
    }

    /// Asks the prover for its key and returns the pairing and its token — stores nothing. The
    /// pairing is named `name` (trimmed, at most 64 characters) or, without one, the prover's host
    /// (and port).
    static func pair(_ link: String, session: URLSession? = nil, name: String? = nil) async throws -> (pairing: ProverPairing, token: String) {
        let p = try parse(link)
        let url = try checkedURL(p.url)
        let info: ProverInfo
        do {
            info = try await ProverClient(url: url, session: session).info()
        } catch {
            throw ProverRefusal(message: "The prover at \(url) did not answer: \(error.localizedDescription)")
        }
        guard sameKey(info, kemEk: p.kemEk, fingerprint: p.fingerprint) else {
            throw ProverRefusal(message: "The prover at that address has a different key from the one the link names. Do not pair it.")
        }
        let comps = URLComponents(string: url)
        let host = comps?.host ?? url
        let given = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let label = given.isEmpty ? (comps?.port.map { "\(host):\($0)" } ?? host) : String(given.prefix(64))
        return (ProverPairing(name: label, url: url, kemEk: p.kemEk, fingerprint: p.fingerprint, own: p.own), p.token)
    }

    // MARK: the trusted prover (`prover.trusted` / `prover.pairTrusted` in the JS)

    /// What a screen may show of the prover the build ships the address of: never the link (it
    /// carries the pairing token).
    struct Trusted: Equatable {
        let name: String
        let url: String
        let fingerprint: String
    }

    /// The core's `version.trusted_prover` — the one source; `nil` when this build carries none.
    static func trustedProver() -> TrustedProver? {
        (try? RandCore.constants())?.trustedProver
    }

    /// The prover every client ships the address of (the RandProtocol validators' pool,
    /// viewing-key jobs only, no fee) — `{name, url, fingerprint}` for Settings to offer in one
    /// step beside the history warning, or `nil` when this build carries none. Asking pairs
    /// nothing. `from` is the test seam; a screen passes nothing.
    static func trusted(from source: TrustedProver?? = nil) -> Trusted? {
        guard let t = source ?? trustedProver(), !t.link.isEmpty else { return nil }
        let name = t.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return Trusted(name: name.isEmpty ? "RandProtocol" : name, url: t.url, fingerprint: t.fingerprint)
    }

    /// Pair the trusted prover: `pair` on the built-in link — the same checks (the link read by
    /// the core, the URL rule, the prover's key asked of the prover itself and held to the link's)
    /// and the same record, named after the pool and never own — after holding the link, through
    /// the core, to the fingerprint the build pins, so a link that somehow named another key is
    /// refused before the prover is asked anything. Stores nothing: Settings saves what comes back
    /// through `save`, exactly as for a pasted link. Never called by the app itself — only by the
    /// user's tap, after the history warning; `forget` undoes it like any pairing. `trusted` is
    /// the test seam; a screen passes nothing.
    static func pairTrusted(session: URLSession? = nil, trusted source: TrustedProver?? = nil) async throws -> (pairing: ProverPairing, token: String) {
        guard let t = source ?? trustedProver(), !t.link.isEmpty else {
            throw ProverRefusal(message: "This build ships no prover to use.")
        }
        let parsed = try parse(t.link)
        guard !t.fingerprint.isEmpty, parsed.fingerprint == t.fingerprint else {
            throw ProverRefusal(message: "The built-in prover link does not name the key this wallet pins; not pairing it.")
        }
        guard !t.own, !parsed.own else {
            throw ProverRefusal(message: "The built-in prover link is marked as your own, which a shared prover is not; not pairing it.")
        }
        let label = trusted(from: .some(t))?.name ?? "RandProtocol"
        let (pairing, token) = try await pair(t.link, session: session, name: label)
        // A shared prover is never the user's own: what the link said is checked above, and the
        // record says so too, whatever a later link might.
        var shared = pairing
        shared.own = false
        return (shared, token)
    }

    /// The Keychain record first — the token with the key and URL it belongs to — then the display
    /// copy in Settings: a pairing is never visible without the record a send needs.
    @MainActor
    static func save(_ pairing: ProverPairing, token: String, settings: Settings) throws {
        try Keychain.saveProverSecret(ProverSecret(token: token, kemEk: pairing.kemEk.lowercased(), url: pairing.url,
                                                   fingerprint: pairing.fingerprint, own: pairing.own))
        settings.prover = pairing
        settings.noProver = false // a prover of the user's own replaces a choice of none
    }

    @MainActor
    static func forget(settings: Settings) {
        settings.prover = nil
        Keychain.deleteProverSecret()
    }

    /// Whether the paired prover answers with the pairing's key.
    static func probe(_ pairing: ProverPairing, session: URLSession? = nil) async -> Probe {
        let info: ProverInfo
        do {
            info = try await ProverClient(url: pairing.url, session: session).info()
        } catch {
            return .unavailable("the prover at \(pairing.url) did not answer (\(error.localizedDescription))")
        }
        guard sameKey(info, kemEk: pairing.kemEk, fingerprint: pairing.fingerprint) else {
            return .unavailable("the prover at that address now has a different key; pair it again")
        }
        return .ok(info)
    }

    /// A remote route: the pairing — its `url`, `kemEk`, `fingerprint` and `own` the Keychain
    /// record's, only `name` from Settings — and its token.
    struct Route {
        let pairing: ProverPairing
        let token: String
        /// The RandProtocol prover as the default (nothing paired): the one-time notice applies.
        var isDefault = false
    }

    /// The default prover's queue is full: said plainly, never retried in a loop.
    static func defaultBusy(_ name: String) -> String {
        "The \(name) prover is busy; try again in a minute, or pair your own prover in Settings."
    }

    /// The one-time notice before the first proof by the RandProtocol prover (the default where
    /// this device cannot prove): what it learns, that it cannot spend, and the way to use a prover
    /// of your own instead.
    static let defaultNoticeTitle = "The RandProtocol prover can read your history"
    static let defaultNotice = "This device cannot make the proof, so the prover RandProtocol runs for everyone makes it. "
        + "It receives this wallet's viewing key, so it can read your whole history — every payment received and sent, past and future. "
        + "It cannot spend. You are asked once; to keep your history to yourself, use your own prover instead."

    /// Whether proofs this device cannot make go to the RandProtocol prover: nothing paired, no
    /// prover not chosen, and a build that ships one.
    static func usesDefault(paired: Bool, noProver: Bool, shipsOne: Bool) -> Bool { !paired && !noProver && shipsOne }

    /// Whether `address`'s wallet has read the notice: the record names THIS wallet.
    static func noticeRead(address: String, readFor: String?) -> Bool { !address.isEmpty && readFor == address }

    /// Whether a send from this wallet must show the notice first.
    static func needsNotice(deviceCanProve: Bool, usesDefault: Bool, read: Bool) -> Bool { !deviceCanProve && usesDefault && !read }

    /// A remote proof's failure as the user reads it for `route`: the RandProtocol prover busy is
    /// `defaultBusy`; anything else (a paired prover's busy included) is unchanged.
    static func failure(_ error: Error, route: Route) -> Error {
        if route.isDefault, let r = error as? ProverRefusal, r.busy { return ProverRefusal(message: defaultBusy(route.pairing.name), busy: true) }
        return error
    }

    /// The RandProtocol prover as the DEFAULT route uses it (wallet 0.6.8: nothing paired, nothing
    /// stored): the built-in link read through the core and held to the pinned fingerprint, the URL
    /// rule and `own=0` — no network; the route asks the prover for its key before any job. Named
    /// after the pool, NOT own; the token is the one every copy ships. `trusted` is the test seam.
    static func builtIn(trusted source: TrustedProver?? = nil) throws -> (pairing: ProverPairing, token: String) {
        guard let t = source ?? trustedProver(), !t.link.isEmpty else {
            throw ProverRefusal(message: "This build ships no prover to use.")
        }
        let parsed = try parse(t.link)
        guard !t.fingerprint.isEmpty, parsed.fingerprint == t.fingerprint else {
            throw ProverRefusal(message: "The built-in prover link does not name the key this wallet pins; not pairing it.")
        }
        guard !t.own, !parsed.own else {
            throw ProverRefusal(message: "The built-in prover link is marked as your own, which a shared prover is not; not pairing it.")
        }
        let url = try checkedURL(parsed.url)
        let name = trusted(from: .some(t))?.name ?? "RandProtocol"
        return (ProverPairing(name: name, url: url, kemEk: parsed.kemEk.lowercased(), fingerprint: parsed.fingerprint, own: false), parsed.token)
    }

    /// `prover_info.fee` as a sentence when it is a fee, `nil` when the prover charges nothing
    /// (`null`, or an amount of zero). This build pays no prover fee.
    static func feeRefusal(_ fee: JSONValue) -> String? {
        if fee.isNull { return nil }
        let amount = (fee.value as? [String: Any])?["amount"] as? String ?? ""
        if !amount.isEmpty && amount.allSatisfy({ $0 == "0" }) { return nil }
        var shown = ""
        if (1...20).contains(amount.count), amount.allSatisfy({ $0.isNumber }), let f = try? RandCore.formatAmount(units: amount) {
            shown = " of \(f) RAND"
        }
        return "it charges a fee\(shown) per proof, which this version of the wallet does not pay"
    }

    /// Where a send's proof is made (`proveRoute` in the JS). `nil` = this device: it can prove,
    /// or no prover is paired. Otherwise the paired prover — the user's own or not — answering
    /// with the pairing's key, charging nothing, and taking a job this wallet can send it: a
    /// viewing-key job (a split-authorisation chain: the prover gets `nk` and a salt, can read
    /// this wallet's history and cannot spend), or, for a prover paired as the user's own, a
    /// spend-key one (an older chain). Which of the two a given send needs is the chain's and is
    /// settled by the core when the job is made (`checkJob`); this only rules out a prover that
    /// could take neither. A pairing whose Keychain record is gone, or a prover that fails any of
    /// this, refuses the send here, before anything is built: nothing is sent. The probe and the
    /// route use the Keychain record's URL, key and `own` (`secret`), never `pairing`'s, which is
    /// the plaintext display copy in Settings.
    ///
    /// With nothing paired (wallet 0.6.8), `defaultProver` — `nil` when the user chose no prover or
    /// the build ships none — is the RandProtocol prover: asked for its key (the pinned one), its fee
    /// (none) and viewing-key jobs; when it is not there the refusal says so plainly and points to
    /// Settings. A paired prover is preferred over it.
    static func route(deviceCanProve: Bool, pairing display: ProverPairing?,
                      probe: (ProverPairing) async -> Probe, secret: () -> ProverSecret?,
                      defaultProver: (() throws -> (pairing: ProverPairing, token: String))? = nil) async throws -> Route? {
        if deviceCanProve { return nil }
        if display == nil, let defaultProver { return try await defaultRoute(probe: probe, defaultProver: defaultProver) }
        guard let d = display else { return nil }
        guard let s = secret(), !s.token.isEmpty else {
            throw ProverRefusal(message: "Your prover's pairing could not be opened. Pair the prover again in Settings.")
        }
        let p = ProverPairing(name: d.name, url: s.url, kemEk: s.kemEk, fingerprint: s.fingerprint, own: s.own)
        let reason = "This device does not have the memory for this proof."
        let why: String?
        switch await probe(p) {
        case .unavailable(let w):
            why = w
        case .ok(let info):
            if let fee = feeRefusal(info.fee) {
                why = fee
            } else if info.witnessKinds.contains("viewing_key") || (p.own && info.witnessKinds.contains("spend_key")) {
                why = nil
            } else {
                why = "it does not take this wallet's jobs"
            }
        }
        if let why { throw ProverRefusal(message: "\(reason) Your paired prover is not available: \(why).") }
        return Route(pairing: p, token: s.token)
    }

    private static func defaultRoute(probe: (ProverPairing) async -> Probe,
                                     defaultProver: () throws -> (pairing: ProverPairing, token: String)) async throws -> Route {
        let lead = "This device does not have the memory for this proof."
        let b: (pairing: ProverPairing, token: String)
        do { b = try defaultProver() } catch {
            throw ProverRefusal(message: "\(lead) \(error.localizedDescription)")
        }
        let why: String?
        switch await probe(b.pairing) {
        case .unavailable(let w):
            why = w.contains("different key") ? "it answered with another key than the one this wallet pins" : w
        case .ok(let info):
            if let fee = feeRefusal(info.fee) { why = fee }
            else if info.witnessKinds.contains("viewing_key") { why = nil }
            else { why = "it does not take this wallet's jobs" }
        }
        if let why {
            throw ProverRefusal(message: "\(lead) The \(b.pairing.name) prover cannot be reached right now (\(why)). Try again later, or pair your own prover in Settings.")
        }
        return Route(pairing: b.pairing, token: b.token, isDefault: true)
    }

    /// What one send's job is allowed to be, decided at the one point a job is built
    /// (`proveHookFor` in the JS), before anything is proved:
    /// 1. what this chain's bundle guest takes, from the core (`chain_guests`): the viewing key on
    ///    a split-authorisation chain, the spend key on an older one — and the core refuses,
    ///    here, a chain whose guests this build cannot prove for;
    /// 2. a spend-key witness goes to a prover paired as the user's own and to no other — the core
    ///    refuses it too (`NOT_OWN`); this says so before the prover is even asked;
    /// 3. the prover as it is NOW (`info`, a fresh `prover_info`): still the key this wallet
    ///    paired, taking this kind of job, and charging nothing. Its fee is its own to change at
    ///    any time, so it is read here and handed to the core verbatim, which refuses any.
    /// Returns the chain's guests (`splitAuthorisation` says whether `prepare_*` will make the auth
    /// proof on this device first) and the fee to pass through.
    struct JobCheck: Equatable {
        let guests: ChainGuests
        /// `prover_info.fee` as answered — `nil` (JSON `null`) when it charges nothing.
        let fee: JSONValue
    }

    static func checkJob(route: Route, hcBundle: String?, hcAuth: String?,
                         info: () async throws -> ProverInfo) async throws -> JobCheck {
        let guests: ChainGuests
        do {
            guests = try RandCore.chainGuests(hcBundle: hcBundle, hcAuth: hcAuth)
        } catch {
            let m = error.localizedDescription
            throw ProverRefusal(message: m.isEmpty ? "This wallet cannot prove for this chain." : m)
        }
        let wants = guests.witnessKind
        if wants == "spend_key" && !route.pairing.own {
            throw ProverRefusal(message: "On this chain a proof needs the spend key, which goes only to a prover paired as your own. Pair your own prover in Settings, or send from the rand command-line wallet.")
        }
        let now: ProverInfo
        do {
            now = try await info()
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw ProverRefusal(message: "Your prover did not answer: \(error.localizedDescription)")
        }
        guard sameKey(now, kemEk: route.pairing.kemEk, fingerprint: route.pairing.fingerprint) else {
            throw ProverRefusal(message: "The prover at that address now has a different key. Pair it again in Settings.")
        }
        guard now.witnessKinds.contains(wants) else {
            throw ProverRefusal(message: wants == "viewing_key"
                ? "Your prover does not take viewing-key jobs (it is older than this chain). Update it, or pair another."
                : "Your prover does not take spend-key jobs. Pair your own prover in Settings, or send from the rand command-line wallet.")
        }
        if let fee = feeRefusal(now.fee) {
            throw ProverRefusal(message: "This prover charges a fee, which this version of the wallet does not pay (\(fee)). Pair a prover that charges nothing, or send from the rand command-line wallet.")
        }
        return JobCheck(guests: guests, fee: now.fee)
    }

    /// The one status line Settings shows under the pairing.
    static func statusLine(_ probe: Probe) -> String {
        switch probe {
        case .ok(let info):
            let max = info.max > 0 ? " of \(info.max)" : ""
            return "Answering · \(info.depth)\(max) in its queue."
        case .unavailable(let why):
            var w = why
            if w.hasSuffix(".") { w.removeLast() }
            return "Not answering: \(w)."
        }
    }

    private static func checkedURL(_ text: String) throws -> String {
        switch ProverURLRule.check(text) {
        case .ok(let u): return u
        case .refused(let why): throw ProverRefusal(message: why)
        }
    }
}
