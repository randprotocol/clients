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
//! word; amounts of value are decimal strings of units (1 RAND = 10^9 units), never a JSON number
//! (see [`dispatch`]'s `amount_param`); heights, leaf indices and counts are plain JSON numbers
//! (see `index_param`); addresses are `rand1` + base58.

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

/// Asset 0 is RAND, the chain's own token: nothing ever deposited it across the bridge, so the
/// registry does not hold it and there is no source chain to release it on. Upstream's own
/// refusal, verbatim (`randprotocol_client::wallet::submit_burn`, the first thing it checks), so
/// this wallet and the `rand` CLI say the same sentence.
pub const RAND_NOT_BRIDGED: &str = "asset 0 is RAND, which is not a bridged asset and cannot be burned";

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

/// Sum note amounts with an overflow check: two adversarial-looking `u64` amounts must never wrap
/// silently into a smaller, plausible-looking total. Every running total this crate builds from
/// note amounts goes through this (or an inline `checked_add` for a total that must bail out of a
/// loop early rather than finish the fold).
fn checked_sum<I: IntoIterator<Item = u64>>(units: I) -> Result<u64> {
    units.into_iter().try_fold(0u64, |acc, u| acc.checked_add(u)).ok_or_else(|| "amounts overflow".to_string())
}

/// Spendable notes of `asset`, largest first; ties keep their original relative order (the sort is
/// stable). The one place "which notes could this bundle spend" is decided, so `select_inputs`
/// (any asset), `plan_transfer` and `max_sendable` (always asset 0 — both refuse a non-zero asset
/// before ever reaching here) cannot drift apart on the rule.
fn spendable_of(notes: &[OwnedNote], asset: u32) -> Vec<&OwnedNote> {
    let mut v: Vec<&OwnedNote> = notes.iter().filter(|n| n.is_spendable() && n.asset == asset).collect();
    v.sort_by_key(|n| std::cmp::Reverse(n.units()));
    v
}

/// Largest-first, at most two notes of one asset (a bundle spends exactly two inputs). Mirrors
/// `randprotocol_client::wallet::select_inputs`, including its two errors.
pub fn select_inputs(notes: &[OwnedNote], asset: u32, need: u64) -> Result<Selection> {
    let sorted = spendable_of(notes, asset);
    let have = checked_sum(sorted.iter().map(|n| n.units()))?;
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
        sum = sum.checked_add(n.units()).ok_or_else(|| "amounts overflow".to_string())?;
        chosen.push((*n).clone());
    }
    if sum < need {
        return bad(format!(
            "need more than two notes; the largest two hold {} RAND — consolidate first by sending to your own address",
            format_amount(sum)
        ));
    }
    // Guarded already by `sum >= need` above (so this never actually fails) — checked anyway,
    // defence in depth for money arithmetic.
    let change = sum.checked_sub(need).ok_or_else(|| "amounts overflow".to_string())?;
    Ok(Selection { chosen, need: need.to_string(), change: change.to_string() })
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
    let candidates: Vec<&OwnedNote> = spendable_of(notes, 0).into_iter().take(BUNDLE_INPUTS).collect();
    let sum = checked_sum(candidates.iter().map(|n| n.units()))?;
    Ok(MaxSendable { amount: sum.saturating_sub(fee).to_string(), fee: fee.to_string(), inputs: candidates.len() })
}

// ------------------------------------------------------------------ planning a bridge burn

/// What a client needs to build one bridge withdrawal. A `BridgeBurn` is the chain's one
/// two-bundle transaction (spec §10), so this plans *two* selections against the same note list:
/// the notes of the bridged asset the burn destroys, and the RAND notes that pay the network fee.
///
/// Mirrors the two `Plan::select` calls of `randprotocol_client::wallet::submit_burn`
/// (`core/vendor/fullnode/crates/randprotocol-client/src/wallet.rs`):
/// `Plan::select(store, asset, &w.address, 0, 0, amount)` for the asset bundle — which pays no
/// fee and burns the whole amount, so its notes must cover exactly `amount` — and
/// `Plan::select(store, 0, &w.address, 0, fee, 0)` for the RAND bundle, which burns nothing and
/// must cover exactly `fee`. The two selections can never collide, since they hold different
/// assets.
///
/// `proofs` is 2 and not a constant a client hard-codes: a burn proves both bundles.
#[derive(Serialize, Debug)]
pub struct BurnPlan {
    /// The notes of `asset` the burn spends; `sum(inputs) - amount` comes back as `change`.
    pub inputs: Vec<OwnedNote>,
    /// The RAND notes the fee bundle spends; `sum(fee_inputs) - fee` comes back as `fee_change`.
    pub fee_inputs: Vec<OwnedNote>,
    /// Change in units of `asset`, back to this wallet.
    pub change: String,
    /// Change in RAND units, back to this wallet.
    pub fee_change: String,
    pub fee: String,
    pub proofs: u8,
}

/// Plan a burn of `amount` units of the bridged asset `asset`, paying `fee` in RAND.
///
/// The refusals are `submit_burn`'s own, in its order: RAND is not a bridged asset, and a burn of
/// zero moves nothing. The fee floor is this crate's (see [`plan_transfer`], which does the same
/// for `gas::BUNDLE_BASE`): a burn under [`gas::BRIDGE_BURN_FEE`] is refused by the ledger
/// outright (`TxError::FeeTooLow`), and finding that out costs two bundle proofs.
///
/// `relayer_fee` is not planned here: it is a *portion* of `amount` carved out on the far side,
/// so it changes nothing this wallet has to select notes for. [`prove_burn`] holds it to
/// `relayer_fee <= amount`, as `submit_burn` does.
pub fn plan_burn(notes: &[OwnedNote], asset: u32, amount: u64, fee: u64) -> Result<BurnPlan> {
    if asset == 0 {
        return bad(RAND_NOT_BRIDGED);
    }
    if amount == 0 {
        return bad("a burn of zero moves nothing");
    }
    if fee < gas::BRIDGE_BURN_FEE {
        return bad(format!(
            "fee must be at least {} RAND (a burn pays for both of its bundles)",
            format_amount(gas::BRIDGE_BURN_FEE)
        ));
    }
    // The asset bundle first, so both selections see the same note list; they can never collide,
    // since they hold different assets. `need` is `amount` for one and `fee` for the other because
    // the guest's balance equation is `in = out + fee + burn` and each bundle has exactly one of
    // those three terms: the asset bundle burns `amount` and pays no fee, the RAND bundle pays
    // `fee` and burns nothing, and neither pays anybody inside the pool.
    let assets =
        select_inputs(notes, asset, amount).map_err(|e| format!("{e} (selecting notes of asset {asset} to burn)"))?;
    let rand = select_inputs(notes, 0, fee).map_err(|e| format!("{e} (selecting RAND notes for the fee bundle)"))?;
    Ok(BurnPlan {
        inputs: assets.chosen,
        fee_inputs: rand.chosen,
        change: assets.change,
        fee_change: rand.change,
        fee: fee.to_string(),
        proofs: 2,
    })
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

/// `ProveRequest.amount`/`.fee` are typed `String` (so a JSON number is already refused at
/// deserialization, before this runs) — this enforces the same `^[0-9]{1,20}$` shape
/// [`amount_param`] does, for one rule across both amount-parsing paths in the crate.
fn parse_units(s: &str, what: &str) -> Result<u64> {
    if !is_decimal_digits(s) {
        return bad(format!("{what} must be a decimal string of units"));
    }
    s.parse::<u64>().map_err(|_| format!("{what} is out of range"))
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

/// One input slot of a bundle as the prover takes it: the note's plaintext, the witness path for
/// its leaf (32 sibling levels, leaf first) and its leaf index. A bundle has exactly
/// [`BUNDLE_INPUTS`] of these, the second a dummy when the wallet needs only one real note.
type Slot = (Note, [Word8; DEPTH], u32);

/// One bundle of a transaction, built but not yet proved: the guest's private-input words, the
/// digest the proof must publish, and the `Bundle` itself with an empty `proof`.
///
/// The split exists so a burn's two-bundle *shape* — which bundle carries the fee, which carries
/// the burn and the asset — is testable without paying for two STARK proofs, and so that a
/// transfer and a burn build their bundles through exactly one piece of code.
struct BundleBuild {
    words: Vec<u32>,
    expected: [u32; randprotocol_zkvm::isa::NUM_OUTPUTS],
    bundle: Bundle,
    /// The per-transaction keys of this bundle's two envelopes, in output order.
    tx_keys: [TxKey; 2],
    change: u64,
}

impl BundleBuild {
    /// Prove this bundle and fill in its `proof`, returning the tier. The slow call — a tier-14
    /// bundle proof peaks at [`PROVER_PEAK_MEMORY_BYTES`], so two of them are proved one after
    /// the other and never at once.
    fn prove(&mut self, profile: FriProfile) -> Result<u8> {
        let (proof, digest, tier) =
            prove_bundle(profile, &self.words, Backend::Cpu).map_err(|e| format!("proving failed: {e}"))?;
        // The guest taints its digest instead of failing when a witness violates the relation, so
        // a proof that does not publish the digest this wallet computed from its own plaintext is
        // a bug here, not something the node could explain.
        if digest != self.expected {
            return bad("the proof published a digest this wallet did not build; refusing to submit (wallet bug)");
        }
        self.bundle.proof = proof;
        Ok(tier)
    }
}

/// Build one bundle from the notes it spends, mirroring `randprotocol_client::wallet::prove_one`
/// up to (but not including) the prover: pad the inputs to two with a dummy, build the two
/// outputs, compute the guest words and the expected digest, seal the two envelopes.
///
/// `amount` is what output 1 pays `dest`; `fee` and `burn` are the bundle's own words and `asset`
/// the one asset every note in it carries. The guest's balance equation is
/// `in = amount + fee + burn + change`, so `change` is derived here and nowhere else.
///
/// A burn's asset bundle pays nobody inside the pool: it passes `dest = &w.address, amount = 0`,
/// exactly as `Plan::select(store, asset, &w.address, 0, 0, amount)` does upstream. The
/// zero-value first output is still a real note with a fresh `r` and a sealed envelope — the
/// bundle shape is fixed at two outputs, and a slot that looked different when nothing was paid
/// would leak that fact.
#[allow(clippy::too_many_arguments)]
fn build_bundle(
    w: &Wallet,
    chosen: &[Slot],
    dest: &ShieldedAddress,
    amount: u64,
    fee: u64,
    burn: u64,
    asset: u32,
    root: Word8,
    time: u32,
) -> Result<BundleBuild> {
    if chosen.is_empty() || chosen.len() > BUNDLE_INPUTS {
        return bad("a bundle spends one or two notes");
    }
    let pk_self = w.vk.pk();
    // `bundle_need`, upstream: what the chosen notes had to cover.
    let need = amount
        .checked_add(fee)
        .and_then(|n| n.checked_add(burn))
        .ok_or("amount + fee + burn overflows")?;
    let in_sum = checked_sum(chosen.iter().map(|(n, _, _)| n.amount))?;
    let change = in_sum.checked_sub(need).ok_or("the chosen notes do not cover amount + fee + burn")?;

    // A dummy input: a zero-value note owned by this wallet, carrying this bundle's own asset,
    // with an all-zero path at index 0. The guest skips MERKLE_VERIFY (and the asset check) for a
    // zero-amount slot; `Note::new` gives it a fresh `r`, without which two dummies would share a
    // commitment and a nullifier.
    let mut slots: Vec<Slot> = chosen.to_vec();
    while slots.len() < BUNDLE_INPUTS {
        slots.push((Note::new(pk_self, [0; 8], 0, asset, time), [[0u32; 8]; DEPTH], 0));
    }
    let inputs: [Slot; 2] = [slots[0], slots[1]];

    // Both outputs carry the bundle's own asset — the guest binds them to it structurally, so no
    // other value could produce a matching digest.
    let out1 = Note::new(dest.pk, pk_self, amount, asset, time);
    let out2 = Note::new(pk_self, pk_self, change, asset, time);
    let outputs = [out1, out2];

    let words = bundle_inputs(&w.sk, &inputs, &outputs, root, fee, burn, asset, time);
    let expected = expected_bundle_outputs(&w.sk, &inputs, &outputs, root, fee, burn, asset, time);

    // One fresh transaction key per envelope: two envelopes sealed under one key would both open
    // under a single-transaction disclosure.
    let key1 = TxKey::random();
    let key2 = TxKey::random();
    let envelopes = [
        seal_note(&w.vk, dest, &out1, &key1).map_err(|e| format!("sealing the payment envelope: {e}"))?,
        seal_note(&w.vk, &w.address, &out2, &key2).map_err(|e| format!("sealing the change envelope: {e}"))?,
    ];
    let bundle = Bundle {
        anchor: root,
        nullifiers: [w.vk.nullifier(&inputs[0].0.commitment()), w.vk.nullifier(&inputs[1].0.commitment())],
        commitments: [out1.commitment(), out2.commitment()],
        fee,
        burn,
        asset,
        time,
        envelopes,
        proof: Vec::new(),
    };
    Ok(BundleBuild { words, expected, bundle, tx_keys: [key1, key2], change })
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
    let mut slots: Vec<Slot> = Vec::with_capacity(2);
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
    // One bundle: it pays `amount` to `dest`, pays `fee`, burns nothing and moves asset 0.
    let mut built = build_bundle(&w, &slots, &dest, amount, fee, 0, 0, root, time)?;
    let tier = built.prove(profile)?;

    let nullifiers = built.bundle.nullifiers;
    let commitments = built.bundle.commitments;
    let proof_bytes = built.bundle.proof.len();
    let change = built.change;
    let tx_keys = [hex::encode(built.tx_keys[0].0), hex::encode(built.tx_keys[1].0)];
    let tx = Transaction::shielded(req.chain_id, built.bundle, Action::None);
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
        tx_keys,
        spent_indices,
    })
}

