import SwiftUI
import UIKit

struct SettingsView: View {
    let onForget: () -> Void
    @EnvironmentObject var settings: Settings
    @EnvironmentObject var wallet: WalletService
    @EnvironmentObject var auth: AuthService
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

    var body: some View {
        NavigationStack {
            Form {
                Section("Network") {
                    TextField("RPC URL", text: $rpcDraft).font(.mono).keyboardType(.URL).autocorrectionDisabled().textInputAutocapitalization(.never)
                    TextField("Chain id", text: $chainDraft).font(.mono).keyboardType(.numberPad)
                    Button(testing ? "Testing…" : "Save and test connection") { Task { await saveAndTest() } }.disabled(testing)
                    if let c = connection { Text(c).font(.system(size: 13)).foregroundColor(Theme.textSoft) }
                }

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
                    Text("The spend key is the wallet. Anyone who sees it can spend your SHRUGG. The key file is what the shrugg command-line wallet reads.")
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
                    row("Core", ShruggCore.version)
                    row("Chain build", (try? ShruggCore.constants())?.chainBuild ?? "")
                    row("Fee floor", "\(Amount.format((try? ShruggCore.constants())?.bundleBaseFee ?? "0")) SHRUGG")
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
            }
            .sheet(isPresented: $showReveal) {
                if let r = revealed { RevealView(title: r.title, value: r.value) }
            }
            .confirmationDialog("Rescan the whole tree? Your notes are rebuilt from the chain; nothing is lost.", isPresented: $confirmRescan, titleVisibility: .visible) {
                Button("Rescan") { Task { await wallet.rescanFromZero() } }
            }
            .confirmationDialog("Forget this wallet on this phone? Without your spend key backup the funds are gone.", isPresented: $confirmForget, titleVisibility: .visible) {
                Button("Forget wallet", role: .destructive) {
                    wallet.forgetWallet()
                    auth.lock()
                    dismiss()
                    onForget()
                }
            }
        }
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
                    Text("Never share this. Anyone who has it controls your funds.").font(.system(size: 14)).foregroundColor(Theme.text)
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
