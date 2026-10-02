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
    @State private var showSwap = false
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
                        // Swap replaces Faucet here, as in the other shells; the faucet stays
                        // reachable from an empty activity list.
                        RoundAction(icon: "arrow.left.arrow.right", label: "Swap") { showSwap = true }
                    }
                    if !settings.hasBackedUpKey {
                        Card {
                            HStack {
                                Image(systemName: "exclamationmark.triangle.fill").foregroundColor(Theme.warning)
                                Text("Back up your spend key in Settings.").font(.ui(13)).foregroundColor(Theme.text)
                            }
                        }
                    }
                    ActivityList(faucetMessage: faucetMessage, faucetBusy: faucetBusy) { Task { await faucet() } }
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
            .fullScreenCover(isPresented: $showSwap, onDismiss: presentationEnded) { SwapView() }
            .sheet(isPresented: $showSettings, onDismiss: presentationEnded) { SettingsView(onForget: onForget) }
            .sheet(isPresented: $showContacts, onDismiss: presentationEnded) { ContactsView() }
            // A `randpay:` link opens Send (which takes the link from the router); a Send already
            // open takes it itself.
            .onAppear { if router.pending != nil { linkArrived() } }
            .onChange(of: router.pending) { p in if p != nil { linkArrived() } }
            .task {
                await wallet.refresh()
                await wallet.loadTokens()
            }
        }
    }

    private var sheetUp: Bool { showReceive || showSettings || showContacts }
    /// Send, or Swap — a full-screen flow that may be proving: a link waits for it to close.
    private var flowUp: Bool { showSend || showSwap }

    /// A link arrived: present Send now, or dismiss the sheets and let their `onDismiss` do it.
    private func linkArrived() {
        switch handoff.linkArrived(sheetUp: sheetUp, sendUp: flowUp) {
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
        if router.settingsRequested && !flowUp && !sheetUp {
            router.settingsRequested = false
            showSettings = true
            return
        }
        if handoff.presentationEnded(linkPending: router.pending != nil, sheetUp: sheetUp, sendUp: flowUp) == .presentSend {
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
        faucetMessage = String(localized: "Asking the faucet for 100 RAND…")
        defer { faucetBusy = false }
        do {
            let hash = try await wallet.faucet()
            faucetMessage = String(localized: "Faucet mint \(hash.shortened(head: 8, tail: 6)) submitted. It appears once committed.")
        } catch {
            faucetMessage = error.localizedDescription
        }
    }
}

/// Received notes, sent payments and pending submissions, newest first.
struct ActivityList: View {
    @EnvironmentObject var wallet: WalletService
    /// The faucet lives here since Swap took its place on the action row: offered while the list
    /// is empty (`ui/screens/home.js`'s empty activity).
    var faucetMessage: String? = nil
    var faucetBusy = false
    var onFaucet: (() -> Void)? = nil

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
                    VStack(alignment: .leading, spacing: 12) {
                        Text("No activity yet. Transactions you send or receive will appear here.")
                            .font(.ui(14)).foregroundColor(Theme.textSoft)
                        if let onFaucet {
                            Button(action: onFaucet) {
                                HStack(spacing: 6) {
                                    if faucetBusy { ProgressView().scaleEffect(0.7) }
                                    Text("Get test RAND from the faucet").font(.ui(14, .semibold))
                                }
                                .foregroundColor(Theme.accent)
                            }
                            .disabled(faucetBusy)
                        }
                    }
                }
            }
            if let m = faucetMessage {
                Text(m).font(.ui(13)).foregroundColor(Theme.textSoft)
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
    @EnvironmentObject var wallet: WalletService
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
        case .sent(let s): return s.status == .pending ? "clock" : (s.status == .failed ? "xmark" : (s.isInvoke ? "arrow.left.arrow.right" : "arrow.up.right"))
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
        case .received(let n): return n.spent ? String(localized: "Received (spent)") : String(localized: "Received")
        case .sent(let s) where s.isInvoke:
            return s.status == .pending ? String(localized: "Swapping") : (s.status == .failed ? String(localized: "Not committed") : String(localized: "Swapped"))
        case .sent(let s):
            return s.status == .pending ? String(localized: "Sending") : (s.status == .failed ? String(localized: "Not committed") : String(localized: "Sent"))
        case .sentRow: return String(localized: "Sent")
        }
    }
    private var subtitle: String {
        switch item {
        case .received(let n): return String(localized: "Leaf #\(n.index) · block \(n.height)")
        case .sent(let s):
            return s.height.map { String(localized: "Block \($0)") }
                ?? String(localized: "Submitted \(s.submittedAt.formatted(date: .omitted, time: .shortened))")
        case .sentRow(let r): return String(localized: "Leaf #\(r.index) · block \(r.height)")
        }
    }
    private var amountText: String {
        switch item {
        case .received(let n) where n.asset != 0:
            // A token's own decimals and symbol (DUR has 6): never printed as if it were RAND.
            let t = wallet.tokenName(n.asset)
            return "+\(Amount.format(n.units, decimals: t.decimals)) \(t.symbol)"
        case .received(let n): return "+\(Amount.format(n.units))"
        case .sent(let s) where s.isInvoke && (UInt64(s.burnA ?? "") ?? 0) > 0:
            let t = wallet.tokenName(s.burnAsset ?? 0)
            return "−\(Amount.format(UInt64(s.burnA ?? "") ?? 0, decimals: t.decimals)) \(t.symbol)"
        case .sent(let s): return "−\(Amount.format(s.units))"
        case .sentRow(let r): return "−\(Amount.format(r.units))"
        }
    }
}
