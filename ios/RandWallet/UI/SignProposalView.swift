import SwiftUI
import UniformTypeIdentifiers

// Private multisig signing, the iOS screen (spec 2026-10-11-msauth-signing-design.md §4). The same
// behavior as ui/screens/signers.js: the signer lists the payments they mean to make (an address
// and an amount per row), the core checks the proposal against them, the screen shows the core's
// own lines verbatim, and Sign needs the fingerprint's last four characters and the device's
// Face ID / Touch ID / passcode. The proposal is @State of this view and is dropped with it.

/// A proposal, a policy or a key file larger than this is refused (the JS screen's `MAX_FILE_BYTES`).
let msauthMaxFileBytes = 1 << 20

/// One intended payment as the signer is typing it: the address and the amount in RAND text.
struct PaymentRow: Equatable {
    var addr = ""
    var amount = ""
}

/// An error whose text is for the signer.
struct PaymentEntryError: LocalizedError, Equatable {
    let errorDescription: String?
}

/// The pure decisions behind the payments section.
enum SignRows {
    /// An output the signer must name a payee for: it leaves the account and moves something.
    /// Decided from the output itself, not from the core's own flag (as the JS screen does).
    static func needsPayee(_ o: MsauthOutput) -> Bool {
        !o.toAccount && !o.amount.allSatisfy { $0 == "0" }
    }
    static func isNonRand(_ o: MsauthOutput) -> Bool { o.asset != 0 }
    static func isMatched(_ o: MsauthOutput) -> Bool { !(o.matches ?? "").trimmingCharacters(in: .whitespaces).isEmpty }

    /// The rows as one string, to tell whether they changed since a check was sent.
    static func key(_ rows: [PaymentRow]) -> String {
        rows.map { "\($0.addr.count):\($0.addr)|\($0.amount.count):\($0.amount)" }.joined(separator: "\n")
    }

    /// One intended payment as the core's `addr:AMOUNT`. AMOUNT is RAND display text, checked by
    /// `Amount.parse` and passed as typed (trimmed). It may be left out only when `amountOptional`
    /// (a row whose address owns a non-RAND paying output: the core refuses a pin there).
    static func entry(_ row: PaymentRow, amountOptional: Bool) throws -> String {
        let a = row.addr.trimmingCharacters(in: .whitespacesAndNewlines)
        let v = row.amount.trimmingCharacters(in: .whitespacesAndNewlines)
        if a.isEmpty { throw PaymentEntryError(errorDescription: String(localized: "Enter the address of every payment.")) }
        if v.isEmpty {
            if amountOptional { return a }
            throw PaymentEntryError(errorDescription: String(localized: "Enter the amount of every payment: it is what stops a split or an inflated payment."))
        }
        guard let units = Amount.parse(v), units > 0 else {
            throw PaymentEntryError(errorDescription: String(localized: "An amount is a number of RAND, such as 1.5."))
        }
        return "\(a):\(v)"
    }

    /// Whether this row may go without an amount: only when the check's `expected` shows the row's
    /// address owns a paying non-RAND output. A row the core has not fingerprinted yet (or whose
    /// address was edited) may be sent address-only when some paying output is non-RAND, so the
    /// next check can tell; the core refuses it unless its fingerprint owns such an output.
    static func amountOptional(_ row: PaymentRow, summary: MsauthSummary?) -> Bool {
        guard let summary else { return false }
        let paying = summary.outputs.filter(needsPayee)
        let anyNonRand = paying.contains(where: isNonRand)
        let owners = Set(paying.filter(isNonRand).map(\.ownerFingerprint).filter { !$0.isEmpty })
        let a = row.addr.trimmingCharacters(in: .whitespacesAndNewlines)
        if !a.isEmpty, let known = summary.expected.first(where: { x in
            let head = x.entry.firstIndex(of: ":").map { String(x.entry[..<$0]) } ?? x.entry
            return head.trimmingCharacters(in: .whitespacesAndNewlines) == a
        }) {
            return known.fingerprint.map(owners.contains) ?? false
        }
        return anyNonRand
    }
}

