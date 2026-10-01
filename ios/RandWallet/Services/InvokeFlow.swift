import Foundation

/// The node reads and the submit an RPL-2 invoke makes — `RpcClient` in the app, a fake in the
/// tests (`InvokeFlowTests`).
protocol InvokeChain: AnyObject {
    func limits() async throws -> RpcClient.ChainLimits
    func programCode(_ program: String) async throws -> ProgramCode?
    func programPublic(_ program: String) async throws -> String?
    func programCell(_ program: String, key: String) async throws -> String?
    func estimateFee(_ spec: [String: Any]) async throws -> String
    func programVault(_ program: String) async throws -> [AssetAmount]?
    func proofParams() async throws -> RpcClient.ProofParams
    func genesisHash() async throws -> String?
    func anchor() async throws -> (height: UInt64, root: String)
    func witness(index: UInt64) async throws -> (root: String, path: [String])
    func sendTransaction(hex: String) async throws -> String
}

extension RpcClient: InvokeChain {}

/// The two core calls a quote makes — `RandCore` in the app, a fake in the tests.
protocol InvokeCore {
    func dryRun(_ transition: [String: Any]) throws -> InvokeDryRun
    func plan(notes: [OwnedNote], burnR: String, burnAsset: UInt32, burnA: String, fee: String) throws -> TransferPlan
}

struct RandInvokeCore: InvokeCore {
    func dryRun(_ transition: [String: Any]) throws -> InvokeDryRun { try RandCore.dryRunInvoke(transition) }
    func plan(notes: [OwnedNote], burnR: String, burnAsset: UInt32, burnA: String, fee: String) throws -> TransferPlan {
        try RandCore.planInvoke(notes: notes, burnR: burnR, burnAsset: burnAsset, burnA: burnA, fee: fee)
    }
}

/// An RPL-2 invoke, step by step — the Swift twin of `ui/engine/wallet.js`'s `quoteInvoke`,
/// `invoke` and `completeInvoke`, without the screen, the store or the prover (those are
/// `WalletService`'s). Every refusal carries the engine's `code`.
enum InvokeFlow {
    /// A refusal with the engine's page-facing code. Every one of them means nothing was sent.
    struct Refusal: LocalizedError, Equatable {
        enum Code: String {
            case staleRead = "STALE_READ"
            case insufficientFunds = "INSUFFICIENT_FUNDS"
            case vaultShort = "VAULT_SHORT"
            case programsUnsupported = "PROGRAMS_UNSUPPORTED"
            case proverUnavailable = "PROVER_UNAVAILABLE"
            case proverNotice = "PROVER_NOTICE"
            case noProgram = "NO_PROGRAM"
            case programRefused = "PROGRAM_REFUSED"
        }
        let code: Code
        let message: String
        var errorDescription: String? { message }
    }

    static let zeroWord8 = String(repeating: "0", count: 64)
    /// The proof cap a fee is quoted at when the node names none (`DEFAULT_PROOF_CAP`).
    static let defaultProofCap = 2_097_152

    private static let unsupported = Refusal(code: .programsUnsupported, message: "This chain does not run programs yet, so Rand Wallet cannot send this. Nothing was sent.")

    /// Everything a quote learned, for the proof that follows it.
    struct Quote {
        /// `TransitionRequest`'s JSON: what `dry_run_invoke` ran and `prove_invoke` proves.
        let transition: [String: Any]
        let dry: InvokeDryRun
        /// The network fee, in RAND units, as the plan settled it.
        let fee: String
        /// How many cells the writes create (each paying `cell_fee`).
        let cells: Int
        let limits: RpcClient.ChainLimits
        let plan: TransferPlan
    }

