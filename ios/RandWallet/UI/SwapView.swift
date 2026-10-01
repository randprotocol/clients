import SwiftUI
import UIKit

/// Swap: trade RAND and listed tokens through the durian.market AMM, from inside the wallet — the
/// twin of `ui/screens/swap.js`, with its words.
///
/// The pools are read from the chain (`rand_getProgramCells` of the durian program), the quote and
/// the exact transition are this wallet's own (`Amm`, checked against durian's vectors), and the
/// swap is an RPL-2 invoke: `canInvoke` and `quoteInvoke` (every refusal that needs no proof, and
/// the network fee) on Review, then `invoke` on Swap. Nothing is sent to durian.market itself.
///
/// Steps: form → review → working → done | failed. A pool that moved between the quote and the
/// chain (STALE_READ) is re-read and quoted again — the program pays exact amounts, so there is no
/// slippage setting: a moved pool means a new quote the user sees, never a worse fill. A full-screen
/// cover, as Send is, so the proof is not interrupted by a swipe.
struct SwapView: View {
    @EnvironmentObject var wallet: WalletService
    @EnvironmentObject var router: LinkRouter
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    enum Step {
        case loading
        case unavailable(String)
        case form
        case checking
        case review(Amm.Swap, InvokeFlow.Quote, WalletService.InvokeVia)
        case working(Amm.Swap)
        case done(Amm.Swap, WalletService.InvokeOutcome)
        case failed(String)
    }

    static let staleNotice = "The pool moved before your swap reached the chain, so nothing was sent. Here is a new quote."

    @State private var step: Step = .loading
    @State private var pools: [Amm.Pool] = []
    @State private var sell: UInt32 = Amm.randAsset
    @State private var buy: UInt32?
    @State private var amountText = ""
    @State private var notice: String?
    @State private var showProverNotice = false

