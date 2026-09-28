import XCTest
import UIKit
@testable import RandWallet

/// The bundled faces (RandWallet/Fonts, UIAppFonts) resolve by the names Theme.swift uses. A name
/// that does not resolve falls back to the system font silently, so this is the only check.
final class TypefaceTests: XCTestCase {
    func testBundledFacesResolveByPostScriptName() {
        XCTAssertEqual(UIFont(name: Typeface.interName, size: 15)?.familyName, "Inter Variable")
        XCTAssertEqual(UIFont(name: Typeface.monoName, size: 13)?.familyName, "JetBrains Mono")
        XCTAssertEqual(UIFont(name: Typeface.displayName, size: 44)?.familyName, "Departure Mono")
    }

    func testVariableWeightsStayInTheirFamily() {
        // `.ui(15, .semibold)` and `.code(13)` build UIFonts through a descriptor with a variation;
        // the descriptor must still name the bundled family, not a fallback.
        let descriptor = UIFontDescriptor(fontAttributes: [
            .name: Typeface.interName,
            UIFontDescriptor.AttributeName(rawValue: kCTFontVariationAttribute as String): [0x7767_6874: 600],
        ])
        XCTAssertEqual(UIFont(descriptor: descriptor, size: 15).familyName, "Inter Variable")
    }
}
