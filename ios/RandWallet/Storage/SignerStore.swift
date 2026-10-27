import Foundation
import Security
import LocalAuthentication

/// Where signer profiles keep their secrets: the Keychain (`KeychainSignerSecrets`), or a test's
/// stand-in.
protocol SignerSecrets {
    /// `requireUserPresence`: the item is readable only after Face ID, Touch ID or the passcode.
    func save(_ data: Data, account: String, requireUserPresence: Bool) throws
    /// `prompt` non-nil: the item is behind user presence and the system asks now, with `prompt`
    /// as the reason. nil when there is no such item.
    func load(account: String, prompt: String?) throws -> Data?
    func delete(account: String)
    /// Deletes every item whose account starts with `accountPrefix`, listed or not, except the
    /// accounts in `keeping`. Throws when the items cannot be listed or one cannot be deleted;
    /// nothing to delete is success.
    func deleteAll(accountPrefix: String, keeping: Set<String>) throws
    /// Whether this device has a passcode, without which an item cannot be kept behind user presence.
    var canRequireUserPresence: Bool { get }
}

/// Keychain items beside the spend key's, never synced or migrated to another device. The policy
/// and the profile list are `WhenUnlockedThisDeviceOnly`. The seed's item is
/// `WhenPasscodeSetThisDeviceOnly` with `.userPresence`: each read asks for Face ID, Touch ID or the
/// passcode, and the system deletes the item if the device passcode is removed.
final class KeychainSignerSecrets: SignerSecrets {
    private let service = "org.randprotocol.wallet"

    var canRequireUserPresence: Bool { LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) }

    private func base(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    func save(_ data: Data, account: String, requireUserPresence: Bool) throws {
        SecItemDelete(base(account) as CFDictionary)
        var add = base(account)
        add[kSecValueData as String] = data
        if requireUserPresence {
            var error: Unmanaged<CFError>?
            guard let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .userPresence, &error) else {
                error?.release()
                throw Keychain.KeychainError(status: errSecParam)
            }
            add[kSecAttrAccessControl as String] = ac
        } else {
            add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        }
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw Keychain.KeychainError(status: status) }
    }

    func load(account: String, prompt: String?) throws -> Data? {
        var q = base(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        if let prompt {
            // A fresh context per read, with no reuse window: an earlier Face ID match does not
            // carry over to the next signature.
            let ctx = LAContext()
            ctx.localizedReason = prompt
            ctx.touchIDAuthenticationAllowableReuseDuration = 0
            q[kSecUseAuthenticationContext as String] = ctx
        }
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let cf = item as? Data else {
            if status == errSecSuccess { return nil }
            throw Keychain.KeychainError(status: status)
        }
        // `cf` wraps the Security framework's immutable CFData; zeroing it through `Data` would
        // copy-on-write and free the original unzeroed. The caller gets its own buffer, which it
        // can zero in place; the framework's copy is outside its reach.
        return cf.withUnsafeBytes { raw in Data(raw) }
    }

    func delete(account: String) {
        SecItemDelete(base(account) as CFDictionary)
    }

    /// Lists this service's items by attributes only (no data, so no prompt even for an item
    /// behind user presence) and deletes each one whose account has the prefix. The service is
    /// shared with the spend key and the prover pairing, so the sweep goes by account, never by
    /// service alone.
    func deleteAll(accountPrefix: String, keeping: Set<String>) throws {
        let ctx = LAContext()
        ctx.interactionNotAllowed = true
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitAll]
        q[kSecUseAuthenticationContext as String] = ctx
        var items: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &items)
        if status == errSecItemNotFound { return }
        guard status == errSecSuccess else { throw Keychain.KeychainError(status: status) }
        guard let list = items as? [[String: Any]] else { throw Keychain.KeychainError(status: errSecInternalError) }
        for attrs in list {
            guard let account = attrs[kSecAttrAccount as String] as? String, account.hasPrefix(accountPrefix),
                  !keeping.contains(account) else { continue }
            let deleted = SecItemDelete(base(account) as CFDictionary)
            guard deleted == errSecSuccess || deleted == errSecItemNotFound else { throw Keychain.KeychainError(status: deleted) }
        }
    }
}

/// What the profile list shows; the policy and the seed are in their own items.
struct SignerProfile: Codable, Identifiable, Equatable {
    let id: String
    var label: String
    let index: Int
    let fingerprint: String
    let threshold: Int
    let signers: Int
    let address: String
    let policyHash: String
    /// The highest fee this signer signs, in base units; nil (a profile saved before 0.8.2) is
    /// `MsauthRules.defaultMaxFeeUnits`, 0.1 RAND.
    var maxFee: String? = nil

    /// The limit the signing rule applies.
    var feeLimit: String { MsauthRules.feeLimit(maxFee) }
}

/// Signer profiles (spec §3), in three kinds of item: `msauth.index` (the list),
/// `msauth.<id>.policy` and `msauth.<id>.seed` (behind user presence). The seed is read once per
/// signature, with the system's prompt, and is not kept by this class.
final class SignerStore: ObservableObject {
    static let shared = SignerStore(secrets: KeychainSignerSecrets())

    @Published private(set) var profiles: [SignerProfile] = []
    private let secrets: SignerSecrets
    private static let indexAccount = "msauth.index"
    private static func seedAccount(_ id: String) -> String { "msauth.\(id).seed" }
    private static func policyAccount(_ id: String) -> String { "msauth.\(id).policy" }

    struct StoreError: LocalizedError, Equatable { let errorDescription: String? }

