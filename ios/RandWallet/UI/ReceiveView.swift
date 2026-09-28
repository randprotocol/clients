import SwiftUI
import CoreImage.CIFilterBuiltins
import UIKit

/// The address, its fingerprint, and a QR of its `randpay:` link (spec 2026-09-26 §3.3). The QR
/// encodes the link, never the bare address (a bare address is the link with no parameters), at
/// error-correction level M. The optional amount and memo rebuild the link; the core formats it
/// and parses it back, so this screen cannot hand out a link another wallet would refuse.
struct ReceiveView: View {
    @EnvironmentObject var wallet: WalletService
    @Environment(\.dismiss) private var dismiss
    @State private var copied: String?
    @State private var amountText = ""
    @State private var memo = ""
    @State private var link = ""
    @State private var linkError: String?
    /// The connected chain's `envelope_bytes`; `nil` (unknown, or a chain without memos) hides the
    /// memo field and keeps memos out of the link.
    @State private var envelopeBytes: Int?

    private var fingerprint: String? { try? RandCore.addressFingerprint(wallet.address) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    Text("Anyone can pay this address. It reveals nothing about what you hold.")
                        .font(.ui(14)).foregroundColor(Theme.textSoft).multilineTextAlignment(.center)
                    if let img = QR.image(for: link) {
                        Image(uiImage: img)
                            .interpolation(.none)
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: 320)
                            .padding(12)
                            .background(Color.white)
                            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous))
                            .accessibilityLabel("QR code of your payment link")
                    } else if !link.isEmpty {
                        Text("This link is too long for a QR code; share or copy it instead.")
                            .font(.ui(13)).foregroundColor(Theme.warning).multilineTextAlignment(.center)
                    }
                    if let fp = fingerprint {
                        VStack(spacing: 4) {
                            Text("Fingerprint").font(.caption12).foregroundColor(Theme.textMute)
                            Text(fp).font(.code(18, .semibold)).foregroundColor(Theme.textStrong)
                                .textSelection(.enabled)
                        }
                    }
                    Text("Whoever pays you sees this fingerprint on their confirmation; if it does not match, it is not your address.")
                        .font(.ui(13)).foregroundColor(Theme.textMute).multilineTextAlignment(.center)
                    Card {
                        ScrollView {
                            Text(wallet.address).font(.monoSmall).foregroundColor(Theme.text).textSelection(.enabled)
                        }
                        .frame(height: 120)
                    }
                    HStack(spacing: 12) {
                        SecondaryButton(title: copied == "address" ? "Copied" : "Copy address") { copy(wallet.address, as: "address") }
                        SecondaryButton(title: copied == "link" ? "Copied" : "Copy link") { copy(link, as: "link") }
                    }
                    ShareLink(item: link) {
                        Text("Share payment link").font(.ui(16, .semibold))
                            .frame(maxWidth: .infinity).frame(height: 52)
                            .foregroundColor(Theme.onAccent).background(Theme.accent)
                            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous))
                    }
                    .disabled(link.isEmpty)
                    linkForm
                }
                .padding(20)
            }
            .screenBackground()
            .navigationTitle("Receive")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .navigationBarTrailing) { Button("Done") { dismiss() } } }
            .onAppear { rebuild() }
            .task {
                envelopeBytes = (try? await wallet.envelopeBytes()) ?? nil
                rebuild()
            }
            .onChange(of: amountText) { _ in rebuild() }
            .onChange(of: memo) { _ in rebuild() }
            .onChange(of: envelopeBytes) { _ in rebuild() }
        }
    }

    private var linkForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: "Payment link")
            Text(ReceiveLinkRules.showsMemo(envelopeBytes: envelopeBytes)
                 ? "Optional: ask for an amount, and add a note the payer’s wallet fills in for them."
                 : "Optional: ask for an amount the payer’s wallet fills in for them.")
                .font(.ui(13)).foregroundColor(Theme.textMute)
            HStack {
                Field(placeholder: "Amount — the payer decides", text: $amountText, keyboard: .decimalPad)
                Text("RAND").font(.ui(14, .semibold)).foregroundColor(Theme.textSoft)
            }
            if ReceiveLinkRules.showsMemo(envelopeBytes: envelopeBytes) {
                HStack {
                    Field(placeholder: "Memo", text: $memo)
                    Text(Memo.counter(memo)).font(.caption12).foregroundColor(Memo.tooLong(memo) == nil ? Theme.textMute : Theme.negative)
                }
            }
            ErrorText(message: linkError)
        }
    }

    /// A field the user is still getting wrong leaves the link — and the QR — at the last good form.
    private func rebuild() {
        guard !wallet.address.isEmpty else { return }
        let linkMemo = ReceiveLinkRules.linkMemo(memo, envelopeBytes: envelopeBytes)
        if let m = linkMemo, let tooLong = Memo.tooLong(m) { linkError = tooLong; return }
        let amount = amountText.trimmingCharacters(in: .whitespaces)
        if !amount.isEmpty, Amount.parse(amount) == nil {
            linkError = "Enter the amount as a number, for example 1.25."
            return
        }
        do {
            link = try RandCore.uriFormat(address: wallet.address, amount: amount, asset: nil, memo: linkMemo)
            linkError = nil
        } catch {
            if link.isEmpty { link = "randpay:\(wallet.address)" }
            linkError = error.localizedDescription
        }
    }

    private func copy(_ text: String, as what: String) {
        UIPasteboard.general.string = text
        copied = what
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { if copied == what { copied = nil } }
    }
}

enum QR {
    /// A `randpay:` link to a ~1.7 KB shielded address fits a byte-mode QR at level M (version 40
    /// holds 2 331 bytes); the generator picks the version and returns `nil` for a link too long
    /// for any (a long memo). Level M, per spec 2026-09-26 §3.3, so it survives a scuffed screen.
    static func image(for text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let ci = filter.outputImage else { return nil }
        let scaled = ci.transformed(by: CGAffineTransform(scaleX: 6, y: 6))
        let ctx = CIContext()
        guard let cg = ctx.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
