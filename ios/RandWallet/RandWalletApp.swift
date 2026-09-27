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

/// When Home presents Send for an incoming link. The link itself stays in `LinkRouter` until Send
/// takes it, so nothing here can lose it; this only sequences the presentation. SwiftUI will not
/// present while another sheet is still dismissing, so with a sheet up the sheets are dismissed
/// and Send follows the dismissal's completion (`onDismiss`), never a timer.
struct LinkHandoff: Equatable {
    enum Action: Equatable { case none, presentSend, dismissSheets }

    /// A link is waiting for the sheets to finish dismissing.
    private(set) var waiting = false

    mutating func linkArrived(sheetUp: Bool, sendUp: Bool) -> Action {
        // Send already up takes the link itself (or, mid-proof, leaves it pending for later).
        if sendUp { return .none }
        if sheetUp { waiting = true; return .dismissSheets }
        waiting = false
        return .presentSend
    }

    /// A sheet or Send finished dismissing. `linkPending` is whether the router still holds a link.
    mutating func presentationEnded(linkPending: Bool, sheetUp: Bool, sendUp: Bool) -> Action {
        guard linkPending else { waiting = false; return .none }
        if sheetUp || sendUp { waiting = true; return .none }
        waiting = false
        return .presentSend
    }
}
