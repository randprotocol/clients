import XCTest
@testable import RandWallet

/// The hand-off from an incoming `randpay:` link to the Send screen (HomeView). The link itself
/// stays in `LinkRouter` until Send takes it, so it can never be lost; this decides only *when*
/// Send is presented — straight away, or once every sheet has actually finished dismissing.
final class LinkHandoffTests: XCTestCase {
    func testNothingUpPresentsSendAtOnce() {
        var h = LinkHandoff()
        XCTAssertEqual(h.linkArrived(sheetUp: false, sendUp: false), .presentSend)
        XCTAssertFalse(h.waiting)
    }

    func testASheetUpIsDismissedFirstAndSendFollowsItsDismissal() {
        var h = LinkHandoff()
        XCTAssertEqual(h.linkArrived(sheetUp: true, sendUp: false), .dismissSheets)
        XCTAssertTrue(h.waiting)
        // However long the dismissal takes, Send follows the completion, never a timer.
        XCTAssertEqual(h.presentationEnded(linkPending: true, sheetUp: false, sendUp: false), .presentSend)
        XCTAssertFalse(h.waiting)
        // A later, unrelated dismissal presents nothing.
        XCTAssertEqual(h.presentationEnded(linkPending: false, sheetUp: false, sendUp: false), .none)
    }

    func testSendAlreadyUpTakesTheLinkItself() {
        var h = LinkHandoff()
        XCTAssertEqual(h.linkArrived(sheetUp: false, sendUp: true), .none)
        // Send was mid-proof and did not take it: the link is still pending when Send closes.
        XCTAssertEqual(h.presentationEnded(linkPending: true, sheetUp: false, sendUp: false), .presentSend)
    }

    func testAPendingLinkWaitsWhileAnythingIsStillPresented() {
        var h = LinkHandoff()
        _ = h.linkArrived(sheetUp: true, sendUp: false)
        XCTAssertEqual(h.presentationEnded(linkPending: true, sheetUp: true, sendUp: false), .none)
        XCTAssertTrue(h.waiting)
        XCTAssertEqual(h.presentationEnded(linkPending: true, sheetUp: false, sendUp: false), .presentSend)
    }

    /// A second link while the first one's dismissal is still in flight must not present Send
    /// early: the sheets' flags are already down, but SwiftUI has not finished dismissing them
    /// (final review, finding 9). Send still follows the dismissal's completion.
    func testASecondLinkDuringADismissalWaitsForIt() {
        var h = LinkHandoff()
        XCTAssertEqual(h.linkArrived(sheetUp: true, sendUp: false), .dismissSheets)
        XCTAssertEqual(h.linkArrived(sheetUp: false, sendUp: false), .none)
        XCTAssertTrue(h.waiting)
        XCTAssertEqual(h.presentationEnded(linkPending: true, sheetUp: false, sendUp: false), .presentSend)
        XCTAssertFalse(h.waiting)
    }

    /// Re-opening the same link Send already holds clears the amount and memo; the recipient text
    /// does not change, so `onChange(of: recipient)` never fires — the intake says to resolve it
    /// again explicitly so the link's amount and memo are filled back in (final review, finding 9).
    func testTheSameLinkAgainIsResolvedAgain() {
        let link = "randpay:rand1abc?amount=1&memo=hi"
        let same = LinkIntake.take(link: link, currentRecipient: link)
        XCTAssertEqual(same, LinkIntake(recipient: link, amount: "", memo: "", resolveNow: true))
        let other = LinkIntake.take(link: link, currentRecipient: "rand1old")
        XCTAssertEqual(other, LinkIntake(recipient: link, amount: "", memo: "", resolveNow: false))
    }

    /// A link Send already consumed is not re-opened.
    func testATakenLinkPresentsNothing() {
        var h = LinkHandoff()
        _ = h.linkArrived(sheetUp: true, sendUp: false)
        XCTAssertEqual(h.presentationEnded(linkPending: false, sheetUp: false, sendUp: false), .none)
        XCTAssertFalse(h.waiting)
    }
}
