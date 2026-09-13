import SwiftUI

@main
struct RandWalletApp: App {
    @StateObject private var settings: Settings
    @StateObject private var wallet: WalletService
    @StateObject private var auth: AuthService
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
