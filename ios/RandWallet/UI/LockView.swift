import SwiftUI

struct LockView: View {
    @EnvironmentObject var auth: AuthService
    @State private var failed = false
    @State private var busy = false

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            // The bare mark, bigger, as the shared UI's lock screen: no box around it.
            Mark(size: 44)
            Text("Rand Wallet").font(.ui(26, .bold)).foregroundColor(Theme.textStrong)
            Text("Locked").font(.body15).foregroundColor(Theme.textSoft)
            Spacer()
            if failed {
                Text("Could not unlock. Try again.").font(.ui(13)).foregroundColor(Theme.negative)
            }
            PrimaryButton(title: "Unlock with \(Keychain.biometryName)", busy: busy) { Task { await unlock() } }
                .padding(.horizontal, 20).padding(.bottom, 24)
        }
        .screenBackground()
        .task { await unlock() }
    }

    private func unlock() async {
        busy = true
        defer { busy = false }
        failed = !(await auth.unlock())
    }
}
