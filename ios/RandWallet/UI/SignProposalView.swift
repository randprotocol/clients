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
struct PaymentRow: Equatable, Identifiable {
    let id = UUID()
    var addr = ""
    var amount = ""
    init(addr: String = "", amount: String = "") { self.addr = addr; self.amount = amount }
    /// Rows are equal by what was typed; the id only keeps a list row's identity.
    static func == (a: PaymentRow, b: PaymentRow) -> Bool { a.addr == b.addr && a.amount == b.amount }
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
    /// A payee that is also paid RAND never gets the exception: its RAND amount must be pinned.
    static func amountOptional(_ row: PaymentRow, summary: MsauthSummary?) -> Bool {
        guard let summary else { return false }
        let paying = summary.outputs.filter(needsPayee)
        let anyNonRand = paying.contains(where: isNonRand)
        let (owners, randOwners) = payeeAssets(paying)
        if let known = knownEntry(row, summary: summary) {
            return known.fingerprint.map { owners.contains($0) && !randOwners.contains($0) } ?? false
        }
        return anyNonRand
    }

    /// Whether the check showed this row's payee paid both RAND and a non-RAND asset: such a payee
    /// needs separate proposals, one per kind.
    static func mixedPayee(_ row: PaymentRow, summary: MsauthSummary?) -> Bool {
        guard let summary, let fp = knownEntry(row, summary: summary)?.fingerprint else { return false }
        let (owners, randOwners) = payeeAssets(summary.outputs.filter(needsPayee))
        return owners.contains(fp) && randOwners.contains(fp)
    }

    private static func knownEntry(_ row: PaymentRow, summary: MsauthSummary) -> MsauthExpected? {
        let a = row.addr.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !a.isEmpty else { return nil }
        return summary.expected.first(where: { x in
            let head = x.entry.firstIndex(of: ":").map { String(x.entry[..<$0]) } ?? x.entry
            return head.trimmingCharacters(in: .whitespacesAndNewlines) == a
        })
    }

