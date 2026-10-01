import XCTest
@testable import RandWallet

/// The RPL-2 invoke flow (`InvokeFlow`), against a fake node and a fake core: every question asked
/// in the engine's order (`ui/engine/wallet.js`'s `quoteInvoke`), each refusal with the engine's
/// code and nothing asked after it, the anchor taken last, and the chain's stale read at submit
/// mapped to `STALE_READ`. `ui/test/engine-invoke.test.mjs` holds the same rules for the JS.
final class InvokeFlowTests: XCTestCase {
    static let program = Amm.durianProgram
    static let pool = AmmTests.live
    static let zero = InvokeFlow.zeroWord8

    final class Chain: InvokeChain {
        var calls: [String] = []
        var limitsReply = RpcClient.ChainLimits(envelopeBytes: 1860, maxProofBytes: 4_194_304, bundleGasLimit: 20479,
                                                proofWindowBlocks: 1024,
                                                programState: ProgramState(cellFee: "10000000", maxReads: 8, maxWrites: 8, maxPayouts: 4))
        var code: ProgramCode? = ProgramCode(basePc: 4096, words: [1, 2, 3])
        var cells: [String: String] = [InvokeFlowTests.pool.key: InvokeFlowTests.pool.value]
        var cellsOff = false
        var vault: [AssetAmount]? = [AssetAmount(asset: 0, amount: "213800000000"), AssetAmount(asset: 2, amount: "18712750994")]
        var feeSpecs: [[String: Any]] = []
        var params = RpcClient.ProofParams(hcBundle: String(repeating: "a", count: 64), hcAuth: nil, profile: "production")
        var submitError: Error?
        var submitted: [String] = []

        func limits() async throws -> RpcClient.ChainLimits { calls.append("limits"); return limitsReply }
        func programCode(_ p: String) async throws -> ProgramCode? { calls.append("code"); return code }
        func programPublic(_ p: String) async throws -> String? { calls.append("public"); return "" }
        func programCell(_ p: String, key: String) async throws -> String? {
            calls.append("cell \(key.prefix(8))")
            return cellsOff ? nil : (cells[key] ?? InvokeFlowTests.zero)
        }
        func estimateFee(_ spec: [String: Any]) async throws -> String { calls.append("fee"); feeSpecs.append(spec); return "1200000" }
        func programVault(_ p: String) async throws -> [AssetAmount]? { calls.append("vault"); return vault }
        func proofParams() async throws -> RpcClient.ProofParams { calls.append("proofParams"); return params }
        func genesisHash() async throws -> String? { calls.append("genesis"); return String(repeating: "b", count: 64) }
        func anchor() async throws -> (height: UInt64, root: String) { calls.append("anchor"); return (900, "root") }
        func witness(index: UInt64) async throws -> (root: String, path: [String]) { calls.append("witness \(index)"); return ("root", ["p\(index)"]) }
        func sendTransaction(hex: String) async throws -> String {
            calls.append("send")
            if let submitError { throw submitError }
            submitted.append(hex)
            return "ab"
        }
    }

    final class Core: InvokeCore {
        var calls: [String] = []
        var dryError: Error?
        var planError: Error?
        var planned: (burnR: String, burnAsset: UInt32, burnA: String, fee: String)?
        func dryRun(_ transition: [String: Any]) throws -> InvokeDryRun {
            calls.append("dry")
            if let dryError { throw dryError }
            return InvokeDryRun(tier: 14, gas: 9000, gasLimit: 12288, gasMax: 16383, keccakLogHeight: 0, sha256LogHeight: 0, contextWords: 80)
        }
        func plan(notes: [OwnedNote], burnR: String, burnAsset: UInt32, burnA: String, fee: String) throws -> TransferPlan {
            calls.append("plan")
            planned = (burnR, burnAsset, burnA, fee)
            if let planError { throw planError }
            return TransferPlan(inputs: [InvokeFlowTests.note(4, "300000000")], feeInputs: [], need: "201200000", change: "98800000",
                                feeChange: "0", fee: fee, proofs: 1)
        }
    }

    struct Nope: LocalizedError { let errorDescription: String? }

    static func note(_ index: UInt64, _ amount: String, asset: UInt32 = 0) -> OwnedNote {
        OwnedNote(index: index, note: "n\(index)", cm: "c\(index)", nf: "f\(index)", amount: amount, asset: asset, time: 1, from: "",
                  height: 10, spent: false, pending: nil)
    }

