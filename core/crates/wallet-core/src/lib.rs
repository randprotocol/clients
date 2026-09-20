//! Rand Wallet core.
//!
//! Everything a lightweight client cannot do in its own language lives here: the Poseidon2 key
//! hierarchy, ML-KEM-768 + ChaCha20-Poly1305 envelopes, note commitments and nullifiers, and the
//! STARK proof of a 2-in-2-out bundle. The iOS app (Swift), the Android app (Java) and the
//! browser extensions (JavaScript) each keep their own HTTP client, note store and UI, and call
//! into this crate through one JSON entry point, [`call`], so the four clients share exactly one
//! implementation of every cryptographic rule the chain enforces.
//!
//! Nothing here performs I/O. A client pages `rand_getCommitments` and hands the rows to
//! [`scan_page`]; it fetches the anchor and the witnesses and hands them to [`prove_transfer`],
//! which returns the encoded transaction to submit. Spend keys enter as parameters and are
//! never stored.
//!
//! Wire conventions match `docs/rpc.md` of the fullnode: `Word8` values (keys, commitments,
//! nullifiers, roots, witness levels) are 64 lowercase hex characters, little-endian word by
//! word; amounts are decimal strings of units (1 RAND = 10^9 units); addresses are
//! `rand1` + base58.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use randprotocol_core::gas;
use randprotocol_core::ledger::TIME_WINDOW;
use randprotocol_core::notes::{word8_from_hex, word8_to_hex, Bundle, Envelope, ShieldedAddress, Word8, DEPTH};
use randprotocol_core::{format_amount, parse_amount, Action, Transaction, FAUCET_MAX_UNITS};
use randprotocol_zkvm::address::{address_of, envelope_from_core, seal_note};
use randprotocol_zkvm::executor::prove_bundle;
use randprotocol_zkvm::machine::{Backend, FriProfile};
use randprotocol_zkvm::notes::{bundle_inputs, expected_bundle_outputs, Note, SpendKey, ViewingKey};
use randprotocol_zkvm::viewing::TxKey;

/// The RPC namespace the fullnode defines (`rand_getCommitments`, …). A wire name: it follows
/// the node, never this wallet.
pub const RPC_NAMESPACE: &str = "rand";
/// The address human-readable part, taken from the fullnode rather than restated here, so the
/// two can never drift.
pub const ADDRESS_HRP: &str = randprotocol_core::notes::ADDRESS_PREFIX;
/// Units per whole token, as the chain defines it.
pub use randprotocol_core::UNITS_PER_RAND;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// The fullnode commit the vendored chain crates come from (core/vendor/fullnode).
pub const CHAIN_BUILD: &str = "142e1f7";
/// The chain the defaults below describe: chain 13, the live testnet at this fullnode commit
/// (`deploy/README.md`, genesis `8123ccac…`, cut 2026-09-19) — the shielded pool with staking
/// and the call limits, zkVM constraint set 6, production FRI profile.
pub const DEFAULT_CHAIN_ID: u64 = 13;
pub const DEFAULT_RPC_URL: &str = "https://rpc.randprotocol.org";
pub const EXPLORER_URL: &str = "https://randscan.org";
/// Peak resident memory of one bundle proof, measured on this crate's own fixture
/// (`examples/prove_fixture.rs`, Apple M-series): the prover materialises every table's
/// low-degree extension at once. Clients compare it with the device's memory before proving,
/// and wasm32 (4 GiB address space) cannot prove at all until this drops. Re-measured on
/// constraint set 6 (2026-09-19): 97.6 s, 5 634 113 536 bytes — within 0.6% of the chain-8
/// figure below, so the published requirement is unchanged.
pub const PROVER_PEAK_MEMORY_BYTES: u64 = 5_600_000_000;

/// A bundle spends exactly this many input notes (2-in-2-out). `select_inputs` enforces it; a
/// client that wants the number without re-deriving it reads `bundle_inputs` from `version`.
pub const BUNDLE_INPUTS: usize = 2;

/// The chain's ledger accepts a transaction bundle only when `asset == 0`
/// (`randprotocol_core::ledger::TxError::UnsupportedAsset`, `core/vendor/fullnode/crates/
/// randprotocol-core/src/ledger/mod.rs`): a registry asset (index ≥ 1, "RPL" in this wallet)
/// cannot move between two shielded addresses on this network. The only planned way out is a
/// `BridgeBurn` (a later task). Every layer — `plan_transfer`, `max_sendable`, `prove_transfer` —
/// refuses with exactly this sentence, so the UI can show it verbatim.
pub const RPL_TRANSFER_UNAVAILABLE: &str = "RPL transfers are not available on this network.";

// ------------------------------------------------------------------ errors

pub type Result<T> = std::result::Result<T, String>;

fn bad<T>(msg: impl Into<String>) -> Result<T> {
    Err(msg.into())
}

// ------------------------------------------------------------------ keys and addresses

/// A spend key and everything derived from it.
pub struct Wallet {
    pub sk: SpendKey,
    pub vk: ViewingKey,
    pub address: ShieldedAddress,
}

impl Wallet {
    pub fn from_spend_key(sk: SpendKey) -> Wallet {
        let vk = sk.viewing_key();
        Wallet { sk, vk, address: address_of(&vk) }
    }

    pub fn from_hex(spend_key_hex: &str) -> Result<Wallet> {
        let words = word8_from_hex(spend_key_hex.trim().trim_start_matches("0x"))
            .ok_or("spend key must be 64 hex characters")?;
        Ok(Wallet::from_spend_key(SpendKey(words)))
    }

    pub fn generate() -> Wallet {
        Wallet::from_spend_key(SpendKey::random())
    }

    pub fn spend_key_hex(&self) -> String {
        word8_to_hex(&self.sk.0)
    }

    /// The viewing key `nk`: what randscan.org's "My history" page takes.
    pub fn viewing_key_hex(&self) -> String {
        word8_to_hex(&self.vk.nk)
    }

    /// The `wallet.key.json` the `rand` CLI reads (version 2), for export.
    pub fn key_file_json(&self) -> String {
        json!({ "version": 2, "spend_key": self.spend_key_hex() }).to_string()
    }
}

/// Everything a client shows about a wallet, derived from its spend key.
#[derive(Serialize)]
pub struct WalletInfo {
    pub spend_key: String,
    pub viewing_key: String,
    pub pk: String,
    pub address: String,
    pub key_file: String,
}

pub fn wallet_info(w: &Wallet) -> WalletInfo {
    WalletInfo {
        spend_key: w.spend_key_hex(),
        viewing_key: w.viewing_key_hex(),
        pk: word8_to_hex(&w.vk.pk()),
        address: w.address.to_string(),
        key_file: w.key_file_json(),
    }
}

/// Accept a spend key as 64 hex characters or as the contents of a `wallet.key.json`.
pub fn spend_key_from_input(input: &str) -> Result<String> {
    let s = input.trim();
    if s.starts_with('{') {
        let v: Value = serde_json::from_str(s).map_err(|e| format!("not a key file: {e}"))?;
        if v["version"].as_u64() != Some(2) {
            return bad("key file must be version 2");
        }
        let sk = v["spend_key"].as_str().ok_or("key file has no spend_key")?;
        word8_from_hex(sk).ok_or("spend_key must be 64 hex characters")?;
        return Ok(sk.to_lowercase());
    }
    let s = s.trim_start_matches("0x");
    word8_from_hex(s).ok_or("a spend key is 64 hex characters, or a wallet.key.json")?;
    Ok(s.to_lowercase())
}

