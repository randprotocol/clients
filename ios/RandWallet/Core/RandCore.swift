import Foundation
import RandWalletCore

/// The one call into the Rust core: `rand_wallet_call(method, paramsJson)` → JSON reply
/// `{"ok":true,"value":…}` or `{"ok":false,"error":"…"}`. Every method and its parameters are
/// documented on `wallet_core::dispatch` in core/crates/wallet-core.
enum RandCore {
    struct CoreError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /// Raw call. Thread-safe; the slow method (`prove_transfer`) must run off the main thread.
    static func callRaw(_ method: String, params: String) throws -> Any {
        guard let reply = rand_wallet_call(method, params) else {
            throw CoreError(message: "core returned no reply")
        }
        defer { rand_wallet_free(reply) }
        let json = String(cString: reply)
        guard let data = json.data(using: .utf8),
              let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw CoreError(message: "core reply is not JSON")
        }
        if obj["ok"] as? Bool == true {
            return obj["value"] ?? NSNull()
        }
        throw CoreError(message: obj["error"] as? String ?? "unknown core error")
    }

    static func call(_ method: String, _ params: [String: Any] = [:]) throws -> Any {
        let data = try JSONSerialization.data(withJSONObject: params)
        return try callRaw(method, params: String(decoding: data, as: UTF8.self))
    }

    /// Call and decode the value as `T`.
    static func call<T: Decodable>(_ method: String, _ params: [String: Any] = [:], as type: T.Type) throws -> T {
        let value = try call(method, params)
        let data = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
        return try JSONDecoder().decode(T.self, from: data)
    }

    static var version: String { String(cString: rand_wallet_version()) }

    // MARK: typed wrappers

    static func constants() throws -> CoreConstants { try call("version", as: CoreConstants.self) }
    static func keygen() throws -> WalletInfo { try call("keygen", as: WalletInfo.self) }
    static func walletInfo(spendKey: String) throws -> WalletInfo {
        try call("wallet_info", ["spend_key": spendKey], as: WalletInfo.self)
    }
    static func importKey(_ input: String) throws -> WalletInfo {
        try call("import_key", ["input": input], as: WalletInfo.self)
    }
    static func parseAddress(_ address: String) throws -> AddressInfo {
        try call("parse_address", ["address": address], as: AddressInfo.self)
    }
    static func scanPage(spendKey: String, rows: [Any]) throws -> ScanResult {
        try call("scan_page", ["spend_key": spendKey, "rows": rows], as: ScanResult.self)
    }
    static func rebuiltDeposit(spendKey: String, action: Any) throws -> OwnedNote? {
        let v = try call("rebuilt_deposit", ["spend_key": spendKey, "action": action])
        if v is NSNull { return nil }
        let data = try JSONSerialization.data(withJSONObject: v)
        return try JSONDecoder().decode(OwnedNote.self, from: data)
    }
    /// Every note a block action created for this wallet from its public fields: a bridge deposit
    /// (net of the chain's fee, v0.6.8) and — when this wallet is `feeRecipient` — the envelope-less
    /// fee notes of deposits and burns.
    static func rebuiltNotes(spendKey: String, action: Any, feeRecipient: String?) throws -> [OwnedNote] {
        var params: [String: Any] = ["spend_key": spendKey, "action": action]
        if let r = feeRecipient { params["fee_recipient"] = r }
        let v = try call("rebuilt_notes", params)
        let data = try JSONSerialization.data(withJSONObject: v)
        return try JSONDecoder().decode([OwnedNote].self, from: data)
    }
    static func selectInputs(notes: [OwnedNote], need: UInt64) throws -> Selection {
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(notes))
        return try call("select_inputs", ["notes": encoded, "need": String(need)], as: Selection.self)
    }
    static func proveTransfer(_ request: ProveRequest) throws -> ProveResult {
        let params = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any] ?? [:]
        return try call("prove_transfer", params, as: ProveResult.self)
    }
    /// What this chain's guests mean for a proof — `chain_guests {hc_bundle, hc_auth}`: the
    /// witness a paired prover is sent (the viewing key on a split-authorisation chain, the spend
    /// key on an older one) is the core's decision, made here and nowhere else. Refuses, before
    /// anything is built, a pair this build cannot prove for (v3 without an auth guest, an auth
    /// guest beside v1/v2, a malformed digest). `nil` is sent as JSON `null`.
    static func chainGuests(hcBundle: String?, hcAuth: String?) throws -> ChainGuests {
        try call("chain_guests", ["hc_bundle": hcBundle ?? NSNull(), "hc_auth": hcAuth ?? NSNull()], as: ChainGuests.self)
    }
    /// Delegated proving: the transfer `prove_transfer` would build, its witness sealed to a
    /// paired prover. `params` carries the spend key and the pairing token — never log it. The
    /// reply's `pending` carries neither. On a split-authorisation chain this call also makes the
    /// auth proof, on this device, from the spend key (about seven seconds natively): call it off
    /// the main thread, and say so on the screen first.
    static func prepareTransfer(_ params: [String: Any]) throws -> (sealedHex: String, pending: Any) {
        guard let v = try call("prepare_transfer", params) as? [String: Any],
              let sealed = v["sealed_hex"] as? String, let pending = v["pending"] else {
            throw CoreError(message: "prepare_transfer returned no sealed job")
        }
        return (sealed, pending)
    }
    /// Opens the prover's reply, checks it and verifies the proof: the ProveResult
    /// `prove_transfer` would have returned, or the core's refusal.
    static func finishProof(pending: Any, replyHex: String) throws -> ProveResult {
        try call("finish_proof", ["pending": pending, "reply_hex": replyHex], as: ProveResult.self)
    }

    // MARK: RPL-2 invoke (`wallet_core`'s "invoking a program": dry_run / plan / prove / prepare)

    /// Runs the program on the transition in the emulator, no proving: the tier and gas the fee is
    /// priced at. `transition` is `TransitionRequest`'s JSON (program, program_code, public_hex,
    /// private_inputs, reads, writes, inflow, pays, mints). A transition the program does not
    /// accept is refused here, with the emulator's reason.
    static func dryRunInvoke(_ transition: [String: Any]) throws -> InvokeDryRun {
        try call("dry_run_invoke", transition, as: InvokeDryRun.self)
    }

    /// The bundle's notes for an invoke that burns `burnR` RAND and `burnA` of `burnAsset` and pays
    /// `fee`: a token's notes in `inputs` and RAND's in `feeInputs` when it burns a token, RAND in
    /// `inputs` otherwise. Refused when the notes do not cover it.
    static func planInvoke(notes: [OwnedNote], burnR: String, burnAsset: UInt32, burnA: String, fee: String) throws -> TransferPlan {
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(notes))
        return try call("plan_invoke", ["notes": encoded, "burn_r": burnR, "burn_asset": burnAsset, "burn_a": burnA, "fee": fee],
                        as: TransferPlan.self)
    }

    /// The call proof, the auth proof and the bundle proof, all on this device (the bundle proof
    /// peaks at ~6 GB): call it off the main thread. `params` carries the spend key — never log it.
    static func proveInvoke(_ params: [String: Any]) throws -> InvokeResult {
        try call("prove_invoke", params, as: InvokeResult.self)
    }

    /// Delegated proving for an invoke: the call proof and the auth proof made HERE (the call's
    /// witness is the program's private inputs; the auth proof's is the spend key), the bundle
    /// witness sealed to the prover in `params["prover"]`. `params` carries the spend key and the
    /// token — never log it. The reply's `pending` goes to `finishInvoke` with the prover's reply.
    static func prepareInvoke(_ params: [String: Any]) throws -> (sealedHex: String, pending: Any) {
        guard let v = try call("prepare_invoke", params) as? [String: Any],
              let sealed = v["sealed_hex"] as? String, let pending = v["pending"] else {
            throw CoreError(message: "prepare_invoke returned no sealed job")
        }
        return (sealed, pending)
    }

    /// `finish_proof` for an invoke's pending job: the reply opened, checked and verified, and the
    /// result `prove_invoke` would have returned.
    static func finishInvoke(pending: Any, replyHex: String) throws -> InvokeResult {
        try call("finish_proof", ["pending": pending, "reply_hex": replyHex], as: InvokeResult.self)
    }

    static func formatAmount(units: String) throws -> String {
        try call("format_amount", ["units": units]) as? String ?? units
    }
    static func parseAmount(_ text: String) throws -> String {
        guard let s = try call("parse_amount", ["text": text]) as? String else { throw CoreError(message: "not an amount") }
        return s
    }
}
