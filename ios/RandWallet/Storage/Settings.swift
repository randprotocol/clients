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

    init() {
        let core = try? RandCore.constants()
        rpcUrl = defaults.string(forKey: "rpcUrl") ?? core?.defaultRpcUrl ?? "https://rpc.randprotocol.org"
        chainId = defaults.object(forKey: "chainId") as? Int ?? Int(core?.defaultChainId ?? 8)
        autoLockMinutes = defaults.object(forKey: "autoLockMinutes") as? Int ?? 15
        theme = Theme(rawValue: defaults.string(forKey: "theme") ?? "") ?? .system
        hasBackedUpKey = defaults.bool(forKey: "hasBackedUpKey")
    }

    var rpcURL: URL? { URL(string: rpcUrl.trimmingCharacters(in: .whitespaces)) }

    static let explorerURL = URL(string: "https://randscan.org")!
    static var explorerViewingURL: URL { explorerURL.appendingPathComponent("viewing") }
    static func explorerTransactionURL(_ hash: String) -> URL {
        explorerURL.appendingPathComponent("transactions").appendingPathComponent(hash)
    }
}