#[derive(Serialize)]
pub struct AddressInfo {
    pub valid: bool,
    pub pk: Option<String>,
    pub error: Option<String>,
}

pub fn parse_address(s: &str) -> AddressInfo {
    match ShieldedAddress::parse(s.trim()) {
        Ok(a) => AddressInfo { valid: true, pk: Some(word8_to_hex(&a.pk)), error: None },
        Err(e) => AddressInfo { valid: false, pk: None, error: Some(e.to_string()) },
    }
}

// ------------------------------------------------------------------ notes as the clients see them

/// A note this wallet owns, as the clients store it. `note` is the 112-byte plaintext (hex) so a
/// client never has to know the note layout; `amount`/`asset`/`time`/`from` repeat the fields a
/// UI shows.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OwnedNote {
    pub index: u64,
    pub note: String,
    pub cm: String,
    pub nf: String,
    pub amount: String,
    pub asset: u32,
    pub time: u32,
    pub from: String,
    pub height: u64,
    #[serde(default)]
    pub spent: bool,
    #[serde(default)]
    pub pending: Option<u32>,
}

impl OwnedNote {
    fn plaintext(&self) -> Result<Note> {
        let bytes = hex::decode(&self.note).map_err(|_| "note is not hex")?;
        Note::from_bytes(&bytes).ok_or_else(|| "note is not 112 bytes".to_string())
    }

    pub fn units(&self) -> u64 {
        self.amount.parse().unwrap_or(0)
    }

    /// Whether this note can be an input: unspent, not held by a pending submission, and worth
    /// something (a zero-value change note is a real leaf that buys nothing).
    pub fn is_spendable(&self) -> bool {
        !self.spent && self.pending.is_none() && self.units() > 0
    }
}

/// A note this wallet created for someone else — history only.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SentRow {
    pub index: u64,
    pub to_pk: String,
    pub amount: String,
    pub asset: u32,
    pub time: u32,
    pub height: u64,
}

fn owned_note(w: &Wallet, index: u64, height: u64, cm: Word8, note: Note) -> OwnedNote {
    OwnedNote {
        index,
        note: hex::encode(note.to_bytes()),
        cm: word8_to_hex(&cm),
        nf: word8_to_hex(&w.vk.nullifier(&cm)),
        amount: note.amount.to_string(),
        asset: note.asset,
        time: note.time,
        from: word8_to_hex(&note.from),
        height,
        spent: false,
        pending: None,
    }
}

// ------------------------------------------------------------------ scanning

/// One row of `rand_getCommitments`, as the node serves it.
#[derive(Deserialize)]
pub struct CommitmentRow {
    pub index: u64,
    pub cm: String,
    pub height: u64,
    pub envelope: EnvelopeHex,
}

#[derive(Serialize, Deserialize)]
pub struct EnvelopeHex {
    pub kem_ct: String,
    pub to_receiver: String,
    pub to_sender: String,
    pub body: String,
}

impl EnvelopeHex {
    fn decode(&self) -> Result<Envelope> {
        let f = |s: &str, name: &str| hex::decode(s).map_err(|_| format!("envelope.{name} is not hex"));
        Ok(Envelope {
            kem_ct: f(&self.kem_ct, "kem_ct")?,
            to_receiver: f(&self.to_receiver, "to_receiver")?,
            to_sender: f(&self.to_sender, "to_sender")?,
            body: f(&self.body, "body")?,
        })
    }
}

/// What one leaf turned out to be for this wallet. Mirrors `randprotocol_client::wallet::classify`:
/// an envelope that opens is not proof of ownership (anyone can seal to a public address), so a
/// received note is only kept when its `pk` is this wallet's.
pub enum Found {
    Received(Note),
    Sent(Note),
    Skipped,
}

pub fn classify(w: &Wallet, cm: Word8, envelope: &Envelope) -> Found {
    let env = envelope_from_core(envelope);
    if let Some((_, note)) = env.open_as_receiver(cm, &w.vk) {
        if note.pk == w.vk.pk() {
            return Found::Received(note);
        }
    }
    if let Some((_, note)) = env.open_as_sender(cm, &w.vk) {
        return Found::Sent(note);
    }
    Found::Skipped
}

#[derive(Serialize, Default)]
pub struct ScanResult {
    pub received: Vec<OwnedNote>,
    pub sent: Vec<SentRow>,
    /// One past the highest leaf index in the page, for the client's cursor.
    pub next_index: u64,
    pub rows: usize,
}

/// Trial-decrypt a page of leaves. The client merges the result into its store by leaf index
/// (a leaf offered twice is the same note) and advances its cursor to `next_index`.
pub fn scan_page(w: &Wallet, rows: &[CommitmentRow]) -> Result<ScanResult> {
    let mut out = ScanResult::default();
    for r in rows {
        let cm = word8_from_hex(&r.cm).ok_or("cm is not 64 hex characters")?;
        let env = r.envelope.decode()?;
        match classify(w, cm, &env) {
            Found::Received(note) => out.received.push(owned_note(w, r.index, r.height, cm, note)),
            Found::Sent(note) => out.sent.push(SentRow {
                index: r.index,
                to_pk: word8_to_hex(&note.pk),
                amount: note.amount.to_string(),
                asset: note.asset,
                time: note.time,
                height: r.height,
            }),
            Found::Skipped => {}
        }
        out.next_index = out.next_index.max(r.index + 1);
    }
    out.rows = rows.len();
    Ok(out)
}

/// The deposit note a committed `bridge_attest` appended for this wallet, rebuilt from the public
/// fields `rand_getTransaction` renders (a hostile relayer can publish a garbage envelope; the
/// chain's own rendering of the note cannot lie). `None` unless the action is a deposit to this
/// wallet whose commitment matches.
pub fn rebuilt_deposit(w: &Wallet, action: &Value) -> Option<OwnedNote> {
    if action["kind"].as_str()? != "bridge_attest" {
        return None;
    }
    let recipient = ShieldedAddress::parse(action["recipient"].as_str()?).ok()?;
    if recipient.pk != w.vk.pk() {
        return None;
    }
    let note = Note {
        pk: recipient.pk,
        from: [0; 8],
        amount: action["amount"].as_u64()?,
        asset: u32::try_from(action["asset_index"].as_u64()?).ok()?,
        time: u32::try_from(action["time"].as_u64()?).ok()?,
        r: word8_from_hex(action["r"].as_str()?)?,
    };
    let cm = note.commitment();
    if word8_to_hex(&cm) != action["commitment"].as_str()? {
        return None;
    }
    // The leaf index is not in the action; the client fills it in when the leaf with this
    // commitment turns up in a commitments page.
    Some(owned_note(w, u64::MAX, 0, cm, note))
}

/// The `pending` bookkeeping a client applies after a scan: a note held by a submission clears
/// once its nullifier appeared (`spent`) or the chain has read past the last height the bundle
/// could still be admitted at.
pub fn pending_cleared(note: &OwnedNote, read_through: u64) -> bool {
    match note.pending {
        Some(time) => note.spent || read_through > time as u64 + TIME_WINDOW,
        None => false,
    }
}

// ------------------------------------------------------------------ coin selection

