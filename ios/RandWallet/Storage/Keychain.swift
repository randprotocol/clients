import Foundation
import Security
import LocalAuthentication

/// The spend key, and nothing else, in the Keychain: accessible only when this device is unlocked,
/// never synced or migrated to another device.
enum Keychain {
    private static let service = "org.randprotocol.wallet"
    private static let account = "spend_key"

    struct KeychainError: LocalizedError {
        let status: OSStatus
        var errorDescription: String? { "keychain error \(status)" }
    }

    static func saveSpendKey(_ hex: String) throws {
        let data = Data(hex.utf8)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service,
                                    kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    static func loadSpendKey() -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service,
                                    kSecAttrAccount as String: account,
                                    kSecReturnData as String: true,
                                    kSecMatchLimit as String: kSecMatchLimitOne]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static var hasSpendKey: Bool { loadSpendKey() != nil }

    static func deleteSpendKey() {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service,
                                    kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
    }

    /// Face ID / Touch ID with the device passcode as fallback. On the simulator with no biometrics
    /// enrolled this still shows the passcode prompt.
    static func authenticate(reason: String) async -> Bool {
        let ctx = LAContext()
        ctx.localizedCancelTitle = "Cancel"
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
        default: return "passcode"
        }
    }
}
