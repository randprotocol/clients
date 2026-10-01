import Foundation
import SwiftUI

/// User settings, published so views refresh, persisted in UserDefaults. Nothing secret here.
final class Settings: ObservableObject {
    enum Theme: String, CaseIterable, Identifiable {
        case system, dark, light
        var id: String { rawValue }
        var colorScheme: ColorScheme? {
            switch self {
            case .system: return nil
            case .dark: return .dark
            case .light: return .light
            }
        }
    }

    private let defaults = UserDefaults.standard

    @Published var rpcUrl: String { didSet { defaults.set(rpcUrl, forKey: "rpcUrl") } }
    @Published var chainId: Int { didSet { defaults.set(chainId, forKey: "chainId") } }
    @Published var autoLockMinutes: Int { didSet { defaults.set(autoLockMinutes, forKey: "autoLockMinutes") } }
    @Published var theme: Theme { didSet { defaults.set(theme.rawValue, forKey: "theme") } }
    @Published var hasBackedUpKey: Bool { didSet { defaults.set(hasBackedUpKey, forKey: "hasBackedUpKey") } }
    /// The paired prover (delegated proving), or `nil`: proofs are made on this device. Its five
    /// public fields only, and DISPLAY ONLY: the token, the key and URL a job is sealed and sent
    /// to, and the `own` a spend-key job is gated on, are in the Keychain
    /// (`Keychain.saveProverSecret`), so a tampered copy here cannot redirect a job or promote a
    /// pairing. Written by `ProverPairingService` alone, which checks the prover's key first.
    @Published var prover: ProverPairing? {
        didSet {
            if let p = prover, let data = try? JSONEncoder().encode(p) { defaults.set(data, forKey: "prover") }
            else { defaults.removeObject(forKey: "prover") }
        }
    }

    /// The user chose NO prover (wallet 0.6.8): the RandProtocol prover, otherwise the default
    /// where this device cannot prove, is not used either. Pairing a prover, or "Use the
    /// RandProtocol prover", clears it.
    @Published var noProver: Bool { didSet { defaults.set(noProver, forKey: "noProver") } }
    /// The address of the wallet that read the one-time notice about the RandProtocol prover, or
    /// `nil`. A record naming another wallet counts for nothing; removing the wallet clears it.
    @Published var proverNoticeFor: String? {
        didSet {
            if let a = proverNoticeFor { defaults.set(a, forKey: "proverNoticeFor") } else { defaults.removeObject(forKey: "proverNoticeFor") }
        }
    }

    init() {
        let core = try? RandCore.constants()
        rpcUrl = defaults.string(forKey: "rpcUrl") ?? core?.defaultRpcUrl ?? "https://rpc.randprotocol.org"
        chainId = defaults.object(forKey: "chainId") as? Int ?? Int(core?.defaultChainId ?? 19)
        autoLockMinutes = defaults.object(forKey: "autoLockMinutes") as? Int ?? 15
        theme = Theme(rawValue: defaults.string(forKey: "theme") ?? "") ?? .system
        hasBackedUpKey = defaults.bool(forKey: "hasBackedUpKey")
        prover = defaults.data(forKey: "prover").flatMap { try? JSONDecoder().decode(ProverPairing.self, from: $0) }
        noProver = defaults.bool(forKey: "noProver")
        proverNoticeFor = defaults.string(forKey: "proverNoticeFor")
    }

    var rpcURL: URL? { URL(string: rpcUrl.trimmingCharacters(in: .whitespaces)) }

    static let explorerURL = URL(string: "https://randscan.org")!
    static var explorerViewingURL: URL { explorerURL.appendingPathComponent("viewing") }
    static func explorerTransactionURL(_ hash: String) -> URL {
        explorerURL.appendingPathComponent("transactions").appendingPathComponent(hash)
    }
}