#[derive(Serialize, Debug)]
pub struct Selection {
    pub chosen: Vec<OwnedNote>,
    pub need: String,
    pub change: String,
}

/// Largest-first, at most two notes of one asset (a bundle spends exactly two inputs). Mirrors
/// `randprotocol_client::wallet::select_inputs`, including its two errors.
pub fn select_inputs(notes: &[OwnedNote], asset: u32, need: u64) -> Result<Selection> {
    let mut sorted: Vec<&OwnedNote> = notes.iter().filter(|n| n.is_spendable() && n.asset == asset).collect();
    sorted.sort_by(|a, b| b.units().cmp(&a.units()));
    let have: u64 = sorted.iter().map(|n| n.units()).sum();
    if have < need {
        return bad(format!(
            "insufficient balance: have {} RAND, need {} RAND",
            format_amount(have),
            format_amount(need)
        ));
    }
    let mut chosen = Vec::new();
    let mut sum = 0u64;
    for n in sorted.iter().take(BUNDLE_INPUTS) {
        if sum >= need {
            break;
        }
        sum += n.units();
        chosen.push((*n).clone());
    }
    if sum < need {
        return bad(format!(
            "need more than two notes; the largest two hold {} RAND — consolidate first by sending to your own address",
            format_amount(sum)
        ));
    }
    Ok(Selection { chosen, need: need.to_string(), change: (sum - need).to_string() })
}

/// What a client needs to build one transfer: which notes to spend and what the bundle's numbers
/// come out to, before it ever fetches a witness or opens the prover. `inputs` is exactly what
/// `select_inputs` chose; `change` is `sum(inputs) - need`; `proofs` is always 1 today (a plain
/// transfer is one bundle) so a client never hard-codes it.
#[derive(Serialize, Debug)]
pub struct TransferPlan {
    pub inputs: Vec<OwnedNote>,
    pub need: String,
    pub change: String,
    pub fee: String,
    pub proofs: u8,
}

/// Plan a transfer of `asset`: pick inputs, compute `need = amount + fee` and the resulting
/// change. Registry assets (`asset >= 1`) are refused outright — see [`RPL_TRANSFER_UNAVAILABLE`]
/// — since the ledger admits only `asset == 0` bundles today.
pub fn plan_transfer(notes: &[OwnedNote], asset: u32, amount: u64, fee: u64) -> Result<TransferPlan> {
    if asset != 0 {
        return bad(RPL_TRANSFER_UNAVAILABLE);
    }
    if amount == 0 {
        return bad("amount must be greater than zero");
    }
    if fee < gas::BUNDLE_BASE {
        return bad(format!(
            "fee must be at least {} RAND (the bundle floor)",
            format_amount(gas::BUNDLE_BASE)
        ));
    }
    let need = amount.checked_add(fee).ok_or("amount + fee overflows")?;
    let selection = select_inputs(notes, 0, need)?;
    Ok(TransferPlan {
        inputs: selection.chosen,
        need: need.to_string(),
        change: selection.change,
        fee: fee.to_string(),
        proofs: 1,
    })
}

/// The largest amount one bundle can send, for a client's "max" button: the sum of the
/// `BUNDLE_INPUTS` largest spendable notes of `asset`, minus `fee`, floored at zero rather than
/// erroring (a wallet that cannot cover the fee can still be shown "0"). `inputs` is how many
/// notes that sum actually used (0, 1 or `BUNDLE_INPUTS`).
#[derive(Serialize, Debug)]
pub struct MaxSendable {
    pub amount: String,
    pub fee: String,
    pub inputs: usize,
}

pub fn max_sendable(notes: &[OwnedNote], asset: u32, fee: u64) -> Result<MaxSendable> {
    if asset != 0 {
        return bad(RPL_TRANSFER_UNAVAILABLE);
    }
    let mut sorted: Vec<&OwnedNote> = notes.iter().filter(|n| n.is_spendable() && n.asset == 0).collect();
    sorted.sort_by_key(|n| std::cmp::Reverse(n.units()));
    sorted.truncate(BUNDLE_INPUTS);
    let sum: u64 = sorted.iter().map(|n| n.units()).sum();
    Ok(MaxSendable { amount: sum.saturating_sub(fee).to_string(), fee: fee.to_string(), inputs: sorted.len() })
}

// ------------------------------------------------------------------ proving a transfer

/// One input of a bundle as the client hands it over: an owned note plus the witness
/// `rand_getWitness` returned for its leaf (32 sibling levels, leaf first).
#[derive(Deserialize)]
pub struct ProveInput {
    pub note: OwnedNote,
    pub path: Vec<String>,
}

#[derive(Deserialize)]
pub struct ProveRequest {
    pub spend_key: String,
    pub chain_id: u64,
    /// Recipient `rand1…` address.
    pub to: String,
    /// Units, decimal string.
    pub amount: String,
    /// Units, decimal string. The floor for a transfer is `gas::BUNDLE_BASE`.
    pub fee: String,
    /// The head anchor: `rand_getAnchor` with no height.
    pub anchor_height: u64,
    pub anchor_root: String,
    /// One or two inputs; the witness roots must equal `anchor_root`.
    pub inputs: Vec<ProveInput>,
    /// `"production"` (chain 13) or `"test"`.
    #[serde(default = "default_profile")]
    pub profile: String,
}

fn default_profile() -> String {
    "production".into()
}

#[derive(Serialize)]
pub struct ProveResult {
    /// `bincode(Transaction)` as hex — the parameter of `rand_sendTransaction`.
    pub tx_hex: String,
    /// The transaction hash the node will report.
    pub hash: String,
    pub time: u32,
    pub amount: String,
    pub change: String,
    pub fee: String,
    pub tier: u8,
    pub proof_bytes: usize,
    pub tx_bytes: usize,
    pub nullifiers: [String; 2],
    pub commitments: [String; 2],
    /// The per-transaction keys of the payment envelope and the change envelope, in that order.
    /// Handing out `tx_keys[0]` discloses exactly the payment (randscan.org opens it).
    pub tx_keys: [String; 2],
    /// Leaf indices of the notes this bundle spends, for the client to mark `pending`.
    pub spent_indices: Vec<u64>,
}

fn parse_units(s: &str, what: &str) -> Result<u64> {
    s.trim().parse::<u64>().map_err(|_| format!("{what} must be a decimal string of units"))
}

fn parse_path(levels: &[String]) -> Result<[Word8; DEPTH]> {
    if levels.len() != DEPTH {
        return bad(format!("witness path has {} levels, expected {DEPTH}", levels.len()));
    }
    let mut path = [[0u32; 8]; DEPTH];
    for (slot, s) in path.iter_mut().zip(levels) {
        *slot = word8_from_hex(s).ok_or("witness level is not 64 hex characters")?;
    }
    Ok(path)
}

fn profile_from_str(s: &str) -> Result<FriProfile> {
    match s {
        "production" => Ok(FriProfile::Production),
        "test" => Ok(FriProfile::Test),
        other => bad(format!("unknown FRI profile {other:?}; use \"production\" or \"test\"")),
    }
}

