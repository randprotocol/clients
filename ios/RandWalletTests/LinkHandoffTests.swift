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

    /// A link Send already consumed is not re-opened.
    func testATakenLinkPresentsNothing() {
        var h = LinkHandoff()
        _ = h.linkArrived(sheetUp: true, sendUp: false)
        XCTAssertEqual(h.presentationEnded(linkPending: false, sheetUp: false, sendUp: false), .none)
        XCTAssertFalse(h.waiting)
    }
}
