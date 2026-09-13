import SwiftUI

/// design/tokens.json as SwiftUI colours. Dark is the default look; light is a full theme.
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
    static let bg = Color.adaptive(light: 0xF5F6FB, dark: 0x0B0D14)
    static let bgSoft = Color.adaptive(light: 0xEDEFF7, dark: 0x10131E)
    static let surface = Color.adaptive(light: 0xFFFFFF, dark: 0x151A2B)
    static let surface2 = Color.adaptive(light: 0xF2F3F9, dark: 0x1D2338)
    static let border = Color.adaptive(light: 0xDCDFEC, dark: 0x262D48)
    static let borderSoft = Color.adaptive(light: 0xE8EAF3, dark: 0x1E2439)
    static let text = Color.adaptive(light: 0x141A2E, dark: 0xEEF0F7)
    static let textSoft = Color.adaptive(light: 0x4A5270, dark: 0xA6ADC8)
    static let textMute = Color.adaptive(light: 0x7B8299, dark: 0x6F7797)
    static let textStrong = Color.adaptive(light: 0x0A0F1F, dark: 0xFFFFFF)
    static let accent = Color.adaptive(light: 0x4F5FE8, dark: 0x6F7EFF)
    static let accent2 = Color.adaptive(light: 0x8457E6, dark: 0x9B6BFF)
    static let positive = Color.adaptive(light: 0x1BA97A, dark: 0x33D69F)
    static let negative = Color.adaptive(light: 0xD94F4F, dark: 0xFF6B6B)
    static let warning = Color.adaptive(light: 0xD98A1E, dark: 0xFFB84D)

    /// The "aurora" gradient: reserved for the balance card and the primary button.
    static let aurora = LinearGradient(colors: [Color(hex: 0x5B7CFF), Color(hex: 0x9B6BFF)],
                                       startPoint: .topLeading, endPoint: .bottomTrailing)

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
