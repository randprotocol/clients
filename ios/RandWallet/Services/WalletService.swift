import Foundation
import SwiftUI
import UIKit

/// The wallet: the spend key while unlocked, the note store, and the scan / send / faucet flows
/// (design spec §3.2). Everything cryptographic goes through `ShruggCore`; everything on the
/// wire through `RpcClient`. The spend key never leaves this process.
@MainActor
final class WalletService: ObservableObject {
    enum Phase: Equatable {
        case idle
        case syncing
        case selecting
        case fetchingWitnesses
        case proving(started: Date)
        case submitting
        case waitingForCommit(hash: String)
        case done
    }

    struct SendOutcome {
        let hash: String
        let amount: String
        let fee: String
        let change: String
        let txKey: String
        let proofBytes: Int
        let tier: Int
        let provingSeconds: Double
        let committedHeight: UInt64?
    }

    @Published private(set) var info: WalletInfo?
    @Published private(set) var store = NoteStore.load()
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var lastSyncError: String?
    @Published private(set) var lastSync: Date?
    @Published private(set) var isSyncing = false

    private let settings: Settings
    private var spendKey: String?
    private var rpc: RpcClient?

    init(settings: Settings) {
        self.settings = settings
    }

    var hasWallet: Bool { Keychain.hasSpendKey }
    var isUnlocked: Bool { spendKey != nil }
    var balance: UInt64 { store.balance }
    var address: String { info?.address ?? "" }
    var chainId: UInt64 { UInt64(max(settings.chainId, 0)) }

    // MARK: wallet lifecycle

    func createWallet() throws -> WalletInfo {
        let w = try ShruggCore.keygen()
        try Keychain.saveSpendKey(w.spendKey)
        NoteStore.delete()
        store = NoteStore()
        unlock(with: w.spendKey)
        return w
    }

    func importWallet(_ input: String) throws -> WalletInfo {
        let w = try ShruggCore.importKey(input)
        try Keychain.saveSpendKey(w.spendKey)
        NoteStore.delete()
        store = NoteStore()
        unlock(with: w.spendKey)
        return w
    }

    /// Load the key from the Keychain after the user authenticated.
    func unlockFromKeychain() -> Bool {
        guard let sk = Keychain.loadSpendKey() else { return false }
        unlock(with: sk)
        return true
    }

    private func unlock(with sk: String) {
        spendKey = sk
        info = try? ShruggCore.walletInfo(spendKey: sk)
        store = NoteStore.load()
    }

    func lock() {
        spendKey = nil
        info = nil
    }

    func forgetWallet() {
        lock()
        Keychain.deleteSpendKey()
        NoteStore.delete()
        store = NoteStore()
        settings.hasBackedUpKey = false
    }

    /// The spend key for export; the caller has already authenticated.
    func exportSpendKey() -> String? { spendKey }
    func exportKeyFile() -> String? { info?.keyFile }
    var viewingKey: String? { info?.viewingKey }

    private func client() throws -> RpcClient {
        guard let url = settings.rpcURL, url.scheme != nil else {
            throw RpcClient.RpcError(code: 0, message: "Set a valid RPC URL in Settings")
        }
        if rpc?.url != url { rpc = RpcClient(url: url) }
        return rpc!
    }

    // MARK: scanning

    private static let page = 500

    /// Trial-decrypt every leaf this wallet has not seen, then mark spent notes from the nullifier
    /// set. Mirrors `shrugg_client::wallet::scan` step for step.
    func scan() async throws {
        guard let sk = spendKey else { return }
        let rpc = try client()
        isSyncing = true
        defer { isSyncing = false }
        var s = store

        // Bridge deposits are rebuilt from public block data, since a relayer's envelope cannot
        // be trusted to open. Read each block once.
        let head0 = try await rpc.headHeight()
        if s.scannedAttestHeight <= head0 {
            if try await rpc.bridgeEnabled() {
                for h in s.scannedAttestHeight...head0 {
                    for action in try await rpc.blockActions(height: h) {
                        if let n = try ShruggCore.rebuiltDeposit(spendKey: sk, action: action) { s.addDeposit(n) }
                    }
                }
            }
            s.scannedAttestHeight = head0 + 1
        }

        // Leaves.
        while true {
            let rows = try await rpc.commitments(from: s.scannedIndex, limit: Self.page)
            if rows.isEmpty { break }
            let before = s.scannedIndex
            let result = try ShruggCore.scanPage(spendKey: sk, rows: rows)
            s.merge(received: result.received, sent: result.sent)
            s.scannedIndex = max(s.scannedIndex, result.nextIndex)
            if s.scannedIndex <= before { throw RpcClient.RpcError(code: 0, message: "getCommitments did not advance") }
            store = s
        }

        // Nullifiers: the head is read before paging so `scannedHeight` never claims a block whose
        // nullifiers this scan did not see.
        let headBefore = try await rpc.headHeight()
        var from = s.scannedHeight
        while true {
            let rows = try await rpc.nullifiers(fromHeight: from, limit: Self.page)
            guard let maxHeight = rows.map(\.height).max() else { break }
            s.markSpent(nullifiers: rows.map(\.nullifier))
            if rows.count < Self.page { from = maxHeight + 1; break }
            if maxHeight == from { throw RpcClient.RpcError(code: 0, message: "block \(from) has more nullifiers than a page") }
            from = maxHeight
        }
        s.advanceScannedHeight(pagedTo: from, headBefore: headBefore)
        s.clearPending(readThrough: s.scannedHeight &- 1)

        // Submissions we are still waiting on.
        for i in s.submissions.indices where s.submissions[i].status == .pending {
            if let h = try? await rpc.transactionHeight(hash: s.submissions[i].hash) {
                s.submissions[i].status = .committed
                s.submissions[i].height = h
            }
        }
        store = s
        try s.save()
        lastSync = Date()
        lastSyncError = nil
    }