/// Which rows the last check was sent for, and whether editing them since disarmed Sign. Editing any
/// row sets `stale`; only a check whose snapshot of the rows equals the current rows when its result
/// lands clears it. The top Check and Retry resend the last payments, so they cannot re-arm Sign.
struct PaymentsGate: Equatable {
    var rows = [PaymentRow()]
    var payees: [String] = []
    private(set) var checkedKey = SignRows.key([PaymentRow()])
    private(set) var stale = false

    mutating func edited() { stale = true }
    /// "Check payments": the entries are built from the rows (throws if a row is incomplete).
    mutating func adopt(entries: [String]) {
        payees = entries
        checkedKey = SignRows.key(rows)
    }
    /// A new proposal: its payments are asked again.
    mutating func reset() { self = PaymentsGate() }
    /// The rows a check is being sent for.
    var sentKey: String { checkedKey }
    /// A check's result arrived: stale if the rows moved since it was sent (or were edited before).
    mutating func landed(sentKey: String) { stale = sentKey != SignRows.key(rows) }
}

/// What the screen shows of a check: the core's lines verbatim, the refusal's message, and whether
/// Sign may be pressed.
struct SignProposalModel {
    let summary: MsauthSummary?
    let verdict: MsauthVerdict

    init(summary: MsauthSummary?, verdict: MsauthVerdict) { self.summary = summary; self.verdict = verdict }
    init(_ check: MsauthCheck) { self.init(summary: check.summary, verdict: check.verdict) }

    /// The core's summary.lines, verbatim.
    var lines: [String] { summary?.lines ?? [] }
    /// A summary the core did not shape as expected (no lines, no outputs) is shown as its refusal
    /// and nothing else.
    var showsSummary: Bool {
        guard let object = summary?.json as? [String: Any] else { return false }
        return object["lines"] is [Any] && object["outputs"] is [Any]
    }
    var refusal: String? { verdict.message }
    var isRetryable: Bool { if case .noNode = verdict { return true } else { return false } }
    func canSign(typed: String, stale: Bool) -> Bool {
        guard !stale, case .signable = verdict, let fp = summary?.policyFingerprint else { return false }
        return MsauthRules.confirms(fingerprint: fp, typed: typed)
    }
    var blocksLeft: UInt64? { if case .signable(let n) = verdict { return n } else { return nil } }
    var payingTotal: Int { summary?.outputs.filter(SignRows.needsPayee).count ?? 0 }
    var payingMatched: Int { summary?.outputs.filter { SignRows.needsPayee($0) && SignRows.isMatched($0) }.count ?? 0 }
}

/// A share as a text file for `.fileExporter`.
struct ShareDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.plainText] }
    var text: String
    init(text: String) { self.text = text }
    init(configuration: ReadConfiguration) throws {
        text = String(decoding: configuration.file.regularFileContents ?? Data(), as: UTF8.self)
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data((text + "\n").utf8))
    }
}

/// Paste or open proposal.json, enter the payments, review what the core checked, type the last
/// four, authenticate, share.
struct SignProposalView: View {
    let profile: SignerProfile
    @EnvironmentObject var store: SignerStore
    @EnvironmentObject var settings: Settings

    @State private var proposal = ""
    @State private var gate = PaymentsGate()
    @State private var model: SignProposalModel?
    @State private var typed = ""
    @State private var share: MsauthShare?
    @State private var error: String?
    @State private var rowError: String?
    @State private var importing = false
    @State private var exporting = false
    @State private var checking = false
    @State private var signing = false
    @State private var shareToVerify = ""
    @State private var verifyNote: String?
    @State private var inHand = Set<Int>()

    private var signing_: MsauthSigning {
        MsauthSigning(store: store, core: RandMsauthCore(), node: settings.rpcURL.map { RpcClient(url: $0) },
                      chainId: UInt64(max(settings.chainId, 0)))
    }

