import Foundation
import Security

/// Contacts: names for the addresses a user pays often (spec 2026-09-26 §3.3).
///
/// The rules are the CLI's (`randprotocol-client/src/contacts.rs`) and the shared UI's
/// (`ui/lib/contacts.js`), word for word in the refusals:
///   * a name is 1–64 characters (Unicode scalars, as Rust counts `chars`) and does not start with
///     `rand1` or `randpay:` in any case — a name that looked like an address or a link would make
///     "is this a name or a recipient?" ambiguous in the send field;
///   * a name is unique;
///   * an address lives under one name only, so the confirmation line can never name the wrong one.
///
/// This type does not decide what a valid address is — that is the core's (`parse_address`); the
/// contacts screen asks it before calling `add`.
struct ContactBook: Equatable {
    struct Contact: Equatable, Identifiable {
        let name: String
        let address: String
        var id: String { name }
    }

    struct ContactError: LocalizedError, Equatable {
        let message: String
        var errorDescription: String? { message }
    }

    static let nameRule = "a contact name is 1-64 characters and cannot start with rand1 or randpay:"

    private(set) var entries: [String: String] = [:]

    init(entries: [String: String] = [:]) {
        self.entries = entries.filter { !$0.value.isEmpty }
    }

    /// `nil` if `name` is a name the CLI would accept, else the CLI's sentence.
    static func checkName(_ name: String) -> String? {
        let chars = name.unicodeScalars.count
        let lower = name.lowercased()
        if chars == 0 || chars > 64 || lower.hasPrefix("rand1") || lower.hasPrefix("randpay:") { return nameRule }
        return nil
    }

    mutating func add(name: String, address: String) throws {
        if let bad = Self.checkName(name) { throw ContactError(message: bad) }
        let addr = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !addr.isEmpty else { throw ContactError(message: "a contact needs an address") }
        if entries[name] != nil { throw ContactError(message: "a contact named \(name) exists") }
        if let other = self.name(of: addr) { throw ContactError(message: "this address is already saved as \(other)") }
        entries[name] = addr
    }

    mutating func remove(name: String) throws {
        guard entries.removeValue(forKey: name) != nil else { throw ContactError(message: "no contact named \(name)") }
    }

    func address(of name: String) -> String? { entries[name] }

    func name(of address: String) -> String? {
        let addr = address.trimmingCharacters(in: .whitespacesAndNewlines)
        return entries.first { $0.value == addr }?.key
    }

    /// Sorted by name, byte order (the CLI's BTreeMap order).
    var sorted: [Contact] {
        entries.keys.sorted { Array($0.utf8).lexicographicallyPrecedes(Array($1.utf8)) }
            .map { Contact(name: $0, address: entries[$0]!) }
    }
}

/// Where the contact list's bytes live. The app uses the Keychain; tests use memory.
protocol SecretBlobStore: AnyObject {
    func read() -> Data?
    func write(_ data: Data) throws
}

/// A generic-password Keychain item beside the spend key's (same service, its own account),
/// accessible only while this device is unlocked, never synced or migrated.
final class KeychainBlob: SecretBlobStore {
    private let service = "org.randprotocol.wallet"
    private let account: String

    init(account: String) { self.account = account }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    func read() -> Data? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    func write(_ data: Data) throws {
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw Keychain.KeychainError(status: status) }
    }

    func delete() { SecItemDelete(query as CFDictionary) }
}

/// The contact book, persisted as the CLI's file shape `{"entries": {name: address}}` in one
/// Keychain item. Forgetting the wallet deletes it.
final class ContactsStore: ObservableObject {
    @Published private(set) var book: ContactBook
    private let backing: SecretBlobStore

    private struct Disk: Codable { var entries: [String: String] }

    init(backing: SecretBlobStore = KeychainBlob(account: "contacts")) {
        self.backing = backing
        if let data = backing.read(), let disk = try? JSONDecoder().decode(Disk.self, from: data) {
            book = ContactBook(entries: disk.entries)
        } else {
            book = ContactBook()
        }
    }

    func add(name: String, address: String) throws {
        var next = book
        try next.add(name: name, address: address)
        try save(next)
    }

    func remove(name: String) throws {
        var next = book
        try next.remove(name: name)
        try save(next)
    }

    func removeAll() {
        try? save(ContactBook())
    }

    private func save(_ next: ContactBook) throws {
        try backing.write(JSONEncoder().encode(Disk(entries: next.entries)))
        book = next
    }
}