/// Build, prove and encode a plain shielded transfer (`Action::None`). This is the slow call:
/// a tier-14 bundle proof takes on the order of a minute on a laptop CPU and longer on a phone
/// or in WebAssembly, so a client runs it off the UI thread. Nothing is submitted.
pub fn prove_transfer(req: &ProveRequest) -> Result<ProveResult> {
    let w = Wallet::from_hex(&req.spend_key)?;
    let dest = ShieldedAddress::parse(req.to.trim()).map_err(|e| format!("recipient: {e}"))?;
    let amount = parse_units(&req.amount, "amount")?;
    let fee = parse_units(&req.fee, "fee")?;
    if amount == 0 {
        return bad("amount must be greater than zero");
    }
    if fee < gas::BUNDLE_BASE {
        return bad(format!("fee {} is below the bundle floor {}", fee, gas::BUNDLE_BASE));
    }
    let need = amount.checked_add(fee).ok_or("amount + fee overflows")?;
    if req.inputs.is_empty() || req.inputs.len() > 2 {
        return bad("a bundle spends one or two notes");
    }
    let root = word8_from_hex(&req.anchor_root).ok_or("anchor_root is not 64 hex characters")?;
    let time = u32::try_from(req.anchor_height).map_err(|_| "anchor height does not fit a bundle's time field")?;
    let profile = profile_from_str(&req.profile)?;

    let pk_self = w.vk.pk();
    let mut slots: Vec<(Note, [Word8; DEPTH], u32)> = Vec::with_capacity(2);
    let mut spent_indices = Vec::new();
    let mut in_sum = 0u64;
    for input in &req.inputs {
        let note = input.note.plaintext()?;
        if note.pk != pk_self {
            return bad(format!("note at leaf {} is not owned by this wallet", input.note.index));
        }
        if note.asset != 0 {
            return bad(RPL_TRANSFER_UNAVAILABLE);
        }
        if note.amount == 0 {
            return bad(format!("note at leaf {} is worth nothing", input.note.index));
        }
        let index = u32::try_from(input.note.index).map_err(|_| "leaf index does not fit 32 bits")?;
        slots.push((note, parse_path(&input.path)?, index));
        spent_indices.push(input.note.index);
        in_sum = in_sum.checked_add(note.amount).ok_or("input amounts overflow")?;
    }
    if in_sum < need {
        return bad(format!(
            "inputs hold {} RAND, but amount + fee is {} RAND",
            format_amount(in_sum),
            format_amount(need)
        ));
    }
    let change = in_sum - need;
    // A dummy input: a zero-value note owned by this wallet with an all-zero path at index 0. The
    // guest skips MERKLE_VERIFY for a zero-amount slot; `Note::new` gives it a fresh `r`, without
    // which two dummies would share a commitment and a nullifier.
    while slots.len() < 2 {
        slots.push((Note::new(pk_self, [0; 8], 0, 0, time), [[0u32; 8]; DEPTH], 0));
    }
    let inputs: [(Note, [Word8; DEPTH], u32); 2] = [slots[0], slots[1]];

    let out1 = Note::new(dest.pk, pk_self, amount, 0, time);
    let out2 = Note::new(pk_self, pk_self, change, 0, time);
    let outputs = [out1, out2];

    let words = bundle_inputs(&w.sk, &inputs, &outputs, root, fee, 0, 0, time);
    let expected = expected_bundle_outputs(&w.sk, &inputs, &outputs, root, fee, 0, 0, time);
    let (proof, digest, tier) = prove_bundle(profile, &words, Backend::Cpu).map_err(|e| format!("proving failed: {e}"))?;
    if digest != expected {
        return bad("the proof published a digest this wallet did not build; refusing to submit (wallet bug)");
    }

    let key1 = TxKey::random();
    let key2 = TxKey::random();
    let envelopes = [
        seal_note(&w.vk, &dest, &out1, &key1).map_err(|e| format!("sealing the payment envelope: {e}"))?,
        seal_note(&w.vk, &w.address, &out2, &key2).map_err(|e| format!("sealing the change envelope: {e}"))?,
    ];
    let nullifiers = [w.vk.nullifier(&inputs[0].0.commitment()), w.vk.nullifier(&inputs[1].0.commitment())];
    let commitments = [out1.commitment(), out2.commitment()];
    let proof_bytes = proof.len();
    let bundle = Bundle { anchor: root, nullifiers, commitments, fee, burn: 0, asset: 0, time, envelopes, proof };
    let tx = Transaction::shielded(req.chain_id, bundle, Action::None);
    let encoded = tx.encode();
    Ok(ProveResult {
        hash: tx.hash().to_hex(),
        tx_bytes: encoded.len(),
        tx_hex: hex::encode(encoded),
        time,
        amount: amount.to_string(),
        change: change.to_string(),
        fee: fee.to_string(),
        tier,
        proof_bytes,
        nullifiers: [word8_to_hex(&nullifiers[0]), word8_to_hex(&nullifiers[1])],
        commitments: [word8_to_hex(&commitments[0]), word8_to_hex(&commitments[1])],
        tx_keys: [hex::encode(key1.0), hex::encode(key2.0)],
        spent_indices,
    })
}

// ------------------------------------------------------------------ opening (for receipts)

/// Open one envelope with a per-transaction key — what a recipient (or randscan.org) does with
/// the `tx_keys[0]` a sender hands over. Returns the note or `None`.
pub fn open_with_tx_key(cm_hex: &str, envelope: &EnvelopeHex, tx_key_hex: &str) -> Result<Option<Value>> {
    let cm = word8_from_hex(cm_hex).ok_or("cm is not 64 hex characters")?;
    let key: [u8; 32] = hex::decode(tx_key_hex.trim())
        .map_err(|_| "tx key is not hex")?
        .try_into()
        .map_err(|_| "tx key must be 32 bytes")?;
    let env = envelope_from_core(&envelope.decode()?);
    Ok(env.open_with_tx_key(cm, &TxKey(key)).map(|n| {
        json!({
            "pk": word8_to_hex(&n.pk), "from": word8_to_hex(&n.from),
            "amount": n.amount.to_string(), "asset": n.asset, "time": n.time,
            "cm": word8_to_hex(&n.commitment()),
        })
    }))
}

// ------------------------------------------------------------------ a fixture for client smoke tests

/// A complete, valid `prove_transfer` request against a two-leaf tree built in memory: a fresh
/// sender holding 3 RAND paying 1 RAND to a fresh recipient. Lets every client exercise the
/// whole proving path (and time it on its own hardware) without a node. Never used for a real
/// transfer: the anchor exists on no chain.
pub fn fixture_prove_request(profile: &str) -> Result<Value> {
    use randprotocol_core::notes::FullTree;
    profile_from_str(profile)?;
    let sender = Wallet::generate();
    let recipient = Wallet::generate();
    let exec = randprotocol_zkvm::executor::ZkExecutor::new(FriProfile::Test);
    let note = Note::new(sender.vk.pk(), [0; 8], 3 * UNITS_PER_RAND, 0, 1);
    let tree = FullTree::new(vec![Note::new([1; 8], [0; 8], 1, 0, 1).commitment(), note.commitment()], &exec);
    let path: Vec<String> = tree.path(1).ok_or("fixture tree")?.iter().map(word8_to_hex).collect();
    let owned = owned_note(&sender, 1, 1, note.commitment(), note);
    Ok(json!({
        "spend_key": sender.spend_key_hex(),
        "chain_id": DEFAULT_CHAIN_ID,
        "to": recipient.address.to_string(),
        "amount": UNITS_PER_RAND.to_string(),
        "fee": gas::BUNDLE_BASE.to_string(),
        "anchor_height": 40,
        "anchor_root": word8_to_hex(&tree.root()),
        "inputs": [{ "note": owned, "path": path }],
        "profile": profile,
    }))
}

