import Foundation
import Security
import LocalAuthentication

/// The spend key in the Keychain — and, beside it under its own account, a paired prover's secret
/// record (delegated proving: the token AND the key and URL a job is sealed to, and whether the
/// link marked the prover the owner's own) — accessible only when this device is unlocked, never
/// synced or migrated to another device.
enum Keychain {
    private static let service = "org.randprotocol.wallet"
    private static let account = "spend_key"
    private static let proverPairingAccount = "prover_pairing"
    /// A pre-release build's bare token. Never read (it names no seal target: pair again); removed
    /// with the pairing.
    private static let legacyProverTokenAccount = "prover_token"

    struct KeychainError: LocalizedError {
        let status: OSStatus
        var errorDescription: String? { String(localized: "keychain error \(status)") }
    }

    static func saveSpendKey(_ hex: String) throws { try save(hex, account: account) }
    static func loadSpendKey() -> String? { load(account: account) }
    static var hasSpendKey: Bool { loadSpendKey() != nil }
    static func deleteSpendKey() { delete(account: account) }

    /// The paired prover's secret record, `{token, kemEk, url, fingerprint, own}` as JSON. The
    /// token travels only inside a job the core sealed to the prover's key; the key, URL and `own`
    /// here — not `Settings.prover`, which is display only — decide where that job is sealed and
    /// sent, and whether an older chain's spend-key job may go at all. Never in `Settings`, never
    /// in a log.
    static func saveProverSecret(_ secret: ProverSecret) throws {
        let json = String(decoding: try JSONEncoder().encode(secret), as: UTF8.self)
        try save(json, account: proverPairingAccount)
        delete(account: legacyProverTokenAccount)
    }
    static func loadProverSecret() -> ProverSecret? {
        load(account: proverPairingAccount).flatMap { ProverSecret.decode($0) }
    }
    static func deleteProverSecret() {
        delete(account: proverPairingAccount)
        delete(account: legacyProverTokenAccount)
    }

    private static func save(_ value: String, account: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service,
                                    kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    private static func load(account: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service,
                                    kSecAttrAccount as String: account,
                                    kSecReturnData as String: true,
                                    kSecMatchLimit as String: kSecMatchLimitOne]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func delete(account: String) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service,
                                    kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
    }

    /// Face ID / Touch ID with the device passcode as fallback. On the simulator with no biometrics
    /// enrolled this still shows the passcode prompt.
    static func authenticate(reason: String) async -> Bool {
        let ctx = LAContext()
        ctx.localizedCancelTitle = String(localized: "Cancel")
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else {
            // No passcode set: nothing to authenticate against; let the user in rather than lock
            // them out of their own funds.
            return true
        }
        return (try? await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
    }

    static var biometryName: String {
        let ctx = LAContext()
        _ = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch ctx.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        default: return String(localized: "passcode")
        }
    }
}