    func refresh() async {
        do { try await scan() } catch { lastSyncError = error.localizedDescription }
    }

    func rescanFromZero() async {
        var s = NoteStore()
        s.submissions = store.submissions
        store = s
        try? s.save()
        await refresh()
    }

    // MARK: sending

    /// The whole send path. `amount` and `fee` in units. Returns after the commit or the commit
    /// timeout; throws with a message the UI shows verbatim.
    func send(to: String, amount: UInt64, fee: UInt64) async throws -> SendOutcome {
        guard let sk = spendKey else { throw RpcClient.RpcError(code: 0, message: "wallet is locked") }
        let rpc = try client()
        let addr = try ShruggCore.parseAddress(to)
        guard addr.valid else { throw RpcClient.RpcError(code: 0, message: addr.error ?? "invalid address") }
        defer { phase = .idle }

        phase = .syncing
        try await scan()

        phase = .selecting
        let need = amount &+ fee
        let selection = try ShruggCore.selectInputs(notes: store.notes, need: need)

        phase = .fetchingWitnesses
        var anchor = try await rpc.anchor()
        var inputs: [ProveInput] = []
        var attempt = 0
        while true {
            attempt += 1
            anchor = try await rpc.anchor()
            inputs = []
            var moved = false
            for n in selection.chosen {
                let w = try await rpc.witness(index: n.index)
                if w.root != anchor.root { moved = true; break }
                inputs.append(ProveInput(note: n, path: w.path))
            }
            if !moved { break }
            if attempt >= 3 { throw RpcClient.RpcError(code: 0, message: "the tree moved while fetching witnesses; try again") }
        }

        let request = ProveRequest(spendKey: sk, chainId: chainId, to: to, amount: String(amount), fee: String(fee),
                                   anchorHeight: anchor.height, anchorRoot: anchor.root, inputs: inputs, profile: "production")
        let started = Date()
        phase = .proving(started: started)
        let proof = try await Self.prove(request)
        let provingSeconds = Date().timeIntervalSince(started)

        phase = .submitting
        let hash = try await rpc.sendTransaction(hex: proof.txHex)
        var s = store
        s.holdPending(indices: proof.spentIndices, time: proof.time)
        s.submissions.insert(Submission(hash: hash, time: proof.time, amount: proof.amount, to: to, fee: proof.fee,
                                        txKey: proof.txKeys[0], status: .pending, height: nil, submittedAt: Date()), at: 0)
        store = s
        try? s.save()

        phase = .waitingForCommit(hash: hash)
        var committed: UInt64?
        let deadline = Date().addingTimeInterval(180)
        while Date() < deadline {
            if let h = try? await rpc.transactionHeight(hash: hash) { committed = h; break }
            try? await Task.sleep(nanoseconds: 1_500_000_000)
        }
        try? await scan()
        phase = .done
        return SendOutcome(hash: hash, amount: proof.amount, fee: proof.fee, change: proof.change, txKey: proof.txKeys[0],
                           proofBytes: proof.proofBytes, tier: proof.tier, provingSeconds: provingSeconds, committedHeight: committed)
    }

    /// The proof runs detached from the main actor with the screen kept awake and a background
    /// task assertion so a brief trip to the home screen does not kill it.
    private static func prove(_ request: ProveRequest) async throws -> ProveResult {
        UIApplication.shared.isIdleTimerDisabled = true
        let bg = UIApplication.shared.beginBackgroundTask(withName: "prove-bundle")
        defer {
            UIApplication.shared.isIdleTimerDisabled = false
            if bg != .invalid { UIApplication.shared.endBackgroundTask(bg) }
        }
        return try await Task.detached(priority: .userInitiated) {
            try ShruggCore.proveTransfer(request)
        }.value
    }

    // MARK: faucet

    /// Ask a validator node to mint 100 SHRUGG into a note only this wallet can open.
    func faucet() async throws -> String {
        let rpc = try client()
        let hash = try await rpc.mint(to: address)
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline {
            if (try? await rpc.transactionHeight(hash: hash)) != nil { break }
            try? await Task.sleep(nanoseconds: 1_500_000_000)
        }
        try? await scan()
        return hash
    }

    // MARK: connection test

    func testConnection() async throws -> String {
        let rpc = try client()
        let id = try await rpc.chainId()
        let st = try await rpc.status()
        let height = st["height"] as? Int ?? 0
        let peers = st["peer_count"] as? Int ?? 0
        if id != chainId { return "Connected to chain \(id) at height \(height) (\(peers) peers) — but Settings says chain \(chainId)" }
        return "Chain \(id), height \(height), \(peers) peers"
    }
}
