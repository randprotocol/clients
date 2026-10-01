import Foundation
import SwiftUI
import UIKit

/// The wallet: the spend key while unlocked, the note store, and the scan / send / faucet flows
/// (design spec §3.2). Everything cryptographic goes through `RandCore`; everything on the
/// wire through `RpcClient`. The spend key never leaves this process.
@MainActor
final class WalletService: ObservableObject {
    enum Phase: Equatable {
        case idle
        case syncing
        case selecting
        case fetchingWitnesses
        case proving(started: Date)
        /// Split authorisation, on the way to a paired prover: the auth proof is being made on this
        /// device, from the spend key, inside the core's `prepare_*` (about seven seconds).
        case authorising(prover: String, started: Date)
        /// A paired prover makes the proof: `position` while the job waits in its queue, `nil`
        /// while it is handed over or being proved.
        case provingRemotely(prover: String, position: Int?, started: Date)
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
        let w = try RandCore.keygen()
        try Keychain.saveSpendKey(w.spendKey)
        NoteStore.delete()
        store = NoteStore()
        unlock(with: w.spendKey)
        return w
    }

    func importWallet(_ input: String) throws -> WalletInfo {
        let w = try RandCore.importKey(input)
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
        info = try? RandCore.walletInfo(spendKey: sk)
        store = NoteStore.load()
    }

    func lock() {
        spendKey = nil
        info = nil
    }

