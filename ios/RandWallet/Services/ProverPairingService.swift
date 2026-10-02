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
    static var historyWarningFallback: String { String(localized: "This prover will be able to read this wallet's whole history — every payment received and sent, before and after today. It cannot spend. To keep your history private, run your own.") }
    static var warning: String {
        let w = (try? RandCore.constants())?.proverHistoryWarning?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        // The core's sentence is English: shown through the mapper, which knows it word for word.
        return w.isEmpty ? historyWarningFallback : CoreErrors.localized(w)
    }

    /// Under a pairing that is not the user's own: what that prover can do, in one line
    /// (`ui/screens/settings.js`'s `PROVER_NOT_OWN_NOTE`).
    static var notOwnNote: String { String(localized: "Not marked as your own: it can read this wallet's whole history. It cannot spend.") }

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
            throw ProverRefusal(message: String(localized: "That is not a pairing link."))
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
            throw ProverRefusal(message: String(localized: "The prover at \(url) did not answer: \(error.localizedDescription)"))
        }
        guard sameKey(info, kemEk: p.kemEk, fingerprint: p.fingerprint) else {
            throw ProverRefusal(message: String(localized: "The prover at that address has a different key from the one the link names. Do not pair it."))
        }
        let comps = URLComponents(string: url)
        let host = comps?.host ?? url
        let given = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let label = given.isEmpty ? (comps?.port.map { "\(host):\($0)" } ?? host) : String(given.prefix(64))
        return (ProverPairing(name: label, url: url, kemEk: p.kemEk, fingerprint: p.fingerprint, own: p.own), p.token)
    }

    // MARK: the RandProtocol provers (`prover.trusted` / the default route in the JS)

    /// What a screen may show of the pool: names, URLs and fingerprints — never a link (each
    /// carries a pairing token).
    struct Trusted: Equatable {
        struct Member: Equatable {
            let name: String
            let url: String
            let fingerprint: String
        }
        let name: String
        let members: [Member]
    }

    /// The core's `version.trusted_prover_pool` — the one source; `nil` when this build carries none.
    static func trustedPool() -> TrustedProverPool? {
        (try? RandCore.constants())?.trustedProverPool
    }

    /// The RandProtocol provers the build pins, for Settings and the notice — or `nil` when this
    /// build carries none (no member with a link). Asking pairs and asks nothing. `from` is the
    /// test seam; a screen passes nothing.
    static func trusted(from source: TrustedProverPool?? = nil) -> Trusted? {
        guard let t = source ?? trustedPool() else { return nil }
        let members = t.members.filter { !$0.link.isEmpty }.map { Trusted.Member(name: $0.name, url: $0.url, fingerprint: $0.fingerprint) }
        if members.isEmpty { return nil }
        let name = t.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return Trusted(name: name.isEmpty ? "RandProtocol" : name, members: members)
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

    /// `probe`'s word for a prover whose key is not the pairing's; `notReady` tells it apart from silence.
    static var keyChangedWarning: String { String(localized: "the prover at that address now has a different key; pair it again") }

    /// Whether the paired prover answers with the pairing's key.
    static func probe(_ pairing: ProverPairing, session: URLSession? = nil) async -> Probe {
        let info: ProverInfo
        do {
            info = try await ProverClient(url: pairing.url, session: session).info()
        } catch {
            return .unavailable(String(localized: "the prover at \(pairing.url) did not answer (\(error.localizedDescription))"))
        }
        guard sameKey(info, kemEk: pairing.kemEk, fingerprint: pairing.fingerprint) else {
            return .unavailable(keyChangedWarning)
        }
        return .ok(info)
    }

    /// A remote route: the pairing — its `url`, `kemEk`, `fingerprint` and `own` the Keychain
    /// record's, only `name` from Settings — and its token.
    struct Route {
        let pairing: ProverPairing
        let token: String
        /// The RandProtocol provers as the default (nothing paired): the one-time notice applies.
        var isDefault = false
        /// The default's members in the order a job tries them — the first is the one that
        /// answered the route; each its own key and token. Empty for a paired prover.
        var members: [PoolMember] = []
        /// The pool's name ("RandProtocol").
        var poolName: String? = nil
    }

    /// One pool member as a job uses it: its pairing (named "RandProtocol (a)", never own) and token.
    struct PoolMember {
        let pairing: ProverPairing
        let token: String
        var member: String {
            let n = pairing.name
            guard let open = n.lastIndex(of: "("), n.hasSuffix(")") else { return n }
            return String(n[n.index(after: open)..<n.index(before: n.endIndex)])
        }
    }

    /// Why a member cannot take a job now — `nil` when it can: not answering, another key than its
    /// pin, a fee, no viewing-key jobs, or a full queue (`busy`).
    static func notReady(_ m: PoolMember, _ answer: Probe) -> (busy: Bool, reason: String)? {
        switch answer {
        case .unavailable(let w):
            return (false, w == keyChangedWarning ? String(localized: "\(m.member) answered with another key than the one this wallet pins") : String(localized: "\(m.member) did not answer"))
        case .ok(let info):
            if let fee = feeRefusal(info.fee) { return (false, "\(m.member): \(fee)") }
            if !info.witnessKinds.contains("viewing_key") { return (false, String(localized: "\(m.member) does not take this wallet's jobs")) }
            if info.max > 0 && info.depth >= info.max { return (true, String(localized: "\(m.member) is busy")) }
            return nil
        }
    }

    /// Every member busy, or none reachable: plainly, with the way out.
    static func poolUnavailable(lead: String, pool: String, _ whys: [(busy: Bool, reason: String)]) -> ProverRefusal {
        if !whys.isEmpty && whys.allSatisfy({ $0.busy }) {
            return ProverRefusal(message: String(localized: "\(lead)The \(pool) provers are all busy right now; try again in a minute, or pair your own prover in Settings."), busy: true)
        }
        return ProverRefusal(message: String(localized: "\(lead)The \(pool) provers cannot be reached right now (\(whys.map { $0.reason }.joined(separator: "; "))). Try again later, or pair your own prover in Settings."))
    }

    /// One job through the RandProtocol provers: the members in order — for each, `probe` again
    /// (`notReady`), `seal` the job to THAT member's key (the core's `prepare_transfer`, the auth
    /// proof made here each time), `submit` it (the transport retry per member); a member busy,
    /// refusing or unreachable at submit is skipped for the next. Once a member has named a job,
    /// `poll` follows THAT member to the end — never another mid-job. Every member out: plainly.
    static func provePool<R>(members: [PoolMember], poolName: String,
                             probe: (ProverPairing) async -> Probe,
                             seal: (PoolMember, ProverInfo) async throws -> (sealedHex: String, pending: Any),
                             submit: (PoolMember, String) async throws -> String,
                             poll: (PoolMember, String, Any) async throws -> R) async throws -> R {
        var whys: [(busy: Bool, reason: String)] = []
        for m in members {
            let answer = await probe(m.pairing)
            if let why = notReady(m, answer) { whys.append(why); continue }
            guard case .ok(let info) = answer else { continue }
            let sealed = try await seal(m, info)
            let job: String
            do {
                job = try await submit(m, sealed.sealedHex)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                whys.append(((error as? ProverRefusal)?.busy ?? false, "\(m.member): \(error.localizedDescription)"))
                continue
            }
            return try await poll(m, job, sealed.pending)
        }
        throw poolUnavailable(lead: "", pool: poolName, whys)
    }

    /// The RandProtocol provers, named the one way every surface names them (wallet 0.6.9).
    static func poolPhrase(_ n: Int) -> String {
        let machines = n > 0 ? String(localized: "\(n) machines") : String(localized: "machines")
        return String(localized: "the RandProtocol provers (\(machines) run by the validators; each one that proves a send sees that wallet's viewing key)")
    }

    /// The one-time notice before the first proof by the RandProtocol provers (the default where
    /// this device cannot prove): what the one that proves learns, that it cannot spend, and the
    /// way to use a prover of your own instead.
    static var defaultNoticeTitle: String { String(localized: "The RandProtocol provers can read your history") }
    static func defaultNotice(_ n: Int) -> String {
        String(localized: "This device cannot make the proof, so one of \(poolPhrase(n)) makes it. The one that does receives this wallet's viewing key, so it can read your whole history — every payment received and sent, past and future. It cannot spend. You are asked once; to keep your history to yourself, use your own prover instead.")
    }

    /// Whether proofs this device cannot make go to the RandProtocol provers: nothing paired, no
    /// prover not chosen, and a build that ships them.
    static func usesDefault(paired: Bool, noProver: Bool, shipsOne: Bool) -> Bool { !paired && !noProver && shipsOne }

    /// Whether `address`'s wallet has read the notice: the record names THIS wallet.
    static func noticeRead(address: String, readFor: String?) -> Bool { !address.isEmpty && readFor == address }

    /// Whether a send from this wallet must show the notice first.
    static func needsNotice(deviceCanProve: Bool, usesDefault: Bool, read: Bool) -> Bool { !deviceCanProve && usesDefault && !read }

    /// The RandProtocol provers as the DEFAULT route uses them (wallet 0.6.9: nothing paired,
    /// nothing stored): each member's link read through the core and held to THAT member's pinned
    /// fingerprint, its pinned URL, the URL rule and `own=0` — no network. A member that fails is
    /// left out (the others keep working) and never asked. Each named "RandProtocol (member)", NOT
    /// own; its token is the one every copy ships. In the pool's order — the caller shuffles.
    /// `pool` is the test seam.
    static func builtInPool(pool source: TrustedProverPool?? = nil) throws -> [PoolMember] {
        guard let t = source ?? trustedPool() else { throw ProverRefusal(message: String(localized: "This build ships no prover to use.")) }
        let name = trusted(from: .some(t))?.name ?? "RandProtocol"
        var out: [PoolMember] = []
        for m in t.members where !m.link.isEmpty && !m.own {
            guard let parsed = try? parse(m.link), !m.fingerprint.isEmpty, parsed.fingerprint == m.fingerprint, !parsed.own,
                  let url = try? checkedURL(parsed.url), url == (try? checkedURL(m.url)) else { continue }
            out.append(PoolMember(pairing: ProverPairing(name: "\(name) (\(m.name))", url: url, kemEk: parsed.kemEk.lowercased(),
                                                         fingerprint: parsed.fingerprint, own: false), token: parsed.token))
        }
        if out.isEmpty {
            throw ProverRefusal(message: String(localized: "None of the built-in RandProtocol prover links names the key this wallet pins for it; not using them."))
        }
        return out
    }

    /// `prover_info.fee` as a sentence when it is a fee, `nil` when the prover charges nothing
    /// (`null`, or an amount of zero). This build pays no prover fee.
    static func feeRefusal(_ fee: JSONValue) -> String? {
        if fee.isNull { return nil }
        let amount = (fee.value as? [String: Any])?["amount"] as? String ?? ""
        if !amount.isEmpty && amount.allSatisfy({ $0 == "0" }) { return nil }
        var shown = ""
        if (1...20).contains(amount.count), amount.allSatisfy({ $0.isNumber }), let f = try? RandCore.formatAmount(units: amount) {
            shown = String(localized: " of \(f) RAND")
        }
        return String(localized: "it charges a fee\(shown) per proof, which this version of the wallet does not pay")
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
                      defaultProver: (() throws -> [PoolMember])? = nil) async throws -> Route? {
        if deviceCanProve { return nil }
        if display == nil, let defaultProver { return try await defaultRoute(probe: probe, defaultProver: defaultProver) }
        guard let d = display else { return nil }
        guard let s = secret(), !s.token.isEmpty else {
            throw ProverRefusal(message: String(localized: "Your prover's pairing could not be opened. Pair the prover again in Settings."))
        }
        let p = ProverPairing(name: d.name, url: s.url, kemEk: s.kemEk, fingerprint: s.fingerprint, own: s.own)
        let reason = String(localized: "This device does not have the memory for this proof.")
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
                why = String(localized: "it does not take this wallet's jobs")
            }
        }
        if let why { throw ProverRefusal(message: String(localized: "\(reason) Your paired prover is not available: \(why).")) }
        return Route(pairing: p, token: s.token)
    }

    /// The default: the members in `defaultProver`'s order, each probed — ITS pinned key, no fee,
    /// viewing-key jobs, room in its queue; the first that can leads the route, the rest follow for
    /// `provePool`. None can: "all busy" or "cannot be reached", plainly, pointing to Settings.
    private static func defaultRoute(probe: (ProverPairing) async -> Probe,
                                     defaultProver: () throws -> [PoolMember]) async throws -> Route {
        let lead = String(localized: "This device does not have the memory for this proof. ")
        let members: [PoolMember]
        do { members = try defaultProver() } catch {
            throw ProverRefusal(message: lead + error.localizedDescription)
        }
        let pool = members.first.map { m -> String in
            let n = m.pairing.name
            guard let r = n.range(of: " (", options: .backwards) else { return n }
            return String(n[..<r.lowerBound])
        } ?? "RandProtocol"
        var whys: [(busy: Bool, reason: String)] = []
        for (i, m) in members.enumerated() {
            if let why = notReady(m, await probe(m.pairing)) { whys.append(why); continue }
            let ordered = [m] + members.enumerated().filter { $0.offset != i }.map { $0.element }
            return Route(pairing: m.pairing, token: m.token, isDefault: true, members: ordered, poolName: pool)
        }
        throw poolUnavailable(lead: lead, pool: pool, whys)
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
            throw ProverRefusal(message: m.isEmpty ? String(localized: "This wallet cannot prove for this chain.") : m)
        }
        let wants = guests.witnessKind
        if wants == "spend_key" && !route.pairing.own {
            throw ProverRefusal(message: String(localized: "On this chain a proof needs the spend key, which goes only to a prover paired as your own. Pair your own prover in Settings, or send from the rand command-line wallet."))
        }
        let now: ProverInfo
        do {
            now = try await info()
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw ProverRefusal(message: String(localized: "Your prover did not answer: \(error.localizedDescription)"))
        }
        guard sameKey(now, kemEk: route.pairing.kemEk, fingerprint: route.pairing.fingerprint) else {
            throw ProverRefusal(message: String(localized: "The prover at that address now has a different key. Pair it again in Settings."))
        }
        guard now.witnessKinds.contains(wants) else {
            throw ProverRefusal(message: wants == "viewing_key"
                ? String(localized: "Your prover does not take viewing-key jobs (it is older than this chain). Update it, or pair another.")
                : String(localized: "Your prover does not take spend-key jobs. Pair your own prover in Settings, or send from the rand command-line wallet."))
        }
        if let fee = feeRefusal(now.fee) {
            throw ProverRefusal(message: String(localized: "This prover charges a fee, which this version of the wallet does not pay (\(fee)). Pair a prover that charges nothing, or send from the rand command-line wallet."))
        }
        return JobCheck(guests: guests, fee: now.fee)
    }

    /// The one status line Settings shows under the pairing.
    static func statusLine(_ probe: Probe) -> String {
        switch probe {
        case .ok(let info):
            let max = info.max > 0 ? String(localized: " of \(info.max)") : ""
            return String(localized: "Answering · \(info.depth)\(max) in its queue.")
        case .unavailable(let why):
            var w = why
            if w.hasSuffix(".") { w.removeLast() }
            return String(localized: "Not answering: \(w).")
        }
    }

    private static func checkedURL(_ text: String) throws -> String {
        switch ProverURLRule.check(text) {
        case .ok(let u): return u
        case .refused(let why): throw ProverRefusal(message: why)
        }
    }
}
