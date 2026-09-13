import SwiftUI

struct ActivityDetailView: View {
    let item: ActivityList.Item
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
        case .received: return "Received"
        case .sent, .sentRow: return "Sent"
        }
    }

    private func received(_ n: OwnedNote) -> some View {
        Group {
            Text("+\(Amount.format(n.units)) SHRUGG").font(.balance).foregroundColor(Theme.positive)
            Card {
                VStack(alignment: .leading, spacing: 12) {
                    row("Status", n.spent ? "Spent" : (n.pending != nil ? "Held by a pending send" : "Unspent"))
                    row("Leaf", "#\(n.index)")
                    row("Block", "\(n.height)")
                    row("Note time", "\(n.time)")
                    if n.asset != 0 { row("Asset", "bridged asset #\(n.asset)") }
                    CopyRow(label: "From (pk)", value: n.from)
                    CopyRow(label: "Commitment", value: n.cm)
                }
            }
            Text("The sender's pk identifies who paid you to anyone holding your viewing key, and nobody else.")
                .font(.system(size: 13)).foregroundColor(Theme.textMute)
            SecondaryButton(title: "View note on RandScan") {
                openURL(Settings.explorerURL.appendingPathComponent("notes").appendingPathComponent(n.cm))
            }
        }
    }

    private func sent(_ s: Submission) -> some View {
        Group {
            Text("−\(Amount.format(s.units)) SHRUGG").font(.balance).foregroundColor(Theme.text)
            Card {
                VStack(alignment: .leading, spacing: 12) {
                    row("Status", s.status == .pending ? "Pending" : (s.status == .failed ? "Not committed (notes released)" : "Committed"))
                    if let h = s.height { row("Block", "\(h)") }
                    row("Fee", "\(Amount.format(s.fee)) SHRUGG")
                    row("Submitted", s.submittedAt.formatted(date: .abbreviated, time: .shortened))
                    CopyRow(label: "To", value: s.to)
                    CopyRow(label: "Transaction", value: s.hash)
                }
            }
            Card {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Disclose this payment").font(.system(size: 15, weight: .semibold)).foregroundColor(Theme.text)
                    Text("Copy the transaction key and paste it on the transaction's RandScan page to show exactly this payment — its amount and recipient — to whoever you hand the key to.")
                        .font(.system(size: 13)).foregroundColor(Theme.textSoft)
                    CopyRow(label: "Transaction key", value: s.txKey)
                    SecondaryButton(title: "Open transaction on RandScan") { openURL(Settings.explorerTransactionURL(s.hash)) }
                }
            }
        }
    }

    private func sentRow(_ r: SentRow) -> some View {
        Group {
            Text("−\(Amount.format(r.units)) SHRUGG").font(.balance).foregroundColor(Theme.text)
            Card {
                VStack(alignment: .leading, spacing: 12) {
                    row("Leaf", "#\(r.index)")
                    row("Block", "\(r.height)")
                    CopyRow(label: "To (pk)", value: r.toPk)
                }
            }
            Text("This payment was made with your key from another device, so its transaction key is not stored here. Your viewing key opens it on RandScan.")
                .font(.system(size: 13)).foregroundColor(Theme.textMute)
        }
    }

    private func row(_ k: String, _ v: String) -> some View {
        HStack {
            Text(k).font(.body15).foregroundColor(Theme.textSoft)
            Spacer()
            Text(v).font(.system(size: 15, weight: .medium).monospacedDigit()).foregroundColor(Theme.text)
        }
    }
}
