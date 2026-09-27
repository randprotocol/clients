import XCTest
@testable import RandWallet

/// The contact rules (spec 2026-09-26 §3.3), word for word the CLI's and the shared UI's
/// (`ui/lib/contacts.js`): a name is 1–64 characters, never starts with `rand1` or `randpay:` in
/// any case, is unique, and an address lives under one name only.
final class ContactsTests: XCTestCase {
    private let a1 = "rand1" + String(repeating: "A", count: 40)
    private let a2 = "rand1" + String(repeating: "B", count: 40)

    func testNameRules() {
        let rule = ContactBook.nameRule
        XCTAssertEqual(rule, "a contact name is 1-64 characters and cannot start with rand1 or randpay:")
        XCTAssertEqual(ContactBook.checkName(""), rule)
        XCTAssertEqual(ContactBook.checkName(String(repeating: "x", count: 65)), rule)
        XCTAssertNil(ContactBook.checkName(String(repeating: "x", count: 64)))
        XCTAssertEqual(ContactBook.checkName("rand1alice"), rule)
        XCTAssertEqual(ContactBook.checkName("RAND1alice"), rule)
        XCTAssertEqual(ContactBook.checkName("RandPay:alice"), rule)
        XCTAssertNil(ContactBook.checkName("randy"))
        XCTAssertNil(ContactBook.checkName("alice"))
        // Characters as the CLI counts them (Unicode scalars): 64 two-byte letters are fine.
        XCTAssertNil(ContactBook.checkName(String(repeating: "é", count: 64)))
        XCTAssertEqual(ContactBook.checkName(String(repeating: "é", count: 65)), rule)
    }

    func testAddRefusesADuplicateNameAndASecondNameForOneAddress() throws {
        var book = ContactBook()
        try book.add(name: "alice", address: a1)
        XCTAssertThrowsError(try book.add(name: "alice", address: a2)) { e in
            XCTAssertEqual(e.localizedDescription, "a contact named alice exists")
        }
        XCTAssertThrowsError(try book.add(name: "al", address: "  \(a1)\n")) { e in
            XCTAssertEqual(e.localizedDescription, "this address is already saved as alice")
        }
        XCTAssertThrowsError(try book.add(name: "randpay:bob", address: a2)) { e in
            XCTAssertEqual(e.localizedDescription, ContactBook.nameRule)
        }
        XCTAssertThrowsError(try book.add(name: "bob", address: "  ")) { e in
            XCTAssertEqual(e.localizedDescription, "a contact needs an address")
        }
        try book.add(name: "bob", address: a2)
        XCTAssertEqual(book.sorted.map(\.name), ["alice", "bob"])
        XCTAssertEqual(book.address(of: "bob"), a2)
        XCTAssertEqual(book.name(of: a1), "alice")
        XCTAssertNil(book.name(of: "rand1nobody"))
    }

    func testRemove() throws {
        var book = ContactBook()
        try book.add(name: "alice", address: a1)
        try book.remove(name: "alice")
        XCTAssertNil(book.address(of: "alice"))
        XCTAssertThrowsError(try book.remove(name: "alice")) { e in
            XCTAssertEqual(e.localizedDescription, "no contact named alice")
        }
    }

    /// The stored form is the CLI's file shape, `{"entries": {name: address}}`, and survives a
    /// reload through the store.
    func testStorePersistsTheCliShape() throws {
        let backing = MemoryBlob()
        let store = ContactsStore(backing: backing)
        try store.add(name: "alice", address: a1)
        let json = try JSONSerialization.jsonObject(with: XCTUnwrap(backing.data)) as? [String: Any]
        XCTAssertEqual(json?["entries"] as? [String: String], ["alice": a1])
        let reloaded = ContactsStore(backing: backing)
        XCTAssertEqual(reloaded.book.address(of: "alice"), a1)
        try reloaded.remove(name: "alice")
        XCTAssertTrue(ContactsStore(backing: backing).book.sorted.isEmpty)
    }

    /// Garbage in the store reads as an empty book, never a crash.
    func testACorruptStoreReadsEmpty() {
        let backing = MemoryBlob()
        backing.data = Data("not json".utf8)
        XCTAssertTrue(ContactsStore(backing: backing).book.sorted.isEmpty)
    }

    /// The real backing: a Keychain item beside the spend key's (a distinct account).
    func testKeychainBackingRoundTrips() throws {
        let backing = KeychainBlob(account: "contacts-test")
        backing.delete()
        defer { backing.delete() }
        XCTAssertNil(backing.read())
        try backing.write(Data("{}".utf8))
        XCTAssertEqual(backing.read(), Data("{}".utf8))
    }
}

final class MemoryBlob: SecretBlobStore {
    var data: Data?
    func read() -> Data? { data }
    func write(_ data: Data) throws { self.data = data }
}
