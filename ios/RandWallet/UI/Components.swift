import SwiftUI
import UIKit

/// The primary action: aurora gradient, full width, 52pt tall.
struct PrimaryButton: View {
    let title: String
    var enabled = true
    var busy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if busy { ProgressView().tint(.white) }
                Text(title).font(.system(size: 16, weight: .semibold))
            }
            .frame(maxWidth: .infinity)
            .frame(height: 52)
            .foregroundColor(.white)
            .background(Theme.aurora)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous))
            .opacity(enabled ? 1 : 0.45)
        }
        .disabled(!enabled || busy)
    }
}

struct SecondaryButton: View {
    let title: String
    var destructive = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 16, weight: .semibold))
                .frame(maxWidth: .infinity)
                .frame(height: 52)
                .foregroundColor(destructive ? Theme.negative : Theme.text)
                .background(Theme.surface2)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous).stroke(Theme.border, lineWidth: 1))
        }
    }
}

/// A rounded card on the surface colour.
struct Card<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder let content: () -> Content
    var body: some View {
        content()
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous).stroke(Theme.borderSoft, lineWidth: 1))
    }
}

/// One of the round Receive / Send / Faucet actions under the balance card.
struct RoundAction: View {
    let icon: String
    let label: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(spacing: 8) {
                ZStack {
                    Circle().fill(Theme.surface2).frame(width: 56, height: 56)
                        .overlay(Circle().stroke(Theme.border, lineWidth: 1))
                    Image(systemName: icon).font(.system(size: 20, weight: .semibold)).foregroundColor(Theme.accent)
                }
                Text(label).font(.caption12).foregroundColor(Theme.textSoft)
            }
        }
        .buttonStyle(.plain)
    }
}

/// A mono value with a copy button.
struct CopyRow: View {
    let label: String
    let value: String
    var shortened = true
    @State private var copied = false
    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(label).font(.caption12).foregroundColor(Theme.textMute)
                Text(shortened ? value.shortened() : value).font(.mono).foregroundColor(Theme.text).lineLimit(shortened ? 1 : nil)
            }
            Spacer()
            Button {
                UIPasteboard.general.string = value
                copied = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc").foregroundColor(copied ? Theme.positive : Theme.accent)
            }
            .buttonStyle(.plain)
        }
    }
}

struct SectionLabel: View {
    let text: String
    var body: some View {
        Text(text.uppercased()).font(.system(size: 11, weight: .semibold)).tracking(0.8).foregroundColor(Theme.textMute)
    }
}

struct ErrorText: View {
    let message: String?
    var body: some View {
        if let m = message, !m.isEmpty {
            Text(m).font(.system(size: 13)).foregroundColor(Theme.negative).fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// A text field styled like the rest of the surfaces.
struct Field: View {
    let placeholder: String
    @Binding var text: String
    var mono = false
    var keyboard: UIKeyboardType = .default
    var body: some View {
        TextField(placeholder, text: $text)
            .font(mono ? .mono : .body15)
            .keyboardType(keyboard)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .padding(14)
            .background(Theme.surface2)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous).stroke(Theme.border, lineWidth: 1))
    }
}

extension View {
    func screenBackground() -> some View {
        self.frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.bg.ignoresSafeArea())
    }
}

/// Elapsed seconds since a date, ticking.
struct ElapsedText: View {
    let since: Date
    var body: some View {
        TimelineView(.periodic(from: since, by: 1)) { ctx in
            let s = Int(ctx.date.timeIntervalSince(since))
            Text(String(format: "%d:%02d", s / 60, s % 60)).font(.mono).foregroundColor(Theme.textSoft)
        }
    }
}
