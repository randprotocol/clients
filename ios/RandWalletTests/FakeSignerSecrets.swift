@testable import RandWallet
import Foundation

/// The Keychain stand-in: records, per item, whether it was stored behind user presence and how
/// often it was read with a prompt. The simulator has no passcode, so `.userPresence` cannot be
/// created there; the device check is manual (task-10 report).
final class FakeSignerSecrets: SignerSecrets {
    var items: [String: (data: Data, presence: Bool)] = [:]
    var promptedReads: [String] = []
    var canRequireUserPresence = true
    /// Runs inside a prompted read, where the system's Face ID / passcode sheet would be: a test
    /// moves the chain on here to stand for the time a person takes to authenticate.
    var duringPrompt: () -> Void = {}
    /// A failing save for the named account (a full Keychain, a passcode removed mid-add).
    var failSaveFor: String?

    func save(_ data: Data, account: String, requireUserPresence: Bool) throws {
        if account == failSaveFor { throw Keychain.KeychainError(status: errSecNotAvailable) }
        items[account] = (data, requireUserPresence)
    }
    func load(account: String, prompt: String?) throws -> Data? {
        if prompt != nil { promptedReads.append(account); duringPrompt() }
        return items[account]?.data
    }
    func delete(account: String) { items[account] = nil }
    /// The Keychain listing fails (`SecItemCopyMatching` refused): the sweep throws, nothing deleted.
    var failListing = false
    func deleteAll(accountPrefix: String, keeping: Set<String>) throws {
        if failListing { throw Keychain.KeychainError(status: errSecInteractionNotAllowed) }
        items = items.filter { !$0.key.hasPrefix(accountPrefix) || keeping.contains($0.key) }
    }
}