// ------------------------------------------------------------------ proving a bridge burn

/// What [`prove_burn`] takes. Mirrors [`ProveRequest`] field for field wherever the two-bundle
/// structure allows; the differences are, in full:
///
/// - no `to` shielded address — a burn pays nobody inside the pool. The destination lives in
///   `to_chain`/`to`, which are the *far* chain's, not this one's;
/// - `to` is 64 hex characters of **plain bytes** (`Action::BridgeBurn.to` is `[u8; 32]`), not a
///   `Word8` — do not read it with `word8_from_hex`, which is little-endian word by word and
///   would scramble a left-padded EVM address. Upstream parses the same string with
///   `randprotocol_client::hex32`, which is `hex::decode` into `[u8; 32]`, and this matches it;
/// - `asset`, `amount` and `relayer_fee` are the burn's own, all in units of `asset`;
/// - `inputs` are notes of `asset` (the bundle that burns) and `fee_inputs` are RAND notes (the
///   bundle that pays), one or two of each; both are witnessed against the same `anchor_root`.
#[derive(Deserialize)]
pub struct BurnRequest {
    pub spend_key: String,
    pub chain_id: u64,
    /// The bridge registry index of the asset being burned. Never 0: see [`RAND_NOT_BRIDGED`].
    pub asset: u32,
    /// Units of `asset`, decimal string. The asset bundle burns exactly this.
    pub amount: String,
    /// Units of `asset`, decimal string: the portion of `amount` the relayer keeps on the far
    /// side. A portion, never an addition — the release contract pays out `amount` in total, so
    /// burning `amount + relayer_fee` would strand the difference there forever.
    pub relayer_fee: String,
    /// The destination chain's bridge id (2, 3, 4 are the EVM/TVM chains).
    pub to_chain: u16,
    /// The 32-byte recipient on `to_chain`, 64 hex characters of plain bytes (an EVM address is
    /// its 20 bytes left-padded with 12 zeros).
    pub to: String,
    /// RAND units, decimal string. The floor is `gas::BRIDGE_BURN_FEE` — a burn pays for both of
    /// its bundles.
    pub fee: String,
    /// The head anchor: `rand_getAnchor` with no height. One anchor for both bundles.
    pub anchor_height: u64,
    pub anchor_root: String,
    /// One or two notes of `asset`; the witness roots must equal `anchor_root`.
    pub inputs: Vec<ProveInput>,
    /// One or two RAND notes; the witness roots must equal `anchor_root`.
    pub fee_inputs: Vec<ProveInput>,
    /// `"production"` (chain 13) or `"test"`.
    #[serde(default = "default_profile")]
    pub profile: String,
}

/// What [`prove_burn`] returns. The four-wide arrays are the **asset bundle's two first, then the
/// fee bundle's two** — the order the two bundles are proved in, not the order they appear on the
/// wire (where the fee bundle is the transaction's own and the asset bundle rides in the action).
#[derive(Serialize)]
pub struct BurnResult {
    /// `bincode(Transaction)` as hex — the parameter of `rand_sendTransaction`.
    pub tx_hex: String,
    pub hash: String,
    pub time: u32,
    pub asset: u32,
    /// Units of `asset`.
    pub amount: String,
    pub relayer_fee: String,
    pub to_chain: u16,
    pub to: String,
    /// Change in units of `asset`, back to this wallet.
    pub change: String,
    /// The RAND fee the fee bundle paid.
    pub fee: String,
    /// Change in RAND units, back to this wallet.
    pub fee_change: String,
    /// The larger of the two bundles' tiers, as `submit_burn` reports it.
    pub tier: u8,
    /// Both proofs together, as `submit_burn` reports it.
    pub proof_bytes: usize,
    pub tx_bytes: usize,
    pub nullifiers: [String; 4],
    pub commitments: [String; 4],
    pub tx_keys: [String; 4],
    /// Leaf indices of every note this transaction spends — the asset bundle's, then the fee
    /// bundle's — for the client to mark `pending`.
    pub spent_indices: Vec<u64>,
    pub proofs: u8,
}

/// `Action::BridgeBurn.to`: 32 bytes of plain hex, exactly as `randprotocol_client::hex32` reads
/// the same string off the `rand bridge-burn --to` flag.
fn parse_to(s: &str) -> Result<[u8; 32]> {
    let s = s.trim();
    let bytes = hex::decode(s.strip_prefix("0x").unwrap_or(s)).map_err(|_| "to is not hex".to_string())?;
    bytes.try_into().map_err(|v: Vec<u8>| format!("to must be 32 bytes (64 hex characters), got {}", v.len()))
}

/// The `(note, path, leaf index)` slots one of a burn's two bundles spends, with each note checked
/// to be this wallet's, of that bundle's asset, and worth something. Returns the slots, the leaf
/// indices and the total the notes hold.
fn burn_slots(
    w: &Wallet,
    inputs: &[ProveInput],
    asset: u32,
) -> Result<(Vec<Slot>, Vec<u64>, u64)> {
    let pk_self = w.vk.pk();
    let mut slots = Vec::with_capacity(BUNDLE_INPUTS);
    let mut spent = Vec::new();
    let mut sum = 0u64;
    for input in inputs {
        let note = input.note.plaintext()?;
        if note.pk != pk_self {
            return bad(format!("note at leaf {} is not owned by this wallet", input.note.index));
        }
        if note.asset != asset {
            return bad(format!(
                "note at leaf {} holds asset {}, but this bundle spends asset {asset}",
                input.note.index, note.asset
            ));
        }
        if note.amount == 0 {
            return bad(format!("note at leaf {} is worth nothing", input.note.index));
        }
        let index = u32::try_from(input.note.index).map_err(|_| "leaf index does not fit 32 bits")?;
        slots.push((note, parse_path(&input.path)?, index));
        spent.push(input.note.index);
        sum = sum.checked_add(note.amount).ok_or("input amounts overflow")?;
    }
    Ok((slots, spent, sum))
}

