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
    /// A token's symbol and decimals, from the chain's registry (`loadTokens`).
    struct TokenName: Equatable {
        let symbol: String
        let decimals: Int
    }
    @Published private(set) var tokens: [UInt32: TokenName] = [:]

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
            var feeRecipient: String? = nil
            do {
                let info = try await rpc.bridgeInfo()
                enabled = info.enabled
                feeRecipient = info.feeRecipient
            } catch is CancellationError { throw CancellationError() } catch { enabled = nil }
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
                        let kind = (action as? [String: Any])?["kind"] as? String
                        if let fr = feeRecipient {
                            found.append(contentsOf: try RandCore.rebuiltNotes(spendKey: sk, action: action, feeRecipient: fr))
                        } else if kind == "bridge_attest", let n = try RandCore.rebuiltDeposit(spendKey: sk, action: action) {
                            found.append(n)
                        }
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
            proof = try await proveRemotely(try RemoteJob.transfer(request), route: route, rpc: rpc, started: started)
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

    /// Whether this device makes the bundle proof itself (`ProverRequirements`). A seam for the
    /// live swap test, whose simulator reports the Mac's memory: it sends through the provers.
    var deviceCanProve: () -> Bool = { ProverRequirements.deviceHasEnoughMemory }

    /// `ProverPairingService.route` with this device's memory, the stored (display) pairing, its
    /// probe and the Keychain's record — the token, key and URL a job is sealed and sent to, and
    /// the `own` a spend-key job (an older chain's) is gated on.
    func proveRoute() async throws -> ProveRoute? {
        try await ProverPairingService.route(deviceCanProve: deviceCanProve(),
                                             pairing: settings.prover,
                                             probe: { await ProverPairingService.probe($0) },
                                             secret: { Keychain.loadProverSecret() },
                                             defaultProver: defaultProver)
    }

    // MARK: the default: the RandProtocol provers (wallet 0.6.8; a keyed pool since 0.6.9)

    /// The RandProtocol provers as the default would use them — every member that passes its pins,
    /// in a fresh random order per send — or `nil`: the user chose none, or this build ships none.
    /// Never paired, never stored.
    var defaultProver: (() throws -> [ProverPairingService.PoolMember])? {
        if settings.noProver || ProverPairingService.trusted() == nil { return nil }
        return { try ProverPairingService.builtInPool().shuffled() }
    }

    /// How many RandProtocol provers this build pins (the notice names them by count).
    var poolSize: Int { ProverPairingService.trusted()?.members.count ?? 0 }

    /// Whether proofs this device cannot make go to the RandProtocol prover (nothing paired, and
    /// no prover not chosen).
    var usesDefaultProver: Bool {
        ProverPairingService.usesDefault(paired: settings.prover != nil, noProver: settings.noProver, shipsOne: ProverPairingService.trusted() != nil)
    }

    /// Whether THIS wallet has read the one-time notice about the RandProtocol prover.
    var defaultNoticeRead: Bool { ProverPairingService.noticeRead(address: address, readFor: settings.proverNoticeFor) }

    /// Whether Send must show the notice before this send.
    var needsDefaultNotice: Bool {
        ProverPairingService.needsNotice(deviceCanProve: deviceCanProve(), usesDefault: usesDefaultProver, read: defaultNoticeRead)
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
    ///
    /// The same for an invoke (`RemoteJob.invoke`): `prepare_invoke` makes the call proof and the
    /// auth proof here, and the prover makes the bundle proof.
    private func proveRemotely<R: Sendable>(_ remote: RemoteJob<R>, route: ProveRoute, rpc: RpcClient, started: Date) async throws -> R {
        if route.isDefault { return try await provePool(remote, route: route, rpc: rpc, started: started) }
        let name = route.pairing.name
        phase = .provingRemotely(prover: name, position: nil, started: started)
        let maxProofBytes = try await rpc.maxProofBytes()
        let client = try ProverClient(url: route.pairing.url)
        // The chain's witness kind, the pairing's `own`, and the prover as it is now (its key, its
        // job kinds, its fee) — every refusal here happens before the auth proof is made.
        let check = try await ProverPairingService.checkJob(route: route, hcBundle: remote.hcBundle, hcAuth: remote.hcAuth,
                                                            info: { try await client.info() })
        let job = RemoteSendParams.build(requestJSON: remote.params, route: route, maxProofBytes: maxProofBytes, fee: check.fee)

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
        let prepare = remote.prepare
        let prepared = try await Task.detached(priority: .userInitiated) { try prepare(job) }.value
        phase = .provingRemotely(prover: name, position: nil, started: started)
        return try await remoteProve(client: client, prepared: prepared, finish: remote.finish, name: name, started: started)
    }

    /// The same, through the RandProtocol provers: one member per job, in the route's order
    /// (`ProverPairingService.provePool`) — each probed again, the job sealed to ITS key and
    /// submitted to it; busy or away at submit, the next; once a job id is named, that member to the
    /// end. A transfer and an invoke take the same path; only the core's seal and open differ.
    private func provePool<R: Sendable>(_ remote: RemoteJob<R>, route: ProveRoute, rpc: RpcClient, started: Date) async throws -> R {
        let pool = route.poolName ?? "RandProtocol"
        phase = .provingRemotely(prover: "\(pool) provers", position: nil, started: started)
        let maxProofBytes = try await rpc.maxProofBytes()
        UIApplication.shared.isIdleTimerDisabled = true
        let bg = UIApplication.shared.beginBackgroundTask(withName: "remote-prove")
        defer {
            UIApplication.shared.isIdleTimerDisabled = false
            if bg != .invalid { UIApplication.shared.endBackgroundTask(bg) }
        }
        return try await ProverPairingService.provePool(
            members: route.members, poolName: pool,
            probe: { await ProverPairingService.probe($0) },
            seal: { [weak self] m, info in
                let memberRoute = ProverPairingService.Route(pairing: m.pairing, token: m.token, isDefault: true)
                let check = try await ProverPairingService.checkJob(route: memberRoute, hcBundle: remote.hcBundle, hcAuth: remote.hcAuth,
                                                                    info: { info })
                let job = RemoteSendParams.build(requestJSON: remote.params, route: memberRoute, maxProofBytes: maxProofBytes, fee: check.fee)
                if check.guests.splitAuthorisation { await MainActor.run { self?.phase = .authorising(prover: m.pairing.name, started: started) } }
                let prepare = remote.prepare
                let prepared = try await Task.detached(priority: .userInitiated) { try prepare(job) }.value
                await MainActor.run { self?.phase = .provingRemotely(prover: m.pairing.name, position: nil, started: started) }
                return prepared
            },
            submit: { m, sealed in try await RemoteProver(client: try ProverClient(url: m.pairing.url)).submit(sealed) },
            poll: { [weak self] m, job, pending in
                let name = m.pairing.name
                return try await RemoteProver(client: try ProverClient(url: m.pairing.url)).poll(
                    job: job, pending: pending,
                    finish: remote.finish,
                    onPhase: { p in
                        await MainActor.run {
                            switch p {
                            case .proving: self?.phase = .provingRemotely(prover: name, position: nil, started: started)
                            case .queued(let n): self?.phase = .provingRemotely(prover: name, position: n, started: started)
                            }
                        }
                    })
            })
    }

    private func remoteProve<R: Sendable>(client: ProverClient, prepared: (sealedHex: String, pending: Any),
                                          finish: @escaping (Any, String) throws -> R, name: String, started: Date) async throws -> R {
        try await RemoteProver(client: client).prove(
            sealedHex: prepared.sealedHex, pending: prepared.pending,
            finish: finish,
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

    // MARK: invoking a program (RPL-2): Swap

    struct InvokeOutcome {
        let hash: String
        let fee: String
        /// What the transition pays this wallet: the notes the next scan finds.
        let payouts: [AssetAmount]
        let tier: Int
        let provingSeconds: Double
        let committedHeight: UInt64?
    }

    /// Where an invoke's proofs are made: on this device, or the bundle proof on a paired prover or
    /// the RandProtocol provers (the call proof and the auth proof are always made here).
    enum InvokeVia: Equatable {
        case device
        case prover(name: String)
        /// The RandProtocol provers; `notice` while this wallet has not read their one-time notice.
        case pool(name: String, notice: Bool)
    }

    private typealias InvokeRefusal = InvokeFlow.Refusal

    /// The route an invoke would take, or `PROVER_UNAVAILABLE`.
    private func invokeRoute() async throws -> ProveRoute? {
        let route: ProveRoute?
        do {
            route = try await proveRoute()
        } catch {
            throw InvokeRefusal(code: .proverUnavailable, message: error.localizedDescription)
        }
        if route == nil && !deviceCanProve() {
            throw InvokeRefusal(code: .proverUnavailable, message: "This device does not have the memory for this proof, and no prover is set up. Pair a prover in Settings › Prover.")
        }
        return route
    }

    /// Whether this wallet can invoke on this chain (`program.canInvoke` in the JS), in the order a
    /// send asks it: a proof route first, then the chain's `program_state` section.
    func canInvoke() async throws -> InvokeVia {
        // Said before anything is quoted, rather than the system stopping the app mid-proof.
        guard ProverRequirements.deviceCanMakeCallProof else {
            throw InvokeRefusal(code: .proverUnavailable, message: "This device does not have the memory a swap needs: it makes two of the proofs itself, about 1.5 GB. Nothing was sent. Swap from the desktop app or the browser extension instead.")
        }
        let route = try await invokeRoute()
        guard try await client().limits().programState != nil else {
            throw InvokeRefusal(code: .programsUnsupported, message: "This chain does not run programs yet.")
        }
        guard let route else { return .device }
        if route.isDefault { return .pool(name: route.poolName ?? "RandProtocol", notice: !defaultNoticeRead) }
        return .prover(name: route.pairing.name)
    }

    /// Every refusal an invoke can meet before anything is proved, and its network fee
    /// (`InvokeFlow.quote`; the wallet scans first so the plan sees every note).
    func quoteInvoke(_ request: InvokeRequest) async throws -> InvokeFlow.Quote {
        guard spendKey != nil else { throw RpcClient.RpcError(code: 0, message: "wallet is locked") }
        let rpc = try client()
        return try await InvokeFlow.quote(request, chain: rpc, core: RandInvokeCore(), notes: { [weak self] in
            guard let self else { return [] }
            try await self.scan()
            return self.store.notes
        })
    }

    /// Quote, prove and submit an RPL-2 invoke (`engine.invoke` + `completeInvoke`). The quote is
    /// taken again here, whatever Review showed, because time has passed: the cells may have moved
    /// and the notes may be spent. The anchor is taken last, right before the proofs. Through a
    /// prover, `prepare_invoke` makes the call proof and the auth proof here and the bundle proof
    /// goes out exactly as a transfer's does (`proveRemotely`, `provePool`). A pool that moved is
    /// `STALE_READ`, before the proof or at submit; nothing is sent either way.
    func invoke(_ request: InvokeRequest, wait: Bool = true) async throws -> InvokeOutcome {
        guard let sk = spendKey else { throw RpcClient.RpcError(code: 0, message: "wallet is locked") }
        let rpc = try client()
        defer { phase = .idle }
        let route = try await invokeRoute()
        // The RandProtocol provers only once this wallet has read what they see (Swap shows the
        // notice before it starts; this is the rule, not the screen).
        if let route, route.isDefault, !defaultNoticeRead {
            throw InvokeRefusal(code: .proverNotice, message: "Before the first swap through the RandProtocol provers, read what they can see: the one that proves it gets this wallet's viewing key. Review the swap again and read the notice, or pair your own prover in Settings.")
        }

        phase = .syncing
        let q = try await InvokeFlow.quote(request, chain: rpc, core: RandInvokeCore(), notes: { [weak self] in
            guard let self else { return [] }
            try await self.scan()
            self.phase = .selecting
            return self.store.notes
        })

        phase = .fetchingWitnesses
        let built = try await InvokeFlow.proveRequest(q, spendKey: sk, chainId: chainId, chain: rpc)
        let started = Date()
        let result: InvokeResult
        if let route {
            result = try await proveRemotely(RemoteJob.invoke(built.params, hcBundle: built.hcBundle, hcAuth: built.hcAuth),
                                             route: route, rpc: rpc, started: started)
        } else {
            phase = .proving(started: started)
            result = try await Self.proveInvoke(built.params)
        }
        let provingSeconds = Date().timeIntervalSince(started)

        phase = .submitting
        let hash = try await InvokeFlow.submit(txHex: result.txHex, chain: rpc)
        let payouts = result.payouts.map { AssetAmount(asset: $0.asset, amount: $0.amount) }
        var s = store
        s.holdPending(indices: result.spentIndices, time: result.time)
        s.submissions.insert(Submission(hash: hash, time: result.time, amount: result.burnR, to: result.program, fee: result.fee,
                                        txKey: "", status: .pending, height: nil, submittedAt: Date(), kind: "invoke",
                                        burnAsset: result.burnAsset, burnA: result.burnA, payouts: payouts), at: 0)
        store = s
        try? s.save()

        var committed: UInt64?
        if wait {
            phase = .waitingForCommit(hash: hash)
            let deadline = Date().addingTimeInterval(180)
            while Date() < deadline {
                if let h = try? await rpc.transactionHeight(hash: hash) { committed = h; break }
                try? await Task.sleep(nanoseconds: 1_500_000_000)
            }
            // The payout notes are leaves like any other: this scan finds them by trial decryption.
            try? await scan()
        }
        phase = .done
        return InvokeOutcome(hash: hash, fee: result.fee, payouts: payouts, tier: result.tier,
                             provingSeconds: provingSeconds, committedHeight: committed)
    }

    /// `prove_invoke` off the main actor, the screen kept awake, as `prove` does a transfer.
    private static func proveInvoke(_ params: [String: Any]) async throws -> InvokeResult {
        UIApplication.shared.isIdleTimerDisabled = true
        let bg = UIApplication.shared.beginBackgroundTask(withName: "prove-invoke")
        defer {
            UIApplication.shared.isIdleTimerDisabled = false
            if bg != .invalid { UIApplication.shared.endBackgroundTask(bg) }
        }
        return try await Task.detached(priority: .userInitiated) { try RandCore.proveInvoke(params) }.value
    }

    /// Spendable units of `asset` (RAND is `balance`).
    func balance(of asset: UInt32) -> UInt64 {
        store.notes.filter { $0.isSpendable && $0.asset == asset }.reduce(0) { $0 + $1.units }
    }

    /// Reads the chain's token registry (`rand_getTokens`) into `tokens`. A node that does not
    /// answer leaves the names this session already had.
    func loadTokens() async {
        guard let rows = try? await client().tokens() else { return }
        var out = tokens
        for r in rows { out[r.index] = TokenName(symbol: r.symbol, decimals: r.decimals) }
        tokens = out
    }

    /// How an asset is shown: RAND, a listed token by its symbol and its own decimals, or an
    /// unlisted index at nine (`ui/screens/swap.js`'s `infoOf`).
    func tokenName(_ asset: UInt32) -> TokenName {
        if asset == Amm.randAsset { return TokenName(symbol: "RAND", decimals: Amount.decimals) }
        return tokens[asset] ?? TokenName(symbol: "asset \(asset)", decimals: Amount.decimals)
    }

    /// Every cell of `program` (`nil`: this chain runs no programs).
    func programCells(_ program: String) async throws -> [CellHex]? {
        try await client().allProgramCells(program)
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
