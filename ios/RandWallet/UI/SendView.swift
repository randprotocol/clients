import SwiftUI
import UIKit

/// Send → Review → Proving → Sent, as one flow in a full-screen cover so the proof is not
/// interrupted by a swipe.
struct SendView: View {
    @EnvironmentObject var wallet: WalletService
    @Environment(\.dismiss) private var dismiss

    enum Step { case form, review, working, done(WalletService.SendOutcome), failed(String) }
    @State private var step: Step = .form
    @State private var recipient = ""
    @State private var amountText = ""
    @State private var addressError: String?
    @State private var showScanner = false

    private let fee: UInt64 = 1_000_000

    var body: some View {
        NavigationStack {
            Group {
                switch step {
                case .form: form
                case .review: review
                case .working: working
                case .done(let o): SentView(outcome: o) { dismiss() }
                case .failed(let m): failed(m)
                }
            }
            .screenBackground()
            .navigationTitle("Send")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    if case .working = step { EmptyView() } else { Button("Cancel") { dismiss() } }
                }
            }
            .interactiveDismissDisabled()
        }
        .sheet(isPresented: $showScanner) {
            QRScannerView { code in
                recipient = code
                showScanner = false
            }
        }
    }

    private var amountUnits: UInt64? { Amount.parse(amountText) }
    private var maxUnits: UInt64 { wallet.balance > fee ? wallet.balance - fee : 0 }
    private var formValid: Bool {
        guard let a = amountUnits, a > 0, a &+ fee <= wallet.balance else { return false }
        return addressError == nil && !recipient.isEmpty
    }

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel(text: "To")
                    HStack(spacing: 8) {
                        Field(placeholder: "rand1…", text: $recipient, mono: true)
                        Button { showScanner = true } label: {
                            Image(systemName: "qrcode.viewfinder").font(.system(size: 22)).foregroundColor(Theme.accent).frame(width: 44, height: 44)
                        }
                        Button {
                            if let s = UIPasteboard.general.string { recipient = s.trimmingCharacters(in: .whitespacesAndNewlines) }
                        } label: {
                            Text("Paste").font(.system(size: 14, weight: .semibold)).foregroundColor(Theme.accent)
                        }
                    }
                    ErrorText(message: addressError)
                }
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        SectionLabel(text: "Amount")
                        Spacer()
                        Button("Max \(Amount.format(maxUnits))") { amountText = Amount.format(maxUnits) }
                            .font(.caption12).foregroundColor(Theme.accent)
                    }
                    Field(placeholder: "0.0", text: $amountText, keyboard: .decimalPad)
                    HStack {
                        Text("Available \(Amount.format(wallet.balance)) RAND").font(.caption12).foregroundColor(Theme.textMute)
                        Spacer()
                        Text("Fee \(Amount.format(fee)) RAND").font(.caption12).foregroundColor(Theme.textMute)
                    }
                    if let a = amountUnits, a &+ fee > wallet.balance {
                        ErrorText(message: "Amount plus fee exceeds your balance.")
                    }
                }
                Text("A transfer is proved on this phone, which takes a minute or two. Keep the app open while it runs.")
                    .font(.system(size: 13)).foregroundColor(Theme.textMute)
                PrimaryButton(title: "Review", enabled: formValid) { step = .review }
            }
            .padding(20)
        }
        .onChange(of: recipient) { v in
            let s = v.trimmingCharacters(in: .whitespacesAndNewlines)
            if s.isEmpty { addressError = nil; return }
            let info = try? RandCore.parseAddress(s)
            addressError = (info?.valid ?? false) ? nil : (info?.error ?? "Not a rand1 address")
        }
    }

    private var review: some View {
        VStack(spacing: 20) {
            Card {
                VStack(alignment: .leading, spacing: 14) {
                    row("Amount", "\(Amount.format(amountUnits ?? 0)) RAND")
                    row("Fee", "\(Amount.format(fee)) RAND")
                    row("Total", "\(Amount.format((amountUnits ?? 0) &+ fee)) RAND")
                    Divider().background(Theme.borderSoft)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("To").font(.caption12).foregroundColor(Theme.textMute)
                        Text(recipient.trimmingCharacters(in: .whitespacesAndNewlines).shortened(head: 14, tail: 8)).font(.mono).foregroundColor(Theme.text)
                    }
                }
            }
            Text("Proving takes a minute or two on this phone. The chain will see two nullifiers, two commitments and a proof — never the amount or the recipient.")
                .font(.system(size: 13)).foregroundColor(Theme.textMute).multilineTextAlignment(.center)
            if !ProverRequirements.deviceHasEnoughMemory {
                Text("This proof needs about \(ProverRequirements.peakMemoryGB) GB of memory and this device has \(ProverRequirements.deviceMemoryGB) GB. iOS will most likely stop the app before it finishes. Until the prover's memory use drops, send from the rand command-line wallet on a computer with the key file from Settings › Export.")
                    .font(.system(size: 13)).foregroundColor(Theme.warning).multilineTextAlignment(.center)
            }
            Spacer()
            PrimaryButton(title: "Confirm and prove") { Task { await run() } }
            SecondaryButton(title: "Back") { step = .form }
        }
        .padding(20)
    }

    private var working: some View {
        VStack(spacing: 18) {
            Spacer()
            ProgressView().scaleEffect(1.6).tint(Theme.accent)
            Text(phaseTitle).font(.title).foregroundColor(Theme.textStrong)
            Text(phaseDetail).font(.body15).foregroundColor(Theme.textSoft).multilineTextAlignment(.center).padding(.horizontal, 24)
            if case .proving(let started) = wallet.phase { ElapsedText(since: started) }
            Spacer()
        }
        .padding(20)
    }

    private var phaseTitle: String {
        switch wallet.phase {
        case .syncing: return "Syncing…"
        case .selecting: return "Choosing notes…"
        case .fetchingWitnesses: return "Fetching witnesses…"
        case .proving: return "Proving your transfer…"
        case .submitting: return "Submitting…"
        case .waitingForCommit: return "Waiting for the block…"
        default: return "Working…"
        }
    }
    private var phaseDetail: String {
        switch wallet.phase {
        case .proving: return "About a minute or two on this device. Keep the app open."
        case .waitingForCommit(let h): return "Transaction \(h.shortened(head: 8, tail: 6)) is in the mempool."
        default: return ""
        }
    }

    private func failed(_ message: String) -> some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "xmark.circle.fill").font(.system(size: 48)).foregroundColor(Theme.negative)
            Text("Could not send").font(.title).foregroundColor(Theme.textStrong)
            Text(message).font(.body15).foregroundColor(Theme.textSoft).multilineTextAlignment(.center).padding(.horizontal, 20)
            Spacer()
            PrimaryButton(title: "Try again") { step = .form }
            SecondaryButton(title: "Close") { dismiss() }
        }
        .padding(20)
    }

    private func row(_ k: String, _ v: String) -> some View {
        HStack {
            Text(k).font(.body15).foregroundColor(Theme.textSoft)
            Spacer()
            Text(v).font(.system(size: 15, weight: .semibold).monospacedDigit()).foregroundColor(Theme.text)
        }
    }

    private func run() async {
        guard let amount = amountUnits else { return }
        step = .working
        do {
            let o = try await wallet.send(to: recipient.trimmingCharacters(in: .whitespacesAndNewlines), amount: amount, fee: fee)
            step = .done(o)
        } catch {
            step = .failed(error.localizedDescription)
        }
    }
}