    var body: some View {
        Form {
            Section(profile.label) {
                Text(profile.fingerprint).font(.mono)
                Text(String(localized: "\(String(profile.threshold)) of \(String(profile.signers)) · signer \(String(profile.index))"))
            }
            Section("Proposal (proposal.json)") {
                TextEditor(text: $proposal).font(.mono).frame(minHeight: 80).autocorrectionDisabled().textInputAutocapitalization(.never)
                Button("Open file") { importing = true }
                Button(checking ? "Checking…" : "Check proposal") { Task { await check() } }.disabled(checking || proposal.isEmpty)
                if let error { Text(verbatim: error).foregroundColor(.red) }
            }
            if showsPayments { paymentsSection }
            if let m = model { reviewSections(m) }
            if let share { shareSection(share) }
            Section("Check a share") {
                TextField("index:hex", text: $shareToVerify).font(.mono).autocorrectionDisabled().textInputAutocapitalization(.never)
                Button("Check share") { verifyShare() }
                if let verifyNote { Text(verbatim: verifyNote) }
            }
        }
        .navigationTitle("Sign a proposal")
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json, .plainText]) { result in
            if case .success(let url) = result { importProposal(url) }
        }
        .fileExporter(isPresented: $exporting, document: ShareDocument(text: share?.share ?? ""), contentType: .plainText,
                      defaultFilename: "share-\(share?.index ?? 0)") { _ in }
        // The proposal carries the account's witness: it is never stored and goes with the screen.
        .onDisappear { proposal = ""; model = nil; share = nil; typed = ""; gate.reset() }
    }

    // MARK: sections

    /// The payments section shows once a check has run and there is something to pay for.
    private var showsPayments: Bool {
        guard let m = model, let s = m.summary else { return false }
        return !s.outputs.filter(SignRows.needsPayee).isEmpty
    }

    private var paymentsSection: some View {
        Section {
            ForEach(gate.rows.indices, id: \.self) { i in
                VStack(alignment: .leading, spacing: 6) {
                    if SignRows.amountOptional(gate.rows[i], summary: model?.summary) {
                        Text("Amounts cannot be checked for non-RAND payments: leave the amount empty for those.")
                            .font(.footnote).foregroundColor(.secondary)
                    }
                    TextField(text: Binding(get: { gate.rows[safe: i]?.addr ?? "" },
                                            set: { if gate.rows.indices.contains(i) { gate.rows[i].addr = $0; gate.edited() } }),
                              prompt: Text(verbatim: "rand1…")) { Text("Payee address") }
                        .font(.mono).autocorrectionDisabled().textInputAutocapitalization(.never)
                    HStack {
                        TextField(text: Binding(get: { gate.rows[safe: i]?.amount ?? "" },
                                                set: { if gate.rows.indices.contains(i) { gate.rows[i].amount = $0; gate.edited() } }),
                                  prompt: Text(verbatim: "0.0")) { Text("Amount in RAND") }
                            .font(.mono).keyboardType(.decimalPad).autocorrectionDisabled()
                        Button("Remove", role: .destructive) { gate.rows.remove(at: i); gate.edited() }.buttonStyle(.borderless)
                    }
                }
            }
            Button("Add payment") { gate.rows.append(PaymentRow()); gate.edited() }
            if let rowError { Text(verbatim: rowError).foregroundColor(.red) }
            Button("Check payments") { checkPayments() }.disabled(checking)
        } header: { Text("Intended payments") } footer: {
            Text("Enter every payment you mean to make: the address and the amount in RAND. A payment to the same address twice is entered once, with the total. An output that matches none of them cannot be signed.")
        }
    }

    @ViewBuilder private func reviewSections(_ m: SignProposalModel) -> some View {
        if m.showsSummary, let s = m.summary {
            Section("What this proposal does, as checked against your policy") {
                ForEach(Array(m.lines.enumerated()), id: \.offset) { Text(verbatim: $0.element).font(.mono) }
                Text(String(localized: "Fee: \(Amount.format(s.fee ?? "0")) RAND · expires at height \(String(s.expiresAt ?? 0))"))
                Text(String(localized: "\(String(m.payingMatched)) of \(String(m.payingTotal)) payments matched."))
                    .font(.footnote).foregroundColor(.secondary)
            }
        }
        if let r = m.refusal {
            Section {
                Text(verbatim: r).foregroundColor(.red)
                Button("Retry") { Task { await check() } }
            }
        } else {
            Section {
                if let left = m.blocksLeft { Text(String(localized: "\(String(left)) blocks left to prove it.")) }
                TextField(text: $typed) { Text("Type the last four characters of the account fingerprint") }
                    .font(.mono).autocorrectionDisabled().textInputAutocapitalization(.never)
                if gate.stale {
                    Text("Payments changed: check them again before signing.").font(.footnote).foregroundColor(.secondary)
                }
                Button(signing ? "Signing…" : "Sign") { sign() }.disabled(signing || !m.canSign(typed: typed, stale: gate.stale))
            } header: { Text("Type the last four characters of the account fingerprint") }
        }
    }

    private func shareSection(_ s: MsauthShare) -> some View {
        Section("Your share — send it to whoever proves the proposal") {
            Text(verbatim: s.share).font(.mono).textSelection(.enabled).lineLimit(3)
            Button("Copy") { UIPasteboard.general.string = s.share }
            ShareLink(item: s.share)
            Button("Save as file") { exporting = true }
        }
    }

    // MARK: actions

    private func importProposal(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let d = try? Data(contentsOf: url), d.count <= msauthMaxFileBytes else {
            error = String(localized: "That file is larger than a proposal, a policy or a key file can be.")
            return
        }
        proposal = String(decoding: d, as: UTF8.self)
    }

    /// "Check payments": build the entries from the rows, then check.
    private func checkPayments() {
        do {
            let entries = try gate.rows.map { try SignRows.entry($0, amountOptional: SignRows.amountOptional($0, summary: model?.summary)) }
            rowError = nil
            gate.adopt(entries: entries)
        } catch { rowError = error.localizedDescription; return }
        Task { await check() }
    }

    /// The top Check and Retry send the payments last adopted; edits made since keep Sign disarmed.
    private func check() async {
        checking = true; defer { checking = false }
        error = nil; share = nil
        if proposal != lastProposal { gate.reset(); model = nil; lastProposal = proposal }
        let sent = gate.sentKey
        do {
            let r = try await signing_.check(id: profile.id, proposal: proposal, expectedRecipients: gate.payees)
            gate.landed(sentKey: sent)
            model = SignProposalModel(r)
        } catch { model = nil; self.error = error.localizedDescription }
    }
    @State private var lastProposal = ""

    private func sign() {
        guard let m = model, m.canSign(typed: typed, stale: gate.stale) else { return }
        signing = true; error = nil
        let payees = gate.payees, text = proposal
        Task {
            defer { signing = false }
            do {
                // The core's check and the head are redone right before and again after the device
                // asks for Face ID (MsauthSigning.sign), so a refusal comes back as its message.
                share = try await signing_.sign(id: profile.id, proposal: text, expectedRecipients: payees,
                                                reason: String(localized: "Sign a multisig proposal"))
                typed = ""
            } catch let refusal as MsauthRefusal {
                model = SignProposalModel(summary: m.summary, verdict: refusal.verdict)
            } catch { self.error = error.localizedDescription }
        }
    }

    private func verifyShare() {
        do {
            let s = MsauthRules.clean(shareToVerify)
            try signing_.verifyShare(id: profile.id, proposal: proposal, share: s)
            guard let i = Int(s.split(separator: ":").first.map { $0.trimmingCharacters(in: .whitespaces) } ?? "") else { return }
            inHand.insert(i)
            verifyNote = String(localized: "Signer \(String(i))'s share verifies. \(String(inHand.count)) of \(String(profile.threshold)) in hand: signers \(inHand.sorted().map(String.init).joined(separator: ", ")).")
        } catch { verifyNote = error.localizedDescription }
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