    /// Everything an invoke can be refused for **without proving anything**, and its price — the
    /// engine's `quoteInvoke`, in its order, the cheapest question first:
    ///
    ///   1. the chain runs programs at all (`rand_getLimits.program_state`) — `PROGRAMS_UNSUPPORTED`;
    ///   2. the program exists, and its code and public input are what the core will prove against
    ///      (`dry_run_invoke` hashes them to the id; a node serving other code is refused there);
    ///   3. every cell the request read is still what the chain holds — `STALE_READ` (the chain
    ///      would refuse the same transaction, after the proofs were paid for);
    ///   4. the cells the writes create, which the fee pays `cell_fee` each for;
    ///   5. the program accepts the transition (`dry_run_invoke`: the emulator, no proof) — its tier
    ///      and gas, which price the fee;
    ///   6. the fee: `rand_estimateFee {"kind":"invoke"}` at that tier and gas, the proof's bytes
    ///      quoted at the chain's cap (the fee is in the bundle, which the call proof commits to);
    ///   7. the vault covers what the transition pays out — `VAULT_SHORT`; then this wallet's notes
    ///      (`notes`, which scans first) cover the burn and the fee (`plan_invoke`) — `INSUFFICIENT_FUNDS`.
    static func quote(_ request: InvokeRequest, chain: InvokeChain, core: InvokeCore,
                      notes: () async throws -> [OwnedNote]) async throws -> Quote {
        let limits = try await chain.limits()
        guard limits.programState != nil else { throw unsupported }
        let program = request.program
        guard let code = try await chain.programCode(program) else {
            throw Refusal(code: .noProgram, message: "There is no program \(program.prefix(12))… on this chain. Nothing was sent.")
        }
        let publicHex = try await chain.programPublic(program) ?? ""
        func live(_ key: String) async throws -> String {
            guard let v = try await chain.programCell(program, key: key) else { throw unsupported }
            return v
        }
        for r in request.reads {
            let now = try await live(r.key)
            if now != r.value {
                throw Refusal(code: .staleRead, message: "The pool changed since this page read it. Nothing was sent; the site can quote again.")
            }
        }
        // A cell is created where a non-zero value is written over the chain's zeros; a read of the
        // same key has just answered what the chain holds.
        var cells = 0
        for w in request.writes where w.value != zeroWord8 {
            let now: String
            if let read = request.reads.first(where: { $0.key == w.key }) { now = read.value } else { now = try await live(w.key) }
            if now == zeroWord8 { cells += 1 }
        }
        let transition = transitionJSON(request, code: code, publicHex: publicHex)
        let dry: InvokeDryRun
        do {
            dry = try core.dryRun(transition)
        } catch {
            throw Refusal(code: .programRefused, message: "The program would not accept this request, so nothing was sent: \(error.localizedDescription)")
        }
        // Under a `gas` section (`bundle_gas_limit` set: chain 18 and later) the call is priced by
        // the gas it declares and every byte of its proof; without one, by tier alone.
        var spec: [String: Any] = ["kind": "invoke", "tier": dry.tier, "keccak_log_height": dry.keccakLogHeight,
                                   "sha256_log_height": dry.sha256LogHeight, "created_cells": cells]
        if limits.bundleGasLimit != nil {
            spec["gas"] = dry.gasLimit
            spec["bytes"] = limits.maxProofBytes ?? defaultProofCap
        }
        let fee = try await chain.estimateFee(spec)
        if !request.pays.isEmpty {
            let vault = try await chain.programVault(program) ?? []
            if vaultShortfall(request, vault: vault) != nil {
                throw Refusal(code: .vaultShort, message: "The pool does not hold enough to pay this out. Nothing was sent; the site can quote again.")
            }
        }
        let held = try await notes()
        let burnsToken = request.inflow.kind != "none"
        let plan: TransferPlan
        do {
            plan = try core.plan(notes: held, burnR: request.inflow.rand, burnAsset: burnsToken ? request.inflow.asset : 0,
                                 burnA: burnsToken ? request.inflow.amount : "0", fee: fee)
        } catch {
            throw Refusal(code: .insufficientFunds, message: "Rand Wallet does not hold enough to cover this and its network fee: \(error.localizedDescription)")
        }
        return Quote(transition: transition, dry: dry, fee: plan.fee.isEmpty ? fee : plan.fee, cells: cells, limits: limits, plan: plan)
    }

    /// `TransitionRequest`'s JSON, the program's code and public input as the node served them.
    static func transitionJSON(_ r: InvokeRequest, code: ProgramCode, publicHex: String) -> [String: Any] {
        let cells = r.cellsJSON
        return [
            "program": r.program,
            "program_code": ["base_pc": code.basePc, "words": code.words] as [String: Any],
            "public_hex": publicHex,
            "private_inputs": r.inputs,
            "reads": cells.reads,
            "writes": cells.writes,
            "inflow": r.inflowJSON,
            "pays": InvokeRequest.amountsJSON(r.pays),
            "mints": InvokeRequest.amountsJSON(r.mints),
        ]
    }