    private static func payeeAssets(_ paying: [MsauthOutput]) -> (Set<String>, Set<String>) {
        let fps = { (list: [MsauthOutput]) in Set(list.map(\.ownerFingerprint).filter { !$0.isEmpty }) }
        return (fps(paying.filter(isNonRand)), fps(paying.filter { !isNonRand($0) }))
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
        guard let lines = object["lines"] as? [Any], lines.allSatisfy({ $0 is String }) else { return false }
        return object["outputs"] is [Any]
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

/// One screen's checking state, apart from SwiftUI so its ordering can be tested: which text the
/// review is of, which check is the latest, the payments, and the last good summary the payment rows
/// are drawn from.
struct CheckSession {
    struct Ticket: Equatable { let id: Int; let proposal: String; let sentKey: String }

    var gate = PaymentsGate()
    private(set) var model: SignProposalModel?
    /// The last summary the core gave, kept when a later check is refused so the rows stay editable.
    private(set) var lastSummary: MsauthSummary?
    var typed = ""
    private(set) var error: String?
    private(set) var inFlight = false
    /// The exact text the displayed review was checked on: the only text Sign signs.
    private(set) var reviewedProposal: String?
    private var sentProposal: String?
    private var latest = 0

    /// A check starts for `proposal` with the payments last adopted. A new proposal text starts the
    /// payments over. Any older check still out is ignored when it lands.
    mutating func begin(proposal: String) -> Ticket {
        if proposal != sentProposal { gate.reset(); lastSummary = nil; sentProposal = proposal }
        latest += 1; inFlight = true; error = nil
        return Ticket(id: latest, proposal: proposal, sentKey: gate.sentKey)
    }
    /// A result lands; false when a newer request has superseded it.
    @discardableResult
    mutating func land(_ t: Ticket, _ check: MsauthCheck) -> Bool {
        guard t.id == latest else { return false }
        inFlight = false
        if let s = check.summary { lastSummary = s }
        gate.landed(sentKey: t.sentKey)
        model = SignProposalModel(check)
        reviewedProposal = t.proposal
        typed = ""
        return true
    }
    /// The check threw (the core refused, e.g. a mistyped payee): no review, but the payments stay.
    @discardableResult
    mutating func fail(_ t: Ticket, message: String) -> Bool {
        guard t.id == latest else { return false }
        inFlight = false; model = nil; reviewedProposal = nil; typed = ""; error = message
        return true
    }
    /// The proposal text was edited: the review no longer describes it, and a check out is dropped.
    /// A text other than the one the payments were asked for also drops them, so rows and the
    /// non-RAND hint never come from a different proposal.
    mutating func proposalEdited(to text: String) {
        latest += 1; inFlight = false; model = nil; reviewedProposal = nil; typed = ""; error = nil
        if text != sentProposal { gate.reset(); lastSummary = nil; sentProposal = nil }
    }
    /// A signature's refusal replaces the verdict on the same summary.
    mutating func refused(_ verdict: MsauthVerdict) {
        if let m = model { model = SignProposalModel(summary: m.summary, verdict: verdict) }
    }
    mutating func clearError() { error = nil }
    /// The sequence keeps rising, so a check that lands after the screen was left is ignored.
    mutating func close() { let n = latest + 1; self = CheckSession(); latest = n }

    /// Sign is armed: signable, the last four typed, the payments unchanged since the check, and the
    /// editor still holds the text that was checked.
    func canSign(editor: String) -> Bool {
        guard let m = model, let reviewed = reviewedProposal, reviewed == editor else { return false }
        return m.canSign(typed: typed, stale: gate.stale)
    }
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

/// Reads a picked file: refused by its size before it is read, and a read failure has its own
/// message. Shared by the proposal, policy and key pickers.
func readPickedFile(_ url: URL) throws -> String {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > msauthMaxFileBytes {
        throw PaymentEntryError(errorDescription: String(localized: "That file is larger than a proposal, a policy or a key file can be."))
    }
    guard let d = try? Data(contentsOf: url) else {
        throw PaymentEntryError(errorDescription: String(localized: "That file could not be read."))
    }
    guard d.count <= msauthMaxFileBytes else {
        throw PaymentEntryError(errorDescription: String(localized: "That file is larger than a proposal, a policy or a key file can be."))
    }
    return String(decoding: d, as: UTF8.self)
}

/// Paste or open proposal.json, enter the payments, review what the core checked, type the last
/// four, authenticate, share.
struct SignProposalView: View {
    let profile: SignerProfile
    @EnvironmentObject var store: SignerStore
    @EnvironmentObject var settings: Settings

    @State private var proposal = ""
    @State private var session = CheckSession()
    @State private var share: MsauthShare?
    @State private var error: String?
    @State private var rowError: String?
    @State private var importing = false
    @State private var exporting = false
    @State private var signing = false
    @State private var signTask: Task<Void, Never>?
    @State private var shareToVerify = ""
    @State private var verifyNote: String?
    @State private var inHand = Set<Int>()

    private var signer: MsauthSigning {
        MsauthSigning(store: store, core: RandMsauthCore(), node: settings.rpcURL.map { RpcClient(url: $0) },
                      chainId: UInt64(max(settings.chainId, 0)))
    }
    private var checking: Bool { session.inFlight }

    var body: some View {
        Form {
            Section(profile.label) {
                Text(profile.fingerprint).font(.mono)
                Text(String(localized: "\(String(profile.threshold)) of \(String(profile.signers)) · signer \(String(profile.index))"))
            }
            Section("Proposal (proposal.json)") {
                TextEditor(text: $proposal).font(.mono).disabled(signing).frame(minHeight: 80).autocorrectionDisabled().textInputAutocapitalization(.never)
                Button("Open file") { importing = true }
                Button(checking ? "Checking…" : "Check proposal") { startCheck() }.disabled(checking || signing || proposal.isEmpty)
                if let e = error ?? session.error { Text(verbatim: e).foregroundColor(.red) }
            }
            if showsPayments { paymentsSection }
            if let m = session.model { reviewSections(m) }
            if let share { shareSection(share) }
            Section("Check a share") {
                TextField("index:hex", text: $shareToVerify).font(.mono).autocorrectionDisabled().textInputAutocapitalization(.never)
                Button("Check share") { verifyShare() }
                if let verifyNote { Text(verbatim: verifyNote) }
            }
        }
        .navigationTitle("Sign a proposal")
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json, .plainText]) { result in
            guard case .success(let url) = result else { return }
            do { proposal = try readPickedFile(url); error = nil } catch { self.error = error.localizedDescription }
        }
        .fileExporter(isPresented: $exporting, document: ShareDocument(text: share?.share ?? ""), contentType: .plainText,
                      defaultFilename: "share-\(share?.index ?? 0)") { _ in }
        // The review describes the text that was checked: editing the text drops it until a new check.
        .onChange(of: proposal) { text in session.proposalEdited(to: text); share = nil }
        // The proposal carries the account's witness: it is never stored and goes with the screen.
        .onDisappear {
            signTask?.cancel(); signTask = nil
            proposal = ""; share = nil; session.close(); signing = false
        }
    }

    // MARK: sections

    /// The payments section shows while the last good summary has something to pay for.
    private var showsPayments: Bool {
        guard let s = session.lastSummary else { return false }
        return !s.outputs.filter(SignRows.needsPayee).isEmpty
    }

    private func rowBinding(_ id: UUID, _ key: WritableKeyPath<PaymentRow, String>) -> Binding<String> {
        Binding(get: { session.gate.rows.first { $0.id == id }?[keyPath: key] ?? "" },
                set: { v in
                    guard let i = session.gate.rows.firstIndex(where: { $0.id == id }) else { return }
                    session.gate.rows[i][keyPath: key] = v; session.gate.edited()
                })
    }

    private var paymentsSection: some View {
        Section {
            ForEach(session.gate.rows) { row in
                VStack(alignment: .leading, spacing: 6) {
                    if SignRows.amountOptional(row, summary: session.lastSummary) {
                        Text("Amounts cannot be checked for non-RAND payments: leave the amount empty for those.")
                            .font(.footnote).foregroundColor(.secondary)
                    }
                    if SignRows.mixedPayee(row, summary: session.lastSummary) {
                        Text("This payee receives both RAND and a token: RAND and token payments to one payee need separate proposals.")
                            .font(.footnote).foregroundColor(.secondary)
                    }
                    TextField(text: rowBinding(row.id, \.addr), prompt: Text(verbatim: "rand1…")) { Text("Payee address") }
                        .font(.mono).autocorrectionDisabled().textInputAutocapitalization(.never)
                    HStack {
                        TextField(text: rowBinding(row.id, \.amount), prompt: Text(verbatim: "0.0")) { Text("Amount in RAND") }
                            .font(.mono).keyboardType(.decimalPad).autocorrectionDisabled()
                        Button("Remove", role: .destructive) {
                            session.gate.rows.removeAll { $0.id == row.id }; session.gate.edited()
                        }.buttonStyle(.borderless)
                    }
                }
            }
            Button("Add payment") { session.gate.rows.append(PaymentRow()); session.gate.edited() }
            if let rowError { Text(verbatim: rowError).foregroundColor(.red) }
            Button("Check payments") { checkPayments() }.disabled(checking || signing)
        } header: { Text("Intended payments") } footer: {
            Text("Enter every payment you mean to make: the address and the amount in RAND. A payment to the same address twice is entered once, with the total. An output that matches none of them cannot be signed.")
        }
    }

    @ViewBuilder private func reviewSections(_ m: SignProposalModel) -> some View {
        if m.showsSummary, let s = m.summary {
            Section("What this proposal does, as checked against your policy") {
                ForEach(Array(m.lines.enumerated()), id: \.offset) { Text(verbatim: $0.element).font(.mono) }
                let fee = MsauthRules.randText(MsauthJSON.amount((s.json as? [String: Any])?["fee"]) ?? "0")
                let max = MsauthRules.randText(profile.feeLimit)
                Text(String(localized: "Fee: \(fee) RAND · at most \(max) RAND · expires at height \(String(s.expiresAt ?? 0))"))
                Text(String(localized: "\(String(m.payingMatched)) of \(String(m.payingTotal)) payments matched."))
                    .font(.footnote).foregroundColor(.secondary)
            }
        }
        if let r = m.refusal {
            Section {
                Text(verbatim: r).foregroundColor(.red)
                Button("Retry") { startCheck() }.disabled(checking || signing)
            }
        } else {
            Section {
                if let left = m.blocksLeft { Text(String(localized: "\(String(left)) blocks left to prove it.")) }
                TextField(text: $session.typed) { Text("Type the last four characters of the account fingerprint") }
                    .font(.mono).autocorrectionDisabled().textInputAutocapitalization(.never)
                if session.gate.stale {
                    Text("Payments changed: check them again before signing.").font(.footnote).foregroundColor(.secondary)
                }
                Button(signing ? "Signing…" : "Sign") { sign() }.disabled(signing || checking || !session.canSign(editor: proposal))
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

    /// "Check payments": build the entries from the rows, then check.
    private func checkPayments() {
        do {
            let entries = try session.gate.rows.map {
                try SignRows.entry($0, amountOptional: SignRows.amountOptional($0, summary: session.lastSummary))
            }
            rowError = nil
            session.gate.adopt(entries: entries)
        } catch { rowError = error.localizedDescription; return }
        startCheck()
    }

    /// The top Check and Retry send the payments last adopted; edits made since keep Sign disarmed.
    /// Only the latest request's result is shown.
    private func startCheck() {
        guard !session.inFlight else { return }
        error = nil; share = nil
        let ticket = session.begin(proposal: proposal)
        let payees = session.gate.payees
        Task {
            do {
                let r = try await signer.check(id: profile.id, proposal: ticket.proposal, expectedRecipients: payees)
                session.land(ticket, r)
            } catch { session.fail(ticket, message: error.localizedDescription) }
        }
    }

    private func sign() {
        guard session.canSign(editor: proposal), let text = session.reviewedProposal else { return }
        signing = true; error = nil
        let payees = session.gate.payees
        signTask = Task {
            defer { signing = false }
            if Task.isCancelled { return }
            do {
                // The text signed is the text that was checked, never the editor's current text. The
                // core's check and the head are redone right before and again after the device asks
                // for Face ID (MsauthSigning.sign), so a refusal comes back as its message.
                let result = try await signer.sign(id: profile.id, proposal: text, expectedRecipients: payees,
                                                   reason: String(localized: "Sign a multisig proposal"))
                if Task.isCancelled { return }
                share = result
                session.typed = ""
            } catch let refusal as MsauthRefusal {
                if !Task.isCancelled { session.refused(refusal.verdict) }
            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
    }

    private func verifyShare() {
        do {
            let s = MsauthRules.clean(shareToVerify)
            try signer.verifyShare(id: profile.id, proposal: session.reviewedProposal ?? proposal, share: s)
            guard let i = Int(s.split(separator: ":").first.map { $0.trimmingCharacters(in: .whitespaces) } ?? "") else { return }
            inHand.insert(i)
            verifyNote = String(localized: "Signer \(String(i))'s share verifies. \(String(inHand.count)) of \(String(profile.threshold)) in hand: signers \(inHand.sorted().map(String.init).joined(separator: ", ")).")
        } catch { verifyNote = error.localizedDescription }
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
