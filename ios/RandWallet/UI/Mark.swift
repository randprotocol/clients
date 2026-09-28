import SwiftUI

/// The brand mark: one 4×4 tile of the entropy field at a single threshold, the same ten cells the
/// shared ui/ lights (`markSvg` in ui/lib/entropy.js) — nine in the strong text colour and one, cell
/// 11, burning in the signal colour. The tile is 23 units across: four 5-unit cells with 1-unit
/// gaps, scaled to `size`.
struct Mark: View {
    var size: CGFloat = 22
    var grain: Color = Theme.textStrong
    var hot: Color = Theme.accent

    /// The cells a threshold of ~10/16 lights, in the shared UI's order.
    static let lit: [Int] = [0, 2, 5, 7, 8, 10, 13, 15, 1, 11]
    static let hotCell = 11

    var body: some View {
        ZStack {
            Cells(cells: Self.lit.filter { $0 != Self.hotCell }).fill(grain)
            Cells(cells: [Self.hotCell]).fill(hot)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    struct Cells: Shape {
        let cells: [Int]
        func path(in rect: CGRect) -> Path {
            let unit = min(rect.width, rect.height) / 23
            var path = Path()
            for i in cells {
                let x = rect.minX + CGFloat(i % 4) * 6 * unit
                let y = rect.minY + CGFloat(i / 4) * 6 * unit
                path.addRect(CGRect(x: x, y: y, width: 5 * unit, height: 5 * unit))
            }
            return path
        }
    }
}

/// The wordmark: lowercase `rand` in the pixel face, at a multiple of its 11 pt grid. Decorative on
/// its own; `Brand` carries the accessible name.
struct Wordmark: View {
    var size: CGFloat = 22
    var color: Color = Theme.textStrong

    var body: some View {
        Text("rand")
            .font(Typeface.display(size))
            .foregroundColor(color)
            .lineLimit(1)
            .fixedSize()
            .accessibilityHidden(true)
    }
}

/// Mark plus wordmark, as the shared UI's topbar draws them: 22 pt each, 10 pt apart. The visible
/// word is `rand`; the accessible name is the product's.
struct Brand: View {
    var size: CGFloat = 22
    var grain: Color = Theme.textStrong
    var hot: Color = Theme.accent

    var body: some View {
        HStack(spacing: size * 10 / 22) {
            Mark(size: size, grain: grain, hot: hot)
            Wordmark(size: size, color: grain)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Rand Wallet")
    }
}
