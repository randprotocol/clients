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
    static func selectInputs(notes: [OwnedNote], need: UInt64) throws -> Selection {
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(notes))
        return try call("select_inputs", ["notes": encoded, "need": String(need)], as: Selection.self)
    }
    static func proveTransfer(_ request: ProveRequest) throws -> ProveResult {
        let params = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any] ?? [:]
        return try call("prove_transfer", params, as: ProveResult.self)
    }
    static func formatAmount(units: String) throws -> String {
        try call("format_amount", ["units": units]) as? String ?? units
    }
    static func parseAmount(_ text: String) throws -> String {
        guard let s = try call("parse_amount", ["text": text]) as? String else { throw CoreError(message: "not an amount") }
        return s
    }
}