    /// The vault must hold what the transition pays out of it, counting what this same transition
    /// deposits (`inflow.rand`, and `inflow.amount` when the kind is `deposit`) — `nil` when it can.
    static func vaultShortfall(_ r: InvokeRequest, vault: [AssetAmount]) -> (asset: UInt32, have: Decimal, want: Decimal)? {
        func dec(_ s: String) -> Decimal { Decimal(string: s) ?? 0 }
        var held: [UInt32: Decimal] = [:]
        for row in vault { held[row.asset] = dec(row.amount) }
        var want: [UInt32: Decimal] = [:]
        for p in r.pays { want[p.asset, default: 0] += dec(p.amount) }
        for (asset, amount) in want.sorted(by: { $0.key < $1.key }) where amount > 0 {
            var have = held[asset] ?? 0
            if asset == 0 { have += dec(r.inflow.rand) }
            else if r.inflow.kind == "deposit" && r.inflow.asset == asset { have += dec(r.inflow.amount) }
            if have < amount { return (asset, have, amount) }
        }
        return nil
    }

    /// `prove_invoke`'s request (and `prepare_invoke`'s, before the prover target is added): the
    /// quote's transition, fee, tier and gas, and the chain's parameters — the guests and the FRI
    /// profile, the genesis — and, **last**, the anchor and the witnesses, right before the proofs:
    /// the bundle's `time` is the anchor's height and the chain refuses a bundle too far behind its
    /// tip when the transaction arrives. Returns the request and the chain's guests and proof cap.
    static func proveRequest(_ q: Quote, spendKey: String, chainId: UInt64, chain: InvokeChain) async throws
        -> (params: [String: Any], hcBundle: String?, hcAuth: String?, maxProofBytes: Int?) {
        let pp = try await chain.proofParams()
        let genesis = try await chain.genesisHash()
        let notes = q.plan.inputs + q.plan.feeInputs
        var anchor = try await chain.anchor()
        var paths: [[String]] = []
        var attempt = 0
        while true {
            attempt += 1
            if attempt > 1 { anchor = try await chain.anchor() }
            paths = []
            var moved = false
            for n in notes {
                let w = try await chain.witness(index: n.index)
                if w.root != anchor.root { moved = true; break }
                paths.append(w.path)
            }
            if !moved { break }
            if attempt >= 3 { throw RpcClient.RpcError(code: 0, message: "the tree moved while fetching witnesses; try again") }
        }
        func inputs(_ list: [OwnedNote], from: Int) throws -> [[String: Any]] {
            try list.enumerated().map { i, n in
                ["note": try JSONSerialization.jsonObject(with: JSONEncoder().encode(n)), "path": paths[from + i]]
            }
        }
        var p = q.transition
        p["spend_key"] = spendKey
        p["chain_id"] = chainId
        if let genesis { p["genesis"] = genesis }
        p["fee"] = q.fee
        p["tier"] = q.dry.tier
        p["gas_limit"] = q.limits.bundleGasLimit != nil ? q.dry.gasLimit as Any : NSNull() as Any
        p["anchor_height"] = anchor.height
        p["anchor_root"] = anchor.root
        p["inputs"] = try inputs(q.plan.inputs, from: 0)
        p["fee_inputs"] = try inputs(q.plan.feeInputs, from: q.plan.inputs.count)
        p["profile"] = pp.profile
        p["envelope_bytes"] = q.limits.envelopeBytes.map { $0 as Any } ?? NSNull()
        p["bundle_gas_limit"] = q.limits.bundleGasLimit.map { $0 as Any } ?? NSNull()
        if let cap = q.limits.maxProofBytes { p["max_proof_bytes"] = cap }
        // The two guest fields as a transfer sends them: neither when the node names neither,
        // else `hc_bundle` when known and `hc_auth` always — an explicit null without one.
        if pp.hcBundle != nil || pp.hcAuth != nil {
            if let hc = pp.hcBundle { p["hc_bundle"] = hc }
            p["hc_auth"] = pp.hcAuth.map { $0 as Any } ?? NSNull()
        }
        return (p, pp.hcBundle, pp.hcAuth, q.limits.maxProofBytes)
    }

    /// Submits the proved transaction. The chain refusing a read as stale is `STALE_READ`, like one
    /// the quote caught: the pool moved while the proof was being made.
    static func submit(txHex: String, chain: InvokeChain) async throws -> String {
        do {
            return try await chain.sendTransaction(hex: txHex)
        } catch {
            if isStaleRead(error) {
                throw Refusal(code: .staleRead, message: "The pool changed while this was being proved. Nothing was sent; the site can quote again.")
            }
            throw error
        }
    }

    /// A refusal from the node at submit that is the chain saying a read was stale.
    static func isStaleRead(_ error: Error) -> Bool {
        error.localizedDescription.range(of: #"stale ?read"#, options: [.regularExpression, .caseInsensitive]) != nil
    }
}