    init(secrets: SignerSecrets) {
        self.secrets = secrets
        if let d = try? secrets.load(account: Self.indexAccount, prompt: nil),
           let list = try? JSONDecoder().decode([SignerProfile].self, from: d) {
            profiles = list
        }
    }

    /// Saves a profile: the label (1-64 characters), the policy, and the key — a `rand-node keygen`
    /// file or 64 hex — which must be one of the policy's signers. Refused without a device
    /// passcode, and for a signer already saved. Nothing is left behind when a save fails.
    func add(label: String, policy: String, key: String, maxFee: String = "") throws -> SignerProfile {
        guard secrets.canRequireUserPresence else {
            throw StoreError(errorDescription: String(localized: "Set a device passcode first: a signer key is read only after Face ID, Touch ID or the passcode."))
        }
        let name = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.unicodeScalars.count <= 64 else { throw StoreError(errorDescription: String(localized: "a signer label is 1-64 characters")) }
        // The fee limit, typed in RAND; empty is the default (0.1 RAND).
        let typedFee = maxFee.trimmingCharacters(in: .whitespacesAndNewlines)
        let limit: String
        if typedFee.isEmpty {
            limit = MsauthRules.defaultMaxFeeUnits
        } else if let units = MsauthRules.parseMaxFee(typedFee) {
            limit = units
        } else {
            throw StoreError(errorDescription: String(localized: "An amount is a number of RAND, such as 1.5."))
        }
        let pol = MsauthRules.clean(policy)
        let info = try RandCore.msauthPolicyInfo(pol)
        // The core's reply carries the seed as a hex String, which cannot be wiped; only the Data
        // copy below is.
        let signer = try RandCore.msauthSignerImport(MsauthRules.clean(key), policy: pol)
        guard let index = signer.index else { throw RandCore.CoreError(message: "this key is not one of the policy's signers") }
        if let same = profiles.first(where: { $0.policyHash == info.policyHash && $0.index == index }) {
            throw StoreError(errorDescription: String(localized: "this signer is already saved as \(same.label)"))
        }
        guard var seed = Data(hex: signer.seed), seed.count == 32 else { throw RandCore.CoreError(message: "a signer seed is 64 hex characters") }
        defer { seed.resetBytes(in: 0..<seed.count) }
        let id = UUID().uuidString.lowercased()
        let p = SignerProfile(id: id, label: name, index: index, fingerprint: info.fingerprint, threshold: info.threshold,
                              signers: info.signers, address: info.address, policyHash: info.policyHash, maxFee: limit)
        do {
            try secrets.save(seed, account: Self.seedAccount(id), requireUserPresence: true)
            try secrets.save(Data(pol.utf8), account: Self.policyAccount(id), requireUserPresence: false)
            try writeIndex(profiles + [p])
        } catch {
            secrets.delete(account: Self.seedAccount(id))
            secrets.delete(account: Self.policyAccount(id))
            throw error
        }
        profiles.append(p)
        return p
    }

    func remove(_ id: String) {
        secrets.delete(account: Self.seedAccount(id))
        secrets.delete(account: Self.policyAccount(id))
        profiles.removeAll { $0.id == id }
        try? writeIndex(profiles)
    }

    /// Every profile, and the list itself (forgetting the wallet). The sweep comes first and also
    /// takes an item the index does not list (an index that no longer decodes, a crash between
    /// the seed's save and the index's). The index is deleted only after the sweep succeeded:
    /// when the sweep fails, the index and `profiles` are kept, so a retry still finds what is
    /// left, and the error is thrown.
    func removeAll() throws {
        for p in profiles {
            secrets.delete(account: Self.seedAccount(p.id))
            secrets.delete(account: Self.policyAccount(p.id))
        }
        try secrets.deleteAll(accountPrefix: "msauth.", keeping: [Self.indexAccount])
        secrets.delete(account: Self.indexAccount)
        profiles = []
    }

    func policy(_ id: String) throws -> String {
        guard let d = try secrets.load(account: Self.policyAccount(id), prompt: nil) else {
            throw StoreError(errorDescription: String(localized: "No such signer profile."))
        }
        return String(decoding: d, as: UTF8.self)
    }

    private func readSeed(_ id: String, reason: String) throws -> Data {
        guard let seed = try secrets.load(account: Self.seedAccount(id), prompt: reason) else {
            throw StoreError(errorDescription: String(localized: "This signer profile has no key on this device: remove it and add it again."))
        }
        return seed
    }

    /// One prompted read of the seed for `body`. The seed is in a buffer this store owns (copied
    /// once out of the Keychain's reply), zeroed in place with `resetBytes` when `body` returns or
    /// throws. The Security framework's own copy cannot be wiped from here; nor can a copy `body`
    /// makes and keeps (the core path makes a hex String, see `RandCore.msauthSign`).
    func withSeed<T>(_ id: String, reason: String, _ body: (Data) throws -> T) throws -> T {
        var seed = try readSeed(id, reason: reason)
        defer { seed.resetBytes(in: 0..<seed.count) }
        return try body(seed)
    }

    /// `withSeed` for a body that awaits (the head re-read after the prompt). The Keychain read
    /// blocks while the system asks: call this off the main thread.
    func withSeedAsync<T>(_ id: String, reason: String, _ body: (Data) async throws -> T) async throws -> T {
        var seed = try readSeed(id, reason: reason)
        defer { seed.resetBytes(in: 0..<seed.count) }
        return try await body(seed)
    }

    private func writeIndex(_ list: [SignerProfile]) throws {
        try secrets.save(try JSONEncoder().encode(list), account: Self.indexAccount, requireUserPresence: false)
    }
}
