import SwiftUI
import UIKit

/// design/tokens.json as SwiftUI colours. Dark (ink) is the default look; light (paper) is a full
/// theme. `accent` is the signal colour: the primary action, and nothing decorative.
extension Color {
    init(hex: UInt32) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255,
                  opacity: 1)
    }

    /// A colour with a light and a dark variant that follows the effective colour scheme.
    static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { trait in
            trait.userInterfaceStyle == .dark ? UIColor(Color(hex: dark)) : UIColor(Color(hex: light))
        })
    }
}

enum Theme {
    static let bg = Color.adaptive(light: 0xF2F3F7, dark: 0x0E1220)
    static let bgSoft = Color.adaptive(light: 0xE9EBF1, dark: 0x121726)
    static let surface = Color.adaptive(light: 0xFFFFFF, dark: 0x161C2C)
    static let surface2 = Color.adaptive(light: 0xF1F2F6, dark: 0x1E2538)
    static let border = Color.adaptive(light: 0xD9DCE6, dark: 0x2B3350)
    static let borderSoft = Color.adaptive(light: 0xE6E8EF, dark: 0x20283D)
    static let text = Color.adaptive(light: 0x121521, dark: 0xECE9E2)
    static let textSoft = Color.adaptive(light: 0x474C5E, dark: 0xABAFBF)
    static let textMute = Color.adaptive(light: 0x62677A, dark: 0x8C91A5)
    static let textStrong = Color.adaptive(light: 0x07090F, dark: 0xFFFDF8)
    static let accent = Color.adaptive(light: 0xC8185F, dark: 0xFF5C9D)
    static let accent2 = Color.adaptive(light: 0xA3124C, dark: 0xFF8FBD)
    /// Text and icons on `accent`: ink on the dark theme's bright signal, white on the light one's.
    static let onAccent = Color.adaptive(light: 0xFFFFFF, dark: 0x0E1220)
    static let positive = Color.adaptive(light: 0x0B7A51, dark: 0x3DDC97)
    static let negative = Color.adaptive(light: 0xC2410C, dark: 0xFF7A59)
    static let warning = Color.adaptive(light: 0x8F6200, dark: 0xF5C451)

    /// The entropy field's ink: the balance card, the same in both themes (design/tokens.json
    /// `field`). The shared ui/ draws dither grain on it; mobile keeps it plain for now.
    static let field = Color(hex: 0x0E1220)
    /// Text on the field: bone, not white.
    static let fieldGrain = Color(hex: 0xECE9E2)

    static let radiusSm: CGFloat = 8
    static let radiusMd: CGFloat = 12
    static let radiusLg: CGFloat = 16
    static let radiusXl: CGFloat = 24
}

/// The three faces the shared ui/ uses (ui/fonts/SOURCES.txt), bundled as TrueType/OpenType in
/// RandWallet/Fonts and registered under UIAppFonts: Inter for all UI text, JetBrains Mono for
/// addresses, hashes and keys, Departure Mono — a pixel face on an 11 pt grid — for the wordmark
/// and the balance figure only. Inter and JetBrains Mono ship as variable fonts, so a weight is a
/// point on their `wght` axis rather than a separate file.
enum Typeface {
    /// PostScript names, as the font files declare them.
    static let interName = "InterVariable"
    static let monoName = "JetBrainsMono-Regular"
    static let displayName = "DepartureMono-Regular"

    /// Inter at a fixed point size. Its optical-size axis follows the size (14–32).
    static func inter(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        Font(variable(interName, size: size, weight: weight, opticalSize: min(max(size, 14), 32)))
    }

    /// JetBrains Mono at a fixed point size.
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        Font(variable(monoName, size: size, weight: weight))
    }

    /// Departure Mono: one weight, set at multiples of 11 so the pixels stay whole.
    static func display(_ size: CGFloat) -> Font {
        Font.custom(displayName, fixedSize: size)
    }

    private static let wghtAxis = 0x7767_6874 // 'wght'
    private static let opszAxis = 0x6F70_737A // 'opsz'

    private static func variable(_ name: String, size: CGFloat, weight: Font.Weight, opticalSize: CGFloat? = nil) -> UIFont {
        var axes: [Int: CGFloat] = [wghtAxis: axisValue(weight)]
        if let opticalSize { axes[opszAxis] = opticalSize }
        let descriptor = UIFontDescriptor(fontAttributes: [
            .name: name,
            UIFontDescriptor.AttributeName(rawValue: kCTFontVariationAttribute as String): axes,
        ])
        return UIFont(descriptor: descriptor, size: size)
    }

    /// The CSS weight the variable axes are calibrated in.
    private static func axisValue(_ weight: Font.Weight) -> CGFloat {
        switch weight {
        case .ultraLight: return 200
        case .thin: return 100
        case .light: return 300
        case .regular: return 400
        case .medium: return 500
        case .semibold: return 600
        case .bold: return 700
        case .heavy: return 800
        case .black: return 900
        default: return 400
        }
    }
}

extension Font {
    /// design/tokens.json `type.balance`: the display face at 44/400, tabular figures.
    static let balance = Typeface.display(44).monospacedDigit()
    static let title = Typeface.inter(22, .semibold)
    static let body15 = Typeface.inter(15)
    static let caption12 = Typeface.inter(12, .medium)
    static let mono = Typeface.mono(13)
    static let monoSmall = Typeface.mono(11)

    /// UI text at any size: Inter.
    static func ui(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { Typeface.inter(size, weight) }
    /// Literal data at any size: JetBrains Mono.
    static func code(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { Typeface.mono(size, weight) }
}
