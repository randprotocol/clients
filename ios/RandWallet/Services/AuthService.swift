import Foundation
import SwiftUI

/// Lock state: unlocked by biometrics / passcode, re-locked after the auto-lock interval in the
/// background.
@MainActor
final class AuthService: ObservableObject {
    @Published private(set) var isUnlocked = false
    private var backgroundedAt: Date?
    private let settings: Settings
    private let wallet: WalletService

    init(settings: Settings, wallet: WalletService) {
        self.settings = settings
        self.wallet = wallet
    }

    func unlock() async -> Bool {
        let ok = await Keychain.authenticate(reason: String(localized: "Unlock your wallet"))
        if ok, wallet.unlockFromKeychain() {
            isUnlocked = true
        }
        return isUnlocked
    }

    /// After creating or importing, the wallet is already in memory.
    func markUnlocked() { isUnlocked = true }

    func lock() {
        isUnlocked = false
        wallet.lock()
    }

    func didEnterBackground() { backgroundedAt = Date() }

    func willEnterForeground() {
        guard let at = backgroundedAt else { return }
        backgroundedAt = nil
        let minutes = settings.autoLockMinutes
        if minutes > 0, Date().timeIntervalSince(at) > Double(minutes) * 60, isUnlocked {
            // Never lock while a proof is running — here, the auth proof on the way to a paired
            // prover, or the wait on that prover: the user was told to keep the app open.
            switch wallet.phase {
            case .proving, .authorising, .provingRemotely: return
            default: break
            }
            lock()
        }
    }

    /// Authenticate again before showing a secret.
    func confirmForSecret() async -> Bool {
        await Keychain.authenticate(reason: String(localized: "Reveal your secret key"))
    }
}
