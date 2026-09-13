import SwiftUI

/// Welcome when there is no wallet, Lock when there is one and it is locked, Home otherwise.
struct RootView: View {
    @EnvironmentObject var wallet: WalletService
    @EnvironmentObject var auth: AuthService
    @State private var hasWallet = Keychain.hasSpendKey

    var body: some View {
        Group {
            if !hasWallet {
                WelcomeView(onReady: { hasWallet = true })
            } else if !auth.isUnlocked {
                LockView()
            } else {
                HomeView(onForget: { hasWallet = false })
            }
        }
        .animation(.easeInOut(duration: 0.2), value: auth.isUnlocked)
        .animation(.easeInOut(duration: 0.2), value: hasWallet)
    }
}
