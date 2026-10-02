import SwiftUI
import UIKit

struct SettingsView: View {
    let onForget: () -> Void
    @EnvironmentObject var settings: Settings
    @EnvironmentObject var wallet: WalletService
    @EnvironmentObject var auth: AuthService
    @EnvironmentObject var contacts: ContactsStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var rpcDraft = ""
    @State private var chainDraft = ""
    @State private var connection: String?
    @State private var testing = false
    @State private var revealed: (title: String, value: String)?
    @State private var showReveal = false
    @State private var confirmForget = false
    @State private var confirmRescan = false
    // The prover (delegated proving, spec 2026-09-28 §4.4 and §5, split authorisation: the job
    // carries the viewing key and a salt, so the prover can read this wallet's history and cannot
    // spend). The link holds a secret: it lives in this field until Save, and the field is emptied
    // once it is paired.
    @State private var proverLink = ""
    @State private var pairing = false
    /// The one status line under the pairing form; `.warn` is a pairing that went through and
    /// says once more what the prover can now read.
    enum StatusTone { case positive, warn, negative }
    @State private var proverStatus: (tone: StatusTone, title: String, message: String)?
    @State private var probeLine = String(localized: "Asking the prover…")
    @State private var showProverScanner = false
    /// The prover the build ships the address of (the core's `version.trusted_prover`), offered in
    /// one step inside the pairing form once the core names one — never paired by itself.
    @State private var trusted: ProverPairingService.Trusted?