    /// 0.2 RAND into the live pool.
    private func swapRequest() throws -> InvokeRequest {
        let pool = try XCTUnwrap(Amm.decodePool(Self.pool))
        guard case .success(let s) = Amm.buildSwap(route: Amm.findRoute([pool], sell: 0, buy: 2), dx: 200_000_000, rnd: [1, 2, 3]) else {
            throw Nope(errorDescription: "no swap")
        }
        return s.request
    }

    private func quote(_ r: InvokeRequest, _ chain: Chain, _ core: Core, notesRead: (() -> Void)? = nil) async throws -> InvokeFlow.Quote {
        try await InvokeFlow.quote(r, chain: chain, core: core, notes: {
            chain.calls.append("scan")
            notesRead?()
            return [Self.note(4, "300000000")]
        })
    }

    private func refusal(_ code: InvokeFlow.Refusal.Code, _ body: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do {
            try await body()
            XCTFail("expected \(code.rawValue)", file: file, line: line)
        } catch let e as InvokeFlow.Refusal {
            XCTAssertEqual(e.code, code, e.message, file: file, line: line)
            XCTAssertTrue(e.message.contains("othing was sent") || e.code == .programsUnsupported || e.code == .insufficientFunds || e.code == .programRefused,
                          e.message, file: file, line: line)
        } catch {
            XCTFail("\(error)", file: file, line: line)
        }
    }

    func testTheQuoteAsksInTheEnginesOrderAndPricesTheCallByItsGas() async throws {
        let chain = Chain(), core = Core()
        let q = try await quote(try swapRequest(), chain, core)
        XCTAssertEqual(chain.calls, ["limits", "code", "public", "cell 01000000", "fee", "vault", "scan"])
        XCTAssertEqual(core.calls, ["dry", "plan"])
        let spec = try XCTUnwrap(chain.feeSpecs.first)
        XCTAssertEqual(spec["kind"] as? String, "invoke")
        XCTAssertEqual(spec["tier"] as? Int, 14)
        XCTAssertEqual(spec["gas"] as? UInt64, 12288, "the declared limit, not the exact gas")
        XCTAssertEqual(spec["bytes"] as? Int, 4_194_304, "the proof quoted at the chain's cap")
        XCTAssertEqual(spec["created_cells"] as? Int, 0, "a pool that exists creates no cell")
        XCTAssertEqual(spec["keccak_log_height"] as? Int, 0)
        XCTAssertEqual(q.fee, "1200000")
        XCTAssertEqual(core.planned?.burnR, "200000000")
        XCTAssertEqual(core.planned?.burnAsset, 0, "selling RAND burns no token")
        XCTAssertEqual(core.planned?.burnA, "0")
        XCTAssertEqual(q.transition["program"] as? String, Self.program)
        XCTAssertEqual((q.transition["program_code"] as? [String: Any])?["base_pc"] as? UInt32, 4096)
        XCTAssertEqual(q.transition["private_inputs"] as? [UInt32], [3, 1, 2, 3])
    }

    func testWithoutAGasSectionTheFeeIsByTierAlone() async throws {
        let chain = Chain(), core = Core()
        chain.limitsReply = RpcClient.ChainLimits(envelopeBytes: nil, maxProofBytes: nil, bundleGasLimit: nil,
                                                  programState: ProgramState(cellFee: "1", maxReads: 8, maxWrites: 8, maxPayouts: 4))
        _ = try await quote(try swapRequest(), chain, core)
        let spec = try XCTUnwrap(chain.feeSpecs.first)
        XCTAssertNil(spec["gas"])
        XCTAssertNil(spec["bytes"])
    }

    func testAChainWithoutProgramsIsRefusedBeforeAnythingElseIsAsked() async throws {
        let chain = Chain(), core = Core()
        chain.limitsReply = RpcClient.ChainLimits(envelopeBytes: 1860, maxProofBytes: nil, bundleGasLimit: 20479)
        let r = try swapRequest()
        await refusal(.programsUnsupported) { _ = try await self.quote(r, chain, core) }
        XCTAssertEqual(chain.calls, ["limits"])
        XCTAssertEqual(core.calls, [])
        // A node whose cells answer `{"enabled": false}` is the same chain.
        let off = Chain()
        off.cellsOff = true
        await refusal(.programsUnsupported) { _ = try await self.quote(r, off, Core()) }
    }

    func testNoProgramAtThatIdIsSaidPlainly() async throws {
        let chain = Chain()
        chain.code = nil
        let r = try swapRequest()
        await refusal(.noProgram) { _ = try await self.quote(r, chain, Core()) }
        XCTAssertEqual(chain.calls, ["limits", "code"])
    }