// ------------------------------------------------------------------ the JSON entry point

/// Chain and fee constants every client needs, so none of them hard-codes a number.
pub fn constants() -> Value {
    json!({
        "version": VERSION,
        "chain_build": CHAIN_BUILD,
        "default_chain_id": DEFAULT_CHAIN_ID,
        "default_rpc_url": DEFAULT_RPC_URL,
        "explorer_url": EXPLORER_URL,
        "rpc_namespace": RPC_NAMESPACE,
        "address_hrp": ADDRESS_HRP,
        "token_symbol": "RAND",
        "token_decimals": 9,
        "units_per_rand": UNITS_PER_RAND.to_string(),
        "bundle_base_fee": gas::BUNDLE_BASE.to_string(),
        "bundle_inputs": BUNDLE_INPUTS,
        // Registry assets (index >= 1) cannot be transferred between shielded addresses on this
        // network yet (see RPL_TRANSFER_UNAVAILABLE); a burn-to-bridge withdrawal is a later task.
        "rpl_transfer": false,
        "bridge_burn": false,
        "faucet_max_units": FAUCET_MAX_UNITS.to_string(),
        "time_window": TIME_WINDOW,
        "anchor_window": randprotocol_core::ledger::ANCHOR_WINDOW,
        "tree_depth": DEPTH,
        "hc_bundle": word8_to_hex(&randprotocol_zkvm::executor::ZkExecutor::hc_bundle()),
        "prover_peak_memory_bytes": PROVER_PEAK_MEMORY_BYTES,
    })
}

fn str_param<'a>(p: &'a Value, name: &str) -> Result<&'a str> {
    p.get(name).and_then(Value::as_str).ok_or_else(|| format!("missing string parameter {name:?}"))
}

fn u64_param(p: &Value, name: &str) -> Result<u64> {
    match p.get(name) {
        Some(Value::Number(n)) => n.as_u64().ok_or_else(|| format!("{name} must be a non-negative integer")),
        Some(Value::String(s)) => s.parse().map_err(|_| format!("{name} must be a decimal integer")),
        _ => bad(format!("missing parameter {name:?}")),
    }
}

/// Dispatch one call. `params` is a JSON object. Every client binding (C, JNI, wasm) is a thin
/// wrapper around this, so the three of them cannot drift.
///
/// Methods:
/// - `version` `{}` → constants
/// - `keygen` `{}` → wallet info for a fresh key
/// - `wallet_info` `{spend_key}` → `{spend_key, viewing_key, pk, address, key_file}`
/// - `import_key` `{input}` (64 hex or a key file) → wallet info
/// - `parse_address` `{address}` → `{valid, pk, error}`
/// - `scan_page` `{spend_key, rows: [getCommitments rows]}` → `{received, sent, next_index, rows}`
/// - `rebuilt_deposit` `{spend_key, action}` → owned note or null
/// - `pending_cleared` `{note, read_through}` → bool
/// - `select_inputs` `{notes, asset?, need}` → `{chosen, need, change}`
/// - `plan_transfer` `{notes, asset?, amount, fee}` → `{inputs, need, change, fee, proofs}`; asset
///   defaults to 0 (RAND); `asset >= 1` fails with [`RPL_TRANSFER_UNAVAILABLE`] (registry assets
///   are not transferable on this network yet — see `select_inputs`/`prove_transfer`, which agree)
/// - `max_sendable` `{notes, asset?, fee}` → `{amount, fee, inputs}`; the largest one-bundle send,
///   floored at zero; `asset >= 1` fails the same way
/// - `prove_transfer` `{…ProveRequest}` → ProveResult (slow)
/// - `open_with_tx_key` `{cm, envelope, tx_key}` → note or null
/// - `format_amount` `{units}` → `"1.5"`; `parse_amount` `{text}` → units string
/// - `fixture_prove_request` `{profile?}` → a valid `prove_transfer` request for smoke tests
pub fn dispatch(method: &str, params: &Value) -> Result<Value> {
    let ser = |v: &dyn erased::Ser| v.to_value();
    match method {
        "version" => Ok(constants()),
        "keygen" => Ok(ser(&wallet_info(&Wallet::generate()))),
        "wallet_info" => Ok(ser(&wallet_info(&Wallet::from_hex(str_param(params, "spend_key")?)?))),
        "import_key" => {
            let sk = spend_key_from_input(str_param(params, "input")?)?;
            Ok(ser(&wallet_info(&Wallet::from_hex(&sk)?)))
        }
        "parse_address" => Ok(ser(&parse_address(str_param(params, "address")?))),
        "scan_page" => {
            let w = Wallet::from_hex(str_param(params, "spend_key")?)?;
            let rows: Vec<CommitmentRow> =
                serde_json::from_value(params.get("rows").cloned().unwrap_or(Value::Array(vec![]))).map_err(|e| format!("rows: {e}"))?;
            Ok(ser(&scan_page(&w, &rows)?))
        }
        "rebuilt_deposit" => {
            let w = Wallet::from_hex(str_param(params, "spend_key")?)?;
            let action = params.get("action").cloned().unwrap_or(Value::Null);
            Ok(rebuilt_deposit(&w, &action).map(|n| serde_json::to_value(n).unwrap()).unwrap_or(Value::Null))
        }
        "pending_cleared" => {
            let note: OwnedNote = serde_json::from_value(params.get("note").cloned().unwrap_or(Value::Null)).map_err(|e| format!("note: {e}"))?;
            Ok(Value::Bool(pending_cleared(&note, u64_param(params, "read_through")?)))
        }
        "select_inputs" => {
            let notes: Vec<OwnedNote> =
                serde_json::from_value(params.get("notes").cloned().unwrap_or(Value::Array(vec![]))).map_err(|e| format!("notes: {e}"))?;
            let asset = params.get("asset").and_then(Value::as_u64).unwrap_or(0) as u32;
            Ok(ser(&select_inputs(&notes, asset, u64_param(params, "need")?)?))
        }
        "plan_transfer" => {
            let notes: Vec<OwnedNote> =
                serde_json::from_value(params.get("notes").cloned().unwrap_or(Value::Array(vec![]))).map_err(|e| format!("notes: {e}"))?;
            let asset = params.get("asset").and_then(Value::as_u64).unwrap_or(0) as u32;
            let amount = u64_param(params, "amount")?;
            let fee = u64_param(params, "fee")?;
            Ok(ser(&plan_transfer(&notes, asset, amount, fee)?))
        }
        "max_sendable" => {
            let notes: Vec<OwnedNote> =
                serde_json::from_value(params.get("notes").cloned().unwrap_or(Value::Array(vec![]))).map_err(|e| format!("notes: {e}"))?;
            let asset = params.get("asset").and_then(Value::as_u64).unwrap_or(0) as u32;
            let fee = u64_param(params, "fee")?;
            Ok(ser(&max_sendable(&notes, asset, fee)?))
        }
        "prove_transfer" => {
            let req: ProveRequest = serde_json::from_value(params.clone()).map_err(|e| format!("request: {e}"))?;
            Ok(ser(&prove_transfer(&req)?))
        }
        "open_with_tx_key" => {
            let env: EnvelopeHex = serde_json::from_value(params.get("envelope").cloned().unwrap_or(Value::Null)).map_err(|e| format!("envelope: {e}"))?;
            Ok(open_with_tx_key(str_param(params, "cm")?, &env, str_param(params, "tx_key")?)?.unwrap_or(Value::Null))
        }
        "fixture_prove_request" => Ok(fixture_prove_request(params.get("profile").and_then(Value::as_str).unwrap_or("test"))?),
        "format_amount" => Ok(Value::String(format_amount(u64_param(params, "units")?))),
        "parse_amount" => Ok(Value::String(parse_amount(str_param(params, "text")?).map_err(|e| e.to_string())?.to_string())),
        other => bad(format!("unknown method {other:?}")),
    }
}