    var body: some View {
        NavigationStack {
            Form {
                Section("Network") {
                    TextField("RPC URL", text: $rpcDraft).font(.mono).keyboardType(.URL).autocorrectionDisabled().textInputAutocapitalization(.never)
                    TextField("Chain id", text: $chainDraft).font(.mono).keyboardType(.numberPad)
                    Button(testing ? "Testing…" : "Save and test connection") { Task { await saveAndTest() } }.disabled(testing)
                    if let c = connection { Text(c).font(.ui(13)).foregroundColor(Theme.textSoft) }
                }

                proverSection

                Section {
                    if let vk = wallet.viewingKey {
                        CopyRow(label: "Viewing key", value: vk)
                        Button("Open My history on RandScan") { openURL(Settings.explorerViewingURL) }
                    }
                } header: { Text("Viewing key") } footer: {
                    Text("Paste the viewing key on randscan.org/viewing to see every note you received or sent, in your browser. It cannot spend. Anyone you give it to sees your whole history.")
                }

                Section {
                    Button("Export key file (wallet.key.json)") { Task { await reveal(title: "wallet.key.json", value: wallet.exportKeyFile()) } } // a file name, not a phrase
                    Button("Show spend key") { Task { await reveal(title: String(localized: "Spend key"), value: wallet.exportSpendKey()) } }
                        .foregroundColor(Theme.negative)
                } header: { Text("Backup") } footer: {
                    Text("The spend key is the wallet. Anyone who sees it can spend your RAND. The key file is what the rand command-line wallet reads.")
                }

                Section("Security") {
                    Picker("Auto-lock", selection: $settings.autoLockMinutes) {
                        Text("Immediately").tag(0)
                        Text("1 minute").tag(1)
                        Text("5 minutes").tag(5)
                        Text("15 minutes").tag(15)
                        Text("1 hour").tag(60)
                    }
                    Button("Lock now") { auth.lock(); dismiss() }
                }

                Section("Appearance") {
                    Picker("Theme", selection: $settings.theme) {
                        ForEach(Settings.Theme.allCases) { t in Text(Self.themeName(t)).tag(t) }
                    }
                }

                Section("Maintenance") {
                    Button("Rescan from the first leaf") { confirmRescan = true }
                    Button("Forget this wallet", role: .destructive) { confirmForget = true }
                }

                Section("About") {
                    row("App", Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")
                    row("Core", RandCore.version)
                    row("Chain build", (try? RandCore.constants())?.chainBuild ?? "")
                    row("Fee floor", String(localized: "\(Amount.format((try? RandCore.constants())?.bundleBaseFee ?? "0")) RAND"))
                    Link("Rand Protocol", destination: URL(string: "https://randprotocol.org/clients")!)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .navigationBarTrailing) { Button("Done") { dismiss() } } }
            .onAppear {
                rpcDraft = settings.rpcUrl
                chainDraft = String(settings.chainId)
                trusted = ProverPairingService.trusted()
            }
            .sheet(isPresented: $showProverScanner) {
                QRScannerView(prompt: "Point the camera at your prover's pairing QR code") { code in
                    proverLink = code.trimmingCharacters(in: .whitespacesAndNewlines)
                    showProverScanner = false
                }
            }
            .task { await probeProver() }
            .sheet(isPresented: $showReveal) {
                if let r = revealed { RevealView(title: r.title, value: r.value) }
            }
            .confirmationDialog("Rescan the whole tree? Your notes are rebuilt from the chain; nothing is lost.", isPresented: $confirmRescan, titleVisibility: .visible) {
                Button("Rescan") { Task { await wallet.rescanFromZero() } }
            }
            .confirmationDialog("Forget this wallet on this phone? Without your spend key backup the funds are gone.", isPresented: $confirmForget, titleVisibility: .visible) {
                Button("Forget wallet", role: .destructive) {
                    wallet.forgetWallet(contacts: contacts)
                    auth.lock()
                    dismiss()
                    onForget()
                }
            }
        }
    }

    @ViewBuilder private var proverSection: some View {
        Section {
            if let p = settings.prover {
                // "My own" only for a pairing whose link said so: a prover somebody else runs
                // makes the proofs too (the job carries the viewing key), and the line under it
                // says what it sees.
                row("Proofs are made by", "\(p.own ? String(localized: "My own prover") : String(localized: "Paired prover")) · \(p.name)")
                if !p.own {
                    Text(ProverPairingService.notOwnNote).font(.ui(13)).foregroundColor(Theme.textSoft)
                }
                row("Fingerprint", p.fingerprint)
                Text(probeLine).font(.ui(13)).foregroundColor(Theme.textSoft)
                if trusted != nil {
                    Text("Forgetting it goes back to the RandProtocol provers.").font(.ui(13)).foregroundColor(Theme.textSoft)
                }
                Button("Forget this prover", role: .destructive) { forgetProver() }
            } else if wallet.usesDefaultProver, let t = trusted {
                // The default: the RandProtocol provers make the proofs this device cannot — each
                // member named with its own fingerprint, what they see, asked, off in one tap.
                row("Proofs are made by", String(localized: "\(t.name) provers · where this device cannot prove"))
                ForEach(t.members, id: \.name) { m in memberRow(m.name, m.fingerprint) }
                Text("The RandProtocol provers: \(t.members.count) machines run by the validators, each with its own key, used until you choose another. They charge nothing. \(Self.defaultNote)")
                    .font(.ui(13)).foregroundColor(Theme.textSoft)
                Text(probeLine).font(.ui(13)).foregroundColor(Theme.textSoft)
                Button("Use no prover") { useNoProver() }
            } else {
                row("Proofs are made by", String(localized: "This device"))
                Text("Where this device cannot make a proof, pair a prover — rand-prover on a machine of yours, or one somebody else runs, reachable from this phone over https. It receives your viewing key and a salt, never your spend key: it can read this wallet's whole history and cannot spend.")
                    .font(.ui(13)).foregroundColor(Theme.textSoft)
                // No prover chosen: the way back to the default is one tap, with what it sees.
                if let t = trusted {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Or use the RandProtocol provers — \(t.members.count) machines run by the validators, each with its own key. They charge nothing. \(Self.defaultNote)")
                            .font(.ui(13)).foregroundColor(Theme.textSoft)
                        ForEach(t.members, id: \.name) { m in memberRow(m.name, m.fingerprint) }
                        Button("Use the RandProtocol provers") { useTrustedProver() }
                    }
                }
            }
            Text("Pair your own prover").font(.ui(14, .semibold)).foregroundColor(Theme.text)
            HStack(spacing: 8) {
                TextField("randprover:…", text: $proverLink).font(.mono).autocorrectionDisabled().textInputAutocapitalization(.never)
                Button { showProverScanner = true } label: { Image(systemName: "qrcode.viewfinder") }
                    .accessibilityLabel("Scan QR code").buttonStyle(.borderless)
                Button("Paste") { if let s = UIPasteboard.general.string { proverLink = s.trimmingCharacters(in: .whitespacesAndNewlines) } }
                    .buttonStyle(.borderless)
            }
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundColor(Theme.negative)
                VStack(alignment: .leading, spacing: 4) {
                    Text("A prover sees your history").font(.ui(14, .semibold)).foregroundColor(Theme.text)
                    Text(ProverPairingService.warning).font(.ui(13)).foregroundColor(Theme.text)
                }
            }
            Button(pairing ? "Pairing…" : "Save") { Task { await saveProver() } }.disabled(pairing)
            if let s = proverStatus {
                VStack(alignment: .leading, spacing: 4) {
                    Text(s.title).font(.ui(14, .semibold)).foregroundColor(statusColor(s.tone))
                    Text(s.message).font(.ui(13)).foregroundColor(Theme.textSoft)
                }
            }
        } header: { Text("Prover") } footer: {
            Text("Pairing link: the randprover: link your prover shows. It carries a secret — paste it here and nowhere else. A prover must be reached over https (plain http only on this device).")
        }
    }

    private func saveProver() async {
        let link = proverLink.trimmingCharacters(in: .whitespacesAndNewlines)
        proverStatus = nil
        guard !link.isEmpty else {
            proverStatus = (.negative, String(localized: "Not paired"), String(localized: "Paste the randprover: link your prover shows."))
            return
        }
        pairing = true
        defer { pairing = false }
        let seen: ProverPairingService.Preview
        do { seen = try ProverPairingService.preview(link) } catch {
            proverStatus = (.negative, String(localized: "Not paired"), error.localizedDescription)
            return
        }
        do {
            let (paired, token) = try await ProverPairingService.pair(link)
            try ProverPairingService.save(paired, token: token, settings: settings)
            proverLink = "" // the token goes with it
            let note = seen.note.map { " \($0)" } ?? ""
            proverStatus = (.positive, String(localized: "Paired"), String(localized: "Proofs this device cannot make go to \(paired.name).\(note) Its fingerprint is \(paired.fingerprint) — check that your prover shows the same."))
            await probeProver()
        } catch {
            proverStatus = (.negative, String(localized: "Not paired"), error.localizedDescription)
        }
    }

    /// What the RandProtocol prover sees, in one line, wherever it is offered or in use.
    static var defaultNote: String { String(localized: "Each one that proves a send receives this wallet's viewing key, so it can read your whole history, past and future. None can spend.") }

    /// "Use the RandProtocol prover": back to the default — nothing paired, nothing asked; the
    /// one-time notice still comes before the first send through it.
    private func useTrustedProver() {
        guard let t = trusted, !pairing else { return }
        wallet.useDefaultProver()
        proverStatus = (.warn, String(localized: "Using the \(t.name) provers"), String(localized: "Proofs this device cannot make go to one of them; each one that proves a send sees that wallet's viewing key. \(ProverPairingService.warning)"))
        Task { await probeProver() }
    }

    private func useNoProver() {
        wallet.useNoProver()
        proverStatus = (.positive, String(localized: "No prover"), String(localized: "Proofs are made on this device only; where it cannot make one, sending waits until you pair a prover or use the RandProtocol provers again."))
    }

    private func forgetProver() {
        ProverPairingService.forget(settings: settings)
        if wallet.usesDefaultProver, let t = trusted {
            proverStatus = (.positive, String(localized: "Forgotten"), String(localized: "The prover's pairing is gone from this wallet. Proofs this device cannot make go to the \(t.name) provers again."))
            Task { await probeProver() }
        } else {
            proverStatus = (.positive, String(localized: "Forgotten"), String(localized: "Proofs are made on this device again. The prover's pairing is gone from this wallet."))
        }
    }

    private func statusColor(_ tone: StatusTone) -> Color {
        switch tone {
        case .positive: return Theme.positive
        case .warn: return Theme.warning
        case .negative: return Theme.negative
        }
    }

    private func probeProver() async {
        probeLine = String(localized: "Asking the prover…")
        if let p = settings.prover {
            let answer = await ProverPairingService.probe(p)
            if settings.prover == p { probeLine = ProverPairingService.statusLine(answer) }
        } else if wallet.usesDefaultProver, let members = try? ProverPairingService.builtInPool() {
            // The default: the first member that answers with its pinned key speaks for the pool.
            for m in members {
                let answer = await ProverPairingService.probe(m.pairing)
                if case .ok = answer {
                    if settings.prover == nil { probeLine = "\(m.pairing.name): \(ProverPairingService.statusLine(answer))" }
                    return
                }
            }
            if settings.prover == nil { probeLine = String(localized: "None of the RandProtocol provers answers right now.") }
        }
    }

    /// `k` is a key in the catalog; `v` is data, or a sentence already localised.
    private func row(_ k: LocalizedStringKey, _ v: String) -> some View {
        HStack { Text(k); Spacer(); Text(v).font(.mono).foregroundColor(Theme.textSoft) }
    }

    /// A pool member's name is data: the same row, no catalog key.
    private func memberRow(_ k: String, _ v: String) -> some View {
        HStack { Text(k); Spacer(); Text(v).font(.mono).foregroundColor(Theme.textSoft) }
    }

    private static func themeName(_ t: Settings.Theme) -> String {
        switch t {
        case .system: return String(localized: "System")
        case .dark: return String(localized: "Dark")
        case .light: return String(localized: "Light")
        }
    }

    private func saveAndTest() async {
        settings.rpcUrl = rpcDraft.trimmingCharacters(in: .whitespaces)
        settings.chainId = Int(chainDraft) ?? settings.chainId
        testing = true
        defer { testing = false }
        do { connection = try await wallet.testConnection() } catch { connection = error.localizedDescription }
    }

    private func reveal(title: String, value: String?) async {
        guard let value, await auth.confirmForSecret() else { return }
        revealed = (title, value)
        showReveal = true
        settings.hasBackedUpKey = true
    }
}

struct RevealView: View {
    let title: String
    let value: String
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundColor(Theme.warning)
                    Text("Never share this. Anyone who has it controls your funds.").font(.ui(14)).foregroundColor(Theme.text)
                }
                Card {
                    Text(value).font(.mono).foregroundColor(Theme.text).textSelection(.enabled)
                }
                CopyRow(label: "Copy", value: value)
                Spacer()
            }
            .padding(20)
            .screenBackground()
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .navigationBarTrailing) { Button("Done") { dismiss() } } }
        }
    }
}