    func testAPoolThatMovedIsAStaleReadAndNothingIsProvedOrPriced() async throws {
        let chain = Chain(), core = Core()
        chain.cells[Self.pool.key] = "001a79c73100000092eb5d5b04000000338ebab90e0000000300000001000000"
        let r = try swapRequest()
        await refusal(.staleRead) { _ = try await self.quote(r, chain, core) }
        XCTAssertEqual(chain.calls, ["limits", "code", "public", "cell 01000000"])
        XCTAssertEqual(core.calls, [], "no dry run, no plan")
    }

    func testATransitionTheProgramRefusesCostsNoFeeQuote() async throws {
        let chain = Chain(), core = Core()
        core.dryError = Nope(errorDescription: "the program does not accept this transition: trap")
        let r = try swapRequest()
        await refusal(.programRefused) { _ = try await self.quote(r, chain, core) }
        XCTAssertFalse(chain.calls.contains("fee"))
    }

    func testAVaultThatCannotPayIsRefusedBeforeTheWalletIsScanned() async throws {
        let chain = Chain(), core = Core()
        chain.vault = [AssetAmount(asset: 0, amount: "213800000000"), AssetAmount(asset: 2, amount: "5")]
        let r = try swapRequest()
        await refusal(.vaultShort) { _ = try await self.quote(r, chain, core) }
        XCTAssertFalse(chain.calls.contains("scan"))
        XCTAssertEqual(core.calls, ["dry"])
    }

    func testTheVaultCountsWhatTheSameTransitionDeposits() throws {
        var r = try swapRequest()
        r.pays = [AssetAmount(asset: 0, amount: "100")]
        r.inflow = .init(rand: "60", asset: 0, amount: "0", kind: "none")
        XCTAssertNil(InvokeFlow.vaultShortfall(r, vault: [AssetAmount(asset: 0, amount: "40")]))
        XCTAssertNotNil(InvokeFlow.vaultShortfall(r, vault: [AssetAmount(asset: 0, amount: "39")]))
        r.pays = [AssetAmount(asset: 2, amount: "100")]
        r.inflow = .init(rand: "0", asset: 2, amount: "100", kind: "deposit")
        XCTAssertNil(InvokeFlow.vaultShortfall(r, vault: []))
        r.inflow.kind = "burn"
        XCTAssertNotNil(InvokeFlow.vaultShortfall(r, vault: []), "a burned token is destroyed, not held")
    }

    func testNotesThatCannotCoverItAreInsufficientFunds() async throws {
        let chain = Chain(), core = Core()
        core.planError = Nope(errorDescription: "not enough RAND")
        let r = try swapRequest()
        await refusal(.insufficientFunds) { _ = try await self.quote(r, chain, core) }
        XCTAssertEqual(chain.calls.last, "scan")
    }

    func testSellingATokenBurnsItIntoTheVault() async throws {
        let chain = Chain(), core = Core()
        let pool = try XCTUnwrap(Amm.decodePool(Self.pool))
        guard case .success(let s) = Amm.buildSwap(route: Amm.findRoute([pool], sell: 2, buy: 0), dx: 10_000_000_000) else { return XCTFail() }
        _ = try await quote(s.request, chain, core)
        XCTAssertEqual(core.planned?.burnR, "0")
        XCTAssertEqual(core.planned?.burnAsset, 2)
        XCTAssertEqual(core.planned?.burnA, "10000000000")
    }

    func testAWriteOverZerosIsACreatedCell() async throws {
        let chain = Chain(), core = Core()
        var r = try swapRequest()
        let fresh = Amm.wordsToHex([9])
        r.writes.append(CellHex(key: fresh, value: Amm.wordsToHex([1])))
        r.writes.append(CellHex(key: Amm.wordsToHex([10]), value: Self.zero))
        _ = try await quote(r, chain, core)
        XCTAssertEqual(chain.feeSpecs.first?["created_cells"] as? Int, 1)
        XCTAssertTrue(chain.calls.contains("cell 09000000"), "an unread key is asked of the chain")
        XCTAssertFalse(chain.calls.contains("cell 0a000000"), "writing zeros creates nothing and needs no read")
    }