/// A burn's two bundles, built and sealed but not proved, with everything the action needs.
struct BurnBuild {
    /// The bundle that burns: `fee == 0`, `burn == amount`, `asset == <index>`. It rides inside
    /// `Action::BridgeBurn.asset_bundle`.
    asset_bundle: BundleBuild,
    /// The bundle that pays: `asset == 0`, `burn == 0`, `fee >= gas::BRIDGE_BURN_FEE`. It is the
    /// *transaction's* own bundle.
    fee_bundle: BundleBuild,
    amount: u64,
    relayer_fee: u64,
    fee: u64,
    to: [u8; 32],
    time: u32,
    spent_indices: Vec<u64>,
    profile: FriProfile,
}

/// Everything [`prove_burn`] does except the two proofs. Split out so the shape the ledger checks
/// is testable in milliseconds rather than minutes.
///
/// Mirrors `randprotocol_client::wallet::submit_burn` line for line: the three refusals before
/// anything is built, then the asset bundle (`dest = own address, amount 0, fee 0, burn = amount,
/// asset = index`) and the RAND fee bundle (`dest = own address, amount 0, fee = fee, burn 0,
/// asset 0`), both anchored at the same root.
///
/// Deliberately *not* restated here, because the bridge owns them and the chain is the only place
/// they can be checked: that the chain has a bridge at all, that `asset` is in its registry, that
/// `to_chain` is that asset's own chain and that `to` is shaped for it
/// (`BridgeState::check_burn`). `submit_burn` reads `rand_getBridgeState` for the first two before
/// proving; a client of this crate should do the same.
fn build_burn_unproven(req: &BurnRequest) -> Result<(Wallet, BurnBuild)> {
    let w = Wallet::from_hex(&req.spend_key)?;
    let amount = parse_units(&req.amount, "amount")?;
    let relayer_fee = parse_units(&req.relayer_fee, "relayer_fee")?;
    let fee = parse_units(&req.fee, "fee")?;
    let to = parse_to(&req.to)?;
    // `submit_burn`'s three, in its order and its words.
    if req.asset == 0 {
        return bad(RAND_NOT_BRIDGED);
    }
    if amount == 0 {
        return bad("a burn of zero moves nothing");
    }
    if relayer_fee > amount {
        return bad(format!("the relayer fee {relayer_fee} is more than the {amount} being burned"));
    }
    // This crate's own, matching `plan_burn` and `prove_transfer`: under the floor the ledger
    // refuses the transaction outright (`TxError::FeeTooLow`), after two proofs.
    if fee < gas::BRIDGE_BURN_FEE {
        return bad(format!("fee {} is below the bridge burn floor {}", fee, gas::BRIDGE_BURN_FEE));
    }
    let root = word8_from_hex(&req.anchor_root).ok_or("anchor_root is not 64 hex characters")?;
    let time = u32::try_from(req.anchor_height).map_err(|_| "anchor height does not fit a bundle's time field")?;
    let profile = profile_from_str(&req.profile)?;

    let (asset_slots, asset_spent, asset_held) = burn_slots(&w, &req.inputs, req.asset)?;
    let (fee_slots, fee_spent, fee_held) = burn_slots(&w, &req.fee_inputs, 0)?;
    if asset_held < amount {
        return bad(format!(
            "the notes of asset {} hold {asset_held} units, but the burn is {amount}",
            req.asset
        ));
    }
    if fee_held < fee {
        return bad(format!(
            "the RAND notes hold {} RAND, but the fee is {} RAND",
            format_amount(fee_held),
            format_amount(fee)
        ));
    }

    // The asset bundle first, so both are built off the same anchor; they can never collide, since
    // they hold different assets. Neither pays anybody inside the pool, so both send zero to this
    // wallet's own address — `Plan::select(store, asset, &w.address, 0, 0, amount)` and
    // `Plan::select(store, 0, &w.address, 0, fee, 0)` upstream.
    let asset_bundle = build_bundle(&w, &asset_slots, &w.address, 0, 0, amount, req.asset, root, time)?;
    let fee_bundle = build_bundle(&w, &fee_slots, &w.address, 0, fee, 0, 0, root, time)?;
    let spent_indices = asset_spent.into_iter().chain(fee_spent).collect();
    Ok((w, BurnBuild { asset_bundle, fee_bundle, amount, relayer_fee, fee, to, time, spent_indices, profile }))
}

/// Put a burn's two bundles on the wire. The one thing here that is easy to get backwards and
/// fatal to get backwards: the **RAND fee bundle is the transaction's own `bundle`** and the
/// **asset bundle rides inside `Action::BridgeBurn.asset_bundle`** — never the other way round.
/// `submit_burn` assembles it exactly so, and `Ledger::validate_inner` refuses any transaction
/// bundle with `asset != 0` (`TxError::UnsupportedAsset`), which is what the two swapped over
/// would be.
///
/// Separate from [`prove_burn`] so that assignment is testable without paying for two proofs.
fn burn_transaction(req: &BurnRequest, b: BurnBuild) -> Transaction {
    let action = Action::BridgeBurn {
        asset_bundle: b.asset_bundle.bundle,
        asset: req.asset,
        amount: b.amount,
        relayer_fee: b.relayer_fee,
        to_chain: req.to_chain,
        to: b.to,
    };
    Transaction::shielded(req.chain_id, b.fee_bundle.bundle, action)
}

