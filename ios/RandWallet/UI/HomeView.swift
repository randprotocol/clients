import SwiftUI
import UIKit

struct HomeView: View {
    let onForget: () -> Void
    @EnvironmentObject var wallet: WalletService
    @EnvironmentObject var settings: Settings
    @EnvironmentObject var router: LinkRouter
    @State private var showReceive = false
    @State private var showContacts = false
    @State private var handoff = LinkHandoff()
    @State private var showSend = false
    @State private var showSettings = false
    @State private var faucetBusy = false
    @State private var faucetMessage: String?
    @State private var copied = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    balanceCard
                    HStack(spacing: 28) {
                        RoundAction(icon: "qrcode", label: "Receive") { showReceive = true }
                        RoundAction(icon: "paperplane.fill", label: "Send") { showSend = true }
                        RoundAction(icon: "drop.fill", label: "Faucet") { Task { await faucet() } }
                    }
                    if let m = faucetMessage {
                        Text(m).font(.ui(13)).foregroundColor(Theme.textSoft).multilineTextAlignment(.center)
                    }
                    if !settings.hasBackedUpKey {
                        Card {
                            HStack {
                                Image(systemName: "exclamationmark.triangle.fill").foregroundColor(Theme.warning)
                                Text("Back up your spend key in Settings.").font(.ui(13)).foregroundColor(Theme.text)
                            }
                        }
                    }
                    ActivityList()
                }
                .padding(20)
            }
            .refreshable { await wallet.refresh() }
            .screenBackground()
            .navigationTitle("Rand Wallet")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // The brand where the shared UI's topbar carries it; the title stays for the back
                // button of pushed screens and for VoiceOver.
                ToolbarItem(placement: .principal) { Brand() }
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { showContacts = true } label: { Image(systemName: "person.2") }
                        .accessibilityLabel("Contacts")
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                }
            }
            .sheet(isPresented: $showReceive, onDismiss: presentationEnded) { ReceiveView() }
            .fullScreenCover(isPresented: $showSend, onDismiss: presentationEnded) { SendView() }
            .sheet(isPresented: $showSettings, onDismiss: presentationEnded) { SettingsView(onForget: onForget) }
            .sheet(isPresented: $showContacts, onDismiss: presentationEnded) { ContactsView() }
            // A `randpay:` link opens Send (which takes the link from the router); a Send already
            // open takes it itself.
            .onAppear { if router.pending != nil { linkArrived() } }
            .onChange(of: router.pending) { p in if p != nil { linkArrived() } }
            .task { await wallet.refresh() }
        }
    }

    private var sheetUp: Bool { showReceive || showSettings || showContacts }

    /// A link arrived: present Send now, or dismiss the sheets and let their `onDismiss` do it.
    private func linkArrived() {
        switch handoff.linkArrived(sheetUp: sheetUp, sendUp: showSend) {
        case .presentSend: showSend = true
        case .dismissSheets:
            showReceive = false
            showSettings = false
            showContacts = false
        case .none: break
        }
    }

    /// Any presentation finished dismissing: a link still pending opens Send now.
    private func presentationEnded() {
        if handoff.presentationEnded(linkPending: router.pending != nil, sheetUp: sheetUp, sendUp: showSend) == .presentSend {
            showSend = true
        }
    }

    private var balanceCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Balance").font(.caption12).foregroundColor(Theme.fieldGrain.opacity(0.8))
                Spacer()
                syncLine
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(Amount.format(wallet.balance)).font(.balance).foregroundColor(Theme.fieldGrain).lineLimit(1).minimumScaleFactor(0.5)
                Text("RAND").font(.ui(15, .semibold)).foregroundColor(Theme.fieldGrain.opacity(0.85))
            }
            if wallet.store.pendingOut > 0 {
                Text("\(Amount.format(wallet.store.pendingOut)) RAND pending").font(.caption12).foregroundColor(Theme.fieldGrain.opacity(0.8))
            }
            Button {
                UIPasteboard.general.string = wallet.address
                copied = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
            } label: {
                HStack(spacing: 6) {
                    Text(wallet.address.shortened()).font(.monoSmall)
                    Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.system(size: 11))
                }
                .foregroundColor(Theme.fieldGrain)
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(Theme.fieldGrain.opacity(0.18))
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.field)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.radiusLg, style: .continuous).stroke(Theme.fieldGrain.opacity(0.08)))
    }

    private var syncLine: some View {
        HStack(spacing: 6) {
            if wallet.isSyncing {
                ProgressView().tint(Theme.fieldGrain).scaleEffect(0.7)
                Text("Syncing").font(.caption12)
            } else if let e = wallet.lastSyncError {
                Image(systemName: "wifi.exclamationmark").font(.system(size: 11))
                Text(e).font(.caption12).lineLimit(1)
            } else if let t = wallet.lastSync {
                Text("Synced \(t, style: .relative) ago").font(.caption12)
            }
        }
        .foregroundColor(Theme.fieldGrain.opacity(0.85))
    }

    private func faucet() async {
        faucetBusy = true
        faucetMessage = "Asking the faucet for 100 RAND…"
        defer { faucetBusy = false }
        do {
            let hash = try await wallet.faucet()
            faucetMessage = "Faucet mint \(hash.shortened(head: 8, tail: 6)) submitted. It appears once committed."
        } catch {
            faucetMessage = error.localizedDescription
        }
    }
}

