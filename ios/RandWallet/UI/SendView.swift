import SwiftUI
import UIKit

/// Send → Review → Proving → Sent, as one flow in a full-screen cover so the proof is not
/// interrupted by a swipe.
struct SendView: View {
    @EnvironmentObject var wallet: WalletService
    @EnvironmentObject var contacts: ContactsStore
    @EnvironmentObject var router: LinkRouter
    @EnvironmentObject var settings: Settings
    @Environment(\.dismiss) private var dismiss

    enum Step { case form, review, working, done(WalletService.SendOutcome), failed(String) }
    @State private var step: Step = .form
    @State private var recipient = ""
    @State private var amountText = ""
    @State private var memo = ""
    @State private var resolved: ResolvedRecipient?
    @State private var addressError: String?
    @State private var showScanner = false
    @State private var showContactPicker = false
    /// Whether the connected chain carries a memo: only when `rand_getLimits` reports the
    /// 1860-byte envelope. Any other size, or unknown (not yet read, or the node did not answer),
    /// hides the field.
    @State private var memoSupported = false

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
            // A scanned code goes through the same resolution as a pasted one: a `randpay:` link
            // is parsed by the core, a bare address still works.
            QRScannerView { code in
                recipient = code.trimmingCharacters(in: .whitespacesAndNewlines)
                showScanner = false
            }
        }
        .sheet(isPresented: $showContactPicker) {
            ContactPicker { name in
                recipient = name
                showContactPicker = false
            }
        }
        .onAppear { takeLink() }
        .onChange(of: router.pending) { p in if p != nil { takeLink() } }
        .task {
            let bytes = try? await wallet.envelopeBytes()
            memoSupported = SendLinkRules.memoSupported(envelopeBytes: bytes)
        }
    }

    /// A `randpay:` link from outside the app replaces whatever the recipient field held — and
    /// fills the form, nothing more: the user still reviews and confirms.
    private func takeLink() {
        guard case .form = step, let link = router.take() else { return }
        let intake = LinkIntake.take(link: link, currentRecipient: recipient)
        amountText = intake.amount
        memo = intake.memo
        recipient = intake.recipient
        // The same link again: `onChange(of: recipient)` will not fire, so fill it back in here.
        if intake.resolveNow { resolveRecipient(intake.recipient) }
    }

    private var amountUnits: UInt64? { Amount.parse(amountText) }
    private var maxUnits: UInt64 { wallet.balance > fee ? wallet.balance - fee : 0 }
    private var conflicts: LinkConflicts {
        guard let link = resolved?.link else { return LinkConflicts() }
        return SendLinkRules.conflicts(link: link, typedAmount: amountText, typedMemo: memo)
    }
    private var memoBlocked: Bool { SendLinkRules.memoBlocksContinue(memoSupported: memoSupported, memo: memo) }
    private var formValid: Bool {
        guard let a = amountUnits, a > 0, a &+ fee <= wallet.balance else { return false }
        guard resolved != nil, addressError == nil, !conflicts.any else { return false }
        return Memo.tooLong(memo) == nil && !memoBlocked
    }
    private var confirmation: String {
        SendLinkRules.confirmationLine(name: resolved?.name, fingerprint: resolved?.fingerprint,
                                       amount: Amount.format(amountUnits ?? 0), symbol: "RAND")
    }
    /// The memo's own line, below the recipient line and never on it (final review, finding 3).
    private var memoConfirmation: String { SendLinkRules.memoLine(memoSupported ? memo : "") }

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel(text: "To")
                    HStack(spacing: 8) {
                        Field(placeholder: "rand1…, randpay: link or contact", text: $recipient, mono: true)
                        Button { showScanner = true } label: {
                            Image(systemName: "qrcode.viewfinder").font(.system(size: 22)).foregroundColor(Theme.accent).frame(width: 36, height: 44)
                        }
                        .accessibilityLabel("Scan")
                        Button { showContactPicker = true } label: {
                            Image(systemName: "person.crop.circle").font(.system(size: 22)).foregroundColor(Theme.accent).frame(width: 36, height: 44)
                        }
                        .accessibilityLabel("Contacts")
                        Button {
                            if let s = UIPasteboard.general.string { recipient = s.trimmingCharacters(in: .whitespacesAndNewlines) }
                        } label: {
                            Text("Paste").font(.system(size: 14, weight: .semibold)).foregroundColor(Theme.accent)
                        }
                    }
                    if let r = resolved {
                        Text(recipientCaption(r)).font(.caption12).foregroundColor(Theme.textSoft)
                    }
                    ErrorText(message: addressError ?? conflicts.to)
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
                    ErrorText(message: conflicts.amount)
                }
                memoSection
                Text("A transfer is proved on this phone, which takes a minute or two. Keep the app open while it runs.")
                    .font(.system(size: 13)).foregroundColor(Theme.textMute)
                PrimaryButton(title: "Review", enabled: formValid) { step = .review }
            }
            .padding(20)
        }
        .onChange(of: recipient) { v in resolveRecipient(v) }
        .onChange(of: contacts.book) { _ in resolveRecipient(recipient) }
    }

    @ViewBuilder private var memoSection: some View {
        if memoSupported {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    SectionLabel(text: "Memo")
                    Spacer()
                    Text(Memo.counter(memo)).font(.caption12).foregroundColor(Memo.tooLong(memo) == nil ? Theme.textMute : Theme.negative)
                }
                TextField("Optional", text: $memo, axis: .vertical)
                    .lineLimit(2...5)
                    .font(.body15)
                    .autocorrectionDisabled()
                    .padding(14)
                    .background(Theme.surface2)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous).stroke(Theme.border, lineWidth: 1))
                Text("Encrypted with the payment: only the recipient, you and anyone either of you shows it to can read it.")
                    .font(.caption12).foregroundColor(Theme.textMute)
                ErrorText(message: Memo.tooLong(memo) ?? conflicts.memo)
            }
        } else if !memo.isEmpty {
            // A link brought a memo this chain cannot carry: say so, and block until it is cleared.
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundColor(Theme.warning)
                    Text(Memo.noMemoNotice).font(.system(size: 13)).foregroundColor(Theme.text)
                }
                Button("Clear memo") { memo = "" }.font(.system(size: 14, weight: .semibold)).foregroundColor(Theme.accent)
            }
        }
    }

    private func recipientCaption(_ r: ResolvedRecipient) -> String {
        let who = r.name.map { "\($0) · " } ?? ""
        let kind = r.link != nil ? "Payment link · " : ""
        return "\(kind)\(who)fingerprint \(r.fingerprint)"
    }

    private func resolveRecipient(_ text: String) {
        let s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { resolved = nil; addressError = nil; return }
        do {
            let r = try SendLinkRules.resolve(s, contacts: contacts.book)
            resolved = r
            addressError = nil
            if let link = r.link {
                let filled = SendLinkRules.fill(link: link, amount: amountText, memo: memo)
                amountText = filled.amount
                memo = filled.memo
            }
        } catch {
            resolved = nil
            addressError = RecipientKind(s) == .link ? "That payment link could not be read: \(error.localizedDescription)" : error.localizedDescription
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
                        Text((resolved?.address ?? "").shortened(head: 14, tail: 8)).font(.mono).foregroundColor(Theme.text)
                    }
                    Divider().background(Theme.borderSoft)
                    // The one line every surface shows before a send (spec 2026-09-26 §3): read the
                    // fingerprint back against the one the recipient sees on their Receive screen.
                    Text(confirmation).font(.mono).foregroundColor(Theme.textStrong)
                        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    // The memo: its own line, one line that never wraps (final review 2). `.clipped()`
                    // too (final review, finding): `Memo.display` neutralises every control and
                    // format character, but stacked combining marks are ordinary text — `lineLimit(1)`
                    // alone lets a tall run of them draw past this view's own bounds and over
                    // whatever sits below it.
                    Text(memoConfirmation).font(.mono).foregroundColor(Theme.text)
                        .lineLimit(1).truncationMode(.tail).clipped()
                }
            }
            Text("Proving takes a minute or two on this phone. The chain will see two nullifiers, two commitments and a proof — never the amount, the recipient or the memo.")
                .font(.system(size: 13)).foregroundColor(Theme.textMute).multilineTextAlignment(.center)
            if let p = remoteProver {
                // Delegated proving, Phase 1: this device cannot fit the proof, and a prover the
                // user paired as their own will make it.
                Text("This device does not have the memory for this proof, so your prover, \(p.name), will make it. Your spend key goes to it inside a sealed job; this phone checks the proof before anything is sent.")
                    .font(.system(size: 13)).foregroundColor(Theme.textSoft).multilineTextAlignment(.center)
            } else if !ProverRequirements.deviceHasEnoughMemory {
                Text("This proof needs about \(ProverRequirements.peakMemoryGB) GB of memory and this device has \(ProverRequirements.deviceMemoryGB) GB. iOS will most likely stop the app before it finishes. Pair a prover you run yourself in Settings › Prover, or send from the rand command-line wallet on a computer with the key file from Settings › Export.")
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
            if case .provingRemotely(_, _, let started) = wallet.phase { ElapsedText(since: started) }
            Spacer()
        }
        .padding(20)
    }

    /// The prover a send will use: only where this device cannot prove and the pairing is the
    /// user's own (whether it answers is checked when the send starts).
    private var remoteProver: ProverPairing? {
        guard !ProverRequirements.deviceHasEnoughMemory, let p = settings.prover, p.own else { return nil }
        return p
    }

    private var phaseTitle: String {
        switch wallet.phase {
        case .syncing: return "Syncing…"
        case .selecting: return "Choosing notes…"
        case .fetchingWitnesses: return "Fetching witnesses…"
        case .proving: return "Proving your transfer…"
        case .provingRemotely(let name, let position, _):
            if let n = position { return "Waiting at position \(n) on \(name)" }
            return "Proving on \(name)…"
        case .submitting: return "Submitting…"
        case .waitingForCommit: return "Waiting for the block…"
        default: return "Working…"
        }
    }
    private var phaseDetail: String {
        switch wallet.phase {
        case .proving: return "About a minute or two on this device. Keep the app open."
        case .provingRemotely: return "Your prover makes the proof; this phone checks it before anything is sent. Keep the app open — closing it loses this proof, and nothing is sent."
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
        guard let amount = amountUnits, let to = resolved?.address else { return }
        step = .working
        do {
            let o = try await wallet.send(to: to, amount: amount, fee: fee, memo: memoSupported ? memo : "")
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

/// Pick a saved contact for the recipient field.
struct ContactPicker: View {
    let onPick: (String) -> Void
    @EnvironmentObject var contacts: ContactsStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if contacts.book.sorted.isEmpty {
                    Text("No contacts yet. Add one from Contacts on the home screen.").foregroundColor(Theme.textMute)
                }
                ForEach(contacts.book.sorted) { c in
                    Button { onPick(c.name) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            // Same rule as the contacts list itself: a saved name is hostile text.
                            Text(Memo.display(c.name)).foregroundColor(Theme.text)
                            Text(c.address.shortened(head: 14, tail: 8)).font(.monoSmall).foregroundColor(Theme.textMute)
                        }
                    }
                }
            }
            .navigationTitle("Contacts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .navigationBarLeading) { Button("Cancel") { dismiss() } } }
        }
    }
}