/// The string form of [`dispatch`] the bindings expose: `params_json` is a JSON object; the
/// reply is always a JSON object, `{"ok":true,"value":…}` or `{"ok":false,"error":"…"}`. A
/// panic inside the prover is caught and reported the same way rather than unwinding into a
/// foreign runtime.
pub fn call(method: &str, params_json: &str) -> String {
    let params: Value = if params_json.trim().is_empty() {
        json!({})
    } else {
        match serde_json::from_str(params_json) {
            Ok(v) => v,
            Err(e) => return json!({ "ok": false, "error": format!("params is not JSON: {e}") }).to_string(),
        }
    };
    let outcome = std::panic::catch_unwind(|| dispatch(method, &params));
    let reply = match outcome {
        Ok(Ok(v)) => json!({ "ok": true, "value": v }),
        Ok(Err(e)) => json!({ "ok": false, "error": e }),
        Err(p) => {
            let msg = p
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "panic".into());
            json!({ "ok": false, "error": format!("internal error: {msg}") })
        }
    };
    reply.to_string()
}

mod erased {
    use serde_json::Value;
    pub trait Ser {
        fn to_value(&self) -> Value;
    }
    impl<T: serde::Serialize> Ser for T {
        fn to_value(&self) -> Value {
            serde_json::to_value(self).expect("serializable")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wallet(n: u32) -> Wallet {
        Wallet::from_spend_key(SpendKey([n; 8]))
    }

    /// A minimal `OwnedNote` for coin-selection tests: no real note bytes, commitment or
    /// nullifier, because `select_inputs`/`plan_transfer`/`max_sendable` never look at them.
    fn owned(index: u64, asset: u32, amount: u64) -> OwnedNote {
        OwnedNote {
            index,
            note: String::new(),
            cm: String::new(),
            nf: String::new(),
            amount: amount.to_string(),
            asset,
            time: 1,
            from: String::new(),
            height: 1,
            spent: false,
            pending: None,
        }
    }

    #[test]
    fn keys_and_addresses_roundtrip() {
        let w = wallet(7);
        let info = wallet_info(&w);
        assert_eq!(info.spend_key.len(), 64);
        assert_eq!(info.viewing_key.len(), 64);
        assert!(info.address.starts_with(ADDRESS_HRP));
        // `rand1` + base58(32-byte pk || 1184-byte ML-KEM encapsulation key). base58 of 1216
        // bytes is 1661 characters unless the leading bytes are small, so the length is pinned
        // per key rather than in general.
        assert_eq!(info.address.len(), 1666);
        assert!(parse_address(&info.address).valid);
        assert!(!parse_address("rand1nope").valid);
        assert_eq!(Wallet::from_hex(&info.spend_key).unwrap().address.to_string(), info.address);
        assert_eq!(spend_key_from_input(&info.key_file).unwrap(), info.spend_key);
        assert_eq!(spend_key_from_input(&format!("0x{}", info.spend_key.to_uppercase())).unwrap(), info.spend_key);
        assert!(spend_key_from_input("zz").is_err());
        // The viewing key is what randscan derives from the same spend key.
        let nk = randprotocol_zkvm::notes::hash(randprotocol_zkvm::notes::domain::NK, &w.sk.0);
        assert_eq!(info.viewing_key, word8_to_hex(&nk));
    }

    fn sealed_row(sender: &Wallet, to: &Wallet, amount: u64, index: u64) -> (CommitmentRow, TxKey) {
        let note = Note::new(to.vk.pk(), sender.vk.pk(), amount, 0, 3);
        let key = TxKey::random();
        let env = seal_note(&sender.vk, &to.address, &note, &key).unwrap();
        let row = CommitmentRow {
            index,
            cm: word8_to_hex(&note.commitment()),
            height: 9,
            envelope: EnvelopeHex {
                kem_ct: hex::encode(&env.kem_ct),
                to_receiver: hex::encode(&env.to_receiver),
                to_sender: hex::encode(&env.to_sender),
                body: hex::encode(&env.body),
            },
        };
        (row, key)
    }

    #[test]
    fn scan_page_finds_received_and_sent_and_ignores_strangers() {
        let alice = wallet(1);
        let bob = wallet(2);
        let carol = wallet(3);
        let (r1, key1) = sealed_row(&alice, &bob, 1_500_000_000, 10);
        let (r2, _) = sealed_row(&carol, &alice, 7, 11);
        let (r3, _) = sealed_row(&carol, &bob, 9, 12);
        let rows = vec![r1, r2, r3];

        let bob_scan = scan_page(&bob, &rows).unwrap();
        assert_eq!(bob_scan.received.len(), 2);
        assert_eq!(bob_scan.sent.len(), 0);
        assert_eq!(bob_scan.received[0].amount, "1500000000");
        assert_eq!(bob_scan.received[0].index, 10);
        assert_eq!(bob_scan.received[0].from, word8_to_hex(&alice.vk.pk()));
        assert_eq!(bob_scan.next_index, 13);
        assert!(bob_scan.received.iter().all(|n| n.is_spendable()));

        let alice_scan = scan_page(&alice, &rows).unwrap();
        assert_eq!(alice_scan.received.len(), 1);
        assert_eq!(alice_scan.received[0].amount, "7");
        assert_eq!(alice_scan.sent.len(), 1);
        assert_eq!(alice_scan.sent[0].to_pk, word8_to_hex(&bob.vk.pk()));

        // The per-transaction key opens exactly that payment.
        let opened = open_with_tx_key(&rows[0].cm, &rows[0].envelope, &hex::encode(key1.0)).unwrap().unwrap();
        assert_eq!(opened["amount"], "1500000000");
        assert!(open_with_tx_key(&rows[1].cm, &rows[1].envelope, &hex::encode(key1.0)).unwrap().is_none());
    }

    #[test]
    fn selection_is_largest_first_and_at_most_two() {
        let w = wallet(4);
        let mk = |index: u64, amount: u64| {
            let note = Note::new(w.vk.pk(), w.vk.pk(), amount, 0, 1);
            owned_note(&w, index, 1, note.commitment(), note)
        };
        let notes = vec![mk(0, 5), mk(1, 50), mk(2, 20), mk(3, 0)];
        let s = select_inputs(&notes, 0, 60).unwrap();
        assert_eq!(s.chosen.iter().map(|n| n.index).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(s.change, "10");
        let s = select_inputs(&notes, 0, 40).unwrap();
        assert_eq!(s.chosen.len(), 1);
        assert!(select_inputs(&notes, 0, 72).unwrap_err().contains("consolidate"));
        assert!(select_inputs(&notes, 0, 100).unwrap_err().contains("insufficient"));
        let mut held = notes.clone();
        held[1].pending = Some(3);
        // With the 50 held back only 25 units remain: not enough at all, so the error is
        // "insufficient" rather than "consolidate".
        assert!(select_inputs(&held, 0, 60).unwrap_err().contains("insufficient"));
        assert_eq!(select_inputs(&held, 0, 25).unwrap().chosen.len(), 2);
        assert!(pending_cleared(&held[1], 3 + TIME_WINDOW + 1));
        assert!(!pending_cleared(&held[1], 3 + TIME_WINDOW));
    }

    #[test]
    fn plan_transfer_selects_inputs_and_computes_change() {
        let notes = vec![owned(0, 0, 5_000_000_000), owned(1, 0, 2_000_000_000)];
        let plan = plan_transfer(&notes, 0, 1_000_000_000, gas::BUNDLE_BASE).unwrap();
        // The largest note alone covers amount + fee, so only one input is chosen.
        assert_eq!(plan.inputs.iter().map(|n| n.index).collect::<Vec<_>>(), vec![0]);
        assert_eq!(plan.need, (1_000_000_000 + gas::BUNDLE_BASE).to_string());
        assert_eq!(plan.change, (5_000_000_000 - 1_000_000_000 - gas::BUNDLE_BASE).to_string());
        assert_eq!(plan.fee, gas::BUNDLE_BASE.to_string());
        assert_eq!(plan.proofs, 1);
    }

    #[test]
    fn plan_transfer_exact_amount_has_zero_change() {
        let fee = gas::BUNDLE_BASE;
        let amount = 2_000_000_000u64;
        let notes = vec![owned(0, 0, amount + fee)];
        let plan = plan_transfer(&notes, 0, amount, fee).unwrap();
        assert_eq!(plan.change, "0");
        assert_eq!(plan.inputs.len(), 1);
    }

    #[test]
    fn plan_transfer_refuses_rpl_assets_with_the_exact_sentence() {
        let notes = vec![owned(0, 1, 10)];
        let err = plan_transfer(&notes, 1, 5, gas::BUNDLE_BASE).unwrap_err();
        assert_eq!(err, RPL_TRANSFER_UNAVAILABLE);
        assert_eq!(err, "RPL transfers are not available on this network.");
    }

    #[test]
    fn plan_transfer_refuses_zero_amount() {
        let err = plan_transfer(&[], 0, 0, gas::BUNDLE_BASE).unwrap_err();
        assert_eq!(err, "amount must be greater than zero");
    }

    #[test]
    fn plan_transfer_refuses_fee_below_the_bundle_floor() {
        let err = plan_transfer(&[], 0, 1, gas::BUNDLE_BASE - 1).unwrap_err();
        assert!(err.contains("RAND"), "{err}");
        assert!(err.contains("0.001"), "{err}");
    }

    #[test]
    fn plan_transfer_amount_plus_fee_overflow_is_an_error_not_a_panic() {
        let err = plan_transfer(&[], 0, u64::MAX, gas::BUNDLE_BASE).unwrap_err();
        assert!(err.contains("overflow"), "{err}");
    }

    #[test]
    fn plan_transfer_insufficient_balance_still_says_rand() {
        let notes = vec![owned(0, 0, 100)];
        let err = plan_transfer(&notes, 0, 1_000_000_000, gas::BUNDLE_BASE).unwrap_err();
        assert!(err.contains("insufficient"), "{err}");
        assert!(err.contains("RAND"), "{err}");
    }

    #[test]
    fn plan_transfer_three_notes_whose_two_largest_do_not_cover_says_consolidate() {
        let notes = vec![owned(0, 0, 1_000_000_000), owned(1, 0, 1_000_000_000), owned(2, 0, 1_000_000_000)];
        // Total (3 RAND) covers amount + fee, but the two largest (2 RAND) alone do not.
        let err = plan_transfer(&notes, 0, 2_000_000_000, gas::BUNDLE_BASE).unwrap_err();
        assert!(err.contains("consolidate"), "{err}");
    }

    #[test]
    fn max_sendable_with_two_notes() {
        let notes = vec![owned(0, 0, 5_000_000_000), owned(1, 0, 3_000_000_000)];
        let r = max_sendable(&notes, 0, gas::BUNDLE_BASE).unwrap();
        assert_eq!(r.amount, (8_000_000_000u64 - gas::BUNDLE_BASE).to_string());
        assert_eq!(r.fee, gas::BUNDLE_BASE.to_string());
        assert_eq!(r.inputs, 2);
    }

    #[test]
    fn max_sendable_with_one_note() {
        let notes = vec![owned(0, 0, 5_000_000_000)];
        let r = max_sendable(&notes, 0, gas::BUNDLE_BASE).unwrap();
        assert_eq!(r.amount, (5_000_000_000u64 - gas::BUNDLE_BASE).to_string());
        assert_eq!(r.inputs, 1);
    }

    #[test]
    fn max_sendable_with_five_notes_uses_the_two_largest() {
        let notes: Vec<OwnedNote> = (0..5).map(|i| owned(i, 0, (i + 1) * 1_000_000_000)).collect();
        // Amounts 1..5 RAND; the two largest are 4 and 5 RAND.
        let r = max_sendable(&notes, 0, gas::BUNDLE_BASE).unwrap();
        assert_eq!(r.amount, (9_000_000_000u64 - gas::BUNDLE_BASE).to_string());
        assert_eq!(r.inputs, 2);
    }

    #[test]
    fn max_sendable_ignores_spent_and_pending_notes() {
        let mut notes = vec![owned(0, 0, 5_000_000_000), owned(1, 0, 4_000_000_000), owned(2, 0, 3_000_000_000)];
        notes[0].spent = true;
        notes[1].pending = Some(3);
        let r = max_sendable(&notes, 0, gas::BUNDLE_BASE).unwrap();
        // Only the 3 RAND note is still spendable.
        assert_eq!(r.amount, (3_000_000_000u64 - gas::BUNDLE_BASE).to_string());
        assert_eq!(r.inputs, 1);
    }

    #[test]
    fn max_sendable_below_the_fee_floors_at_zero_not_an_error() {
        let notes = vec![owned(0, 0, 100)];
        let r = max_sendable(&notes, 0, gas::BUNDLE_BASE).unwrap();
        assert_eq!(r.amount, "0");
    }

    #[test]
    fn max_sendable_refuses_rpl_assets() {
        let err = max_sendable(&[], 1, gas::BUNDLE_BASE).unwrap_err();
        assert_eq!(err, RPL_TRANSFER_UNAVAILABLE);
    }

    #[test]
    fn version_reports_bundle_and_rpl_constants() {
        let v = constants();
        assert_eq!(v["bundle_inputs"], 2);
        assert!(v["bundle_inputs"].is_number());
        assert_eq!(v["bundle_base_fee"], gas::BUNDLE_BASE.to_string());
        assert!(v["bundle_base_fee"].is_string());
        assert_eq!(v["rpl_transfer"], false);
        assert!(v["rpl_transfer"].is_boolean());
        assert_eq!(v["bridge_burn"], false);
        assert!(v["bridge_burn"].is_boolean());
    }

    /// This is what upstream's `BUNDLE_BASE` actually is today (`core/vendor/fullnode/crates/
    /// randprotocol-core/src/gas.rs`); a change here means upstream moved the floor.
    #[test]
    fn bundle_base_fee_is_the_documented_value() {
        assert_eq!(gas::BUNDLE_BASE, 1_000_000);
    }

    #[test]
    fn dispatch_plan_transfer_and_max_sendable_round_trip_json() {
        let notes = json!([{
            "index": 0, "note": "", "cm": "", "nf": "", "amount": "5000000000", "asset": 0,
            "time": 1, "from": "", "height": 1, "spent": false, "pending": null,
        }]);
        let params = json!({ "notes": notes, "amount": "1000000000", "fee": gas::BUNDLE_BASE.to_string() });
        let v: Value = serde_json::from_str(&call("plan_transfer", &params.to_string())).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["value"]["proofs"], 1);
        assert_eq!(v["value"]["need"], (1_000_000_000u64 + gas::BUNDLE_BASE).to_string());
        assert_eq!(v["value"]["change"], (4_000_000_000u64 - gas::BUNDLE_BASE).to_string());

        let params = json!({ "notes": notes, "fee": gas::BUNDLE_BASE.to_string() });
        let v: Value = serde_json::from_str(&call("max_sendable", &params.to_string())).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["value"]["inputs"], 1);
        assert_eq!(v["value"]["amount"], (5_000_000_000u64 - gas::BUNDLE_BASE).to_string());

        let rpl_params = json!({ "notes": notes, "asset": 1, "amount": "1", "fee": gas::BUNDLE_BASE.to_string() });
        let v: Value = serde_json::from_str(&call("plan_transfer", &rpl_params.to_string())).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], "RPL transfers are not available on this network.");