/// What a bundle proof costs, so the review step can say whether this device can run it.
/// `peakMemoryBytes` mirrors `wallet_core::PROVER_PEAK_MEMORY_BYTES` (measured 2026-09-20, chain 14).
enum ProverRequirements {
    static let peakMemoryBytes: UInt64 = 5_700_000_000
    static var deviceMemoryBytes: UInt64 { ProcessInfo.processInfo.physicalMemory }
    /// iOS lets a foreground app use roughly half to two thirds of physical memory.
    static var deviceHasEnoughMemory: Bool { deviceMemoryBytes / 3 * 2 >= peakMemoryBytes }
    static var peakMemoryGB: String { String(format: "%.1f", Double(peakMemoryBytes) / 1e9) }
    static var deviceMemoryGB: String { String(format: "%.0f", Double(deviceMemoryBytes) / 1e9) }
}

struct SentView: View {
    let outcome: WalletService.SendOutcome
    let onDone: () -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                Image(systemName: "checkmark.circle.fill").font(.system(size: 56)).foregroundColor(Theme.positive).padding(.top, 20)
                Text(outcome.committedHeight == nil ? "Submitted" : "Sent").font(.title).foregroundColor(Theme.textStrong)
                Text("\(Amount.format(outcome.amount)) RAND").font(.balance).foregroundColor(Theme.text)
                Card {
                    VStack(alignment: .leading, spacing: 12) {
                        CopyRow(label: "Transaction", value: outcome.hash)
                        if let h = outcome.committedHeight {
                            Text("Committed in block \(h)").font(.caption12).foregroundColor(Theme.textMute)
                        } else {
                            Text("Accepted by the node; not yet seen in a block. It will show in Activity once committed.").font(.caption12).foregroundColor(Theme.textMute)
                        }
                        Text("Proved in \(Int(outcome.provingSeconds)) s · tier \(outcome.tier) · \(outcome.proofBytes / 1024) KB proof").font(.caption12).foregroundColor(Theme.textMute)
                    }
                }
                Card {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Disclose this payment").font(.system(size: 15, weight: .semibold)).foregroundColor(Theme.text)
                        Text("The transaction key opens exactly this payment on RandScan — the amount and the recipient — and nothing else you ever did.")
                            .font(.system(size: 13)).foregroundColor(Theme.textSoft)
                        CopyRow(label: "Transaction key", value: outcome.txKey)
                    }
                }
                SecondaryButton(title: "View on RandScan") { openURL(Settings.explorerTransactionURL(outcome.hash)) }
                PrimaryButton(title: "Done", action: onDone)
            }
            .padding(20)
        }
    }
}