    /// Forgets the wallet on this phone. `contacts` is the store the app holds for its whole
    /// lifetime: it is emptied in memory as well as in the Keychain, so a forgotten wallet's
    /// contacts are not offered to the next one (final review, finding 2).
    func forgetWallet(contacts: ContactsStore) {
        lock()
        Keychain.deleteSpendKey()
        contacts.forget()
        // A prover's pairing token was issued to this phone's wallet; it goes with the wallet, and
        // so do the choice of no prover and the notice read.
        ProverPairingService.forget(settings: settings)
        settings.noProver = false
        settings.proverNoticeFor = nil
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
    /// set. Mirrors `randprotocol_client::wallet::scan` step for step.
    func scan() async throws {
        guard let sk = spendKey else { return }
        let rpc = try client()
        isSyncing = true
        defer { isSyncing = false }
        var s = store

        // Bridge deposits are rebuilt from public block data, since a relayer's envelope cannot
        // be trusted to open. `DepositWalk` reads the headers and opens only the blocks that carry
        // a transaction; a node that will not answer leaves the cursor where the walk stopped and
        // does not fail the scan — the leaves and the nullifiers are read regardless.
        let head0 = try await rpc.headHeight()
        if s.scannedAttestHeight <= head0 {
            // `nil`: the bridge could not be asked, so the cursor stands still this scan.
            let enabled: Bool?
            do { enabled = try await rpc.bridgeEnabled() } catch is CancellationError { throw CancellationError() } catch { enabled = nil }
            if enabled == false {
                s.scannedAttestHeight = head0 + 1
            } else if enabled == true {
                var found: [OwnedNote] = []
                let walked = try await DepositWalk.run(
                    start: s.scannedAttestHeight,
                    head: head0,
                    headers: { try await rpc.blockHeaders(from: $0, to: $1) },
                    actions: { try await rpc.blockActions(height: $0) },
                    offer: { action in
                        if let n = try RandCore.rebuiltDeposit(spendKey: sk, action: action) { found.append(n) }
                    }
                )
                for n in found { s.addDeposit(n) }
                s.scannedAttestHeight = max(s.scannedAttestHeight, walked.next)
            }
        }

        // Leaves.
        while true {
            let rows = try await rpc.commitments(from: s.scannedIndex, limit: Self.page)
            if rows.isEmpty { break }
            let before = s.scannedIndex
            let result = try RandCore.scanPage(spendKey: sk, rows: rows)
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
        // The chain's proof window, read only when something waits on it; unread, the longest this
        // wallet accepts, so nothing is released early.
        var window = NoteStore.timeWindow
        if s.hasPending {
            if let lim = try? await rpc.limits() { window = NoteStore.proofWindow(lim.proofWindowBlocks.map { UInt64($0) }) }
            else { window = NoteStore.maxProofWindow }
        }
        s.clearPending(readThrough: s.scannedHeight &- 1, window: window)

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
    func send(to: String, amount: UInt64, fee: UInt64, memo: String = "") async throws -> SendOutcome {
        guard let sk = spendKey else { throw RpcClient.RpcError(code: 0, message: "wallet is locked") }
        let rpc = try client()
        let addr = try RandCore.parseAddress(to)
        guard addr.valid else { throw RpcClient.RpcError(code: 0, message: addr.error ?? "invalid address") }
        defer { phase = .idle }
        // Where the proof is made, decided before any work: this device, or the paired prover
        // (delegated proving; on a split-authorisation chain any paired prover, own or not — the
        // job carries the viewing key and a salt, never the spend key).
        let route = try await proveRoute()
        // The RandProtocol prover only once this wallet has read what it sees (Send shows the
        // notice before it starts; this is the rule, not the screen).
        if let route, route.isDefault, !defaultNoticeRead {
            throw ProverRefusal(message: "Before the first send through the RandProtocol prover, read what it can see: it gets this wallet's viewing key. Send again and read the notice, or pair your own prover in Settings.")
        }

        phase = .syncing
        try await scan()

        phase = .selecting
        let need = amount &+ fee
        let selection = try RandCore.selectInputs(notes: store.notes, need: need)

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

        // Read from the node this send talks to, right before proving: every output is sealed at
        // exactly this size, and a chain that declares none carries no memo. On a chain pinned
        // as pre-memo (issue #64) the node's claim is not believed; the core seals legacy there
        // whatever `envelopeBytes` says, and refuses the memo first. `bundleGasLimit` is chain
        // 18's pin, which the core checks against its own guest before building anything.
        let limits = try await rpc.limits()
        if !SendLinkRules.memoSupported(envelopeBytes: limits.envelopeBytes, chainId: chainId) && !memo.isEmpty {
            throw RpcClient.RpcError(code: 0, message: Memo.noMemoNotice)
        }
        // The chain's guests and FRI profile, read once for either route: a proof on another
        // guest or profile is refused by the chain, whoever makes it. `hcAuth` beside `hcBundle`
        // (split authorisation): the core refuses a pair it cannot prove for before building.
        let params = try await rpc.proofParams()
        let request = ProveRequest(spendKey: sk, chainId: chainId, to: to, amount: String(amount), fee: String(fee),
                                   anchorHeight: anchor.height, anchorRoot: anchor.root, inputs: inputs, profile: params.profile,
                                   memo: memo, envelopeBytes: limits.envelopeBytes, hcBundle: params.hcBundle, hcAuth: params.hcAuth,
                                   bundleGasLimit: limits.bundleGasLimit, genesis: try await rpc.genesisHash())
        let started = Date()
        let proof: ProveResult
        if let route {
            proof = try await proveRemotely(request, route: route, rpc: rpc, started: started)
        } else {
            phase = .proving(started: started)
            proof = try await Self.prove(request)
        }
        let provingSeconds = Date().timeIntervalSince(started)
        // The receipt's key is the PAYMENT output's own, named by the core — never a slot index:
        // chain 14's four slots put dummies ahead of the payment for a RAND transfer.
        guard let paymentTxKey = proof.paymentTxKey else {
            throw RpcClient.RpcError(code: 0, message: "the core did not name the payment's transaction key")
        }

        phase = .submitting
        let hash = try await rpc.sendTransaction(hex: proof.txHex)
        var s = store
        s.holdPending(indices: proof.spentIndices, time: proof.time)
        s.submissions.insert(Submission(hash: hash, time: proof.time, amount: proof.amount, to: to, fee: proof.fee,
                                        txKey: paymentTxKey, status: .pending, height: nil, submittedAt: Date()), at: 0)
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
        return SendOutcome(hash: hash, amount: proof.amount, fee: proof.fee, change: proof.change, txKey: paymentTxKey,
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
            try RandCore.proveTransfer(request)
        }.value
    }

    typealias ProveRoute = ProverPairingService.Route

    /// `ProverPairingService.route` with this device's memory, the stored (display) pairing, its
    /// probe and the Keychain's record — the token, key and URL a job is sealed and sent to, and
    /// the `own` a spend-key job (an older chain's) is gated on.
    func proveRoute() async throws -> ProveRoute? {
        try await ProverPairingService.route(deviceCanProve: ProverRequirements.deviceHasEnoughMemory,
                                             pairing: settings.prover,
                                             probe: { await ProverPairingService.probe($0) },
                                             secret: { Keychain.loadProverSecret() },
                                             defaultProver: defaultProver)
    }

    // MARK: the default prover (wallet 0.6.8)

    /// The RandProtocol prover as the default would use it, or `nil`: the user chose none, or this
    /// build ships none. Never paired, never stored.
    var defaultProver: (() throws -> (pairing: ProverPairing, token: String))? {
        if settings.noProver || ProverPairingService.trusted() == nil { return nil }
        return { try ProverPairingService.builtIn() }
    }

    /// Whether proofs this device cannot make go to the RandProtocol prover (nothing paired, and
    /// no prover not chosen).
    var usesDefaultProver: Bool {
        ProverPairingService.usesDefault(paired: settings.prover != nil, noProver: settings.noProver, shipsOne: ProverPairingService.trusted() != nil)
    }

    /// Whether THIS wallet has read the one-time notice about the RandProtocol prover.
    var defaultNoticeRead: Bool { ProverPairingService.noticeRead(address: address, readFor: settings.proverNoticeFor) }

    /// Whether Send must show the notice before this send.
    var needsDefaultNotice: Bool {
        ProverPairingService.needsNotice(deviceCanProve: ProverRequirements.deviceHasEnoughMemory, usesDefault: usesDefaultProver, read: defaultNoticeRead)
    }

    /// The notice was read: remembered for this wallet until it is removed.
    func acknowledgeDefaultProver() {
        if !address.isEmpty { settings.proverNoticeFor = address }
    }

    /// Back to the default: forgets a paired prover and a choice of none. Nothing is asked.
    func useDefaultProver() {
        ProverPairingService.forget(settings: settings)
        settings.noProver = false
    }

    /// No prover at all: forgets a paired one and turns the default off.
    func useNoProver() {
        ProverPairingService.forget(settings: settings)
        settings.noProver = true
    }

    /// The same transfer `prove_transfer` would build, its witness sealed by the core to the
    /// paired prover's key; the reply opened, checked and verified by the core (`finish_proof`)
    /// before its result is used exactly where a local proof's would be. On a split-authorisation
    /// chain the job carries the viewing key and a salt and the spend authorisation — the auth
    /// proof — is made here first, inside `prepare_transfer`, from the spend key, which never
    /// leaves this process; on an older chain the spend key leaves it only inside the sealed job,
    /// and only to a prover paired as the user's own (`checkJob`). No resume: the job lives in
    /// this call.
    private func proveRemotely(_ request: ProveRequest, route: ProveRoute, rpc: RpcClient, started: Date) async throws -> ProveResult {
        let name = route.pairing.name
        phase = .provingRemotely(prover: name, position: nil, started: started)
        let maxProofBytes = try await rpc.maxProofBytes()
        let client = try ProverClient(url: route.pairing.url)
        // The chain's witness kind, the pairing's `own`, and the prover as it is now (its key, its
        // job kinds, its fee) — every refusal here happens before the auth proof is made.
        let check = try await ProverPairingService.checkJob(route: route, hcBundle: request.hcBundle, hcAuth: request.hcAuth,
                                                            info: { try await client.info() })
        let job = try RemoteSendParams.build(request: request, route: route, maxProofBytes: maxProofBytes, fee: check.fee)

        // The screen awake and a background-task assertion from the auth proof on: a brief trip to
        // the home screen during it, or during the wait on the prover, does not kill the send.
        UIApplication.shared.isIdleTimerDisabled = true
        let bg = UIApplication.shared.beginBackgroundTask(withName: "remote-prove")
        defer {
            UIApplication.shared.isIdleTimerDisabled = false
            if bg != .invalid { UIApplication.shared.endBackgroundTask(bg) }
        }
        // Split authorisation: `prepare_transfer` makes the auth proof here, from the spend key,
        // before the job is sealed — its own step on the screen, so the wait says where it is.
        if check.guests.splitAuthorisation { phase = .authorising(prover: name, started: started) }
        let prepared = try await Task.detached(priority: .userInitiated) { try RandCore.prepareTransfer(job) }.value
        phase = .provingRemotely(prover: name, position: nil, started: started)
        do {
            return try await remoteProve(client: client, prepared: prepared, name: name, started: started)
        } catch {
            throw ProverPairingService.failure(error, route: route)
        }
    }

    private func remoteProve(client: ProverClient, prepared: (sealedHex: String, pending: Any), name: String, started: Date) async throws -> ProveResult {
        try await RemoteProver(client: client).prove(
            sealedHex: prepared.sealedHex, pending: prepared.pending,
            finish: { pending, reply in try RandCore.finishProof(pending: pending, replyHex: reply) },
            onPhase: { [weak self] p in
                await MainActor.run {
                    switch p {
                    case .proving: self?.phase = .provingRemotely(prover: name, position: nil, started: started)
                    case .queued(let n): self?.phase = .provingRemotely(prover: name, position: n, started: started)
                    }
                }
            })
    }

    /// The connected chain's `envelope_bytes` as the memo gate may believe it (`nil`: no memo on
    /// this chain) — `nil` on a chain pinned as pre-memo whatever the node claimed (issue #64,
    /// `SendLinkRules.believedEnvelopeBytes`), so Send and Receive offer no memo field there.
    func envelopeBytes() async throws -> Int? {
        SendLinkRules.believedEnvelopeBytes(try await client().envelopeBytes(), chainId: chainId)
    }

    // MARK: faucet

    /// Ask a validator node to mint 100 RAND into a note only this wallet can open.
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