    var body: some View {
        NavigationStack {
            Group {
                switch step {
                case .loading: ProgressView().tint(Theme.accent)
                case .unavailable(let m): unavailable(m)
                case .form: form
                case .checking: checking
                case .review(let s, let q, let via): review(s, q, via)
                case .working: working
                case .done(let s, let o): done(s, o)
                case .failed(let m): failed(m)
                }
            }
            .screenBackground()
            .navigationTitle("Swap")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    if case .working = step { EmptyView() } else { Button("Cancel") { dismiss() } }
                }
            }
            .interactiveDismissDisabled()
        }
        .task { await loadPools(notice: nil) }
    }

    // MARK: the pools and the quote

    /// Reads the pools (and the token names) and shows the form, or says why there is nothing to
    /// swap through.
    private func loadPools(notice n: String?) async {
        step = .loading
        await wallet.loadTokens()
        let cells: [CellHex]?
        do {
            cells = try await wallet.programCells(Amm.durianProgram)
        } catch {
            step = .unavailable("The pools could not be read: \(error.localizedDescription).")
            return
        }
        guard let cells else { step = .unavailable("This chain does not run programs, so there is nothing to swap through."); return }
        pools = Amm.pools(of: cells)
        if pools.isEmpty { step = .unavailable("durian.market has no pools on this chain yet."); return }
        let list = Amm.tradeable(pools)
        if !list.contains(sell) { sell = Amm.randAsset }
        if buy == nil || !list.contains(buy!) || buy == sell { buy = list.first { $0 != sell } }
        notice = n
        step = .form
    }

    private var list: [UInt32] { Amm.tradeable(pools) }
    private func name(_ a: UInt32) -> WalletService.TokenName { wallet.tokenName(a) }
    private func shown(_ units: UInt64, _ asset: UInt32, frac: Int? = nil) -> String {
        "\(Amount.format(units, decimals: name(asset).decimals, maxFraction: frac)) \(name(asset).symbol)"
    }
    private var route: Amm.Route? { buy.flatMap { Amm.findRoute(pools, sell: sell, buy: $0) } }
    private var units: UInt64? {
        let t = amountText.trimmingCharacters(in: .whitespaces)
        return t.isEmpty ? nil : Amount.parse(t, decimals: name(sell).decimals)
    }
    private var available: UInt64 { wallet.balance(of: sell) }

    /// `amm.buildSwap` for the form's values, or why not; `nil` with no amount typed.
    private var quote: Result<Amm.Swap, Amm.Refusal>? {
        guard let u = units, u > 0 else { return nil }
        return Amm.buildSwap(route: route, dx: u)
    }

    private var amountError: String? {
        let t = amountText.trimmingCharacters(in: .whitespaces)
        if t.isEmpty { return nil }
        guard let u = units, u > 0 else { return "Enter an amount like 1.5." }
        if u > available { return "You have \(shown(available, sell, frac: 6))." }
        if case .failure(let r) = quote { return r.message }
        return nil
    }

    private var built: Amm.Swap? {
        if amountError != nil { return nil }
        if case .success(let s) = quote { return s }
        return nil
    }

    // MARK: form

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let n = notice {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundColor(Theme.warning)
                        Text(n).font(.ui(13)).foregroundColor(Theme.text).fixedSize(horizontal: false, vertical: true)
                    }
                }
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        SectionLabel(text: "You pay")
                        Spacer()
                        Button("Max") { setMax() }.font(.caption12).foregroundColor(Theme.accent)
                    }
                    HStack(spacing: 8) {
                        Field(placeholder: "0.0", text: $amountText, keyboard: .decimalPad)
                        assetPicker(selected: sell) { pickSell($0) }
                    }
                    Text("Available \(shown(available, sell, frac: 6))").font(.caption12).foregroundColor(Theme.textMute)
                    ErrorText(message: amountError)
                }
                HStack {
                    Spacer()
                    Button { flip() } label: {
                        Image(systemName: "arrow.up.arrow.down").font(.system(size: 16, weight: .semibold)).foregroundColor(Theme.accent)
                            .frame(width: 40, height: 40).background(Theme.surface2).clipShape(Circle())
                            .overlay(Circle().stroke(Theme.border, lineWidth: 1))
                    }
                    .accessibilityLabel("Swap the two assets")
                    Spacer()
                }
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel(text: "You receive")
                    HStack(spacing: 8) {
                        Text(built.map { Amount.format($0.amountOut, decimals: name($0.buy).decimals) } ?? "—")
                            .font(.ui(17, .semibold).monospacedDigit()).foregroundColor(Theme.text)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(14).background(Theme.surface2)
                            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
                            .accessibilityLabel("You receive")
                        if let b = buy { assetPicker(selected: b) { pickBuy($0) } }
                    }
                }
                if let s = built { details(s) }
                PrimaryButton(title: "Review", enabled: built != nil) { Task { await review() } }
                Text("Priced by the durian.market pools on this chain (\(String(format: "%.1f", Double(Amm.feeBps) / 100))% pool fee). The swap is a transaction this wallet proves and sends itself.")
                    .font(.caption12).foregroundColor(Theme.textMute)
            }
            .padding(20)
        }
    }

    private func assetPicker(selected: UInt32, pick: @escaping (UInt32) -> Void) -> some View {
        Menu {
            ForEach(list, id: \.self) { a in
                Button(name(a).symbol) { pick(a) }
            }
        } label: {
            HStack(spacing: 4) {
                Text(name(selected).symbol).font(.ui(15, .semibold))
                Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold))
            }
            .foregroundColor(Theme.text)
            .padding(.horizontal, 12).frame(height: 48)
            .background(Theme.surface2)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd, style: .continuous).stroke(Theme.border, lineWidth: 1))
        }
    }

    private func pickSell(_ a: UInt32) {
        sell = a
        if sell == buy { buy = list.first { $0 != sell } }
        amountText = ""
    }

    private func pickBuy(_ a: UInt32) {
        buy = a
        if buy == sell { sell = list.first { $0 != a } ?? Amm.randAsset }
    }

    private func flip() {
        guard let b = buy else { return }
        (sell, buy) = (b, sell)
        amountText = ""
    }

    /// Selling RAND leaves room for the network fee, which is paid in RAND too.
    private func setMax() {
        let room = sell == Amm.randAsset ? (available > 10_000_000 ? available - 10_000_000 : 0) : available
        amountText = room > 0 ? Amount.format(room, decimals: name(sell).decimals) : ""
    }

    private func details(_ s: Amm.Swap) -> some View {
        let impact = Double(s.impactPpm) / 10_000
        let rate = Amm.spotRate(route, sellDecimals: name(s.sell).decimals) ?? 0
        return Card {
            VStack(alignment: .leading, spacing: 10) {
                row("Rate", "1 \(name(s.sell).symbol) ≈ \(shown(rate, s.buy, frac: 6))")
                row("Price impact", impact < 0.01 ? "< 0.01%" : String(format: "%.2f%%", impact), color: impact >= 5 ? Theme.negative : Theme.text)
                row("Pool fee", shown(s.fee, s.feeAsset, frac: 6))
                if s.hops.count == 2 { row("Route", "\(name(s.sell).symbol) → RAND → \(name(s.buy).symbol)") }
            }
        }
    }

    // MARK: review

    private var checking: some View {
        VStack(spacing: 16) {
            Spacer()
            ProgressView().scaleEffect(1.4).tint(Theme.accent)
            Text("Checking the swap…").font(.title).foregroundColor(Theme.textStrong)
            Spacer()
        }
    }

    private func review() async {
        guard let s = built else { return }
        step = .checking
        do {
            let via = try await wallet.canInvoke()
            let q = try await wallet.quoteInvoke(s.request)
            step = .review(s, q, via)
        } catch let e as InvokeFlow.Refusal where e.code == .staleRead {
            await loadPools(notice: Self.staleNotice)
        } catch {
            step = .failed(error.localizedDescription.isEmpty ? "The swap could not be checked." : error.localizedDescription)
        }
    }

    private func review(_ s: Amm.Swap, _ q: InvokeFlow.Quote, _ via: WalletService.InvokeVia) -> some View {
        ScrollView {
            VStack(spacing: 20) {
                Card {
                    VStack(alignment: .leading, spacing: 14) {
                        row("You pay", shown(s.amountIn, s.sell))
                        row("You receive", shown(s.amountOut, s.buy))
                        row("Pool fee", shown(s.fee, s.feeAsset))
                        row("Network fee", shown(UInt64(q.fee) ?? 0, Amm.randAsset))
                        row("Program", Amm.durianProgram.shortened(head: 10, tail: 10), mono: true)
                    }
                }
                Text("The amount you receive is exact: if the pool moves before the swap lands, nothing is sent and you get a new quote. \(proverSentence(via))")
                    .font(.ui(13)).foregroundColor(Theme.textSoft).multilineTextAlignment(.center)
                PrimaryButton(title: "Swap") {
                    if case .pool(_, true) = via, !wallet.defaultNoticeRead { showProverNotice = true } else { Task { await run(s) } }
                }
                SecondaryButton(title: "Edit") { step = .form }
            }
            .padding(20)
        }
        .alert(ProverPairingService.defaultNoticeTitle, isPresented: $showProverNotice) {
            Button("I understand — continue") {
                wallet.acknowledgeDefaultProver()
                Task { await run(s) }
            }
            Button("Use my own prover") {
                router.settingsRequested = true
                dismiss()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(ProverPairingService.defaultNotice(wallet.poolSize))
        }
    }

    private func proverSentence(_ via: WalletService.InvokeVia) -> String {
        switch via {
        case .device: return "This device proves the swap. It takes a few minutes."
        case .pool: return "One of the RandProtocol provers makes the large proof; this device makes the small ones. It takes a few minutes."
        case .prover: return "Your paired prover makes the large proof; this device makes the small ones. It takes a few minutes."
        }
    }

    // MARK: running

    private func run(_ s: Amm.Swap) async {
        step = .working(s)
        do {
            let o = try await wallet.invoke(s.request)
            step = .done(s, o)
        } catch let e as InvokeFlow.Refusal where e.code == .staleRead {
            await loadPools(notice: Self.staleNotice)
        } catch {
            step = .failed(error.localizedDescription.isEmpty ? "The swap did not go through." : error.localizedDescription)
        }
    }

    private var working: some View {
        VStack(spacing: 18) {
            Spacer()
            ProgressView().scaleEffect(1.6).tint(Theme.accent)
            Text("Swapping").font(.title).foregroundColor(Theme.textStrong)
            Text(phaseLabel).font(.body15).foregroundColor(Theme.textSoft).multilineTextAlignment(.center).padding(.horizontal, 24)
            if case .proving(let started) = wallet.phase { ElapsedText(since: started) }
            if case .authorising(_, let started) = wallet.phase { ElapsedText(since: started) }
            if case .provingRemotely(_, _, let started) = wallet.phase { ElapsedText(since: started) }
            Spacer()
            Card {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "checkmark.shield").foregroundColor(Theme.accent)
                    Text("Keep the app open. Closing it before it says submitted stops the swap, and nothing is lost.")
                        .font(.ui(13)).foregroundColor(Theme.textSoft).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(20)
    }

    private var phaseLabel: String {
        switch wallet.phase {
        case .syncing: return "Syncing…"
        case .selecting: return "Choosing notes…"
        case .fetchingWitnesses: return "Fetching witnesses…"
        case .proving: return "Proving your swap on this device…"
        case .authorising: return SendView.authorisingLabel
        case .provingRemotely(let name, let position, _):
            if let n = position { return "Waiting at position \(n) on \(name)" }
            return "Proving on \(name)…"
        case .submitting: return "Submitting…"
        case .waitingForCommit: return "Waiting for the block…"
        default: return "Working…"
        }
    }

    // MARK: outcome

    private func done(_ s: Amm.Swap, _ o: WalletService.InvokeOutcome) -> some View {
        ScrollView {
            VStack(spacing: 18) {
                Image(systemName: "checkmark.circle.fill").font(.system(size: 56)).foregroundColor(Theme.positive).padding(.top, 20)
                Text("Swap submitted").font(.title).foregroundColor(Theme.textStrong)
                Text(shown(s.amountOut, s.buy)).font(.ui(22, .semibold).monospacedDigit()).foregroundColor(Theme.text)
                Card {
                    VStack(alignment: .leading, spacing: 12) {
                        row("Paid", shown(s.amountIn, s.sell))
                        CopyRow(label: "Transaction", value: o.hash)
                        if let h = o.committedHeight {
                            Text("Committed in block \(h)").font(.caption12).foregroundColor(Theme.textMute)
                        }
                    }
                }
                Text("What the pool pays you arrives as a note your wallet finds on its next sync.")
                    .font(.ui(13)).foregroundColor(Theme.textMute).multilineTextAlignment(.center)
                SecondaryButton(title: "View on RandScan") { openURL(Settings.explorerTransactionURL(o.hash)) }
                PrimaryButton(title: "Done") { dismiss() }
            }
            .padding(20)
        }
    }

    private func failed(_ message: String) -> some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "xmark.circle.fill").font(.system(size: 48)).foregroundColor(Theme.negative)
            Text("Not swapped").font(.title).foregroundColor(Theme.textStrong)
            Text("Nothing was sent").font(.ui(15, .semibold)).foregroundColor(Theme.text)
            Text(message).font(.body15).foregroundColor(Theme.textSoft).multilineTextAlignment(.center).padding(.horizontal, 20)
            Spacer()
            PrimaryButton(title: "Try again") { Task { await loadPools(notice: nil) } }
            SecondaryButton(title: "Back to home") { dismiss() }
        }
        .padding(20)
    }

    private func unavailable(_ message: String) -> some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "arrow.left.arrow.right.circle").font(.system(size: 48)).foregroundColor(Theme.textMute)
            Text(message).font(.body15).foregroundColor(Theme.textSoft).multilineTextAlignment(.center).padding(.horizontal, 20)
            Spacer()
            SecondaryButton(title: "Open durian.market") { openURL(Amm.durianURL) }
            SecondaryButton(title: "Back to home") { dismiss() }
        }
        .padding(20)
    }

    private func row(_ k: String, _ v: String, color: Color = Theme.text, mono: Bool = false) -> some View {
        HStack {
            Text(k).font(.body15).foregroundColor(Theme.textSoft)
            Spacer()
            Text(v).font(mono ? .mono : .ui(15, .semibold).monospacedDigit()).foregroundColor(color)
        }
    }
}
