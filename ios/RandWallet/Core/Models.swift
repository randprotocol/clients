import Foundation

/// Shapes returned by the core (core/crates/wallet-core, `wallet_core::dispatch`). Field names
/// are the core's; amounts are decimal strings of units because they exceed 2^53.

struct CoreConstants: Decodable {
    let version: String
    let chainBuild: String
    let defaultChainId: UInt64
    let defaultRpcUrl: String
    let explorerUrl: String
    let tokenSymbol: String
    let tokenDecimals: Int
    let bundleBaseFee: String
    let faucetMaxUnits: String
    let timeWindow: UInt64
    let anchorWindow: UInt64

    enum CodingKeys: String, CodingKey {
        case version
        case chainBuild = "chain_build"
        case defaultChainId = "default_chain_id"
        case defaultRpcUrl = "default_rpc_url"
        case explorerUrl = "explorer_url"
        case tokenSymbol = "token_symbol"
        case tokenDecimals = "token_decimals"
        case bundleBaseFee = "bundle_base_fee"
        case faucetMaxUnits = "faucet_max_units"
        case timeWindow = "time_window"
        case anchorWindow = "anchor_window"
    }
}

struct WalletInfo: Codable, Equatable {
    let spendKey: String
    let viewingKey: String
    let pk: String
    let address: String
    let keyFile: String

    enum CodingKeys: String, CodingKey {
        case spendKey = "spend_key", viewingKey = "viewing_key", pk, address, keyFile = "key_file"
    }
}

struct AddressInfo: Decodable {
    let valid: Bool
    let pk: String?
    let error: String?
}

/// A note this wallet owns, exactly as the core hands it over and as the store persists it.
struct OwnedNote: Codable, Equatable, Identifiable {
    var index: UInt64
    var note: String
    var cm: String
    var nf: String
    var amount: String
    var asset: UInt32
    var time: UInt32
    var from: String
    var height: UInt64
    var spent: Bool
    var pending: UInt32?

    var id: String { cm }
    var units: UInt64 { UInt64(amount) ?? 0 }
    var isSpendable: Bool { !spent && pending == nil && units > 0 }
    /// A deposit rebuilt from a bridge attestation has no leaf index until its leaf is scanned.
    var isUnplaced: Bool { index == UInt64.max }
}

struct SentRow: Codable, Equatable, Identifiable {
    var index: UInt64
    var toPk: String
    var amount: String
    var asset: UInt32
    var time: UInt32
    var height: UInt64

    var id: UInt64 { index }
    var units: UInt64 { UInt64(amount) ?? 0 }
    enum CodingKeys: String, CodingKey { case index, toPk = "to_pk", amount, asset, time, height }
}

struct ScanResult: Decodable {
    let received: [OwnedNote]
    let sent: [SentRow]
    let nextIndex: UInt64
    let rows: Int
    enum CodingKeys: String, CodingKey { case received, sent, nextIndex = "next_index", rows }
}

struct Selection: Decodable {
    let chosen: [OwnedNote]
    let need: String
    let change: String
}

struct ProveInput: Encodable {
    let note: OwnedNote
    let path: [String]
}

struct ProveRequest: Encodable {
    let spendKey: String
    let chainId: UInt64
    let to: String
    let amount: String
    let fee: String
    let anchorHeight: UInt64
    let anchorRoot: String
    let inputs: [ProveInput]
    let profile: String

    enum CodingKeys: String, CodingKey {
        case spendKey = "spend_key", chainId = "chain_id", to, amount, fee
        case anchorHeight = "anchor_height", anchorRoot = "anchor_root", inputs, profile
    }
}

struct ProveResult: Decodable {
    let txHex: String
    let hash: String
    let time: UInt32
    let amount: String
    let change: String
    let fee: String
    let tier: Int
    let proofBytes: Int
    let txBytes: Int
    let nullifiers: [String]
    let commitments: [String]
    let txKeys: [String]
    let spentIndices: [UInt64]

    enum CodingKeys: String, CodingKey {
        case txHex = "tx_hex", hash, time, amount, change, fee, tier
        case proofBytes = "proof_bytes", txBytes = "tx_bytes", nullifiers, commitments
        case txKeys = "tx_keys", spentIndices = "spent_indices"
    }
}

/// A transfer this wallet submitted, kept so the user can find the hash and disclose the payment.
struct Submission: Codable, Equatable, Identifiable {
    enum Status: String, Codable { case pending, committed, failed }
    var hash: String
    var time: UInt32
    var amount: String
    var to: String
    var fee: String
    var txKey: String
    var status: Status
    var height: UInt64?
    var submittedAt: Date

    var id: String { hash }
    var units: UInt64 { UInt64(amount) ?? 0 }
}