    func testTheProofRequestTakesTheAnchorLastAndCarriesTheQuote() async throws {
        let chain = Chain(), core = Core()
        let q = try await quote(try swapRequest(), chain, core)
        chain.calls = []
        let built = try await InvokeFlow.proveRequest(q, spendKey: "sk", chainId: 20, chain: chain)
        XCTAssertEqual(chain.calls, ["proofParams", "genesis", "anchor", "witness 4"])
        let p = built.params
        XCTAssertEqual(p["spend_key"] as? String, "sk")
        XCTAssertEqual(p["chain_id"] as? UInt64, 20)
        XCTAssertEqual(p["fee"] as? String, "1200000")
        XCTAssertEqual(p["tier"] as? Int, 14)
        XCTAssertEqual(p["gas_limit"] as? UInt64, 12288)
        XCTAssertEqual(p["anchor_height"] as? UInt64, 900)
        XCTAssertEqual(p["anchor_root"] as? String, "root")
        XCTAssertEqual(p["bundle_gas_limit"] as? Int, 20479)
        XCTAssertEqual(p["max_proof_bytes"] as? Int, 4_194_304)
        XCTAssertEqual(p["envelope_bytes"] as? Int, 1860)
        XCTAssertEqual(p["genesis"] as? String, String(repeating: "b", count: 64))
        XCTAssertEqual(p["hc_bundle"] as? String, String(repeating: "a", count: 64))
        XCTAssertTrue(p["hc_auth"] is NSNull, "an explicit null: this chain names no auth guest")
        let inputs = try XCTUnwrap(p["inputs"] as? [[String: Any]])
        XCTAssertEqual(inputs.count, 1)
        XCTAssertEqual(inputs[0]["path"] as? [String], ["p4"])
        XCTAssertEqual((inputs[0]["note"] as? [String: Any])?["index"] as? Int, 4)
        XCTAssertEqual((p["fee_inputs"] as? [Any])?.count, 0)
        XCTAssertEqual(p["program"] as? String, Self.program)
        XCTAssertEqual(built.maxProofBytes, 4_194_304)
        // The params must be JSON the core can take.
        XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: p))
    }

    func testTheChainsStaleReadAtSubmitIsStaleRead() async throws {
        let chain = Chain()
        chain.submitError = RpcClient.RpcError(code: -32000, message: "transaction rejected: StaleRead { key: 01… }")
        await refusal(.staleRead) { _ = try await InvokeFlow.submit(txHex: "00", chain: chain) }
        chain.submitError = RpcClient.RpcError(code: -32000, message: "transaction rejected: stale read of cell 0100…")
        await refusal(.staleRead) { _ = try await InvokeFlow.submit(txHex: "00", chain: chain) }
        // Any other refusal is the node's own words, unchanged.
        chain.submitError = RpcClient.RpcError(code: -32000, message: "fee too low")
        do {
            _ = try await InvokeFlow.submit(txHex: "00", chain: chain)
            XCTFail()
        } catch let e as RpcClient.RpcError {
            XCTAssertEqual(e.message, "fee too low")
        }
        chain.submitError = nil
        let hash = try await InvokeFlow.submit(txHex: "00", chain: chain)
        XCTAssertEqual(hash, "ab")
    }

    @MainActor
    func testWithoutMemoryOrAProverAnInvokeIsProverUnavailable() async throws {
        let settings = Settings()
        let saved = (settings.noProver, settings.prover)
        defer { settings.noProver = saved.0; settings.prover = saved.1 }
        settings.prover = nil
        settings.noProver = true
        let wallet = WalletService(settings: settings)
        wallet.deviceCanProve = { false }
        do {
            _ = try await wallet.canInvoke()
            XCTFail("an invoke with nowhere to prove it was offered")
        } catch let e as InvokeFlow.Refusal {
            XCTAssertEqual(e.code, .proverUnavailable)
        }
    }

    // MARK: RpcClient: the program-state replies, held to their shape

    func testProgramStateRepliesAreHeldToTheirShape() throws {
        let page = try XCTUnwrap(RpcClient.programCells(fromReply: ["cells": [["key": Self.pool.key, "value": Self.pool.value]], "next": NSNull()]))
        XCTAssertEqual(page.cells, [Self.pool])
        XCTAssertNil(page.next)
        XCTAssertNil(try RpcClient.programCells(fromReply: ["enabled": false]), "no section")
        XCTAssertThrowsError(try RpcClient.programCells(fromReply: ["cells": [["key": "zz", "value": Self.pool.value]]]))
        XCTAssertEqual(try RpcClient.programCells(fromReply: ["cells": [], "next": Self.pool.key])?.next, Self.pool.key)

        XCTAssertEqual(try RpcClient.programCell(fromReply: ["key": Self.pool.key, "value": Self.pool.value], key: Self.pool.key), Self.pool.value)
        XCTAssertNil(try RpcClient.programCell(fromReply: ["enabled": false], key: Self.pool.key))
        XCTAssertThrowsError(try RpcClient.programCell(fromReply: ["key": Self.zero, "value": Self.pool.value], key: Self.pool.key), "another key's reply")

        XCTAssertEqual(try RpcClient.programCode(fromReply: ["base_pc": 4096, "words": [74007, 2566979859]]), ProgramCode(basePc: 4096, words: [74007, 2566979859]))
        XCTAssertNil(try RpcClient.programCode(fromReply: NSNull()))
        XCTAssertThrowsError(try RpcClient.programCode(fromReply: ["base_pc": 4096, "words": [-1]]))
        XCTAssertThrowsError(try RpcClient.programCode(fromReply: ["base_pc": 4096, "words": [4_294_967_296]]))

        XCTAssertEqual(try RpcClient.programPublic(fromReply: ""), "")
        XCTAssertEqual(try RpcClient.programPublic(fromReply: "0x0100000002000000"), "0100000002000000")
        XCTAssertNil(try RpcClient.programPublic(fromReply: NSNull()))
        XCTAssertThrowsError(try RpcClient.programPublic(fromReply: "010"), "not whole words")

        XCTAssertEqual(try RpcClient.programVault(fromReply: [["asset": 0, "amount": "213800000000"], ["asset": 2, "amount": "18712750994"]]),
                       [AssetAmount(asset: 0, amount: "213800000000"), AssetAmount(asset: 2, amount: "18712750994")])
        XCTAssertNil(try RpcClient.programVault(fromReply: ["enabled": false]))
        XCTAssertThrowsError(try RpcClient.programVault(fromReply: [["asset": 2, "amount": "1"], ["asset": 0, "amount": "1"]]), "not ascending")
        XCTAssertThrowsError(try RpcClient.programVault(fromReply: [["asset": 0, "amount": 5]]), "a number is not an amount")
    }

    func testGetLimitsCarriesProgramState() throws {
        let live: [String: Any] = ["envelope_bytes": 1860, "max_proof_bytes": 4_194_304, "bundle_gas_limit": 20479, "proof_window_blocks": 1024,
                                   "program_state": ["cell_fee": "10000000", "max_payouts": 4, "max_reads": 8, "max_writes": 8]]
        let l = try RpcClient.limits(fromLimits: live)
        XCTAssertEqual(l.programState, ProgramState(cellFee: "10000000", maxReads: 8, maxWrites: 8, maxPayouts: 4))
        var none = live
        none["program_state"] = NSNull()
        XCTAssertNil(try RpcClient.limits(fromLimits: none).programState)
        none.removeValue(forKey: "program_state")
        XCTAssertNil(try RpcClient.limits(fromLimits: none).programState, "an older node")
        var bad = live
        bad["program_state"] = ["cell_fee": 10, "max_payouts": 4, "max_reads": 8, "max_writes": 8]
        XCTAssertThrowsError(try RpcClient.limits(fromLimits: bad))
    }

    func testEstimateFeeAndTheProgramCallsSendTheirParamsAsTheNodeTakesThem() async throws {
        StubProver.requests = []
        StubProver.hosts = []
        StubProver.handler = { method, _ in
            switch method {
            case "rand_estimateFee": return .result("1200000")
            case "rand_getProgramCells": return .result(["cells": [["key": Self.pool.key, "value": Self.pool.value]], "next": NSNull()])
            default: return .error(-32601, "no", nil)
            }
        }
        let rpc = RpcClient(url: URL(string: "https://node.example")!, session: StubProver.session(), pause: { _ in })
        let fee = try await rpc.estimateFee(["kind": "invoke", "tier": 14, "created_cells": 0])
        XCTAssertEqual(fee, "1200000")
        let cells = try await rpc.allProgramCells(Self.program)
        XCTAssertEqual(cells, [Self.pool])
        let sent = StubProver.requests.compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }
        let feeParams = try XCTUnwrap(sent.first?["params"] as? [Any])
        XCTAssertEqual((feeParams.first as? [String: Any])?["kind"] as? String, "invoke", "[spec], positional")
        let cellParams = try XCTUnwrap(sent.last?["params"] as? [Any])
        XCTAssertEqual(cellParams.first as? String, Self.program)
        XCTAssertEqual((cellParams.last as? [String: Any])?["limit"] as? Int, 256)
    }
}
