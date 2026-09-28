import Foundation

/// A paired prover as Settings keeps it: public fields only. The token is in the Keychain.
struct ProverPairing: Codable, Equatable {
    /// What the proving screen calls it: the prover's host (and port).
    var name: String
    var url: String
    /// The prover's ML-KEM-768 encapsulation key, lowercase hex (1 184 bytes).
    var kemEk: String
    var fingerprint: String
    /// The link was made with `own=1`. Phase 1 sends a spend-key job to such a prover only.
    var own: Bool
}

/// Pairing, probing and forgetting a prover — the Swift twin of `ui/engine/backend-shared.js`'s
/// `prover` group. The link is read by the core (`parse_prover_link`); the prover's key is asked of
/// the prover itself and must be the one the link names, the fingerprint recomputed by the core
/// from that key (the prover's own `kem_fingerprint` is its word, not evidence). Only then is
/// anything stored.
enum ProverPairingService {
    /// Copy, Phase 1 (spec §4.4), shown before a pairing is saved.
    static let warning = "This prover will receive your spend key each time it makes a proof. Anyone who controls it can spend your funds. Pair only a machine you run yourself."

    static let notOwnWarning = "This link does not mark the prover as your own, so this version of the wallet will never send it a job: pair only a prover you run yourself, from a link it made with own=1."

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
        /// Set when the link is not marked `own`: such a pairing is saved but never used.
        let warning: String?
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
        return Preview(url: url, fingerprint: p.fingerprint, own: p.own, warning: p.own ? nil : notOwnWarning)
    }

    /// Whether the prover's reported key is the pairing's.
    static func sameKey(_ info: ProverInfo, kemEk: String, fingerprint: String) -> Bool {
        guard !info.kemEk.isEmpty, info.kemEk == kemEk.lowercased() else { return false }
        return (try? self.fingerprint(kemEk: info.kemEk)) == fingerprint
    }

    /// Asks the prover for its key and returns the pairing and its token — stores nothing.
    static func pair(_ link: String, session: URLSession? = nil) async throws -> (pairing: ProverPairing, token: String) {
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
        let name = comps?.port.map { "\(host):\($0)" } ?? host
        return (ProverPairing(name: name, url: url, kemEk: p.kemEk, fingerprint: p.fingerprint, own: p.own), p.token)
    }

    /// The token in the Keychain first, then the pairing in Settings: a pairing is never visible
    /// without the token it needs.
    @MainActor
    static func save(_ pairing: ProverPairing, token: String, settings: Settings) throws {
        try Keychain.saveProverToken(token)
        settings.prover = pairing
    }

    @MainActor
    static func forget(settings: Settings) {
        settings.prover = nil
        Keychain.deleteProverToken()
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

    /// A remote route: the pairing and its token.
    struct Route {
        let pairing: ProverPairing
        let token: String
    }

    /// Where a send's proof is made. `nil` = this device: it can prove, or no prover is paired as
    /// the user's own (Phase 1 sends a spend-key job nowhere else). A paired own prover that does
    /// not answer, answers with another key, or takes no spend-key job — or whose token is gone —
    /// refuses the send here, before anything is built: nothing is sent.
    static func route(deviceCanProve: Bool, pairing: ProverPairing?,
                      probe: (ProverPairing) async -> Probe, token: () -> String?) async throws -> Route? {
        if deviceCanProve { return nil }
        guard let p = pairing, p.own else { return nil }
        let reason = "This device does not have the memory for this proof."
        switch await probe(p) {
        case .unavailable(let why):
            throw ProverRefusal(message: "\(reason) Your paired prover is not available: \(why).")
        case .ok(let info) where !info.witnessKinds.contains("spend_key"):
            throw ProverRefusal(message: "\(reason) Your paired prover is not available: it does not take a spend-key job.")
        case .ok:
            break
        }
        guard let t = token(), !t.isEmpty else {
            throw ProverRefusal(message: "Your prover's pairing could not be opened. Pair the prover again in Settings.")
        }
        return Route(pairing: p, token: t)
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
