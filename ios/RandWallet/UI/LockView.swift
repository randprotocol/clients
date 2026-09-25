import SwiftUI

struct LockView: View {
    @EnvironmentObject var auth: AuthService
    @State private var failed = false
    @State private var busy = false

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            ZStack {
                RoundedRectangle(cornerRadius: 28, style: .continuous).fill(Theme.surface2).frame(width: 96, height: 96)
                Image(systemName: "lock.fill").font(.system(size: 40, weight: .semibold)).foregroundColor(Theme.accent)
            }
            Text("Rand Wallet").font(.system(size: 26, weight: .bold)).foregroundColor(Theme.textStrong)
            Text("Locked").font(.body15).foregroundColor(Theme.textSoft)
            Spacer()
            if failed {
                Text("Could not unlock. Try again.").font(.system(size: 13)).foregroundColor(Theme.negative)
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
