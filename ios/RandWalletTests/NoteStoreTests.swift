import XCTest
@testable import RandWallet

final class NoteStoreTests: XCTestCase {
    private func note(_ index: UInt64, amount: UInt64, cm: String? = nil, height: UInt64 = 1) -> OwnedNote {
        OwnedNote(index: index, note: "00", cm: cm ?? "cm\(index)", nf: "nf\(index)", amount: String(amount), asset: 0,
                  time: 1, from: "pk", height: height, spent: false, pending: nil)
    }

    func testMergeIsByLeafIndexAndBalanceCountsSpendableOnly() {
        var s = NoteStore()
        s.merge(received: [note(1, amount: 5), note(2, amount: 0)], sent: [])
        s.merge(received: [note(1, amount: 5), note(3, amount: 7)], sent: [])
        XCTAssertEqual(s.notes.count, 3)
        XCTAssertEqual(s.balance, 12)
        s.markSpent(nullifiers: ["nf3"])
        XCTAssertEqual(s.balance, 5)
        XCTAssertTrue(s.notes.first { $0.index == 3 }!.spent)
    }

    func testPendingClearsOnSpendOrAfterTheWindow() {
        var s = NoteStore()
        s.merge(received: [note(1, amount: 5), note(2, amount: 6)], sent: [])
        s.holdPending(indices: [1, 2], time: 100)
        XCTAssertEqual(s.balance, 0)
        s.markSpent(nullifiers: ["nf1"])
        s.clearPending(readThrough: 100 + NoteStore.timeWindow)
        XCTAssertNil(s.notes[0].pending)
        XCTAssertTrue(s.notes[0].spent)
        XCTAssertEqual(s.notes[1].pending, 100)
        s.clearPending(readThrough: 100 + NoteStore.timeWindow + 1)
        XCTAssertNil(s.notes[1].pending)
        XCTAssertEqual(s.balance, 6)
    }

    func testRebuiltDepositIsPlacedWhenItsLeafArrives() {
        var s = NoteStore()
        var deposit = note(UInt64.max, amount: 9, cm: "cmdep", height: 0)
        deposit.index = UInt64.max
        s.addDeposit(deposit)
        s.addDeposit(deposit)
        XCTAssertEqual(s.notes.count, 1)
        XCTAssertTrue(s.notes[0].isUnplaced)
        s.merge(received: [note(40, amount: 9, cm: "cmdep", height: 37)], sent: [])
        XCTAssertEqual(s.notes.count, 1)
        XCTAssertEqual(s.notes[0].index, 40)
        XCTAssertEqual(s.notes[0].height, 37)
    }

    func testScannedHeightNeverRunsAheadOfWhatWasRead() {
        var s = NoteStore()
        s.scannedHeight = 10
        s.advanceScannedHeight(pagedTo: 10, headBefore: 20)
        XCTAssertEqual(s.scannedHeight, 21)
        s.advanceScannedHeight(pagedTo: 30, headBefore: 25)
        XCTAssertEqual(s.scannedHeight, 30)
    }

    func testAmountFormatAndParseRoundTrip() {
        XCTAssertEqual(Amount.format(1_500_000_000), "1.5")
        XCTAssertEqual(Amount.format(1), "0.000000001")
        XCTAssertEqual(Amount.format(42_000_000_000), "42")
        XCTAssertEqual(Amount.parse("1.5"), 1_500_000_000)
        XCTAssertEqual(Amount.parse(".25"), 250_000_000)
        XCTAssertEqual(Amount.parse("3"), 3_000_000_000)
        XCTAssertNil(Amount.parse("0.0000000001"))
        XCTAssertNil(Amount.parse("abc"))
        XCTAssertNil(Amount.parse(""))
    }
}
