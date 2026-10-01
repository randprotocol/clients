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
    @State private var probeLine = "Asking the prover…"
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
                    Button("Export key file (wallet.key.json)") { Task { await reveal(title: "wallet.key.json", value: wallet.exportKeyFile()) } }
                    Button("Show spend key") { Task { await reveal(title: "Spend key", value: wallet.exportSpendKey()) } }
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
                        ForEach(Settings.Theme.allCases) { t in Text(t.rawValue.capitalized).tag(t) }
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
                    row("Fee floor", "\(Amount.format((try? RandCore.constants())?.bundleBaseFee ?? "0")) RAND")
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
                row("Proofs are made by", "\(p.own ? "My own prover" : "Paired prover") · \(p.name)")
                if !p.own {
                    Text(ProverPairingService.notOwnNote).font(.ui(13)).foregroundColor(Theme.textSoft)
                }
                row("Fingerprint", p.fingerprint)
                Text(probeLine).font(.ui(13)).foregroundColor(Theme.textSoft)
                Button("Forget this prover", role: .destructive) { forgetProver() }
            } else {
                row("Proofs are made by", "This device")
                Text("Where this device cannot make a proof, pair a prover — rand-prover on a machine of yours, or one somebody else runs, reachable from this phone over https. It receives your viewing key and a salt, never your spend key: it can read this wallet's whole history and cannot spend.")
                    .font(.ui(13)).foregroundColor(Theme.textSoft)
            }
            HStack(spacing: 8) {
                TextField("randprover:…", text: $proverLink).font(.mono).autocorrectionDisabled().textInputAutocapitalization(.never)
                Button { showProverScanner = true } label: { Image(systemName: "qrcode.viewfinder") }
                    .accessibilityLabel("Scan QR code").buttonStyle(.borderless)
                Button("Paste") { if let s = UIPasteboard.general.string { proverLink = s.trimmingCharacters(in: .whitespacesAndNewlines) } }
                    .buttonStyle(.borderless)
            }
            // The one-step pairing of the prover the build ships the address of (the JS's
            // `use-trusted-prover`): part of the form, above the warning, so the warning is on
            // screen before the button is, and the same status line afterwards.
            if let t = trusted {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Or use the prover RandProtocol runs for everyone — \(t.url), fingerprint \(t.fingerprint). It sees as much as any prover you pair (the warning below) and charges nothing; your spend key stays here either way.")
                        .font(.ui(13)).foregroundColor(Theme.textSoft)
                    Button(pairing ? "Pairing…" : "Use the RandProtocol prover") { Task { await useTrustedProver() } }.disabled(pairing)
                }
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
            proverStatus = (.negative, "Not paired", "Paste the randprover: link your prover shows.")
            return
        }
        pairing = true
        defer { pairing = false }
        let seen: ProverPairingService.Preview
        do { seen = try ProverPairingService.preview(link) } catch {
            proverStatus = (.negative, "Not paired", error.localizedDescription)
            return
        }
        do {
            let (paired, token) = try await ProverPairingService.pair(link)
            try ProverPairingService.save(paired, token: token, settings: settings)
            proverLink = "" // the token goes with it
            let note = seen.note.map { " \($0)" } ?? ""
            proverStatus = (.positive, "Paired", "Proofs this device cannot make go to \(paired.name).\(note) Its fingerprint is \(paired.fingerprint) — check that your prover shows the same.")
            await probeProver()
        } catch {
            proverStatus = (.negative, "Not paired", error.localizedDescription)
        }
    }

    /// The one-step pairing of the built-in prover: the link never passes through this screen;
    /// the service holds it to the pinned fingerprint and asks the prover for its key like any
    /// pairing, and the record is saved not own, named RandProtocol. The status says once more
    /// what the prover can now read.
    private func useTrustedProver() async {
        guard let t = trusted, !pairing else { return }
        proverStatus = nil
        pairing = true
        defer { pairing = false }
        do {
            let (paired, token) = try await ProverPairingService.pairTrusted()
            try ProverPairingService.save(paired, token: token, settings: settings)
            proverStatus = (.warn, "Paired — this prover can read your history",
                            "Proofs this device cannot make go to \(paired.name). Its fingerprint is \(paired.fingerprint.isEmpty ? t.fingerprint : paired.fingerprint). \(ProverPairingService.warning)")
            await probeProver()
        } catch {
            proverStatus = (.negative, "Not paired", error.localizedDescription)
        }
    }

    private func forgetProver() {
        ProverPairingService.forget(settings: settings)
        proverStatus = (.positive, "Forgotten", "Proofs are made on this device again. The prover's pairing is gone from this wallet.")
    }

    private func statusColor(_ tone: StatusTone) -> Color {
        switch tone {
        case .positive: return Theme.positive
        case .warn: return Theme.warning
        case .negative: return Theme.negative
        }
    }

    private func probeProver() async {
        guard let p = settings.prover else { return }
        probeLine = "Asking the prover…"
        let answer = await ProverPairingService.probe(p)
        if settings.prover == p { probeLine = ProverPairingService.statusLine(answer) }
    }

    private func row(_ k: String, _ v: String) -> some View {
        HStack { Text(k); Spacer(); Text(v).font(.mono).foregroundColor(Theme.textSoft) }
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
