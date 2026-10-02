import SwiftUI

struct ActivityDetailView: View {
    let item: ActivityList.Item
    @EnvironmentObject var wallet: WalletService
    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                switch item {
                case .received(let n): received(n)
                case .sent(let s): sent(s)
                case .sentRow(let r): sentRow(r)
                }
            }
            .padding(20)
        }
        .screenBackground()
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var title: String {
        switch item {
        case .received: return String(localized: "Received")
        case .sent(let s) where s.isInvoke: return String(localized: "Swap")
        case .sent, .sentRow: return String(localized: "Sent")
        }
    }

    private func received(_ n: OwnedNote) -> some View {
        Group {
            Text("+\(Amount.format(n.units, decimals: wallet.tokenName(n.asset).decimals)) \(wallet.tokenName(n.asset).symbol)")
                .font(.balance).foregroundColor(Theme.positive).lineLimit(1).minimumScaleFactor(0.5)
            Card {
                VStack(alignment: .leading, spacing: 12) {
                    row("Status", n.spent ? String(localized: "Spent") : (n.pending != nil ? String(localized: "Held by a pending send") : String(localized: "Unspent")))
                    row("Leaf", "#\(n.index)")
                    row("Block", "\(n.height)")
                    row("Note time", "\(n.time)")
                    if n.asset != 0 { row("Asset", "\(wallet.tokenName(n.asset).symbol) (#\(n.asset))") }
                    CopyRow(label: "From (pk)", value: n.from)
                    CopyRow(label: "Commitment", value: n.cm)
                }
            }
            Text("The sender's pk identifies who paid you to anyone holding your viewing key, and nobody else.")
                .font(.ui(13)).foregroundColor(Theme.textMute)
            SecondaryButton(title: "View note on RandScan") {
                openURL(Settings.explorerURL.appendingPathComponent("notes").appendingPathComponent(n.cm))
            }
        }
    }

    @ViewBuilder private func sent(_ s: Submission) -> some View {
        if s.isInvoke { swap(s) } else { transfer(s) }
    }

    /// A swap: what it paid, what the pool pays back (found by the next scan), its transaction.
    private func swap(_ s: Submission) -> some View {
        Group {
            if let a = s.burnAsset, let b = s.burnA, (UInt64(b) ?? 0) > 0 {
                Text("−\(Amount.format(UInt64(b) ?? 0, decimals: wallet.tokenName(a).decimals)) \(wallet.tokenName(a).symbol)")
                    .font(.balance).foregroundColor(Theme.text).lineLimit(1).minimumScaleFactor(0.5)
            } else {
                Text("−\(Amount.format(s.units)) RAND").font(.balance).foregroundColor(Theme.text).lineLimit(1).minimumScaleFactor(0.5)
            }
            Card {
                VStack(alignment: .leading, spacing: 12) {
                    row("Status", Self.status(s))
                    if let h = s.height { row("Block", "\(h)") }
                    ForEach(Array((s.payouts ?? []).enumerated()), id: \.offset) { _, p in
                        row("You receive", "\(Amount.format(UInt64(p.amount) ?? 0, decimals: wallet.tokenName(p.asset).decimals)) \(wallet.tokenName(p.asset).symbol)")
                    }
                    row("Network fee", String(localized: "\(Amount.format(s.fee)) RAND"))
                    row("Submitted", s.submittedAt.formatted(date: .abbreviated, time: .shortened))
                    CopyRow(label: "Program", value: s.to)
                    CopyRow(label: "Transaction", value: s.hash)
                }
            }
            SecondaryButton(title: "Open transaction on RandScan") { openURL(Settings.explorerTransactionURL(s.hash)) }
        }
    }

    private func transfer(_ s: Submission) -> some View {
        Group {
            Text("−\(Amount.format(s.units)) RAND").font(.balance).foregroundColor(Theme.text)
            Card {
                VStack(alignment: .leading, spacing: 12) {
                    row("Status", Self.status(s))
                    if let h = s.height { row("Block", "\(h)") }
                    row("Fee", String(localized: "\(Amount.format(s.fee)) RAND"))
                    row("Submitted", s.submittedAt.formatted(date: .abbreviated, time: .shortened))
                    CopyRow(label: "To", value: s.to)
                    CopyRow(label: "Transaction", value: s.hash)
                }
            }
            Card {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Disclose this payment").font(.ui(15, .semibold)).foregroundColor(Theme.text)
                    Text("Copy the transaction key and paste it on the transaction's RandScan page to show exactly this payment — its amount and recipient — to whoever you hand the key to.")
                        .font(.ui(13)).foregroundColor(Theme.textSoft)
                    CopyRow(label: "Transaction key", value: s.txKey)
                    SecondaryButton(title: "Open transaction on RandScan") { openURL(Settings.explorerTransactionURL(s.hash)) }
                }
            }
        }
    }

    private func sentRow(_ r: SentRow) -> some View {
        Group {
            Text("−\(Amount.format(r.units)) RAND").font(.balance).foregroundColor(Theme.text)
            Card {
                VStack(alignment: .leading, spacing: 12) {
                    row("Leaf", "#\(r.index)")
                    row("Block", "\(r.height)")
                    CopyRow(label: "To (pk)", value: r.toPk)
                }
            }
            Text("This payment was made with your key from another device, so its transaction key is not stored here. Your viewing key opens it on RandScan.")
                .font(.ui(13)).foregroundColor(Theme.textMute)
        }
    }

    private static func status(_ s: Submission) -> String {
        switch s.status {
        case .pending: return String(localized: "Pending")
        case .failed: return String(localized: "Not committed (notes released)")
        default: return String(localized: "Committed")
        }
    }

    /// `k` is a key in the catalog; `v` is data, or a sentence already localised.
    private func row(_ k: LocalizedStringKey, _ v: String) -> some View {
        HStack {
            Text(k).font(.body15).foregroundColor(Theme.textSoft)
            Spacer()
            Text(v).font(.ui(15, .medium).monospacedDigit()).foregroundColor(Theme.text)
        }
    }
}
