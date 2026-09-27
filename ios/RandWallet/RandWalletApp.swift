import SwiftUI

@main
struct RandWalletApp: App {
    @StateObject private var settings: Settings
    @StateObject private var wallet: WalletService
    @StateObject private var auth: AuthService
    @StateObject private var contacts = ContactsStore()
    @StateObject private var router = LinkRouter()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let settings = Settings()
        let wallet = WalletService(settings: settings)
        _settings = StateObject(wrappedValue: settings)
        _wallet = StateObject(wrappedValue: wallet)
        _auth = StateObject(wrappedValue: AuthService(settings: settings, wallet: wallet))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(settings)
                .environmentObject(wallet)
                .environmentObject(auth)
                .environmentObject(contacts)
                .environmentObject(router)
                // A `randpay:` link opens Send pre-filled once the wallet is unlocked. Never sends.
                .onOpenURL { router.open($0) }
                .preferredColorScheme(settings.theme.colorScheme)
                .tint(Theme.accent)
        }
        .onChange(of: scenePhase) { phase in
            switch phase {
            case .background: auth.didEnterBackground()
            case .active: auth.willEnterForeground()
            default: break
            }
        }
    }
}

/// A `randpay:` link the system handed the app, held until the Send screen takes it.
final class LinkRouter: ObservableObject {
    @Published private(set) var pending: String?

    func open(_ url: URL) {
        guard url.scheme?.lowercased() == "randpay" else { return }
        pending = url.absoluteString
    }

    /// The link, once: the send screen that reads it clears it.
    func take() -> String? {
        defer { pending = nil }
        return pending
    }
}
