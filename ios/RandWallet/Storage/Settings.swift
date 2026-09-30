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
    /// The paired prover (delegated proving, Phase 1), or `nil`: proofs are made on this device.
    /// Its five public fields only, and DISPLAY ONLY: the token, and the key and URL a job is sealed
    /// and sent to, are in the Keychain (`Keychain.saveProverSecret`), so a tampered copy here
    /// cannot redirect a job. Written by `ProverPairingService` alone, which checks the prover's key
    /// first.
    @Published var prover: ProverPairing? {
        didSet {
            if let p = prover, let data = try? JSONEncoder().encode(p) { defaults.set(data, forKey: "prover") }
            else { defaults.removeObject(forKey: "prover") }
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
    }

    var rpcURL: URL? { URL(string: rpcUrl.trimmingCharacters(in: .whitespaces)) }

    static let explorerURL = URL(string: "https://randscan.org")!
    static var explorerViewingURL: URL { explorerURL.appendingPathComponent("viewing") }
    static func explorerTransactionURL(_ hash: String) -> URL {
        explorerURL.appendingPathComponent("transactions").appendingPathComponent(hash)
    }
}
