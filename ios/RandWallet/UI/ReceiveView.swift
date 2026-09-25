import SwiftUI
import CoreImage.CIFilterBuiltins
import UIKit

struct ReceiveView: View {
    @EnvironmentObject var wallet: WalletService
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    Text("Anyone can pay this address. It reveals nothing about what you hold.")
                        .font(.system(size: 14)).foregroundColor(Theme.textSoft).multilineTextAlignment(.center)
                    if let img = QR.image(for: wallet.address) {
                        Image(uiImage: img)
                            .interpolation(.none)
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: 320)
                            .padding(12)
                            .background(Color.white)
                            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous))
                    }
                    Card {
                        ScrollView {
                            Text(wallet.address).font(.monoSmall).foregroundColor(Theme.text).textSelection(.enabled)
                        }
                        .frame(height: 140)
                    }
                    HStack(spacing: 12) {
                        SecondaryButton(title: copied ? "Copied" : "Copy") {
                            UIPasteboard.general.string = wallet.address
                            copied = true
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                        }
                        ShareLink(item: wallet.address) {
                            Text("Share").font(.system(size: 16, weight: .semibold))
                                .frame(maxWidth: .infinity).frame(height: 52)
                                .foregroundColor(Theme.onAccent).background(Theme.accent)
                                .clipShape(RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous))
                        }
                    }
                }
                .padding(20)
            }
            .screenBackground()
            .navigationTitle("Receive")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .navigationBarTrailing) { Button("Done") { dismiss() } } }
        }
    }
}

enum QR {
    /// A shielded address is ~1.7 KB, which fits a byte-mode QR at version 33 and above; the
    /// generator picks the version. Low error correction keeps the module count down.
    static func image(for text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "L"
        guard let ci = filter.outputImage else { return nil }
        let scaled = ci.transformed(by: CGAffineTransform(scaleX: 6, y: 6))
        let ctx = CIContext()
        guard let cg = ctx.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
