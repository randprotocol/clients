import XCTest
@testable import RandWallet

/// The one-time chain-id migration (wallet v0.8.0 runs chain 21 onward): a saved 20 becomes 21 on
/// the first launch, once, and nothing else changes.
final class SettingsMigrationTests: XCTestCase {
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUp() {
        suite = "SettingsMigrationTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }
    override func tearDown() { defaults.removePersistentDomain(forName: suite) }

    func testASavedTwentyBecomesTwentyOneAndNothingElseChanges() {
        defaults.set(20, forKey: "chainId")
        defaults.set("http://10.0.0.5:8545", forKey: "rpcUrl")
        defaults.set(5, forKey: "autoLockMinutes")
        Settings.migrateChainId(defaults)
        XCTAssertEqual(defaults.object(forKey: "chainId") as? Int, 21)
        XCTAssertEqual(defaults.string(forKey: "rpcUrl"), "http://10.0.0.5:8545", "the RPC URL is not touched")
        XCTAssertEqual(defaults.object(forKey: "autoLockMinutes") as? Int, 5)
        XCTAssertTrue(defaults.bool(forKey: Settings.chainMigrationKey))
    }

    func testItRunsOnce() {
        defaults.set(20, forKey: "chainId")
        Settings.migrateChainId(defaults)
        defaults.set(20, forKey: "chainId")   // the user chose 20 again afterwards
        Settings.migrateChainId(defaults)
        XCTAssertEqual(defaults.object(forKey: "chainId") as? Int, 20, "a later launch leaves the user's choice alone")
    }

    func testOtherValuesAndNoValueAreLeftAlone() {
        defaults.set(13, forKey: "chainId")
        Settings.migrateChainId(defaults)
        XCTAssertEqual(defaults.object(forKey: "chainId") as? Int, 13)

        let fresh = "\(suite!).fresh"
        let empty = UserDefaults(suiteName: fresh)!
        defer { empty.removePersistentDomain(forName: fresh) }
        Settings.migrateChainId(empty)
        XCTAssertNil(empty.object(forKey: "chainId"), "no saved chain id: none is written")
        XCTAssertEqual(Set(empty.persistentDomain(forName: fresh)?.keys.map { $0 } ?? []), [Settings.chainMigrationKey])
    }
}
