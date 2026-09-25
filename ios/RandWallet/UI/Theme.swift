import SwiftUI

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

    static let radiusMd: CGFloat = 12
    static let radiusLg: CGFloat = 16
    static let radiusXl: CGFloat = 24
}

extension Font {
    static let balance = Font.system(size: 40, weight: .bold, design: .rounded).monospacedDigit()
    static let title = Font.system(size: 22, weight: .semibold)
    static let body15 = Font.system(size: 15)
    static let caption12 = Font.system(size: 12, weight: .medium)
    static let mono = Font.system(size: 13, design: .monospaced)
    static let monoSmall = Font.system(size: 11, design: .monospaced)
}