/// Received notes, sent payments and pending submissions, newest first.
struct ActivityList: View {
    @EnvironmentObject var wallet: WalletService

    enum Item: Identifiable {
        case received(OwnedNote)
        case sent(Submission)
        case sentRow(SentRow)
        var id: String {
            switch self {
            case .received(let n): return "r\(n.cm)"
            case .sent(let s): return "s\(s.hash)"
            case .sentRow(let r): return "x\(r.index)"
            }
        }
        var height: UInt64 {
            switch self {
            case .received(let n): return n.height
            case .sent(let s): return s.height ?? UInt64.max
            case .sentRow(let r): return r.height
            }
        }
    }

    var items: [Item] {
        let store = wallet.store
        var out: [Item] = store.notes.filter { !$0.isUnplaced && $0.units > 0 }.map { .received($0) }
        out += store.submissions.map { .sent($0) }
        // Sent rows the wallet did not submit from this device (e.g. the CLI) are history too.
        let known = Set(store.submissions.map(\.hash))
        _ = known
        out += store.sent.filter { $0.units > 0 }.map { .sentRow($0) }
        return out.sorted { $0.height > $1.height }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: "Activity")
            if items.isEmpty {
                Card {
                    Text("No activity yet. Tap Faucet to get 100 testnet RAND, or share your address to receive.")
                        .font(.ui(14)).foregroundColor(Theme.textSoft)
                }
            }
            ForEach(items) { item in
                NavigationLink { ActivityDetailView(item: item) } label: { ActivityRow(item: item) }
                    .buttonStyle(.plain)
            }
        }
    }
}

struct ActivityRow: View {
    let item: ActivityList.Item
    var body: some View {
        Card(padding: 14) {
            HStack(spacing: 12) {
                ZStack {
                    Circle().fill(Theme.surface2).frame(width: 40, height: 40)
                    Image(systemName: icon).foregroundColor(color)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.ui(15, .semibold)).foregroundColor(Theme.text)
                    Text(subtitle).font(.caption12).foregroundColor(Theme.textMute)
                }
                Spacer()
                Text(amountText).font(.ui(15, .semibold).monospacedDigit()).foregroundColor(color)
            }
        }
    }

    private var icon: String {
        switch item {
        case .received: return "arrow.down.left"
        case .sent(let s): return s.status == .pending ? "clock" : (s.status == .failed ? "xmark" : "arrow.up.right")
        case .sentRow: return "arrow.up.right"
        }
    }
    private var color: Color {
        switch item {
        case .received: return Theme.positive
        case .sent(let s): return s.status == .failed ? Theme.negative : (s.status == .pending ? Theme.warning : Theme.text)
        case .sentRow: return Theme.text
        }
    }
    private var title: String {
        switch item {
        case .received(let n): return n.spent ? "Received (spent)" : "Received"
        case .sent(let s): return s.status == .pending ? "Sending" : (s.status == .failed ? "Not committed" : "Sent")
        case .sentRow: return "Sent"
        }
    }
    private var subtitle: String {
        switch item {
        case .received(let n): return "Leaf #\(n.index) · block \(n.height)"
        case .sent(let s): return s.height.map { "Block \($0)" } ?? "Submitted \(s.submittedAt.formatted(date: .omitted, time: .shortened))"
        case .sentRow(let r): return "Leaf #\(r.index) · block \(r.height)"
        }
    }
    private var amountText: String {
        switch item {
        case .received(let n): return "+\(Amount.format(n.units))"
        case .sent(let s): return "−\(Amount.format(s.units))"
        case .sentRow(let r): return "−\(Amount.format(r.units))"
        }
    }
}
