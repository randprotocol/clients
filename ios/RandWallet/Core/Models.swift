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
    /// Chain 18 (constraint set 8): the gas every bundle proof this core makes declares.
    let bundleGasLimit: UInt64
    /// Fullnode issue #64: the chains on which a node's memo claim is never believed.
    let legacyEnvelopeChainIds: [UInt64]
    /// The guests of the chain this build's defaults describe: bundle guest v3 and the auth guest
    /// (split authorisation, fullnode v0.6.3). Optional so an older core's reply still decodes.
    let hcBundle: String?
    let hcAuth: String?
    /// A transaction carries an auth proof this device makes itself beside the bundle proof.
    let splitAuthorisation: Bool?
    /// What a prover learns from a viewing-key job — the sentence every shell shows before a
    /// pairing is saved (`wallet_core::PROVER_HISTORY_WARNING`).
    let proverHistoryWarning: String?

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
        case bundleGasLimit = "bundle_gas_limit"
        case legacyEnvelopeChainIds = "legacy_envelope_chain_ids"
        case hcBundle = "hc_bundle"
        case hcAuth = "hc_auth"
        case splitAuthorisation = "split_authorisation"
        case proverHistoryWarning = "prover_history_warning"
    }
}

/// `chain_guests`: what a chain's guests mean for a proof, decided by the core and nowhere else.
struct ChainGuests: Decodable, Equatable {
    let hcBundle: String
    /// `nil` on a chain without split authorisation.
    let hcAuth: String?
    let splitAuthorisation: Bool
    /// `"viewing_key"` (a split-authorisation chain: a paired prover gets `nk` and a salt) or
    /// `"spend_key"` (an older chain: only a prover paired as the owner's own may have it).
    let witnessKind: String

    enum CodingKeys: String, CodingKey {
        case hcBundle = "hc_bundle", hcAuth = "hc_auth", splitAuthorisation = "split_authorisation", witnessKind = "witness_kind"
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
    /// Sealed with the payment only; `""` for none.
    let memo: String
    /// The chain's `envelope_bytes` from `rand_getLimits`; `nil` seals the legacy envelope, and
    /// the core refuses a non-empty memo then, before proving.
    let envelopeBytes: Int?
    /// The chain's bundle guest, `rand_status.hc_bundle` (64 hex); `nil` together with `hcAuth`
    /// (both omitted) leaves the core on the guests of the chain its defaults describe. A proof of
    /// the wrong guest is refused by the chain.
    var hcBundle: String? = nil
    /// The chain's auth guest, `rand_status.hc_auth` (64 hex, or `nil` on a chain without split
    /// authorisation). Sent as an explicit `null` whenever `hcBundle` is known: "this chain names
    /// no auth guest" is what the core must hear to refuse a v3 bundle guest it could not
    /// authorise a spend for (`ui/engine/wallet.js`'s `guestFields`).
    var hcAuth: String? = nil
    /// The chain's `bundle_gas_limit` from `rand_getLimits` (chain 18, constraint set 8): the gas
    /// every bundle proof must declare on a chain with a `gas` section; `nil` is a chain without
    /// one. The core refuses a value its guest does not declare before building anything.
    var bundleGasLimit: Int? = nil
    /// The chain's genesis hash (BIND-1: bound by every transaction on a chain after 19; the core
    /// ignores it on 14–19). Omitted when the node would not name it.
    var genesis: String? = nil

    enum CodingKeys: String, CodingKey {
        case genesis
        case spendKey = "spend_key", chainId = "chain_id", to, amount, fee
        case anchorHeight = "anchor_height", anchorRoot = "anchor_root", inputs, profile
        case memo, envelopeBytes = "envelope_bytes", hcBundle = "hc_bundle", hcAuth = "hc_auth"
        case bundleGasLimit = "bundle_gas_limit"
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(spendKey, forKey: .spendKey)
        try c.encode(chainId, forKey: .chainId)
        try c.encode(to, forKey: .to)
        try c.encode(amount, forKey: .amount)
        try c.encode(fee, forKey: .fee)
        try c.encode(anchorHeight, forKey: .anchorHeight)
        try c.encode(anchorRoot, forKey: .anchorRoot)
        try c.encode(inputs, forKey: .inputs)
        try c.encode(profile, forKey: .profile)
        try c.encode(memo, forKey: .memo)
        // An explicit null, as the other clients send it.
        try c.encode(envelopeBytes, forKey: .envelopeBytes)
        // The two guest fields: neither when the node names neither (the core's defaults), else
        // `hc_bundle` when known and `hc_auth` always — an explicit `null` on a chain without one.
        if hcBundle != nil || hcAuth != nil {
            try c.encodeIfPresent(hcBundle, forKey: .hcBundle)
            try c.encode(hcAuth, forKey: .hcAuth)
        }
        try c.encode(bundleGasLimit, forKey: .bundleGasLimit)
        try c.encodeIfPresent(genesis, forKey: .genesis)
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
    /// The PAYMENT output's transaction key (null on a burn, which pays nobody). Chain 14's
    /// bundle has four slots in slot order, two of them dummies — the payment is the one the
    /// core names, never a fixed index.
    let paymentTxKey: String?
    let spentIndices: [UInt64]
    /// Split authorisation: the auth proof's size, made on this device from the spend key beside
    /// the bundle proof (`nil` from a core that predates it, `0` on a chain without it).
    let authProofBytes: Int?

    enum CodingKeys: String, CodingKey {
        case txHex = "tx_hex", hash, time, amount, change, fee, tier
        case proofBytes = "proof_bytes", txBytes = "tx_bytes", nullifiers, commitments
        case txKeys = "tx_keys", paymentTxKey = "payment_tx_key", spentIndices = "spent_indices"
        case authProofBytes = "auth_proof_bytes"
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
