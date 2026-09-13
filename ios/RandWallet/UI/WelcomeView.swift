import SwiftUI

struct WelcomeView: View {
    let onReady: () -> Void
    @State private var showCreate = false
    @State private var showImport = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Spacer()
                ZStack {
                    RoundedRectangle(cornerRadius: 28, style: .continuous).fill(Theme.aurora).frame(width: 96, height: 96)
                    Image(systemName: "shield.lefthalf.filled").font(.system(size: 44, weight: .semibold)).foregroundColor(.white)
                }
                Text("Rand Wallet").font(.system(size: 30, weight: .bold)).foregroundColor(Theme.textStrong).padding(.top, 24)
                Text("A shielded wallet for SHRUGG.\nYour balance and payments are private; the chain sees only proofs.")
                    .font(.body15).foregroundColor(Theme.textSoft).multilineTextAlignment(.center).padding(.top, 8).padding(.horizontal, 32)
                Spacer()
                VStack(spacing: 12) {
                    PrimaryButton(title: "Create a new wallet") { showCreate = true }
                    SecondaryButton(title: "I already have a wallet") { showImport = true }
                }
                .padding(.horizontal, 20).padding(.bottom, 24)
            }
            .screenBackground()
            .navigationDestination(isPresented: $showCreate) { CreateWalletView(onDone: onReady) }
            .navigationDestination(isPresented: $showImport) { ImportWalletView(onDone: onReady) }
        }
    }
}

struct CreateWalletView: View {
    let onDone: () -> Void
    @EnvironmentObject var wallet: WalletService
    @EnvironmentObject var auth: AuthService
    @EnvironmentObject var settings: Settings
    @State private var info: WalletInfo?
    @State private var saved = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Your secret key").font(.title).foregroundColor(Theme.textStrong)
                Text("This 64-character spend key is the only copy of your wallet. Anyone who has it can spend your SHRUGG; anyone who loses it loses the wallet. Write it down and keep it offline.")
                    .font(.body15).foregroundColor(Theme.textSoft)
                if let info {
                    Card {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(info.spendKey).font(.mono).foregroundColor(Theme.text).textSelection(.enabled)
                            CopyRow(label: "Copy spend key", value: info.spendKey, shortened: true)
                        }
                    }
                    Card {
                        CopyRow(label: "Your address", value: info.address)
                    }
                    Toggle(isOn: $saved) {
                        Text("I have saved my spend key somewhere safe").font(.body15).foregroundColor(Theme.text)
                    }
                    .tint(Theme.accent)
                    PrimaryButton(title: "Open my wallet", enabled: saved) {
                        settings.hasBackedUpKey = true
                        auth.markUnlocked()
                        onDone()
                    }
                }
                ErrorText(message: error)
            }
            .padding(20)
        }
        .screenBackground()
        .navigationTitle("New wallet")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            guard info == nil else { return }
            do { info = try wallet.createWallet() } catch { self.error = error.localizedDescription }
        }
    }
}

struct ImportWalletView: View {
    let onDone: () -> Void
    @EnvironmentObject var wallet: WalletService
    @EnvironmentObject var auth: AuthService
    @EnvironmentObject var settings: Settings
    @State private var input = ""
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Import a wallet").font(.title).foregroundColor(Theme.textStrong)
                Text("Paste your 64-character spend key, or the contents of a wallet.key.json from the shrugg command-line wallet.")
                    .font(.body15).foregroundColor(Theme.textSoft)
                TextEditor(text: $input)
                    .font(.mono).frame(minHeight: 120)
                    .scrollContentBackground(.hidden)
                    .padding(10).background(Theme.surface2)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous).stroke(Theme.border, lineWidth: 1))
                    .autocorrectionDisabled().textInputAutocapitalization(.never)
                ErrorText(message: error)
                PrimaryButton(title: "Import", enabled: !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                    do {
                        _ = try wallet.importWallet(input)
                        settings.hasBackedUpKey = true
                        auth.markUnlocked()
                        onDone()
                    } catch { self.error = error.localizedDescription }
                }
            }
            .padding(20)
        }
        .screenBackground()
        .navigationTitle("Import")
        .navigationBarTitleDisplayMode(.inline)
    }
}