        for bad_amount in ["1.5", "-1", "abc"] {
            let params = json!({ "notes": notes, "amount": bad_amount, "fee": gas::BUNDLE_BASE.to_string() });
            let v: Value = serde_json::from_str(&call("plan_transfer", &params.to_string())).unwrap();
            assert_eq!(v["ok"], false, "amount {bad_amount:?} should have been refused");
            assert!(v["error"].as_str().unwrap().contains("decimal integer"), "{v}");
        }
    }

    #[test]
    fn version_reports_rand_and_wire_names() {
        let v = constants();
        assert_eq!(v["token_symbol"], "RAND");
        assert_eq!(v["rpc_namespace"], RPC_NAMESPACE);
        assert_eq!(v["address_hrp"], ADDRESS_HRP);
        assert_eq!(RPC_NAMESPACE, "rand");
        assert_eq!(ADDRESS_HRP, "rand1");
        // The wire names come from upstream, not from a second literal here.
        assert_eq!(ADDRESS_HRP, randprotocol_core::notes::ADDRESS_PREFIX);
        assert_eq!(v["default_chain_id"], 13);
        assert!(v.get("units_per_rand").is_some());
    }

    #[test]
    fn user_facing_errors_say_rand() {
        let err = select_inputs(&[], 0, 1).unwrap_err().to_string();
        assert!(err.contains("RAND"), "{err}");
    }

    #[test]
    fn json_entry_point_reports_errors_as_json() {
        let v: Value = serde_json::from_str(&call("version", "{}")).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["value"]["default_chain_id"], 13);
        assert_eq!(v["value"]["bundle_base_fee"], "1000000");
        let v: Value = serde_json::from_str(&call("wallet_info", r#"{"spend_key":"zz"}"#)).unwrap();
        assert_eq!(v["ok"], false);
        let v: Value = serde_json::from_str(&call("nope", "")).unwrap();
        assert!(v["error"].as_str().unwrap().contains("unknown method"));
        let v: Value = serde_json::from_str(&call("format_amount", r#"{"units":"1500000000"}"#)).unwrap();
        assert_eq!(v["value"], "1.5");
        let v: Value = serde_json::from_str(&call("parse_amount", r#"{"text":"0.25"}"#)).unwrap();
        assert_eq!(v["value"], "250000000");
    }

    /// The whole send path against a real tree, under the fast FRI profile: a proved transfer
    /// whose bundle the chain's own ledger rules accept (digest, nullifiers, commitments).
    #[test]
    fn prove_transfer_produces_an_admissible_bundle() {
        use randprotocol_core::notes::FullTree;
        let alice = wallet(11);
        let bob = wallet(12);
        let exec = randprotocol_zkvm::executor::ZkExecutor::new(FriProfile::Test);
        let note = Note::new(alice.vk.pk(), [0; 8], 3_000_000_000, 0, 1);
        let leaves = vec![Note::new([1; 8], [0; 8], 1, 0, 1).commitment(), note.commitment()];
        let tree = FullTree::new(leaves, &exec);
        let root = tree.root();
        let path = tree.path(1).unwrap();
        let owned = owned_note(&alice, 1, 1, note.commitment(), note);
        let req = ProveRequest {
            spend_key: alice.spend_key_hex(),
            chain_id: DEFAULT_CHAIN_ID,
            to: bob.address.to_string(),
            amount: "1000000000".into(),
            fee: gas::BUNDLE_BASE.to_string(),
            anchor_height: 40,
            anchor_root: word8_to_hex(&root),
            inputs: vec![ProveInput { note: owned, path: path.iter().map(word8_to_hex).collect() }],
            profile: "test".into(),
        };
        let res = prove_transfer(&req).unwrap();
        assert_eq!(res.change, (3_000_000_000u64 - 1_000_000_000 - gas::BUNDLE_BASE).to_string());
        assert_eq!(res.spent_indices, vec![1]);
        let tx = Transaction::decode(&hex::decode(&res.tx_hex).unwrap()).unwrap();
        assert_eq!(tx.hash().to_hex(), res.hash);
        let bundle = tx.bundle.as_ref().unwrap();
        assert_eq!(bundle.anchor, root);
        assert_eq!(bundle.time, 40);
        // Bob's wallet opens the payment envelope; Alice's opens the change.
        let rows: Vec<CommitmentRow> = (0..2)
            .map(|i| CommitmentRow {
                index: 100 + i as u64,
                cm: word8_to_hex(&bundle.commitments[i]),
                height: 41,
                envelope: EnvelopeHex {
                    kem_ct: hex::encode(&bundle.envelopes[i].kem_ct),
                    to_receiver: hex::encode(&bundle.envelopes[i].to_receiver),
                    to_sender: hex::encode(&bundle.envelopes[i].to_sender),
                    body: hex::encode(&bundle.envelopes[i].body),
                },
            })
            .collect();
        let bob_scan = scan_page(&bob, &rows).unwrap();
        assert_eq!(bob_scan.received.len(), 1);
        assert_eq!(bob_scan.received[0].amount, "1000000000");
        let alice_scan = scan_page(&alice, &rows).unwrap();
        assert_eq!(alice_scan.received.len(), 1);
        assert_eq!(alice_scan.received[0].amount, res.change);
        assert_eq!(alice_scan.sent.len(), 1);
        // Exactly the ledger's two checks: the digest the proof published is the one recomputed
        // from the bundle's plaintext, and the proof verifies against the pinned bundle guest.
        use randprotocol_core::confidential::ConfidentialExecutor;
        let recomputed = exec.bundle_digest(&bundle.digest_input());
        assert_eq!(exec.bundle_proof_digest(&bundle.proof).unwrap(), recomputed);
        exec.verify_bundle(&randprotocol_zkvm::executor::ZkExecutor::hc_bundle(), &bundle.proof).unwrap();
        assert!(open_with_tx_key(&rows[0].cm, &rows[0].envelope, &res.tx_keys[0]).unwrap().is_some());
    }
}
