import Foundation

/// Everything scanning has learned, persisted as JSON in Application Support. Purely a cache of
/// chain data plus this wallet's own submissions: every note row is recoverable by rescanning
/// from leaf 0, which is what "Rescan" in Settings does.
struct NoteStore: Codable, Equatable {
    static let timeWindow: UInt64 = 256

    var scannedIndex: UInt64 = 0
    var scannedHeight: UInt64 = 0
    var scannedAttestHeight: UInt64 = 0
    var notes: [OwnedNote] = []
    var sent: [SentRow] = []
    var submissions: [Submission] = []

    /// Spendable SHRUGG (asset 0), in units.
    var balance: UInt64 {
        notes.filter { $0.isSpendable && $0.asset == 0 }.reduce(0) { $0 + $1.units }
    }

    var pendingOut: UInt64 {
        submissions.filter { $0.status == .pending }.reduce(0) { $0 + $1.units + (UInt64($1.fee) ?? 0) }
    }

    /// Merge a scanned page: a leaf is unique by index, so re-offered rows are dropped. A deposit
    /// rebuilt earlier without an index (`isUnplaced`) is placed when its leaf appears.
    mutating func merge(received: [OwnedNote], sent newSent: [SentRow]) {
        for n in received where !notes.contains(where: { $0.index == n.index }) {
            if let i = notes.firstIndex(where: { $0.isUnplaced && $0.cm == n.cm }) {
                notes[i].index = n.index
                notes[i].height = n.height
            } else {
                notes.append(n)
            }
        }
        for s in newSent where !sent.contains(where: { $0.index == s.index }) {
            sent.append(s)
        }
    }

    /// A rebuilt deposit: kept by commitment, placed by `merge` once the leaf is scanned. A leaf
    /// already scanned under this commitment is used directly.
    mutating func addDeposit(_ note: OwnedNote) {
        if notes.contains(where: { $0.cm == note.cm }) { return }
        notes.append(note)
    }

    mutating func markSpent(nullifiers: [String]) {
        let set = Set(nullifiers)
        for i in notes.indices where set.contains(notes[i].nf) {
            notes[i].spent = true
        }
    }

    mutating func holdPending(indices: [UInt64], time: UInt32) {
        for i in notes.indices where indices.contains(notes[i].index) {
            notes[i].pending = time
        }
    }

    /// Clear `pending` on notes the chain has answered for: the spend landed, or the blocks read
    /// reach past the last height the bundle could be admitted at (`time + TIME_WINDOW`).
    mutating func clearPending(readThrough: UInt64) {
        for i in notes.indices {
            if let t = notes[i].pending, notes[i].spent || readThrough > UInt64(t) + Self.timeWindow {
                notes[i].pending = nil
            }
        }
        for i in submissions.indices where submissions[i].status == .pending {
            if readThrough > UInt64(submissions[i].time) + Self.timeWindow {
                submissions[i].status = .failed
            }
        }
    }

    mutating func advanceScannedHeight(pagedTo: UInt64, headBefore: UInt64) {
        scannedHeight = max(scannedHeight, pagedTo, headBefore &+ 1)
    }

    // MARK: persistence

    static func fileURL() throws -> URL {
        let dir = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("RandWallet", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("notes.json")
    }

    static func load() -> NoteStore {
        guard let url = try? fileURL(), let data = try? Data(contentsOf: url),
              let store = try? JSONDecoder().decode(NoteStore.self, from: data) else { return NoteStore() }
        return store
    }

    func save() throws {
        let url = try Self.fileURL()
        let data = try JSONEncoder().encode(self)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
    }

    static func delete() {
        if let url = try? fileURL() { try? FileManager.default.removeItem(at: url) }
    }
}