/// Build, prove and encode a bridge withdrawal (`Action::BridgeBurn`) — the chain's one
/// two-bundle transaction (spec §10), and the only thing a note of a registry asset can do, since
/// the ledger admits no shielded transfer of an `asset != 0` bundle (see
/// [`RPL_TRANSFER_UNAVAILABLE`]).
///
/// **Twice the slow call**: both bundles are proved, one after the other and never at once — a
/// single bundle proof peaks at [`PROVER_PEAK_MEMORY_BYTES`], so two concurrent proofs would
/// double that and take a device that only just clears the requirement out. Nothing is submitted.
///
/// The wire assignment is the one thing here that is easy to get backwards and fatal to get
/// backwards: the **RAND fee bundle is the transaction's own `bundle`**, and the **asset bundle
/// rides inside `Action::BridgeBurn.asset_bundle`** (`submit_burn`, and `Ledger::validate_inner`,
/// which refuses any transaction bundle with `asset != 0`).
pub fn prove_burn(req: &BurnRequest) -> Result<BurnResult> {
    let (_w, mut b) = build_burn_unproven(req)?;
    // Sequentially. `prove_bundles` upstream is a plain `for` loop over the plans for the same
    // reason, and this workspace caps proving concurrency with a file-lock semaphore besides.
    let asset_tier = b.asset_bundle.prove(b.profile)?;
    let fee_tier = b.fee_bundle.prove(b.profile)?;

    let nf = [
        b.asset_bundle.bundle.nullifiers[0],
        b.asset_bundle.bundle.nullifiers[1],
        b.fee_bundle.bundle.nullifiers[0],
        b.fee_bundle.bundle.nullifiers[1],
    ];
    let cm = [
        b.asset_bundle.bundle.commitments[0],
        b.asset_bundle.bundle.commitments[1],
        b.fee_bundle.bundle.commitments[0],
        b.fee_bundle.bundle.commitments[1],
    ];
    let tx_keys = [
        hex::encode(b.asset_bundle.tx_keys[0].0),
        hex::encode(b.asset_bundle.tx_keys[1].0),
        hex::encode(b.fee_bundle.tx_keys[0].0),
        hex::encode(b.fee_bundle.tx_keys[1].0),
    ];
    let proof_bytes = b.asset_bundle.bundle.proof.len() + b.fee_bundle.bundle.proof.len();
    let (change, fee_change) = (b.asset_bundle.change, b.fee_bundle.change);
    let (time, fee, amount, relayer_fee, to) = (b.time, b.fee, b.amount, b.relayer_fee, b.to);
    let spent_indices = std::mem::take(&mut b.spent_indices);

    let tx = burn_transaction(req, b);
    let encoded = tx.encode();
    Ok(BurnResult {
        hash: tx.hash().to_hex(),
        tx_bytes: encoded.len(),
        tx_hex: hex::encode(encoded),
        time,
        asset: req.asset,
        amount: amount.to_string(),
        relayer_fee: relayer_fee.to_string(),
        to_chain: req.to_chain,
        to: hex::encode(to),
        change: change.to_string(),
        fee: fee.to_string(),
        fee_change: fee_change.to_string(),
        tier: asset_tier.max(fee_tier),
        proof_bytes,
        nullifiers: [word8_to_hex(&nf[0]), word8_to_hex(&nf[1]), word8_to_hex(&nf[2]), word8_to_hex(&nf[3])],
        commitments: [word8_to_hex(&cm[0]), word8_to_hex(&cm[1]), word8_to_hex(&cm[2]), word8_to_hex(&cm[3])],
        tx_keys,
        spent_indices,
        proofs: 2,
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

/// The fixture burn's bridged asset, destination chain and recipient. An EVM chain (2) and a
/// 20-byte address left-padded to 32, because that is the one recipient shape
/// `BridgeState::check_burn` screens for; the asset index is the first one a registry ever hands
/// out (`FIRST_ASSET_INDEX`).
const FIXTURE_BURN_ASSET: u32 = 1;
const FIXTURE_BURN_TO_CHAIN: u16 = 2;
const FIXTURE_BURN_AMOUNT: u64 = 400;
const FIXTURE_BURN_RELAYER_FEE: u64 = 100;

/// A complete, valid [`prove_burn`] request against a two-leaf tree built in memory: a fresh
/// wallet holding 500 units of the bridged asset at index 1 (leaf 0) and 3 RAND (leaf 1), burning
/// 400 of the asset to an EVM chain, 100 of which pays the relayer there, and paying
/// `BRIDGE_BURN_FEE` out of the RAND note.
///
/// Lets a client exercise the whole two-bundle path — and time two proofs on its own hardware —
/// without a node. Never used for a real burn: the anchor exists on no chain, and neither does
/// the asset.
///
/// The two leaves are laid out so a caller can rebuild the very tree they were witnessed against
/// from the request alone: leaf indices are 0 and 1 and both notes are in the request, so
/// appending `inputs` then `fee_inputs` in leaf-index order reproduces `anchor_root`. The
/// `prove_fixture` example relies on exactly that to put the proved transaction in front of
/// `Ledger::validate`.
pub fn fixture_burn_request(profile: &str) -> Result<Value> {
    use randprotocol_core::notes::FullTree;
    profile_from_str(profile)?;
    let sender = Wallet::generate();
    let exec = randprotocol_zkvm::executor::ZkExecutor::new(FriProfile::Test);
    let asset_note = Note::new(sender.vk.pk(), [0; 8], 500, FIXTURE_BURN_ASSET, 1);
    let rand_note = Note::new(sender.vk.pk(), [0; 8], 3 * UNITS_PER_RAND, 0, 1);
    let tree = FullTree::new(vec![asset_note.commitment(), rand_note.commitment()], &exec);
    let path = |i: u64| -> Result<Vec<String>> {
        Ok(tree.path(i).ok_or("fixture tree")?.iter().map(word8_to_hex).collect())
    };
    // A 20-byte EVM address left-padded with twelve zero bytes, as `check_burn` requires of
    // chains 2, 3 and 4.
    let mut to = [0u8; 32];
    to[12..].copy_from_slice(&[0x11u8; 20]);
    Ok(json!({
        "spend_key": sender.spend_key_hex(),
        "chain_id": DEFAULT_CHAIN_ID,
        "asset": FIXTURE_BURN_ASSET,
        "amount": FIXTURE_BURN_AMOUNT.to_string(),
        "relayer_fee": FIXTURE_BURN_RELAYER_FEE.to_string(),
        "to_chain": FIXTURE_BURN_TO_CHAIN,
        "to": hex::encode(to),
        "fee": gas::BRIDGE_BURN_FEE.to_string(),
        "anchor_height": 40,
        "anchor_root": word8_to_hex(&tree.root()),
        "inputs": [{ "note": owned_note(&sender, 0, 1, asset_note.commitment(), asset_note), "path": path(0)? }],
        "fee_inputs": [{ "note": owned_note(&sender, 1, 1, rand_note.commitment(), rand_note), "path": path(1)? }],
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
        // network (see RPL_TRANSFER_UNAVAILABLE). The one thing a note of one can do is be burned
        // back to its origin chain, which `plan_burn`/`prove_burn` build.
        "rpl_transfer": false,
        "bridge_burn": true,
        "bridge_burn_fee": gas::BRIDGE_BURN_FEE.to_string(),
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

// ---------------------------------------------------------------------------------------------
// The wire rule this crate follows for every numeric parameter and field, matching the fullnode's
// own chain-14 RPC convention: AMOUNTS of value (units of RAND, or any other asset) are decimal
// strings of digits, because a JavaScript `number` cannot carry a `u64` past 2^53 without silently
// losing precision and money must never round; HEIGHTS, leaf INDICES and COUNTS are ordinary JSON
// numbers, because they are small, plain and every language already has a natural integer type for
// them. `amount_param` and `index_param` are the two — and only two — ways this crate reads either
// kind out of a JSON params object; nothing else in `dispatch` should hand-roll a third.
// ---------------------------------------------------------------------------------------------

/// Whether `s` is exactly `^[0-9]{1,20}$` — ASCII digits only, no sign, no whitespace, no
/// fractional part, 1 to 20 characters (`u64::MAX` is 20 digits, so nothing shorter can ever
/// overflow and nothing this crate needs to parse is longer).
fn is_decimal_digits(s: &str) -> bool {
    !s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit())
}

/// AMOUNTS: a JSON string matching `^[0-9]{1,20}$`, parsed as `u64` (out of range is still an
/// error, since 20 digits alone does not guarantee the value fits). A JSON number is refused
/// outright, never coerced — a JavaScript caller that already lost precision past 2^53 must not be
/// able to hand that loss to us as a bare number silently rounded; requiring a string moves the
/// precision boundary out to `u64::MAX` where `parse` catches the rest. Used for every amount of
/// value this crate reads: `need`, `amount`, `fee`, `units` — never for a height, index or count
/// (see [`index_param`]).
fn amount_param(p: &Value, name: &str) -> Result<u64> {
    match p.get(name) {
        Some(Value::String(s)) => {
            if !is_decimal_digits(s) {
                return bad(format!("{name} must be a decimal string of ASCII digits"));
            }
            s.parse::<u64>().map_err(|_| format!("{name} is out of range"))
        }
        Some(_) => bad("amounts must be decimal strings"),
        None => bad(format!("missing parameter {name:?}")),
    }
}

/// The largest integer a JavaScript `number` can represent exactly (`Number.MAX_SAFE_INTEGER`,
/// 2^53 − 1). A JS caller cannot have produced anything larger as a JSON *number* without already
/// having lost precision, so [`index_param`] refuses a bare number above this rather than trust a
/// value that may not be the one the caller meant.
const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// HEIGHTS, leaf INDICES and COUNTS: a JSON number that is a non-negative integer no larger than
/// [`JS_MAX_SAFE_INTEGER`] (negative, fractional, or too large — `as_u64()` already rejects the
/// first two; the bound catches the third), or — for robustness, since a non-JavaScript caller
/// (Swift, Java, the desktop app's own Rust) may reasonably send an exact value beyond 2^53 and a
/// digit string carries it exactly either way — a JSON string of `^[0-9]{1,20}$` over the *full*
/// `u64` range (no 2^53 cap on the string form, since a string never lost precision to begin with).
/// Used for `read_through`, `asset`, and any other index/height/count parameter; never for money
/// (see [`amount_param`]).
fn index_param(p: &Value, name: &str) -> Result<u64> {
    match p.get(name) {
        Some(Value::Number(n)) => {
            let v = n.as_u64().ok_or_else(|| format!("{name} must be a non-negative integer"))?;
            if v > JS_MAX_SAFE_INTEGER {
                return bad(format!("{name} is above 2^53 - 1; send it as a decimal string instead"));
            }
            Ok(v)
        }
        Some(Value::String(s)) => {
            if !is_decimal_digits(s) {
                return bad(format!("{name} must be a non-negative integer or a decimal string of digits"));
            }
            s.parse::<u64>().map_err(|_| format!("{name} is out of range"))
        }
        Some(_) => bad(format!("{name} must be a non-negative integer")),
        None => bad(format!("missing parameter {name:?}")),
    }
}

/// `asset` is a COUNT (a small registry index, never money), always a JSON number here — every
/// asset index fits comfortably under [`JS_MAX_SAFE_INTEGER`] (u32::MAX is ~4.29e9, `2^53 - 1` is
/// ~9.007e15), so unlike [`index_param`] a digit-string form buys nothing and is refused, keeping
/// exactly one accepted shape. Absent means the default, asset 0; anything else that is not a
/// whole number fitting `u32` is refused outright — critically, an oversized `u64` is refused
/// rather than truncated: `as u32` on 2^32 silently wraps to 0 (i.e. RAND), which would have let a
/// client's typo or a hostile page redirect an RPL call onto the native asset.
fn asset_param(p: &Value) -> Result<u32> {
    match p.get("asset") {
        None => Ok(0),
        Some(Value::Number(n)) => {
            n.as_u64().and_then(|v| u32::try_from(v).ok()).ok_or_else(|| "asset must be a non-negative integer".to_string())
        }
        Some(_) => bad("asset must be a non-negative integer"),
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
/// - `pending_cleared` `{note, read_through}` → bool; `read_through` is a block height (a JSON
///   number, or a digit string for a non-JS caller — never an amount)
/// - `select_inputs` `{notes, asset?, need}` → `{chosen, need, change}`
/// - `plan_transfer` `{notes, asset?, amount, fee}` → `{inputs, need, change, fee, proofs}`; asset
///   defaults to 0 (RAND); `asset >= 1` fails with [`RPL_TRANSFER_UNAVAILABLE`] (registry assets
///   are not transferable on this network yet — see `select_inputs`/`prove_transfer`, which agree)
/// - `max_sendable` `{notes, asset?, fee}` → `{amount, fee, inputs}`; the largest one-bundle send,
///   floored at zero; `asset >= 1` fails the same way
/// - `plan_burn` `{notes, asset, amount, fee?}` → `{inputs, fee_inputs, change, fee_change, fee,
///   proofs}`; a bridge withdrawal is two bundles, so `inputs` are notes of `asset` and
///   `fee_inputs` are RAND notes, and `proofs` is 2. `fee` defaults to `gas::BRIDGE_BURN_FEE`,
///   which `version` reports as `bridge_burn_fee`; `asset == 0` fails with [`RAND_NOT_BRIDGED`]
/// - `prove_burn` `{…BurnRequest}` → BurnResult (slow, and slow twice — two bundle proofs, one
///   after the other)
/// - `prove_transfer` `{…ProveRequest}` → ProveResult (slow)
/// - `open_with_tx_key` `{cm, envelope, tx_key}` → note or null
/// - `format_amount` `{units}` → `"1.5"`; `parse_amount` `{text}` → units string
/// - `fixture_prove_request` `{profile?}` → a valid `prove_transfer` request for smoke tests
/// - `fixture_burn_request` `{profile?}` → a valid `prove_burn` request for smoke tests
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
            // `read_through` is a block height, not an amount of value: a JSON number, as every
            // caller today already sends it.
            Ok(Value::Bool(pending_cleared(&note, index_param(params, "read_through")?)))
        }
        "select_inputs" => {
            let notes: Vec<OwnedNote> =
                serde_json::from_value(params.get("notes").cloned().unwrap_or(Value::Array(vec![]))).map_err(|e| format!("notes: {e}"))?;
            Ok(ser(&select_inputs(&notes, asset_param(params)?, amount_param(params, "need")?)?))
        }
        "plan_transfer" => {
            let notes: Vec<OwnedNote> =
                serde_json::from_value(params.get("notes").cloned().unwrap_or(Value::Array(vec![]))).map_err(|e| format!("notes: {e}"))?;
            let asset = asset_param(params)?;
            let amount = amount_param(params, "amount")?;
            let fee = amount_param(params, "fee")?;
            Ok(ser(&plan_transfer(&notes, asset, amount, fee)?))
        }
        "max_sendable" => {
            let notes: Vec<OwnedNote> =
                serde_json::from_value(params.get("notes").cloned().unwrap_or(Value::Array(vec![]))).map_err(|e| format!("notes: {e}"))?;
            let asset = asset_param(params)?;
            let fee = amount_param(params, "fee")?;
            Ok(ser(&max_sendable(&notes, asset, fee)?))
        }
        "plan_burn" => {
            let notes: Vec<OwnedNote> =
                serde_json::from_value(params.get("notes").cloned().unwrap_or(Value::Array(vec![]))).map_err(|e| format!("notes: {e}"))?;
            let asset = asset_param(params)?;
            let amount = amount_param(params, "amount")?;
            // Absent (or an explicit JSON null, which a JS caller's optional field turns into)
            // means the chain's own floor, so no client hard-codes 0.01 RAND.
            let fee = match params.get("fee") {
                None | Some(Value::Null) => gas::BRIDGE_BURN_FEE,
                Some(_) => amount_param(params, "fee")?,
            };
            Ok(ser(&plan_burn(&notes, asset, amount, fee)?))
        }
        "prove_burn" => {
            let req: BurnRequest = serde_json::from_value(params.clone()).map_err(|e| format!("request: {e}"))?;
            Ok(ser(&prove_burn(&req)?))
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
        "fixture_burn_request" => Ok(fixture_burn_request(params.get("profile").and_then(Value::as_str).unwrap_or("test"))?),
        "format_amount" => Ok(Value::String(format_amount(amount_param(params, "units")?))),
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

    // ------------------------------------------------------------------ the two-bundle burn

    /// A burn plans two selections against one note list, and each sees only its own asset: the
    /// asset bundle's notes cover `amount` (it pays no fee) and the RAND bundle's cover `fee` (it
    /// burns nothing). Mirrors `submit_burn`'s two `Plan::select` calls, which the comment there
    /// notes "can never collide, since they hold different assets".
    #[test]
    fn plan_burn_picks_fee_notes_separately() {
        let notes = vec![
            owned(0, 1, 500),               // asset 1
            owned(1, 0, 5_000_000_000),     // RAND
            owned(2, 1, 300),               // asset 1
            owned(3, 0, 2_000_000_000),     // RAND
            owned(4, 2, 9_999),             // another asset entirely
        ];
        let plan = plan_burn(&notes, 1, 600, gas::BRIDGE_BURN_FEE).unwrap();
        // Largest-first within each asset: 500 then 300 covers 600; the 5 RAND note alone covers
        // the fee.
        assert_eq!(plan.inputs.iter().map(|n| n.index).collect::<Vec<_>>(), vec![0, 2]);
        assert_eq!(plan.fee_inputs.iter().map(|n| n.index).collect::<Vec<_>>(), vec![1]);
        assert!(plan.inputs.iter().all(|n| n.asset == 1), "the asset bundle holds only asset 1");
        assert!(plan.fee_inputs.iter().all(|n| n.asset == 0), "the fee bundle holds only RAND");
        assert_eq!(plan.change, "200", "800 of asset 1 chosen, 600 burned");
        assert_eq!(plan.fee_change, (5_000_000_000u64 - gas::BRIDGE_BURN_FEE).to_string());
        assert_eq!(plan.fee, gas::BRIDGE_BURN_FEE.to_string());
        assert_eq!(plan.proofs, 2, "a burn proves both of its bundles");
    }

    /// A wallet can hold plenty of the asset and still not be able to burn it: the fee is always
    /// RAND, and the guest's own rule is that a non-RAND bundle's fee is zero. The refusal has to
    /// say which of the two is missing.
    #[test]
    fn plan_burn_without_rand_for_fee_says_so() {
        let notes = vec![owned(0, 1, 5_000)];
        let err = plan_burn(&notes, 1, 400, gas::BRIDGE_BURN_FEE).unwrap_err();
        assert!(err.contains("RAND"), "{err}");
        assert!(err.contains("fee"), "{err}");
        // And it is the *fee* selection that failed, not the asset one.
        assert!(err.contains("insufficient"), "{err}");
    }

    #[test]
    fn plan_burn_refuses_asset_zero() {
        let notes = vec![owned(0, 0, 5_000_000_000)];
        let err = plan_burn(&notes, 0, 400, gas::BRIDGE_BURN_FEE).unwrap_err();
        assert_eq!(err, RAND_NOT_BRIDGED);
        assert!(err.contains("RAND"), "{err}");
        assert!(err.contains("not a bridged asset"), "{err}");
    }

    #[test]
    fn plan_burn_refuses_zero_amount_and_an_underpaying_fee() {
        let notes = vec![owned(0, 1, 500), owned(1, 0, 5_000_000_000)];
        assert_eq!(plan_burn(&notes, 1, 0, gas::BRIDGE_BURN_FEE).unwrap_err(), "a burn of zero moves nothing");
        let err = plan_burn(&notes, 1, 400, gas::BRIDGE_BURN_FEE - 1).unwrap_err();
        assert!(err.contains("RAND"), "{err}");
        assert!(err.contains("0.01"), "{err}");
    }

    /// The asset side gets `plan_transfer`'s own consolidate-first refusal, named with the asset
    /// it was selecting for — a bundle spends two notes, so no amount of dust adds up to a third.
    #[test]
    fn plan_burn_three_asset_notes_whose_two_largest_do_not_cover_says_consolidate() {
        let notes = vec![owned(0, 1, 100), owned(1, 1, 100), owned(2, 1, 100), owned(3, 0, 5_000_000_000)];
        let err = plan_burn(&notes, 1, 250, gas::BRIDGE_BURN_FEE).unwrap_err();
        assert!(err.contains("consolidate"), "{err}");
        assert!(err.contains("asset 1"), "{err}");
    }

    /// The shape the ledger checks, without paying for two proofs: the asset bundle pays no fee,
    /// burns exactly the amount and carries the asset index; the RAND fee bundle carries asset 0,
    /// burns nothing and pays at least `BRIDGE_BURN_FEE`. Plus the cross-bundle rule
    /// `bridge_notes::validate` enforces — all four nullifiers and all four commitments differ —
    /// and the fact that a burn addresses no note to anybody else.
    #[test]
    fn burn_bundles_have_the_ledger_shape() {
        let req: BurnRequest = serde_json::from_value(fixture_burn_request("test").unwrap()).unwrap();
        let amount: u64 = req.amount.parse().unwrap();
        let (w, b) = build_burn_unproven(&req).unwrap();
        let (asset, fee) = (&b.asset_bundle.bundle, &b.fee_bundle.bundle);

        assert_eq!(asset.fee, 0, "the fee is always RAND, and it is the other bundle's");
        assert_eq!(asset.burn, amount, "a burn destroys exactly what the outbound message sends");
        assert_eq!(asset.asset, req.asset);
        assert_eq!(fee.asset, 0, "the transaction's own bundle is always RAND");
        assert_eq!(fee.burn, 0, "value leaves the pool through the asset bundle only");
        assert!(fee.fee >= gas::BRIDGE_BURN_FEE, "{} < {}", fee.fee, gas::BRIDGE_BURN_FEE);
        assert_eq!(fee.fee, req.fee.parse::<u64>().unwrap());

        // Both bundles share the one anchor and the one `time`.
        assert_eq!(asset.anchor, fee.anchor);
        assert_eq!(asset.time, fee.time);
        assert_eq!(u64::from(asset.time), req.anchor_height);

        // `bridge_notes::validate`: the pairs *between* the two bundles are checked there, since
        // `check_bundle` sees each bundle alone.
        let nfs = [asset.nullifiers[0], asset.nullifiers[1], fee.nullifiers[0], fee.nullifiers[1]];
        let cms = [asset.commitments[0], asset.commitments[1], fee.commitments[0], fee.commitments[1]];
        for i in 0..4 {
            for j in (i + 1)..4 {
                assert_ne!(nfs[i], nfs[j], "nullifiers {i} and {j} collide");
                assert_ne!(cms[i], cms[j], "commitments {i} and {j} collide");
            }
        }

        // A burn pays nobody inside the pool: every output of both bundles is this wallet's own,
        // and the destination lives in the action's `to_chain`/`to` instead.
        assert_eq!(b.asset_bundle.change, 500 - amount);
        assert_eq!(b.fee_bundle.change, 3 * UNITS_PER_RAND - fee.fee);
        assert_eq!(b.to[..12], [0u8; 12], "an EVM recipient is left-padded");
        assert_eq!(b.relayer_fee, req.relayer_fee.parse::<u64>().unwrap());
        assert!(b.relayer_fee <= amount, "the relayer fee is a portion of the amount");
        assert_eq!(b.spent_indices, vec![0, 1], "the asset bundle's inputs first, then the fee bundle's");
        // Both outputs of both bundles open as this wallet's own notes.
        let rows: Vec<CommitmentRow> = [(asset, 0u64), (fee, 2)]
            .iter()
            .flat_map(|(bundle, base)| {
                (0..2).map(move |i| CommitmentRow {
                    index: base + i as u64,
                    cm: word8_to_hex(&bundle.commitments[i]),
                    height: 41,
                    envelope: EnvelopeHex {
                        kem_ct: hex::encode(&bundle.envelopes[i].kem_ct),
                        to_receiver: hex::encode(&bundle.envelopes[i].to_receiver),
                        to_sender: hex::encode(&bundle.envelopes[i].to_sender),
                        body: hex::encode(&bundle.envelopes[i].body),
                    },
                })
            })
            .collect();
        let scan = scan_page(&w, &rows).unwrap();
        assert_eq!(scan.received.len(), 4, "all four outputs come back to this wallet");
        assert_eq!(scan.received.iter().filter(|n| n.asset == req.asset).count(), 2);
        assert_eq!(scan.received.iter().filter(|n| n.asset == 0).count(), 2);
    }

    /// The wire assignment, without paying for two proofs: the RAND fee bundle is the
    /// transaction's own `bundle` and the asset bundle rides inside the action. Swapped over, the
    /// ledger refuses the transaction outright (`TxError::UnsupportedAsset` — a transaction bundle
    /// is always RAND), so this is the one placement a burn cannot be wrong about.
    #[test]
    fn the_fee_bundle_is_the_transactions_own_and_the_asset_bundle_rides_in_the_action() {
        let req: BurnRequest = serde_json::from_value(fixture_burn_request("test").unwrap()).unwrap();
        let amount: u64 = req.amount.parse().unwrap();
        let (_w, b) = build_burn_unproven(&req).unwrap();
        let tx = burn_transaction(&req, b);

        assert_eq!(tx.chain_id, DEFAULT_CHAIN_ID);
        let outer = tx.bundle.as_ref().expect("a burn carries a bundle");
        assert_eq!(outer.asset, 0, "the transaction's own bundle is the RAND fee bundle");
        assert_eq!(outer.burn, 0);
        assert_eq!(outer.fee, gas::BRIDGE_BURN_FEE);
        let Action::BridgeBurn { asset_bundle, asset, amount: act_amount, relayer_fee, to_chain, to } = &tx.action
        else {
            panic!("a bridge burn")
        };
        assert_eq!(asset_bundle.asset, req.asset, "the asset bundle rides inside the action");
        assert_eq!(asset_bundle.burn, amount);
        assert_eq!(asset_bundle.fee, 0);
        assert_eq!(*asset, req.asset);
        assert_eq!(*act_amount, amount, "the action's amount is the asset bundle's burn word");
        assert_eq!(*relayer_fee, req.relayer_fee.parse::<u64>().unwrap());
        assert_eq!(*to_chain, req.to_chain);
        assert_eq!(hex::encode(to), req.to, "`to` is plain bytes, carried through unchanged");
    }

    /// `to` keeps the byte order it was written in, pinned on a value that can tell.
    ///
    /// The assertion above, and every other `to` assertion in this file, runs on the fixture's
    /// recipient — twelve `0x00` then twenty `0x11`. Every four-byte group of that value is
    /// uniform, so it is *invariant under a per-word byte reversal*: it round-trips identically
    /// whether or not anything between the hex string and the action permutes bytes within a
    /// four-byte word, which is the class of mistake a future refactor through a word-oriented
    /// decoder could introduce. An asymmetric value is the only kind that can fail, so this test
    /// uses one: twenty ascending bytes after the required twelve-byte EVM pad. Reverse the bytes
    /// inside any word and `[…, 0x01, 0x02, 0x03, 0x04, …]` becomes `[…, 0x04, 0x03, 0x02, 0x01,
    /// …]`, and the first `assert_eq!` below fails on the first word it reaches.
    #[test]
    fn to_keeps_its_byte_order_through_parsing_and_into_the_action() {
        let mut want = [0u8; 32];
        want[12..].copy_from_slice(&[
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11,
            0x12, 0x13, 0x14,
        ]);
        let hexed = "0000000000000000000000000102030405060708090a0b0c0d0e0f1011121314";
        assert_eq!(hexed.len(), 64);
        assert_eq!(parse_to(hexed).unwrap(), want, "the bytes come out in the order they were written");
        // The same string `0x`-prefixed and upper-cased is the same bytes, still in order.
        assert_eq!(
            parse_to("0x0000000000000000000000000102030405060708090A0B0C0D0E0F1011121314").unwrap(),
            want,
            "a 0x prefix and upper case are cosmetic"
        );

        // And the order survives all the way onto the action the chain reads.
        let mut req = fixture_burn_request("test").unwrap();
        req["to"] = json!(hexed);
        let req: BurnRequest = serde_json::from_value(req).unwrap();
        let (_w, b) = build_burn_unproven(&req).unwrap();
        assert_eq!(b.to, want, "no re-ordering between the request and the bundle");
        let tx = burn_transaction(&req, b);
        let Action::BridgeBurn { to, .. } = &tx.action else { panic!("a bridge burn") };
        assert_eq!(*to, want, "nor between the bundle and the action");
        assert_eq!(to[12], 0x01, "the recipient's first byte, not its word's last");
        assert_eq!(to[31], 0x14, "the recipient's last byte, not its word's first");
    }

    /// `prove_burn`'s refusals before anything is built, in `submit_burn`'s own order and words.
    #[test]
    fn prove_burn_refuses_what_could_never_be_admitted_before_building_anything() {
        let base: Value = fixture_burn_request("test").unwrap();
        let attempt = |patch: Value| -> String {
            let mut req = base.clone();
            for (k, v) in patch.as_object().unwrap() {
                req[k] = v.clone();
            }
            let req: BurnRequest = serde_json::from_value(req).unwrap();
            match build_burn_unproven(&req) {
                Ok(_) => panic!("{patch} should have been refused"),
                Err(e) => e,
            }
        };
        assert_eq!(attempt(json!({ "asset": 0 })), RAND_NOT_BRIDGED);
        assert_eq!(attempt(json!({ "amount": "0" })), "a burn of zero moves nothing");
        let err = attempt(json!({ "relayer_fee": "401" }));
        assert!(err.contains("more than the 400"), "{err}");
        let err = attempt(json!({ "fee": (gas::BRIDGE_BURN_FEE - 1).to_string() }));
        assert!(err.contains("below the bridge burn floor"), "{err}");
        // `to` is plain bytes, never a Word8: a short or non-hex value is refused outright.
        assert!(attempt(json!({ "to": "1122" })).contains("32 bytes"));
        assert!(attempt(json!({ "to": "zz" })).contains("not hex"));
        // A RAND note cannot fund the asset bundle, nor the reverse: the fixture's two inputs
        // swapped over are both refused.
        let swapped = json!({ "inputs": base["fee_inputs"].clone(), "fee_inputs": base["inputs"].clone() });
        assert!(attempt(swapped).contains("holds asset 0, but this bundle spends asset 1"));
    }

    /// The fixture is a request `prove_burn` would accept, and `dispatch` carries both new methods
    /// end to end.
    #[test]
    fn dispatch_plan_burn_and_fixture_burn_request_round_trip_json() {
        let notes = json!([
            { "index": 0, "note": "", "cm": "", "nf": "", "amount": "500", "asset": 1,
              "time": 1, "from": "", "height": 1, "spent": false, "pending": null },
            { "index": 1, "note": "", "cm": "", "nf": "", "amount": "5000000000", "asset": 0,
              "time": 1, "from": "", "height": 1, "spent": false, "pending": null },
        ]);
        // `fee` omitted: the chain's own floor, which `version` also reports.
        let params = json!({ "notes": notes, "asset": 1, "amount": "400" });
        let v: Value = serde_json::from_str(&call("plan_burn", &params.to_string())).unwrap();
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["value"]["proofs"], 2);
        assert_eq!(v["value"]["fee"], gas::BRIDGE_BURN_FEE.to_string());
        assert_eq!(v["value"]["change"], "100");
        assert_eq!(v["value"]["fee_change"], (5_000_000_000u64 - gas::BRIDGE_BURN_FEE).to_string());
        assert_eq!(v["value"]["inputs"][0]["index"], 0);
        assert_eq!(v["value"]["fee_inputs"][0]["index"], 1);

        // An explicit fee, as a decimal string; a bare JSON number is refused like every amount.
        let params = json!({ "notes": notes, "asset": 1, "amount": "400", "fee": "20000000" });
        let v: Value = serde_json::from_str(&call("plan_burn", &params.to_string())).unwrap();
        assert_eq!(v["value"]["fee"], "20000000");
        let params = json!({ "notes": notes, "asset": 1, "amount": "400", "fee": 20_000_000u64 });
        let v: Value = serde_json::from_str(&call("plan_burn", &params.to_string())).unwrap();
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap().contains("decimal strings"), "{v}");

        // asset 0 through the JSON door too.
        let params = json!({ "notes": notes, "asset": 0, "amount": "400" });
        let v: Value = serde_json::from_str(&call("plan_burn", &params.to_string())).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], RAND_NOT_BRIDGED);

        let v: Value = serde_json::from_str(&call("fixture_burn_request", "{}")).unwrap();
        assert_eq!(v["ok"], true, "{v}");
        let req = &v["value"];
        assert_eq!(req["asset"], 1);
        assert_eq!(req["to_chain"], 2);
        assert_eq!(req["to"].as_str().unwrap().len(), 64);
        assert_eq!(req["fee"], gas::BRIDGE_BURN_FEE.to_string());
        assert_eq!(req["inputs"][0]["note"]["asset"], 1);
        assert_eq!(req["fee_inputs"][0]["note"]["asset"], 0);
        assert_eq!(req["inputs"][0]["path"].as_array().unwrap().len(), DEPTH);
        // And it deserializes as the request `prove_burn` takes.
        let _: BurnRequest = serde_json::from_value(req.clone()).unwrap();
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
        assert_eq!(v["bridge_burn"], true);
        assert!(v["bridge_burn"].is_boolean());
        // An amount, so a string, like every other amount this crate reports.
        assert_eq!(v["bridge_burn_fee"], gas::BRIDGE_BURN_FEE.to_string());
        assert!(v["bridge_burn_fee"].is_string());
    }

    /// What upstream's `BRIDGE_BURN_FEE` is today (`core/vendor/fullnode/crates/
    /// randprotocol-core/src/gas.rs`, pinned by that crate's own test): ten bundle bases,
    /// 0.01 RAND. A change here means upstream moved the bridge's charge.
    #[test]
    fn bridge_burn_fee_is_the_documented_value() {
        assert_eq!(gas::BRIDGE_BURN_FEE, 10 * gas::BUNDLE_BASE);
        assert_eq!(gas::BRIDGE_BURN_FEE, 10_000_000);
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
            assert!(v["error"].as_str().unwrap().contains("digits"), "{v}");
        }
    }

    // ---------------------------------------------------------- checked arithmetic (review fix)

    #[test]
    fn select_inputs_note_sum_overflow_is_an_error_not_a_panic() {
        let notes = vec![owned(0, 0, u64::MAX), owned(1, 0, u64::MAX)];
        let err = select_inputs(&notes, 0, 10).unwrap_err();
        assert!(err.contains("overflow"), "{err}");
    }

    #[test]
    fn plan_transfer_note_sum_overflow_is_an_error_not_a_panic() {
        let notes = vec![owned(0, 0, u64::MAX), owned(1, 0, u64::MAX)];
        let err = plan_transfer(&notes, 0, 10, gas::BUNDLE_BASE).unwrap_err();
        assert!(err.contains("overflow"), "{err}");
    }

    #[test]
    fn max_sendable_note_sum_overflow_is_an_error_not_a_panic() {
        let notes = vec![owned(0, 0, u64::MAX), owned(1, 0, u64::MAX)];
        let err = max_sendable(&notes, 0, gas::BUNDLE_BASE).unwrap_err();
        assert!(err.contains("overflow"), "{err}");
    }

    #[test]
    fn checked_sum_helper_overflows_cleanly() {
        assert_eq!(checked_sum([1u64, 2, 3]).unwrap(), 6);
        assert_eq!(checked_sum(std::iter::empty()).unwrap(), 0);
        assert!(checked_sum([u64::MAX, 1]).is_err());
    }

    // -------------------------------------------------- shared spendable-native helper (review fix)

    #[test]
    fn spendable_of_filters_and_sorts_largest_first_stably() {
        let mut notes = vec![owned(0, 0, 1_000_000_000), owned(1, 1, 9_000_000_000), owned(2, 0, 5_000_000_000), owned(3, 0, 5_000_000_000), owned(4, 0, 0)];
        notes[0].spent = true;
        let out: Vec<u64> = spendable_of(&notes, 0).into_iter().map(|n| n.index).collect();
        // note 0 (spent), note 1 (wrong asset) and note 4 (zero amount) are all excluded; the
        // 5-RAND tie (2 and 3) keeps its original relative order.
        assert_eq!(out, vec![2, 3]);
    }

    // ------------------------------------------------------ consistency property (review fix)

    /// `max_sendable`'s answer and `plan_transfer`'s own selection must never disagree: the largest
    /// amount `max_sendable` reports must be exactly the amount `plan_transfer` can still build a
    /// bundle for (one unit more always fails), and both pick the same notes to spend. A dozen
    /// hand-written wallets: single notes at, above and below the fee, equal-amount and tied notes,
    /// five notes, spent/pending notes mixed in, an empty wallet, a balance landing exactly on the
    /// fee, and a real zero-amount note (never spendable).
    #[test]
    fn max_sendable_and_plan_transfer_agree_on_amount_and_notes() {
        let fee = gas::BUNDLE_BASE;
        let cases: Vec<Vec<OwnedNote>> = vec![
            vec![owned(0, 0, 5_000_000_000)],
            vec![owned(0, 0, fee)],
            vec![owned(0, 0, fee / 2)],
            vec![owned(0, 0, 2_000_000_000), owned(1, 0, 2_000_000_000)],
            vec![owned(0, 0, 5_000_000_000), owned(1, 0, 3_000_000_000)],
            (0..5).map(|i| owned(i, 0, (i + 1) * 1_000_000_000)).collect(),
            vec![
                owned(0, 0, 5_000_000_000),
                owned(1, 0, 5_000_000_000),
                owned(2, 0, 1_000_000_000),
                owned(3, 0, 1_000_000_000),
                owned(4, 0, 1_000_000_000),
            ],
            {
                let mut v = vec![
                    owned(0, 0, 10_000_000_000),
                    owned(1, 0, 9_000_000_000),
                    owned(2, 0, 3_000_000_000),
                    owned(3, 0, 2_000_000_000),
                ];
                v[0].spent = true;
                v[1].pending = Some(3);
                v
            },
            vec![],
            vec![owned(0, 0, fee / 2), owned(1, 0, fee / 2)],
            vec![owned(0, 0, 4_000_000_000), owned(1, 0, 4_000_000_000), owned(2, 0, 1_000_000_000)],
            vec![owned(0, 0, 0), owned(1, 0, 5_000_000_000), owned(2, 0, 3_000_000_000)],
        ];
        assert_eq!(cases.len(), 12, "a dozen hand-written wallets, as asked");

        for (i, notes) in cases.iter().enumerate() {
            let max = max_sendable(notes, 0, fee).unwrap();
            let m: u64 = max.amount.parse().unwrap();
            let expected_indices: Vec<u64> = spendable_of(notes, 0).into_iter().take(BUNDLE_INPUTS).map(|n| n.index).collect();

            if m > 0 {
                let plan = plan_transfer(notes, 0, m, fee).unwrap_or_else(|e| panic!("case {i}: plan_transfer(m={m}) should succeed: {e}"));
                // `m` is defined as the candidates' sum minus fee, so spending exactly `m` always
                // leaves zero change — that is what "the max you can send" means.
                assert_eq!(plan.change, "0", "case {i}");
                assert_eq!(
                    plan.inputs.iter().map(|n| n.index).collect::<Vec<_>>(),
                    expected_indices,
                    "case {i}: plan_transfer and max_sendable disagree on which notes to spend"
                );
                assert!(plan_transfer(notes, 0, m + 1, fee).is_err(), "case {i}: one more unit than max_sendable should fail");
            } else {
                assert!(plan_transfer(notes, 0, 1, fee).is_err(), "case {i}: max_sendable says 0, so even amount 1 should fail");
            }
        }
    }

    // --------------------------------------------------- strict asset/amount parsing (review fix)

    #[test]
    fn asset_param_defaults_absent_to_zero_and_rejects_everything_malformed() {
        assert_eq!(asset_param(&json!({})).unwrap(), 0);
        assert_eq!(asset_param(&json!({"asset": 0})).unwrap(), 0);
        assert_eq!(asset_param(&json!({"asset": 1})).unwrap(), 1);
        assert_eq!(asset_param(&json!({"asset": 4294967295u32})).unwrap(), 4294967295);
        // The truncating-cast bug this replaces: 2^32 must be rejected, never silently read as 0.
        assert!(asset_param(&json!({"asset": 4294967296u64})).is_err());
        assert!(asset_param(&json!({"asset": -1})).is_err());
        assert!(asset_param(&json!({"asset": 1.5})).is_err());
        assert!(asset_param(&json!({"asset": "1"})).is_err());
        assert!(asset_param(&json!({"asset": null})).is_err());
        assert!(asset_param(&json!({"asset": true})).is_err());
    }

    #[test]
    fn amount_param_requires_a_strict_ascii_digit_string() {
        let get = |v: Value| amount_param(&json!({ "amount": v }), "amount");
        assert_eq!(get(json!("5")).unwrap(), 5);
        assert_eq!(get(json!("00000000000000000001")).unwrap(), 1, "leading zeros are still digits");
        assert_eq!(get(json!(u64::MAX.to_string())).unwrap(), u64::MAX);
        assert!(get(json!("+5")).is_err(), "no sign");
        assert!(get(json!(" 5")).is_err(), "no leading whitespace");
        assert!(get(json!("5 ")).is_err(), "no trailing whitespace");
        assert!(get(json!("")).is_err(), "empty is not a number");
        assert!(get(json!("18446744073709551616")).is_err(), "u64::MAX + 1 is out of range");
        let err = get(json!(5)).unwrap_err();
        assert!(err.contains("decimal strings"), "{err}");
        assert!(get(json!(5.0)).is_err(), "a JSON number is refused even when integral");
        assert!(get(json!(null)).is_err());
    }

    #[test]
    fn amount_param_rejects_numbers_for_every_amount_field_across_dispatch() {
        // `need` (select_inputs), `amount`/`fee` (plan_transfer), `fee` (max_sendable) and `units`
        // (format_amount) must all refuse a bare JSON number the same way.
        let notes = json!([]);
        let cases = [
            ("select_inputs", json!({ "notes": notes, "need": 5 })),
            ("plan_transfer", json!({ "notes": notes, "amount": 5, "fee": 1 })),
            ("plan_transfer", json!({ "notes": notes, "amount": "5", "fee": 1 })),
            ("max_sendable", json!({ "notes": notes, "fee": 5 })),
            ("format_amount", json!({ "units": 5 })),
        ];
        for (method, params) in cases {
            let v: Value = serde_json::from_str(&call(method, &params.to_string())).unwrap();
            assert_eq!(v["ok"], false, "{method} should refuse a bare number amount: {params}");
            assert!(v["error"].as_str().unwrap().contains("decimal strings"), "{v}");
        }
    }

    #[test]
    fn index_param_accepts_numbers_and_digit_strings_rejects_the_rest() {
        let get = |v: Value| index_param(&json!({ "n": v }), "n");
        assert_eq!(get(json!(0)).unwrap(), 0);
        assert_eq!(get(json!(12345)).unwrap(), 12345);
        assert_eq!(get(json!("12345")).unwrap(), 12345, "a digit string is also accepted, for non-JS callers");
        assert_eq!(get(json!(JS_MAX_SAFE_INTEGER)).unwrap(), JS_MAX_SAFE_INTEGER);
        // A digit string is not bound by 2^53 - 1: it never lost precision to begin with.
        assert_eq!(get(json!(u64::MAX.to_string())).unwrap(), u64::MAX);
        assert!(get(json!(JS_MAX_SAFE_INTEGER + 1)).is_err(), "above 2^53 - 1 as a bare number is refused");
        assert!(get(json!(-1)).is_err(), "negative");
        assert!(get(json!(1.5)).is_err(), "fractional");
        assert!(get(json!("abc")).is_err(), "not digits");
        assert!(get(json!(null)).is_err());
        assert!(get(json!(true)).is_err());
    }

    #[test]
    fn pending_cleared_dispatch_accepts_read_through_as_number_or_digit_string() {
        let note = json!({
            "index": 0, "note": "", "cm": "", "nf": "", "amount": "5", "asset": 0,
            "time": 1, "from": "", "height": 1, "spent": false, "pending": 3,
        });
        // As a bare JSON number — exactly what ui/engine/wallet.js and the extension send today.
        let v: Value = serde_json::from_str(&call("pending_cleared", &json!({ "note": note, "read_through": 999 }).to_string())).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["value"], true);
        // As a digit string too, for a non-JS caller.
        let v: Value =
            serde_json::from_str(&call("pending_cleared", &json!({ "note": note, "read_through": "999" }).to_string())).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["value"], true);

        for bad in [json!(-1), json!(1.5), json!(9_007_199_254_740_992u64), json!("abc"), json!(null)] {
            let v: Value =
                serde_json::from_str(&call("pending_cleared", &json!({ "note": note, "read_through": bad }).to_string())).unwrap();
            assert_eq!(v["ok"], false, "read_through {bad:?} should have been refused");
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

    /// Mirrors exactly the param shapes `ui/engine/wallet.js`'s `core` binding (its `call(...)`
    /// wrappers, `wallet.js:214-226`) and `ui/engine/backend-wasm.js`'s `select_inputs` call site
    /// (`:1002-1003`) send today (read-only source inspection — nothing there was changed). If a
    /// future core change ever breaks one of these shapes, it fails here in `cargo test`, not in
    /// a browser.
    mod js_engine_contract {
        use super::*;

        #[test]
        fn wallet_info_import_key_and_parse_address() {
            // wallet.js:216 `walletInfo: (spend_key) => call('wallet_info', { spend_key })`
            let sk = wallet(31).spend_key_hex();
            let v: Value = serde_json::from_str(&call("wallet_info", &json!({ "spend_key": sk }).to_string())).unwrap();
            assert_eq!(v["ok"], true);
            assert_eq!(v["value"]["spend_key"], sk);

            // wallet.js:217 `importKey: (input) => call('import_key', { input })`
            let v: Value = serde_json::from_str(&call("import_key", &json!({ "input": sk }).to_string())).unwrap();
            assert_eq!(v["ok"], true);

            // wallet.js:218 `parseAddress: (address) => call('parse_address', { address })`
            let addr = wallet_info(&wallet(31)).address;
            let v: Value = serde_json::from_str(&call("parse_address", &json!({ "address": addr }).to_string())).unwrap();
            assert_eq!(v["ok"], true);
            assert_eq!(v["value"]["valid"], true);
        }

        #[test]
        fn scan_page_shape() {
            // wallet.js:219 `scanPage: (spend_key, rows) => call('scan_page', { spend_key, rows })`;
            // `rows` are node `rand_getCommitments` rows — `index`/`height` are JSON numbers,
            // everything else hex strings.
            let sender = wallet(32);
            let receiver = wallet(33);
            let (row, _) = sealed_row(&sender, &receiver, 1_000_000_000, 5);
            let params = json!({
                "spend_key": receiver.spend_key_hex(),
                "rows": [{
                    "index": row.index, "cm": row.cm, "height": row.height,
                    "envelope": {
                        "kem_ct": row.envelope.kem_ct, "to_receiver": row.envelope.to_receiver,
                        "to_sender": row.envelope.to_sender, "body": row.envelope.body,
                    },
                }],
            });
            let v: Value = serde_json::from_str(&call("scan_page", &params.to_string())).unwrap();
            assert_eq!(v["ok"], true);
            assert_eq!(v["value"]["received"][0]["amount"], "1000000000");
            assert_eq!(v["value"]["next_index"], 6);
        }

        #[test]
        fn select_inputs_shape() {
            // wallet.js:222 `selectInputs: (notes, need, asset = 0) => call('select_inputs',
            // { notes, need: String(need), asset })` and backend-wasm.js:1003
            // `c.selectInputs(st.notes || [], need.toString(), 0)`: `need` a decimal string,
            // `asset` a bare number.
            let notes = json!([{
                "index": 0, "note": "", "cm": "", "nf": "", "amount": "5000000000", "asset": 0,
                "time": 1, "from": "", "height": 1, "spent": false, "pending": null,
            }]);
            let params = json!({ "notes": notes, "need": "1000000000", "asset": 0 });
            let v: Value = serde_json::from_str(&call("select_inputs", &params.to_string())).unwrap();
            assert_eq!(v["ok"], true);
            assert_eq!(v["value"]["chosen"][0]["amount"], "5000000000");
        }

        #[test]
        fn pending_cleared_shape() {
            // wallet.js:221 `pendingCleared: (note, read_through) => call('pending_cleared',
            // { note, read_through })`, called with `read_through = st.scanned_height - 1`
            // (`wallet.js:716,718`) — a bare JSON number, never a string.
            let note = json!({
                "index": 0, "note": "", "cm": "", "nf": "", "amount": "1", "asset": 0,
                "time": 1, "from": "", "height": 1, "spent": false, "pending": 3,
            });
            let params = json!({ "note": note, "read_through": 999 });
            let v: Value = serde_json::from_str(&call("pending_cleared", &params.to_string())).unwrap();
            assert_eq!(v["ok"], true);
            assert_eq!(v["value"], true);
        }

        #[test]
        fn format_amount_and_parse_amount_shape() {
            // wallet.js:225 `formatAmount: (units) => call('format_amount', { units: String(units) })`
            // wallet.js:226 `parseAmount: (text) => call('parse_amount', { text })`
            let v: Value = serde_json::from_str(&call("format_amount", &json!({ "units": "1500000000" }).to_string())).unwrap();
            assert_eq!(v["value"], "1.5");
            let v: Value = serde_json::from_str(&call("parse_amount", &json!({ "text": "1.5" }).to_string())).unwrap();
            assert_eq!(v["value"], "1500000000");
        }

        #[test]
        fn rebuilt_deposit_shape() {
            // wallet.js:220 `rebuiltDeposit: (spend_key, action) => call('rebuilt_deposit',
            // { spend_key, action })`, where `action` is a raw node block-action object
            // (`wallet.js:389-393`, straight from `rand_getBlockByHeight`) — NOT a wallet-core
            // parameter this crate defines the shape of. Its `amount`/`asset_index`/`time` fields
            // are read here as JSON numbers (`rebuilt_deposit`'s `action["amount"].as_u64()`,
            // `lib.rs`), which is the node's own rendering, mirrored as-is.
            let w = wallet(34);
            let note = Note::new(w.vk.pk(), [0; 8], 2_000_000_000, 0, 7);
            let cm = note.commitment();
            let action = json!({
                "kind": "bridge_attest",
                "recipient": w.address.to_string(),
                "amount": note.amount,
                "asset_index": note.asset,
                "time": note.time,
                "r": word8_to_hex(&note.r),
                "commitment": word8_to_hex(&cm),
            });
            let params = json!({ "spend_key": w.spend_key_hex(), "action": action });
            let v: Value = serde_json::from_str(&call("rebuilt_deposit", &params.to_string())).unwrap();
            assert_eq!(v["ok"], true);
            assert_eq!(v["value"]["amount"], "2000000000");
            assert_eq!(v["value"]["asset"], 0);
        }
    }
}
