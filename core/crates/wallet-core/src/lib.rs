//! Rand Wallet core.
//!
//! Everything a lightweight client cannot do in its own language lives here: the Poseidon2 key
//! hierarchy, ML-KEM-768 + ChaCha20-Poly1305 envelopes, note commitments and nullifiers, and the
//! STARK proof of one hidden-asset bundle — four input and four output slots, slots 0–1 carrying a
//! private asset the chain never sees and slots 2–3 carrying RAND and paying the fee, so a
//! transfer of RAND, of a bridged coin and of an RPL token are one indistinguishable shape. The iOS app (Swift), the Android app (Java) and the
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
use randprotocol_core::types::TX_BINDING_WORDS;
use randprotocol_core::{format_amount, parse_amount, Action, Transaction, FAUCET_MAX_UNITS};
use randprotocol_zkvm::address::{address_of, envelope_from_core, seal_note};
use randprotocol_zkvm::executor::prove_bundle;
use randprotocol_zkvm::hidden::{self, HiddenDigestInput, HiddenOutput, A_SLOTS, SLOTS};
use randprotocol_zkvm::machine::{Backend, FriProfile};
use randprotocol_zkvm::notes::{Note, SpendKey, ViewingKey};
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
pub const CHAIN_BUILD: &str = "9c142c1";
/// The chain the defaults below describe: chain 14, the live testnet at this fullnode commit
/// (v0.5.1, `deploy/README.md`, genesis `1cff3b7d…`, cut 2026-09-20) — the shielded pool on the
/// **hidden-asset bundle** (one 4-in/4-out proof for RAND, a bridged coin or an RPL token alike),
/// transaction binding, RPL tokens, staking and the call limits, zkVM constraint set 6,
/// production FRI profile.
pub const DEFAULT_CHAIN_ID: u64 = 14;
pub const DEFAULT_RPC_URL: &str = "https://rpc.randprotocol.org";
pub const EXPLORER_URL: &str = "https://randscan.org";
/// Peak resident memory of one bundle proof, measured on this crate's own fixture
/// (`examples/prove_fixture.rs`, Apple M-series): the prover materialises every table's
/// low-degree extension at once. Clients compare it with the device's memory before proving,
/// and wasm32 (4 GiB address space) cannot prove at all until this drops. Re-measured on
/// constraint set 6 (2026-09-19): 97.6 s, 5 634 113 536 bytes.
///
/// **Re-measured on chain 14's hidden-asset guest (2026-09-20)**, Apple M-series, `--release`,
/// production FRI, `/usr/bin/time -l ./target/release/examples/prove_fixture <kind> production`
/// — the *largest* of the three shapes a wallet builds, which is what a device has to clear:
///
/// | fixture | proving | peak RSS |
/// |---|---|---|
/// | `transfer` (RAND) | 97.0 s | **5 656 723 456** |
/// | `token` (asset 1) | 97.0 s | 5 645 041 664 |
/// | `burn` | 99.1 s | 5 643 026 432 |
///
/// Four slots cost about 0.4% more than the retired two-slot guest's 5 634 113 536 — the guest
/// doubled its slots but the prover's peak is dominated by one low-degree extension either way —
/// and a burn is now **one** proof rather than two, so the worst case a client must budget for
/// went *down*. The published requirement (an 8 GiB device gate) is unchanged.
pub const PROVER_PEAK_MEMORY_BYTES: u64 = 5_656_723_456;

/// A bundle spends at most this many input notes **per group** — slots 0–1 carry the private
/// asset, slots 2–3 carry RAND — so coin selection picks at most two notes of each. Unchanged
/// from the 2-in/2-out bundle: `select_inputs` enforces it per asset, and a client that wants the
/// number without re-deriving it reads `bundle_inputs` from `version`.
pub const BUNDLE_INPUTS: usize = 2;

/// Input and output slots of one hidden-asset bundle (`randprotocol_zkvm::hidden::SLOTS`), and
/// how many of them carry the private asset `A` (`A_SLOTS`). Reported by `version` as
/// `bundle_slots`, so no client hard-codes four.
pub const BUNDLE_SLOTS: usize = SLOTS;

/// `build_bundle` and `BundlePlan::outputs` fill four slots by hand, two of them the private
/// asset's. Upstream asserts the same pair at runtime (`debug_assert!` in its `build_bundle`);
/// here it is a compile-time assertion, so a resync that changed the guest's slot layout would
/// fail the build rather than a debug run.
const _: () = assert!(A_SLOTS == 2 && BUNDLE_SLOTS == 4, "the slot layout build_bundle fills");

/// The fee is always RAND, from slots 2–3 of the same proof (spec §3.9), so a wallet holding a
/// token and no spendable RAND cannot transfer or burn it at all. Upstream's own refusal, verbatim
/// (`randprotocol_client::wallet::Plan::select`), so this wallet and the `rand` CLI say the same
/// sentence — exported as a constant so a UI can match on it rather than on a substring.
pub const NO_SPENDABLE_RAND: &str = "a transfer pays its fee in RAND, and this wallet holds no spendable RAND: \
     receive some RAND (on a testnet, `rand faucet`) and retry";

/// [`NO_SPENDABLE_RAND`]'s other half, also upstream's: RAND held back by a submission that has
/// not committed is not missing, only unavailable, and the answer is "wait", not "go and get
/// some". The `{}` is the held amount, `format_amount`ed.
pub const NO_SPENDABLE_RAND_PENDING: &str = "a transfer pays its fee in RAND, and this wallet holds no spendable RAND: \
     {} RAND is held by a pending submission — rescan once it commits (or expires) and retry";

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
///
/// `amount` is read with `amount_field`, which takes **a decimal string** (chain 14's rendering
/// of every RPC amount, node I3) **or a JSON number** (an older node's). Before the chain-14 port
/// this read `as_u64()` alone, which returns `None` on a string — so every bridge deposit rebuild
/// would have silently failed against a chain-14 node. `asset_index` and `time` stay JSON numbers:
/// they are an index and a height, not money, and the node still renders them as numbers.
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
        amount: amount_field(&action["amount"])?,
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
/// stable). The one place "which notes could this group spend" is decided, so `select_inputs`,
/// `select_groups` (and through it `plan_transfer`, `plan_burn`) and `max_sendable` cannot drift
/// apart on the rule. Mirrors `NoteStore::spendable_of`, which `Plan::select` calls once per group.
fn spendable_of(notes: &[OwnedNote], asset: u32) -> Vec<&OwnedNote> {
    let mut v: Vec<&OwnedNote> = notes.iter().filter(|n| n.is_spendable() && n.asset == asset).collect();
    v.sort_by_key(|n| std::cmp::Reverse(n.units()));
    v
}

/// An amount of `asset` as a user reads it. RAND has nine decimals and a name; a token's units are
/// the token's own and this crate does not know its decimals (the registry does, and a UI that has
/// read `rand_getTokens` can re-render), so they are printed bare and named by index.
///
/// Upstream's `SelectError` is asset-neutral for the same reason (`"insufficient balance: {have}
/// units"`). Before chain 14 every selection was RAND, so this crate printed "RAND" unconditionally
/// and 500 units of asset 1 read as `0.0000005 RAND`; now that a token really can be transferred,
/// that would be a lie on every RPL error path.
fn amount_of(asset: u32, units: u64) -> String {
    if asset == 0 {
        format!("{} RAND", format_amount(units))
    } else {
        format!("{units} units of asset {asset}")
    }
}

/// Largest-first, at most [`BUNDLE_INPUTS`] notes of one asset (a group has two input slots).
/// Mirrors `randprotocol_client::wallet::select_inputs`, including its two errors.
pub fn select_inputs(notes: &[OwnedNote], asset: u32, need: u64) -> Result<Selection> {
    let sorted = spendable_of(notes, asset);
    let have = checked_sum(sorted.iter().map(|n| n.units()))?;
    if have < need {
        return bad(format!(
            "insufficient balance: have {}, need {}",
            amount_of(asset, have),
            amount_of(asset, need)
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
            "need more than two notes; the largest two hold {} — consolidate first by sending to your own address",
            amount_of(asset, sum)
        ));
    }
    // Guarded already by `sum >= need` above (so this never actually fails) — checked anyway,
    // defence in depth for money arithmetic.
    let change = sum.checked_sub(need).ok_or_else(|| "amounts overflow".to_string())?;
    Ok(Selection { chosen, need: need.to_string(), change: change.to_string() })
}

// ------------------------------------------------------------------ the two groups of one bundle

/// What one group of a bundle's inputs must cover — the guest's balance equation for that group
/// (spec §3.3): `in0 + in1 = out0 + out1 + burn_a` in the asset's slots and
/// `in2 + in3 = out2 + out3 + fee + burn_r` in RAND's. Upstream's `bundle_need`, checked.
fn bundle_need(amount: u64, fee: u64, burn: u64) -> Result<u64> {
    amount
        .checked_add(fee)
        .and_then(|n| n.checked_add(burn))
        .ok_or_else(|| "amount + fee + burn overflows".to_string())
}

/// The notes each of a bundle's two groups spends, largest-first and at most two per group —
/// upstream's `Plan::select`, note-picking half, line for line including its three refusals.
///
/// Slots 0–1 carry `asset` and slots 2–3 carry RAND. A bundle whose asset *is* RAND (`asset == 0`)
/// keeps the old shape: value and fee both from slots 2–3, slots 0–1 dummies, so `a_notes` is
/// empty and the RAND group covers `amount + fee + burn_r`.
///
/// The fee is RAND, always: a token bundle whose wallet holds no spendable RAND is refused here,
/// with the reason, before anything is proved ([`NO_SPENDABLE_RAND`]).
fn select_groups(
    notes: &[OwnedNote],
    asset: u32,
    amount: u64,
    fee: u64,
    burn_a: u64,
    burn_r: u64,
) -> Result<(Vec<OwnedNote>, Vec<OwnedNote>)> {
    if asset == 0 {
        // RAND is burned through `burn_r` only; the ledger refuses a RAND `burn_a`
        // (`NonCanonicalRandBurn`), so a plan that asked for one is this wallet's bug.
        if burn_a != 0 {
            return bad("a RAND burn goes through burn_r, never burn_a");
        }
        let need = bundle_need(amount, fee, burn_r)?;
        return Ok((Vec::new(), select_inputs(notes, 0, need)?.chosen));
    }
    let need_a = bundle_need(amount, 0, burn_a)?;
    if need_a == 0 {
        return bad(format!("a bundle of asset {asset} that neither pays nor burns any of it"));
    }
    let need_r = bundle_need(0, fee, burn_r)?;
    let a_notes = select_inputs(notes, asset, need_a)?.chosen;
    let r_notes = select_rand_fee(notes, need_r)?;
    Ok((a_notes, r_notes))
}

/// The RAND notes of a token bundle's slots 2–3, and the two refusals a wallet without spendable
/// RAND gets. Shared by [`select_groups`] and [`max_sendable`], so the "max" button and the plan
/// behind it can never disagree about whether the fee is payable.
fn select_rand_fee(notes: &[OwnedNote], need_r: u64) -> Result<Vec<OwnedNote>> {
    if spendable_of(notes, 0).is_empty() && need_r > 0 {
        // RAND held back by a submission that has not committed is not spendable yet, but it is
        // not missing either: say which, so the answer is "wait", not "go and get some".
        let pending =
            checked_sum(notes.iter().filter(|n| n.asset == 0 && !n.spent && n.pending.is_some()).map(|n| n.units()))?;
        if pending > 0 {
            return bad(NO_SPENDABLE_RAND_PENDING.replacen("{}", &format_amount(pending), 1));
        }
        return bad(NO_SPENDABLE_RAND);
    }
    Ok(select_inputs(notes, 0, need_r).map_err(|e| format!("the RAND fee: {e}"))?.chosen)
}

/// The asset change (slots 0–1), upstream's `Plan::change_a`. Zero for a RAND bundle, whose change
/// is all [`change_r_of`]. `a_sum` is what the asset group's notes hold.
fn change_a_of(asset: u32, a_sum: u64, amount: u64, burn_a: u64) -> Result<u64> {
    if asset == 0 {
        return Ok(0);
    }
    a_sum
        .checked_sub(bundle_need(amount, 0, burn_a)?)
        .ok_or_else(|| "the chosen notes do not cover the amount and the burn".to_string())
}

/// The RAND change (slots 2–3), upstream's `Plan::change_r`. A RAND bundle pays its `amount` from
/// here too; a token bundle pays only the fee and any RAND burn.
fn change_r_of(asset: u32, r_sum: u64, amount: u64, fee: u64, burn_r: u64) -> Result<u64> {
    let paid_here = if asset == 0 { amount } else { 0 };
    r_sum
        .checked_sub(bundle_need(paid_here, fee, burn_r)?)
        .ok_or_else(|| "the chosen RAND notes do not cover the fee".to_string())
}

/// What a client needs to build one transfer or one burn: which notes each of the bundle's two
/// groups spends and what its numbers come out to, before it ever fetches a witness or opens the
/// prover.
///
/// One shape for both, because since chain 14 they are one bundle with the same two groups:
///
/// * `inputs` are the notes of `asset` (slots 0–1) and `change` is what comes back as a note of
///   `asset`. When `asset` is RAND there is no separate asset group — value and fee share slots
///   2–3 — so `inputs` are the RAND notes and `change` is the RAND change, exactly as before.
/// * `fee_inputs` are the RAND notes that pay the fee from slots 2–3 and `fee_change` is their
///   change. Both are empty/`"0"` for a RAND bundle.
/// * `need` is what `inputs` had to cover: `amount + fee` for RAND, `amount` (or, for a burn, the
///   burned amount) for a token.
/// * `proofs` is 1 — one hidden-asset bundle, one proof, for a transfer and a burn alike — and is
///   reported rather than assumed so a client never hard-codes it.
#[derive(Serialize, Debug)]
pub struct TransferPlan {
    pub inputs: Vec<OwnedNote>,
    pub fee_inputs: Vec<OwnedNote>,
    pub need: String,
    pub change: String,
    pub fee_change: String,
    pub fee: String,
    pub proofs: u8,
}

/// Plan a transfer of `asset` (0 = RAND, ≥ 1 = an RPL or bridged token): pick both groups' notes
/// and compute both changes. Mirrors `Plan::select` with
/// `Spend { asset, to: Some((dest, amount)), fee, burn_a: 0, burn_r: 0 }` — which is what
/// `rand send` builds — so a wallet and the CLI select the same notes for the same transfer.
///
/// A token transfer IS admitted on chain 14 (the hidden-asset bundle: nobody without a key can
/// tell which asset moved), and its fee is RAND from the same proof's slots 2–3.
pub fn plan_transfer(notes: &[OwnedNote], asset: u32, amount: u64, fee: u64) -> Result<TransferPlan> {
    if amount == 0 {
        return bad("amount must be greater than zero");
    }
    if fee < gas::BUNDLE_BASE {
        return bad(format!(
            "fee must be at least {} RAND (the bundle floor)",
            format_amount(gas::BUNDLE_BASE)
        ));
    }
    group_plan(notes, asset, amount, fee, 0, 1)
}

/// The body [`plan_transfer`] and [`plan_burn`] share: select both groups, then derive both
/// changes with the same arithmetic `BundlePlan` uses when it builds the real bundle.
fn group_plan(notes: &[OwnedNote], asset: u32, amount: u64, fee: u64, burn_a: u64, proofs: u8) -> Result<TransferPlan> {
    let (a_notes, r_notes) = select_groups(notes, asset, amount, fee, burn_a, 0)?;
    let a_sum = checked_sum(a_notes.iter().map(|n| n.units()))?;
    let r_sum = checked_sum(r_notes.iter().map(|n| n.units()))?;
    let change_a = change_a_of(asset, a_sum, amount, burn_a)?;
    let change_r = change_r_of(asset, r_sum, amount, fee, 0)?;
    // What `inputs` had to cover, which is the asset group's need for a token and the RAND
    // group's for RAND — the one number a client compares its balance against.
    let need = if asset == 0 { bundle_need(amount, fee, 0)? } else { bundle_need(amount, 0, burn_a)? };
    // For RAND the one group is the RAND group, so its notes are `inputs` and `fee_inputs` is
    // empty: the fee comes out of the very notes `inputs` names, as it always did.
    let (inputs, fee_inputs) = if asset == 0 { (r_notes, Vec::new()) } else { (a_notes, r_notes) };
    let (change, fee_change) = if asset == 0 { (change_r, 0) } else { (change_a, change_r) };
    Ok(TransferPlan {
        inputs,
        fee_inputs,
        need: need.to_string(),
        change: change.to_string(),
        fee_change: fee_change.to_string(),
        fee: fee.to_string(),
        proofs,
    })
}

/// The largest amount one bundle can send, for a client's "max" button.
///
/// * RAND: the sum of the [`BUNDLE_INPUTS`] largest spendable RAND notes minus `fee`, floored at
///   zero rather than erroring (a wallet that cannot cover the fee can still be shown "0").
/// * A token: the sum of the two largest spendable notes *of that token*, with no fee subtracted —
///   the fee is RAND and comes from the other group — except that a wallet whose RAND cannot cover
///   the fee can send none of it at all, which is `"0"` and a `reason`.
///
/// `inputs` is how many notes of `asset` that sum used (0, 1 or `BUNDLE_INPUTS`); `fee_inputs` is
/// how many RAND notes would pay the fee (always 0 for RAND, whose fee comes out of `inputs`).
#[derive(Serialize, Debug)]
pub struct MaxSendable {
    pub amount: String,
    pub fee: String,
    pub inputs: usize,
    pub fee_inputs: usize,
    /// Why `amount` is `"0"` when it is not simply that the wallet is empty — today, only that
    /// the RAND fee cannot be paid. `null` otherwise.
    pub reason: Option<String>,
}

pub fn max_sendable(notes: &[OwnedNote], asset: u32, fee: u64) -> Result<MaxSendable> {
    let candidates: Vec<&OwnedNote> = spendable_of(notes, asset).into_iter().take(BUNDLE_INPUTS).collect();
    let sum = checked_sum(candidates.iter().map(|n| n.units()))?;
    if asset == 0 {
        return Ok(MaxSendable {
            amount: sum.saturating_sub(fee).to_string(),
            fee: fee.to_string(),
            inputs: candidates.len(),
            fee_inputs: 0,
            reason: None,
        });
    }
    // The fee is RAND, from the same proof's slots 2–3: ask the very selection `plan_transfer`
    // will, so "max" and "plan" cannot disagree about whether the fee is payable at all.
    let (amount, fee_inputs, reason) = match select_rand_fee(notes, fee) {
        Ok(rand) => (sum, rand.len(), None),
        Err(e) => (0, 0, Some(e)),
    };
    Ok(MaxSendable {
        amount: amount.to_string(),
        fee: fee.to_string(),
        inputs: if reason.is_some() { 0 } else { candidates.len() },
        fee_inputs,
        reason,
    })
}

// ------------------------------------------------------------------ planning a bridge burn

/// Plan a burn of `amount` units of the bridged asset `asset`, paying `fee` in RAND.
///
/// Since chain 14 a `BridgeBurn` is **one** hidden-asset bundle, exactly like a token transfer:
/// the token is spent from slots 0–1 and destroyed there (`burn_a == amount`,
/// `burn_asset == asset`), the RAND fee is paid from slots 2–3 of the same proof
/// (`burn_r == 0`). So this is [`plan_transfer`]'s own selection with the amount moved from the
/// payment to the burn — upstream's
/// `Spend { asset, to: None, fee, burn_a: amount, burn_r: 0 }` — and it returns the same
/// [`TransferPlan`] shape, with `proofs: 1`.
///
/// The refusals are `submit_burn`'s own, in its order: RAND is not a bridged asset, and a burn of
/// zero moves nothing. The fee floor is this crate's (see [`plan_transfer`], which does the same
/// for `gas::BUNDLE_BASE`): a burn under [`gas::BRIDGE_BURN_FEE`] is refused by the ledger
/// outright (`TxError::FeeTooLow`), and finding that out costs a bundle proof.
///
/// `relayer_fee` is not planned here: it is a *portion* of `amount` carved out on the far side,
/// so it changes nothing this wallet has to select notes for. [`prove_burn`] holds it to
/// `relayer_fee <= amount`, as `submit_burn` does.
pub fn plan_burn(notes: &[OwnedNote], asset: u32, amount: u64, fee: u64) -> Result<TransferPlan> {
    if asset == 0 {
        return bad(RAND_NOT_BRIDGED);
    }
    if amount == 0 {
        return bad("a burn of zero moves nothing");
    }
    if fee < gas::BRIDGE_BURN_FEE {
        return bad(format!(
            "fee must be at least {} RAND (the bridge burn floor)",
            format_amount(gas::BRIDGE_BURN_FEE)
        ));
    }
    // A burn pays nobody inside the pool: `amount = 0`, `burn_a = amount`.
    group_plan(notes, asset, 0, fee, amount, 1)
}

// ------------------------------------------------------------ building one hidden-asset bundle

/// One input of a bundle as the client hands it over: an owned note plus the witness
/// `rand_getWitness` returned for its leaf (32 sibling levels, leaf first).
#[derive(Deserialize)]
pub struct ProveInput {
    pub note: OwnedNote,
    pub path: Vec<String>,
}

/// One input slot of a bundle as the prover takes it: the note's plaintext, the witness path for
/// its leaf (32 sibling levels, leaf first) and its leaf index. A bundle has [`BUNDLE_SLOTS`] of
/// these — the slots a group does not fill are dummies.
type Slot = (Note, [Word8; DEPTH], u32);

/// A fresh random word: a blinding `r`. Upstream's `fresh_word`.
fn fresh_word() -> Word8 {
    SpendKey::random().0
}

fn default_profile() -> String {
    "production".into()
}

/// `ProveRequest`/`BurnRequest`'s amount fields are typed `String` (so a JSON number is already
/// refused at deserialization, before this runs) — this enforces the same `^[0-9]{1,20}$` shape
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

/// Who an output slot pays. Upstream's `Payee`.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Payee {
    /// Someone else (or this wallet by its address): a payment.
    To(ShieldedAddress),
    /// This wallet: change.
    Me,
    /// Nobody: a zero-value dummy whose envelope is sealed to a throwaway key, so it opens to no
    /// one, **the sender included**. A dummy slot must be indistinguishable from a used one, and a
    /// slot this wallet could open would say which slots were real.
    Nobody,
}

/// One hidden-asset bundle as this wallet plans it, before any proof: the notes each group spends,
/// what each output slot pays, and the bundle's four public words. Upstream's `Plan`.
///
/// Slots 0–1 (in and out) carry a **private** asset `A` — a witness word the chain never sees —
/// and slots 2–3 carry RAND and pay the fee. A bundle whose asset is RAND itself (`A = 0`) keeps
/// the pre-chain-14 shape: the value and the fee both in slots 2–3, slots 0–1 dummies.
///
/// The one difference from upstream's `Plan` is that each note arrives with the Merkle path the
/// client fetched for it: this crate does no I/O, so `prepare_bundle`'s anchor-and-witness fetch is
/// the caller's and the paths ride in the request.
struct BundlePlan {
    asset: u32,
    /// Slots 0–1: the notes of `asset`. Empty when `asset` is RAND.
    a_slots: Vec<Slot>,
    /// Slots 2–3: the RAND notes.
    r_slots: Vec<Slot>,
    /// The payment, if the bundle pays anyone: the recipient and the amount, in `asset`. `None`
    /// for a burn, which pays nobody inside the pool.
    to: Option<(ShieldedAddress, u64)>,
    fee: u64,
    /// Burned from the asset's slots (`asset` must then be a token).
    burn_a: u64,
    /// RAND burned from slots 2–3. Always 0 here: this crate builds no `Bond`.
    burn_r: u64,
}

impl BundlePlan {
    fn amount(&self) -> u64 {
        self.to.as_ref().map_or(0, |(_, a)| *a)
    }

    fn a_sum(&self) -> Result<u64> {
        checked_sum(self.a_slots.iter().map(|(n, _, _)| n.amount))
    }

    fn r_sum(&self) -> Result<u64> {
        checked_sum(self.r_slots.iter().map(|(n, _, _)| n.amount))
    }

    /// The asset change (slots 0–1), through the very arithmetic `plan_transfer` reported.
    fn change_a(&self) -> Result<u64> {
        change_a_of(self.asset, self.a_sum()?, self.amount(), self.burn_a)
    }

    /// The RAND change (slots 2–3), through the very arithmetic `plan_transfer` reported.
    fn change_r(&self) -> Result<u64> {
        change_r_of(self.asset, self.r_sum()?, self.amount(), self.fee, self.burn_r)
    }

    /// What each output slot pays, and how much — upstream's `Plan::outputs`, the one place the
    /// slot layout is decided:
    ///
    /// * a RAND bundle is `[nobody, nobody, pay, change_r]`;
    /// * a token bundle is `[pay, change_a, change_r, nobody]`.
    ///
    /// A zero amount is a dummy sealed to nobody, **a change of exactly zero included** — a
    /// zero-value note is worth nothing to keep, and a slot that looked different when a change
    /// happened to be zero would leak that fact.
    fn outputs(&self) -> Result<[(Payee, u64); BUNDLE_SLOTS]> {
        let pay = |amount: u64| match &self.to {
            Some((dest, _)) if amount > 0 => (Payee::To(dest.clone()), amount),
            _ => (Payee::Nobody, 0),
        };
        let mine = |amount: u64| if amount > 0 { (Payee::Me, amount) } else { (Payee::Nobody, 0) };
        Ok(if self.asset == 0 {
            [(Payee::Nobody, 0), (Payee::Nobody, 0), pay(self.amount()), mine(self.change_r()?)]
        } else {
            [pay(self.amount()), mine(self.change_a()?), mine(self.change_r()?), (Payee::Nobody, 0)]
        })
    }

    /// The slot the payment sits in: 2 for a RAND bundle, 0 for a token's. What a client hands out
    /// as the disclosure key for "this payment" ([`ProveResult::payment_slot`]).
    fn payment_slot(&self) -> usize {
        if self.asset == 0 {
            A_SLOTS
        } else {
            0
        }
    }
}

/// A planned bundle with its witness built, its outputs chosen and its envelopes sealed — every
/// field of the bundle but its proof, which is left empty. Upstream's `Prepared`.
///
/// A bundle is proved only once the whole transaction around it exists: its proof carries
/// [`Transaction::binding`] as its public input segment, and the binding covers every field of the
/// transaction except the proof — the action, the four envelopes, the chain id. So the wallet
/// builds the transaction from this first, takes its binding, and then proves
/// ([`prove_transaction`]).
struct Prepared {
    /// The bundle, `proof` empty.
    bundle: Bundle,
    /// The guest's private inputs (`hidden::hidden_bundle_inputs`).
    words: Vec<u32>,
    /// The digest this wallet computed from its own plaintext, which the proof must publish.
    expected: Word8,
    /// One fresh per-transaction key per envelope, in slot order.
    tx_keys: [TxKey; BUNDLE_SLOTS],
    change_a: u64,
    change_r: u64,
}

/// Build one hidden-asset bundle from a plan, the anchor and the bundle's `time` — upstream's
/// `build_bundle`, line for line.
///
/// Every slot the plan does not fill is a dummy: a zero-value input under this wallet's own key
/// carrying that slot's asset (`hidden::slot_asset`), and a zero-value output to a throwaway key,
/// **each with a fresh blinding** — two identical dummies would repeat a nullifier or a commitment
/// and taint the proof (spec §3.3), and a repeated one across transactions would be refused as
/// spent. Every output envelope is sealed under its own fresh transaction key.
fn build_bundle(w: &Wallet, plan: &BundlePlan, anchor: Word8, time: u32) -> Result<Prepared> {
    let pk_self = w.vk.pk();
    let asset = plan.asset;
    // The guest stages every input under this wallet's key, and asserts on one that is not; the
    // callers (`group_slots`) already refuse a foreign note, so this is defence in depth.
    let slot_input = |k: usize, spent: Option<&Slot>| -> Result<Slot> {
        match spent {
            Some(s) => {
                if s.0.pk != pk_self {
                    return bad("a note in this bundle is not owned by this wallet's key");
                }
                Ok(*s)
            }
            None => Ok((Note::new(pk_self, [0; 8], 0, hidden::slot_asset(k, asset), time), [[0u32; 8]; DEPTH], 0)),
        }
    };
    let inputs: [Slot; BUNDLE_SLOTS] = [
        slot_input(0, plan.a_slots.first())?,
        slot_input(1, plan.a_slots.get(1))?,
        slot_input(2, plan.r_slots.first())?,
        slot_input(3, plan.r_slots.get(1))?,
    ];

    let mut outs = [HiddenOutput { pk: [0; 8], amount: 0, r: [0; 8] }; BUNDLE_SLOTS];
    let mut envelopes: Vec<Envelope> = Vec::with_capacity(BUNDLE_SLOTS);
    let mut commitments = [[0u32; 8]; BUNDLE_SLOTS];
    let mut keys: Vec<TxKey> = Vec::with_capacity(BUNDLE_SLOTS);
    for (k, (payee, amount)) in plan.outputs()?.into_iter().enumerate() {
        // The throwaway key a dummy is sealed to — and owned by — exists only for this call and is
        // dropped with it, so nobody, this wallet included, can ever open that envelope.
        let nobody = matches!(payee, Payee::Nobody).then(Wallet::generate);
        let pk = match (&payee, &nobody) {
            (Payee::To(dest), _) => dest.pk,
            (Payee::Me, _) => pk_self,
            (Payee::Nobody, Some(t)) => t.vk.pk(),
            (Payee::Nobody, None) => return bad("a throwaway key for every dummy (wallet bug)"),
        };
        outs[k] = HiddenOutput { pk, amount, r: fresh_word() };
        // The guest commits every output with `from = pk_self`, its slot's asset and the bundle's
        // time, so the note the wallet seals is derived from the witness rather than restated.
        let note = outs[k].note(k, pk_self, asset, time);
        commitments[k] = note.commitment();
        let key = TxKey::random();
        let sealed = match (&payee, &nobody) {
            (Payee::To(dest), _) => seal_note(&w.vk, dest, &note, &key),
            (Payee::Me, _) => seal_note(&w.vk, &w.address, &note, &key),
            (Payee::Nobody, Some(t)) => seal_note(&t.vk, &t.address, &note, &key),
            (Payee::Nobody, None) => return bad("a throwaway key for every dummy (wallet bug)"),
        };
        envelopes.push(sealed.map_err(|e| format!("sealing output {k}'s envelope: {e}"))?);
        keys.push(key);
    }
    let nullifiers: [Word8; BUNDLE_SLOTS] = std::array::from_fn(|k| w.vk.nullifier(&inputs[k].0.commitment()));
    // The ledger refuses a repeated nullifier or commitment and the guest taints on one; with a
    // fresh blinding per slot neither can happen, so one here is a bug worth stopping on before a
    // proof is paid for.
    for i in 0..BUNDLE_SLOTS {
        for j in i + 1..BUNDLE_SLOTS {
            if nullifiers[i] == nullifiers[j] || commitments[i] == commitments[j] {
                return bad(format!("slots {i} and {j} repeat a nullifier or a commitment (wallet bug)"));
            }
        }
    }
    // A burn is a public boundary, so it names its asset; everything else publishes 0, which the
    // ledger requires of every non-burning action (`TxError::UnsupportedAsset`).
    let burn_asset = if plan.burn_a != 0 { asset } else { 0 };
    let expected = hidden::hidden_bundle_digest(&HiddenDigestInput {
        anchor,
        nullifiers,
        commitments,
        fee: plan.fee,
        burn_a: plan.burn_a,
        burn_r: plan.burn_r,
        burn_asset,
        time,
    });
    let words =
        hidden::hidden_bundle_inputs(&w.sk, &inputs, &outs, anchor, plan.fee, plan.burn_a, plan.burn_r, asset, time);
    let envelopes: [Envelope; BUNDLE_SLOTS] =
        envelopes.try_into().map_err(|_| "a bundle has four envelopes".to_string())?;
    let tx_keys: [TxKey; BUNDLE_SLOTS] =
        keys.try_into().map_err(|_| "a bundle has four transaction keys".to_string())?;
    let bundle = Bundle {
        anchor,
        nullifiers,
        commitments,
        fee: plan.fee,
        burn_a: plan.burn_a,
        burn_r: plan.burn_r,
        burn_asset,
        time,
        envelopes,
        proof: Vec::new(),
    };
    Ok(Prepared { bundle, words, expected, tx_keys, change_a: plan.change_a()?, change_r: plan.change_r()? })
}

/// Prove `tx`'s one bundle against `tx`'s own binding, in place — upstream's `prove_transaction`.
///
/// **The order is load-bearing.** The binding is taken with the proof still empty, because a proof
/// cannot commit to itself: `Transaction::binding` blanks every proof byte string before hashing,
/// so filling the proof in afterwards cannot move it (asserted here in a debug build, as upstream
/// does). Prove first and bind afterwards and the proof would be made over a binding the chain
/// never recomputes.
///
/// This is the slow call — a tier-14 hidden-asset bundle proof takes on the order of a minute and a
/// half on a laptop CPU and peaks at [`PROVER_PEAK_MEMORY_BYTES`], so a client runs it off the UI
/// thread and never two at once. Returns the tier and the proof's size.
fn prove_transaction(tx: &mut Transaction, prepared: &Prepared, profile: FriProfile) -> Result<(u8, usize)> {
    let binding: [u32; TX_BINDING_WORDS] = tx.binding();
    let (proof, digest, tier) = prove_bundle(profile, &prepared.words, &binding, Backend::Cpu)
        .map_err(|e| format!("proving failed: {e}"))?;
    // The guest taints its digest instead of failing when a witness violates the relation, so a
    // proof that does not publish the digest this wallet computed from its own plaintext is a bug
    // here, not something the node could explain.
    if digest != prepared.expected {
        return bad("the proof published a digest this wallet did not build; refusing to submit (wallet bug)");
    }
    let proof_bytes = proof.len();
    tx.bundle.as_mut().ok_or("a shielded transaction has a bundle")?.proof = proof;
    debug_assert_eq!(tx.binding(), binding, "filling the proof in never moves the binding");
    Ok((tier, proof_bytes))
}

/// The `(note, path, leaf index)` slots one group of a bundle spends, with each note checked to be
/// this wallet's, of that group's asset, and worth something. Returns the slots, the leaf indices
/// and the total the notes hold.
fn group_slots(w: &Wallet, inputs: &[ProveInput], asset: u32) -> Result<(Vec<Slot>, Vec<u64>, u64)> {
    if inputs.len() > BUNDLE_INPUTS {
        return bad(format!("a group of a bundle spends one or two notes, not {}", inputs.len()));
    }
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
                "note at leaf {} holds asset {}, but this group spends asset {asset}",
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

// ------------------------------------------------------------------ proving a transfer

#[derive(Deserialize)]
pub struct ProveRequest {
    pub spend_key: String,
    pub chain_id: u64,
    /// Recipient `rand1…` address.
    pub to: String,
    /// Units of `asset`, decimal string.
    pub amount: String,
    /// RAND units, decimal string. The floor for a transfer is `gas::BUNDLE_BASE`.
    pub fee: String,
    /// The asset being transferred: 0 (RAND) or a registry index. **Optional, defaulting to 0**,
    /// so a request shaped as the pre-chain-14 clients send it is still a RAND transfer.
    #[serde(default)]
    pub asset: u32,
    /// The head anchor: `rand_getAnchor` with no height.
    pub anchor_height: u64,
    pub anchor_root: String,
    /// One or two notes of `asset` (slots 0–1 for a token, slots 2–3 for RAND); the witness roots
    /// must equal `anchor_root`.
    pub inputs: Vec<ProveInput>,
    /// One or two RAND notes for the fee (slots 2–3), when `asset >= 1`. **Optional and empty for
    /// a RAND transfer**, whose fee comes out of `inputs`.
    #[serde(default)]
    pub fee_inputs: Vec<ProveInput>,
    /// `"production"` (chain 14) or `"test"`.
    #[serde(default = "default_profile")]
    pub profile: String,
}

#[derive(Serialize)]
pub struct ProveResult {
    /// `bincode(Transaction)` as hex — the parameter of `rand_sendTransaction`.
    pub tx_hex: String,
    /// The transaction hash the node will report.
    pub hash: String,
    pub time: u32,
    pub asset: u32,
    /// Units of `asset`.
    pub amount: String,
    /// Change in units of `asset`, back to this wallet. For a RAND transfer this is the RAND
    /// change, exactly as before.
    pub change: String,
    /// RAND change from the fee slots when `asset` is a token; `"0"` when `asset` is RAND, whose
    /// change is `change`.
    pub fee_change: String,
    pub fee: String,
    pub tier: u8,
    pub proof_bytes: usize,
    pub tx_bytes: usize,
    /// One per slot, in slot order.
    pub nullifiers: [String; BUNDLE_SLOTS],
    pub commitments: [String; BUNDLE_SLOTS],
    /// The per-slot disclosure keys, in slot order. Handing out `tx_keys[payment_slot]` discloses
    /// exactly the payment (randscan.org opens it); the dummy slots' keys open envelopes sealed to
    /// a throwaway key and are worth nothing to anybody.
    pub tx_keys: [String; BUNDLE_SLOTS],
    /// Which slot the payment sits in: 2 for a RAND transfer, 0 for a token's.
    pub payment_slot: usize,
    /// Leaf indices of the notes this bundle spends — the asset group's, then the RAND group's —
    /// for the client to mark `pending`.
    pub spent_indices: Vec<u64>,
    /// 1. One hidden-asset bundle, one proof.
    pub proofs: u8,
}

/// Everything [`prove_transfer`] does except the proof: parse, check, select the slots, build the
/// bundle and assemble the transaction with its proof empty. Split out so the shape the ledger
/// checks — the slot layout, the burn words, the fee — is testable in milliseconds rather than the
/// ~100 s a real proof costs.
struct TransferBuild {
    plan: BundlePlan,
    prepared: Prepared,
    /// The transaction, its bundle's proof still empty. [`prove_transaction`] fills it in.
    tx: Transaction,
    asset: u32,
    amount: u64,
    fee: u64,
    time: u32,
    spent_indices: Vec<u64>,
    profile: FriProfile,
    proofs: u8,
}

fn build_transfer_unproven(req: &ProveRequest) -> Result<(Wallet, TransferBuild)> {
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
    if req.inputs.is_empty() {
        return bad("a bundle spends one or two notes");
    }
    let root = word8_from_hex(&req.anchor_root).ok_or("anchor_root is not 64 hex characters")?;
    let time = u32::try_from(req.anchor_height).map_err(|_| "anchor height does not fit a bundle's time field")?;
    let profile = profile_from_str(&req.profile)?;

    // Which group `inputs` belongs to is what `asset` decides — the whole difference between the
    // two shapes, and the reason a request with neither new field is still a RAND transfer.
    let (a_slots, a_spent, a_held, r_slots, r_spent, r_held) = if req.asset == 0 {
        if !req.fee_inputs.is_empty() {
            return bad(
                "a RAND transfer pays its fee out of the notes in `inputs`; `fee_inputs` names the RAND notes of \
                 a transfer of a token",
            );
        }
        let (r, spent, held) = group_slots(&w, &req.inputs, 0)?;
        (Vec::new(), Vec::new(), 0u64, r, spent, held)
    } else {
        if req.fee_inputs.is_empty() {
            return bad(format!(
                "a transfer of asset {} pays its fee in RAND: name one or two RAND notes in `fee_inputs`",
                req.asset
            ));
        }
        let (a, a_spent, a_held) = group_slots(&w, &req.inputs, req.asset)?;
        let (r, r_spent, r_held) = group_slots(&w, &req.fee_inputs, 0)?;
        (a, a_spent, a_held, r, r_spent, r_held)
    };

    // The guest's balance equation per group, checked here so a shortfall costs no proof.
    if req.asset == 0 {
        let need = bundle_need(amount, fee, 0)?;
        if r_held < need {
            return bad(format!(
                "inputs hold {}, but amount + fee is {}",
                amount_of(0, r_held),
                amount_of(0, need)
            ));
        }
    } else {
        if a_held < amount {
            return bad(format!(
                "the notes of asset {} hold {a_held} units, but the transfer is {amount}",
                req.asset
            ));
        }
        if r_held < fee {
            return bad(format!(
                "the RAND notes hold {}, but the fee is {}",
                amount_of(0, r_held),
                amount_of(0, fee)
            ));
        }
    }

    let plan = BundlePlan { asset: req.asset, a_slots, r_slots, to: Some((dest, amount)), fee, burn_a: 0, burn_r: 0 };
    let prepared = build_bundle(&w, &plan, root, time)?;
    // The whole transaction first, its bundle's proof empty; then the proof, bound to it.
    let tx = Transaction::shielded(req.chain_id, prepared.bundle.clone(), Action::None);
    let spent_indices = a_spent.into_iter().chain(r_spent).collect();
    Ok((
        w,
        TransferBuild { plan, prepared, tx, asset: req.asset, amount, fee, time, spent_indices, profile, proofs: 1 },
    ))
}

/// Build, prove and encode a plain shielded transfer (`Action::None`) of RAND or of any registry
/// token. Since chain 14 both are the same transaction: one hidden-asset bundle whose asset is a
/// witness word the chain never sees, so nobody without a key can tell which moved.
///
/// This is the slow call — see `prove_transaction`. Nothing is submitted.
pub fn prove_transfer(req: &ProveRequest) -> Result<ProveResult> {
    let (_w, mut b) = build_transfer_unproven(req)?;
    let (tier, proof_bytes) = prove_transaction(&mut b.tx, &b.prepared, b.profile)?;

    let bundle = &b.prepared.bundle;
    let nullifiers = std::array::from_fn(|k| word8_to_hex(&bundle.nullifiers[k]));
    let commitments = std::array::from_fn(|k| word8_to_hex(&bundle.commitments[k]));
    let tx_keys = std::array::from_fn(|k| hex::encode(b.prepared.tx_keys[k].0));
    let payment_slot = b.plan.payment_slot();
    let (change, fee_change) =
        if b.asset == 0 { (b.prepared.change_r, 0) } else { (b.prepared.change_a, b.prepared.change_r) };
    let encoded = b.tx.encode();
    Ok(ProveResult {
        hash: b.tx.hash().to_hex(),
        tx_bytes: encoded.len(),
        tx_hex: hex::encode(encoded),
        time: b.time,
        asset: b.asset,
        amount: b.amount.to_string(),
        change: change.to_string(),
        fee_change: fee_change.to_string(),
        fee: b.fee.to_string(),
        tier,
        proof_bytes,
        nullifiers,
        commitments,
        tx_keys,
        payment_slot,
        spent_indices: b.spent_indices,
        proofs: b.proofs,
    })
}

// ------------------------------------------------------------------ proving a bridge burn

/// What [`prove_burn`] takes. Mirrors [`ProveRequest`] wherever a burn allows; the differences are,
/// in full:
///
/// - no `to` shielded address — a burn pays nobody inside the pool. The destination lives in
///   `to_chain`/`to`, which are the *far* chain's, not this one's;
/// - `token` and `to` are 64 hex characters of **plain bytes** (`Action::BridgeBurn`'s fields are
///   `[u8; 32]`), not `Word8`s — do not read either with `word8_from_hex`, which is little-endian
///   word by word. Upstream parses the same strings with `randprotocol_client::hex32`, which is
///   `hex::decode` into `[u8; 32]`, and `parse_bytes32` matches it;
/// - `asset`, `amount` and `relayer_fee` are the burn's own, all in units of `asset`;
/// - `inputs` are notes of `asset` (slots 0–1, where the burn destroys them) and `fee_inputs` are
///   RAND notes (slots 2–3, which pay the fee), one or two of each, all witnessed against the same
///   `anchor_root` — **one bundle, one proof**, unlike chain 13's two.
#[derive(Deserialize)]
pub struct BurnRequest {
    pub spend_key: String,
    pub chain_id: u64,
    /// The registry index of the bridged token being burned. Never 0: see [`RAND_NOT_BRIDGED`].
    pub asset: u32,
    /// Units of `asset`, decimal string. The bundle burns exactly this through `burn_a`.
    pub amount: String,
    /// Units of `asset`, decimal string: the portion of `amount` the relayer keeps on the far
    /// side. A portion, never an addition — the release contract pays out `amount` in total, so
    /// burning `amount + relayer_fee` would strand the difference there forever.
    pub relayer_fee: String,
    /// The destination chain's bridge id (2, 3, 4 are the EVM/TVM chains; 5 is Solana).
    pub to_chain: u16,
    /// **New on chain 14.** The source-chain coin being redeemed, 32 plain bytes as 64 hex
    /// characters. One bridged token has several backings (zUSD is seven), so a burn names the coin
    /// it redeems and `(to_chain, token)` must be one of that asset's backings — otherwise the
    /// ledger refuses it `NotABacking`.
    pub token: String,
    /// The 32-byte recipient on `to_chain`, 64 hex characters of plain bytes (an EVM address is its
    /// 20 bytes left-padded with 12 zeros).
    pub to: String,
    /// RAND units, decimal string. The floor is `gas::BRIDGE_BURN_FEE`.
    pub fee: String,
    /// The head anchor: `rand_getAnchor` with no height.
    pub anchor_height: u64,
    pub anchor_root: String,
    /// One or two notes of `asset`; the witness roots must equal `anchor_root`.
    pub inputs: Vec<ProveInput>,
    /// One or two RAND notes for the fee; the witness roots must equal `anchor_root`.
    pub fee_inputs: Vec<ProveInput>,
    /// `"production"` (chain 14) or `"test"`.
    #[serde(default = "default_profile")]
    pub profile: String,
}

/// What [`prove_burn`] returns. One bundle, so every array is slot-ordered exactly as
/// [`ProveResult`]'s: slots 0–1 are the token's, slots 2–3 the RAND fee's.
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
    /// The redeemed coin, normalized (lower case, no `0x`).
    pub token: String,
    /// The recipient on `to_chain`, normalized (lower case, no `0x`).
    pub to: String,
    /// Change in units of `asset`, back to this wallet.
    pub change: String,
    /// The RAND fee the bundle paid.
    pub fee: String,
    /// Change in RAND units, back to this wallet.
    pub fee_change: String,
    pub tier: u8,
    pub proof_bytes: usize,
    pub tx_bytes: usize,
    pub nullifiers: [String; BUNDLE_SLOTS],
    pub commitments: [String; BUNDLE_SLOTS],
    pub tx_keys: [String; BUNDLE_SLOTS],
    /// Leaf indices of every note this transaction spends — the token group's, then the RAND
    /// group's — for the client to mark `pending`.
    pub spent_indices: Vec<u64>,
    /// 1. Chain 13 proved a burn twice; chain 14 proves it once.
    pub proofs: u8,
}

/// 32 bytes of plain hex — `Action::BridgeBurn`'s `token` and `to` — exactly as
/// `randprotocol_client::hex32` reads the same strings off the `rand bridge-burn` flags. A `0x`
/// prefix and upper case are accepted and normalized away; the byte order is never touched.
fn parse_bytes32(s: &str, what: &str) -> Result<[u8; 32]> {
    let s = s.trim();
    let bytes = hex::decode(s.strip_prefix("0x").unwrap_or(s)).map_err(|_| format!("{what} is not hex"))?;
    bytes.try_into().map_err(|v: Vec<u8>| format!("{what} must be 32 bytes (64 hex characters), got {}", v.len()))
}

/// A burn's one bundle, built and sealed but not proved, with everything the action needs.
struct BurnBuild {
    plan: BundlePlan,
    prepared: Prepared,
    /// The transaction, its bundle's proof still empty.
    tx: Transaction,
    asset: u32,
    amount: u64,
    relayer_fee: u64,
    fee: u64,
    token: [u8; 32],
    to: [u8; 32],
    time: u32,
    spent_indices: Vec<u64>,
    profile: FriProfile,
    proofs: u8,
}

/// Everything [`prove_burn`] does except the proof. Split out so the shape the ledger checks is
/// testable in milliseconds rather than minutes.
///
/// Mirrors `randprotocol_client::wallet::submit_burn_with`: the three refusals before anything is
/// built, then `Spend { asset, to: None, fee, burn_a: amount, burn_r: 0 }` — one bundle that spends
/// the token in slots 0–1 and burns exactly `amount` of it, paying the RAND fee from slots 2–3.
///
/// Deliberately *not* restated here, because the bridge owns them and only the chain can answer
/// them: that the chain has a bridge and a token registry at all, that `asset` is a bridged token,
/// that `(to_chain, token)` backs it, that the coin is holding enough and that `amount` is a whole
/// number of its release unit. Those are [`burn_is_possible`], which takes a
/// `rand_getBridgeState` reply the client fetched — run it before calling this, as `submit_burn`
/// does, or a typo costs a proof for a transaction the chain refuses outright.
fn build_burn_unproven(req: &BurnRequest) -> Result<(Wallet, BurnBuild)> {
    let w = Wallet::from_hex(&req.spend_key)?;
    let amount = parse_units(&req.amount, "amount")?;
    let relayer_fee = parse_units(&req.relayer_fee, "relayer_fee")?;
    let fee = parse_units(&req.fee, "fee")?;
    let token = parse_bytes32(&req.token, "token")?;
    let to = parse_bytes32(&req.to, "to")?;
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
    // refuses the transaction outright (`TxError::FeeTooLow`), after a proof.
    if fee < gas::BRIDGE_BURN_FEE {
        return bad(format!("fee {} is below the bridge burn floor {}", fee, gas::BRIDGE_BURN_FEE));
    }
    if req.inputs.is_empty() {
        return bad(format!("a burn spends one or two notes of asset {}", req.asset));
    }
    if req.fee_inputs.is_empty() {
        return bad("a burn pays its fee in RAND: name one or two RAND notes in `fee_inputs`");
    }
    let root = word8_from_hex(&req.anchor_root).ok_or("anchor_root is not 64 hex characters")?;
    let time = u32::try_from(req.anchor_height).map_err(|_| "anchor height does not fit a bundle's time field")?;
    let profile = profile_from_str(&req.profile)?;

    let (a_slots, a_spent, a_held) = group_slots(&w, &req.inputs, req.asset)?;
    let (r_slots, r_spent, r_held) = group_slots(&w, &req.fee_inputs, 0)?;
    if a_held < amount {
        return bad(format!("the notes of asset {} hold {a_held} units, but the burn is {amount}", req.asset));
    }
    if r_held < fee {
        return bad(format!("the RAND notes hold {}, but the fee is {}", amount_of(0, r_held), amount_of(0, fee)));
    }

    // A burn pays nobody inside the pool: `to: None`, and the amount moves to `burn_a`.
    let plan = BundlePlan { asset: req.asset, a_slots, r_slots, to: None, fee, burn_a: amount, burn_r: 0 };
    let prepared = build_bundle(&w, &plan, root, time)?;
    let action = Action::BridgeBurn {
        asset: req.asset,
        amount,
        relayer_fee,
        to_chain: req.to_chain,
        token,
        to,
    };
    let tx = Transaction::shielded(req.chain_id, prepared.bundle.clone(), action);
    let spent_indices = a_spent.into_iter().chain(r_spent).collect();
    Ok((
        w,
        BurnBuild {
            plan,
            prepared,
            tx,
            asset: req.asset,
            amount,
            relayer_fee,
            fee,
            token,
            to,
            time,
            spent_indices,
            profile,
            proofs: 1,
        },
    ))
}

/// Build, prove and encode a bridge withdrawal (`Action::BridgeBurn`).
///
/// **One bundle and one proof** since chain 14 (the hidden-asset bundle, spec §3.7): the token is
/// spent from slots 0–1 and destroyed there, the RAND fee is paid from slots 2–3 of the same proof.
/// Chain 13's two-bundle burn — and its doubled cost — is gone. Nothing is submitted.
pub fn prove_burn(req: &BurnRequest) -> Result<BurnResult> {
    let (_w, mut b) = build_burn_unproven(req)?;
    let (tier, proof_bytes) = prove_transaction(&mut b.tx, &b.prepared, b.profile)?;

    let bundle = &b.prepared.bundle;
    let nullifiers = std::array::from_fn(|k| word8_to_hex(&bundle.nullifiers[k]));
    let commitments = std::array::from_fn(|k| word8_to_hex(&bundle.commitments[k]));
    let tx_keys = std::array::from_fn(|k| hex::encode(b.prepared.tx_keys[k].0));
    let _ = &b.plan;
    let encoded = b.tx.encode();
    Ok(BurnResult {
        hash: b.tx.hash().to_hex(),
        tx_bytes: encoded.len(),
        tx_hex: hex::encode(encoded),
        time: b.time,
        asset: b.asset,
        amount: b.amount.to_string(),
        relayer_fee: b.relayer_fee.to_string(),
        to_chain: req.to_chain,
        token: hex::encode(b.token),
        to: hex::encode(b.to),
        change: b.prepared.change_a.to_string(),
        fee: b.fee.to_string(),
        fee_change: b.prepared.change_r.to_string(),
        tier,
        proof_bytes,
        nullifiers,
        commitments,
        tx_keys,
        spent_indices: b.spent_indices,
        proofs: b.proofs,
    })
}

// ------------------------------------------------- what only the chain knows about a burn

/// The four facts about the chain a burn needs before any proving — upstream's `burn_is_possible`
/// (`randprotocol_client::wallet`), ported whole, with the one `rand_getBridgeState` reply the
/// caller already fetched handed in as a parameter instead of read here (this crate does no I/O).
///
/// None of them is something a wallet can know locally, and getting any of them wrong costs a
/// bundle proof — a minute and a half of a laptop — for a transaction the ledger refuses outright:
/// `Bridge(Disabled)` for a chain with no bridge, `Bridge(UnknownAsset)` for an index nothing was
/// registered under, `NotABacking` for a coin that does not back it, `NotReleasable` for an amount
/// or fee that is not a whole release unit, and `InsufficientBacking` for a coin that does back it
/// but is not holding enough.
///
/// **A client must call this before [`prove_burn`].** The `locked` check is the one the zUSD
/// amendment added (spec §12): one bridged token is backed by several coins, so a burn may be well
/// within the token's supply and still more than the chain it names is holding.
///
/// Deliberately not the rest of `BridgeState::check_burn` — the recipient must be shaped for the
/// destination chain — which is the bridge's own policy and stays stated in one place.
pub fn burn_is_possible(
    bridge_state: &Value,
    asset: u32,
    to_chain: u16,
    token: &[u8; 32],
    amount: u64,
    relayer_fee: u64,
) -> Result<()> {
    if bridge_state["enabled"] != Value::Bool(true) {
        return bad("this chain has no bridge, so there is nothing to burn to");
    }
    let rows = bridge_state["assets"].as_array().ok_or("bridge state has no asset registry")?;
    let of_asset: Vec<&Value> = rows.iter().filter(|r| r["index"].as_u64() == Some(asset as u64)).collect();
    if of_asset.is_empty() {
        let known: Vec<String> = rows.iter().filter_map(|r| r["index"].as_u64()).map(|i| i.to_string()).collect();
        return bad(format!(
            "asset {asset} is not in this chain's registry, so no note of it was ever deposited{}",
            if known.is_empty() {
                " (the registry is empty)".to_string()
            } else {
                format!(" (registered: {})", known.join(", "))
            }
        ));
    }
    let hex_token = hex::encode(token);
    let Some(backing) = of_asset
        .iter()
        .find(|r| r["chain"].as_u64() == Some(to_chain as u64) && r["token"].as_str() == Some(hex_token.as_str()))
    else {
        let coins: Vec<String> = of_asset
            .iter()
            .filter_map(|r| Some(format!("chain {} token {}", r["chain"].as_u64()?, r["token"].as_str()?)))
            .collect();
        return bad(format!(
            "coin {hex_token} on chain {to_chain} does not back asset {asset}; its backings are: {}",
            coins.join(", ")
        ));
    };
    // The release unit, from the coin's own declared decimals. Derived through the chain's own
    // `tokens::release_unit` rather than by a second `10^(8-d)` written here, so the wallet and the
    // ledger can never disagree about what a whole unit is.
    let decimals = backing["decimals"].as_u64().ok_or("an asset row without the coin's decimals")?;
    let decimals = u8::try_from(decimals).map_err(|_| "an asset row whose decimals is not a byte")?;
    let unit = randprotocol_core::ledger::tokens::release_unit(decimals);
    if !amount.is_multiple_of(unit) || !relayer_fee.is_multiple_of(unit) {
        return bad(format!(
            "{hex_token} on chain {to_chain} has {decimals} decimals: \
             the amount and the relayer fee must be multiples of {unit}"
        ));
    }
    // `amount_field`, not `as_u64`: the node renders every amount as a decimal string since chain
    // 14, and an older one as a number. Both are read here, exactly as upstream does.
    let locked = amount_field(&backing["locked"]).ok_or("an asset row without a locked amount")?;
    if amount > locked {
        return bad(format!(
            "only {locked} is locked in that coin on chain {to_chain}; choose another backing or a smaller amount"
        ));
    }
    Ok(())
}

/// A `u64` off the wire: a decimal string since chain 14, a JSON number on an older node. Upstream's
/// `randprotocol_client::amount_field`, verbatim — the one place this crate reads a *node-rendered*
/// amount, as opposed to a parameter of its own API (which is always a string, see [`amount_param`]).
fn amount_field(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
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

/// A complete, valid `prove_transfer` request against a two-leaf tree built in memory.
///
/// * `asset == 0`: a fresh sender holding 2 RAND at **leaf 0** and 3 RAND at **leaf 1** pays 1 RAND
///   to a fresh recipient, spending both notes — so slots 2-3 are both real and slots 0-1 are both
///   dummies.
/// * `asset >= 1`: a fresh sender holding 500 units of that token at **leaf 0** and 3 RAND at
///   **leaf 1** pays 100 of the token, with the RAND note paying the fee from slots 2-3.
///
/// Lets every client exercise the whole proving path (and time it on its own hardware) without a
/// node. Never used for a real transfer: the anchor exists on no chain.
///
/// The leaves are laid out so a caller can rebuild the very tree they were witnessed against from
/// the request alone — every leaf index is in the request and they are 0 and 1 — which is what
/// `examples/prove_fixture.rs` relies on to put the proved transaction in front of
/// `Ledger::validate`.
pub fn fixture_prove_request(profile: &str, asset: u32) -> Result<Value> {
    use randprotocol_core::notes::FullTree;
    profile_from_str(profile)?;
    let sender = Wallet::generate();
    let recipient = Wallet::generate();
    let exec = randprotocol_zkvm::executor::ZkExecutor::new(FriProfile::Test);
    let rand_note = Note::new(sender.vk.pk(), [0; 8], 3 * UNITS_PER_RAND, 0, 1);
    if asset == 0 {
        // Both leaves are the sender's own and both are spent, so appending `inputs` in leaf-index
        // order reproduces `anchor_root` exactly — which is what `prove_fixture` needs to reach
        // `Ledger::validate`, and what the token and burn fixtures below already did.
        let second = Note::new(sender.vk.pk(), [0; 8], 2 * UNITS_PER_RAND, 0, 1);
        let tree = FullTree::new(vec![second.commitment(), rand_note.commitment()], &exec);
        let path = |i: u64| -> Result<Vec<String>> {
            Ok(tree.path(i).ok_or("fixture tree")?.iter().map(word8_to_hex).collect())
        };
        return Ok(json!({
            "spend_key": sender.spend_key_hex(),
            "chain_id": DEFAULT_CHAIN_ID,
            "to": recipient.address.to_string(),
            "asset": 0,
            "amount": UNITS_PER_RAND.to_string(),
            "fee": gas::BUNDLE_BASE.to_string(),
            "anchor_height": 40,
            "anchor_root": word8_to_hex(&tree.root()),
            "inputs": [
                { "note": owned_note(&sender, 0, 1, second.commitment(), second), "path": path(0)? },
                { "note": owned_note(&sender, 1, 1, rand_note.commitment(), rand_note), "path": path(1)? },
            ],
            "fee_inputs": [],
            "profile": profile,
        }));
    }
    let token_note = Note::new(sender.vk.pk(), [0; 8], FIXTURE_TOKEN_HELD, asset, 1);
    let tree = FullTree::new(vec![token_note.commitment(), rand_note.commitment()], &exec);
    let path = |i: u64| -> Result<Vec<String>> { Ok(tree.path(i).ok_or("fixture tree")?.iter().map(word8_to_hex).collect()) };
    Ok(json!({
        "spend_key": sender.spend_key_hex(),
        "chain_id": DEFAULT_CHAIN_ID,
        "to": recipient.address.to_string(),
        "asset": asset,
        "amount": FIXTURE_TOKEN_SENT.to_string(),
        "fee": gas::BUNDLE_BASE.to_string(),
        "anchor_height": 40,
        "anchor_root": word8_to_hex(&tree.root()),
        "inputs": [{ "note": owned_note(&sender, 0, 1, token_note.commitment(), token_note), "path": path(0)? }],
        "fee_inputs": [{ "note": owned_note(&sender, 1, 1, rand_note.commitment(), rand_note), "path": path(1)? }],
        "profile": profile,
    }))
}

/// The fixture burn's bridged asset, destination chain, redeemed coin and recipient. An EVM chain
/// (2) and a 20-byte address left-padded to 32, because that is the one recipient shape
/// `BridgeState::check_burn` screens for; the asset index is the first one a registry ever hands
/// out (`FIRST_TOKEN_INDEX`).
const FIXTURE_BURN_ASSET: u32 = 1;
const FIXTURE_BURN_TO_CHAIN: u16 = 2;
const FIXTURE_BURN_AMOUNT: u64 = 400;
const FIXTURE_BURN_RELAYER_FEE: u64 = 100;
/// The coin the fixture burn redeems. Asymmetric on purpose: a `token` that scrambled under a
/// per-word byte reversal would still round-trip if every four-byte group were uniform.
const FIXTURE_BURN_TOKEN: [u8; 32] = [
    0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x01, 0x02, 0x03, 0x04, 0x05,
    0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12,
];
/// What the token fixtures hold and move, in the token's own units.
const FIXTURE_TOKEN_HELD: u64 = 500;
const FIXTURE_TOKEN_SENT: u64 = 100;

/// A complete, valid [`prove_burn`] request against a two-leaf tree built in memory: a fresh
/// wallet holding 500 units of the bridged token at index 1 (leaf 0) and 3 RAND (leaf 1), burning
/// 400 of the token to an EVM chain, 100 of which pays the relayer there, and paying
/// `BRIDGE_BURN_FEE` out of the RAND note.
///
/// Lets a client exercise the whole burn path — and time **one** proof on its own hardware —
/// without a node. Never used for a real burn: the anchor exists on no chain, and neither does the
/// token.
///
/// The two leaves are laid out so a caller can rebuild the very tree they were witnessed against
/// from the request alone: leaf indices are 0 and 1 and both notes are in the request, so appending
/// `inputs` then `fee_inputs` in leaf-index order reproduces `anchor_root`. The `prove_fixture`
/// example relies on exactly that to put the proved transaction in front of `Ledger::validate`.
pub fn fixture_burn_request(profile: &str) -> Result<Value> {
    use randprotocol_core::notes::FullTree;
    profile_from_str(profile)?;
    let sender = Wallet::generate();
    let exec = randprotocol_zkvm::executor::ZkExecutor::new(FriProfile::Test);
    let asset_note = Note::new(sender.vk.pk(), [0; 8], FIXTURE_TOKEN_HELD, FIXTURE_BURN_ASSET, 1);
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
        "token": hex::encode(FIXTURE_BURN_TOKEN),
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
        // Two notes per group (slots 0-1 for the private asset, 2-3 for RAND), four slots in all.
        "bundle_inputs": BUNDLE_INPUTS,
        "bundle_slots": BUNDLE_SLOTS,
        "bundle_asset_slots": A_SLOTS,
        // Chain 14's hidden-asset bundle admits a shielded transfer of ANY asset: `plan_transfer`,
        // `max_sendable` and `prove_transfer` all take an `asset`, and the fee is always RAND from
        // slots 2-3 of the same proof. (`false` on chain 13, where the ledger refused it.)
        "rpl_transfer": true,
        "bridge_burn": true,
        "bridge_burn_fee": gas::BRIDGE_BURN_FEE.to_string(),
        // A burn is ONE bundle and ONE proof since chain 14; it was two on chain 13. A client
        // budgeting proving time reads this rather than assuming either number.
        "bridge_burn_proofs": 1,
        "transfer_proofs": 1,
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
/// - `plan_transfer` `{notes, asset?, amount, fee}` → `{inputs, fee_inputs, need, change,
///   fee_change, fee, proofs}`; `asset` defaults to 0 (RAND), where `fee_inputs` is empty and
///   `fee_change` is `"0"` because the fee comes out of `inputs`. For `asset >= 1`, `inputs` are
///   notes of the token and `fee_inputs` are the RAND notes paying the fee from slots 2–3 of the
///   same proof; a wallet with no spendable RAND is refused with [`NO_SPENDABLE_RAND`]
/// - `max_sendable` `{notes, asset?, fee}` → `{amount, fee, inputs, fee_inputs, reason}`; the
///   largest one-bundle send, floored at zero. RAND subtracts the fee; a token does not (the fee
///   is RAND), but answers `"0"` with a `reason` when the RAND fee cannot be paid
/// - `plan_burn` `{notes, asset, amount, fee?}` → the same shape as `plan_transfer`, `proofs: 1`:
///   `inputs` are notes of `asset` (which the bundle burns) and `fee_inputs` are RAND notes.
///   `fee` defaults to `gas::BRIDGE_BURN_FEE`, which `version` reports as `bridge_burn_fee`;
///   `asset == 0` fails with [`RAND_NOT_BRIDGED`]
/// - `burn_is_possible` `{bridge_state, asset, to_chain, token, amount, relayer_fee}` → `true`, or
///   an error naming what the chain would refuse. `bridge_state` is a whole `rand_getBridgeState`
///   reply the client fetched. **Call this before `prove_burn`** — it is the only thing standing
///   between a typo and a wasted proof
/// - `prove_burn` `{…BurnRequest}` → BurnResult (slow — one bundle proof)
/// - `prove_transfer` `{…ProveRequest}` → ProveResult (slow — one bundle proof)
/// - `open_with_tx_key` `{cm, envelope, tx_key}` → note or null
/// - `format_amount` `{units}` → `"1.5"`; `parse_amount` `{text}` → units string
/// - `fixture_prove_request` `{profile?, asset?}` → a valid `prove_transfer` request for smoke
///   tests: a RAND transfer at `asset: 0` (the default), a token transfer at `asset >= 1`
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
        "burn_is_possible" => {
            let state = params.get("bridge_state").cloned().unwrap_or(Value::Null);
            let asset = asset_param(params)?;
            let to_chain = u16::try_from(index_param(params, "to_chain")?)
                .map_err(|_| "to_chain must fit 16 bits".to_string())?;
            let token = parse_bytes32(str_param(params, "token")?, "token")?;
            let amount = amount_param(params, "amount")?;
            let relayer_fee = amount_param(params, "relayer_fee")?;
            burn_is_possible(&state, asset, to_chain, &token, amount, relayer_fee)?;
            Ok(Value::Bool(true))
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
        "fixture_prove_request" => Ok(fixture_prove_request(
            params.get("profile").and_then(Value::as_str).unwrap_or("test"),
            asset_param(params)?,
        )?),
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

    /// Chain 14 admits a token transfer. What it still refuses is one that cannot pay its RAND
    /// fee — and the refusal names the fee, not the token.
    #[test]
    fn plan_transfer_admits_a_token_and_names_the_fee_when_it_cannot_be_paid() {
        let notes = vec![owned(0, 1, 10), owned(1, 0, 5_000_000_000)];
        let plan = plan_transfer(&notes, 1, 5, gas::BUNDLE_BASE).unwrap();
        assert_eq!(plan.inputs.iter().map(|n| n.index).collect::<Vec<_>>(), vec![0]);
        assert_eq!(plan.fee_inputs.iter().map(|n| n.index).collect::<Vec<_>>(), vec![1]);
        assert_eq!(plan.need, "5", "a token group's need is the amount; the fee is the other group's");
        assert_eq!(plan.change, "5");
        assert_eq!(plan.fee_change, (5_000_000_000u64 - gas::BUNDLE_BASE).to_string());
        assert_eq!(plan.proofs, 1);

        assert_eq!(plan_transfer(&[owned(0, 1, 10)], 1, 5, gas::BUNDLE_BASE).unwrap_err(), NO_SPENDABLE_RAND);
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

    /// A token's max is its two largest notes, with no fee subtracted (the fee is RAND) — and
    /// `"0"` plus a `reason` when the RAND fee cannot be paid at all.
    #[test]
    fn max_sendable_for_a_token_does_not_subtract_the_rand_fee() {
        let notes = vec![owned(0, 1, 500), owned(1, 1, 300), owned(2, 1, 100), owned(3, 0, 5_000_000_000)];
        let r = max_sendable(&notes, 1, gas::BUNDLE_BASE).unwrap();
        assert_eq!(r.amount, "800", "the two largest token notes, whole");
        assert_eq!(r.inputs, 2);
        assert_eq!(r.fee_inputs, 1);
        assert!(r.reason.is_none());

        let r = max_sendable(&notes[..3], 1, gas::BUNDLE_BASE).unwrap();
        assert_eq!(r.amount, "0");
        assert_eq!(r.inputs, 0);
        assert_eq!(r.reason.as_deref(), Some(NO_SPENDABLE_RAND));

        // A RAND max is unchanged: the two largest, minus the fee, and no reason.
        let r = max_sendable(&notes, 0, gas::BUNDLE_BASE).unwrap();
        assert_eq!(r.amount, (5_000_000_000u64 - gas::BUNDLE_BASE).to_string());
        assert_eq!(r.fee_inputs, 0);
        assert!(r.reason.is_none());
    }

    // ------------------------------------------------------------------ the two-bundle burn

    /// A burn selects both of its bundle's groups against one note list, and each sees only its
    /// own asset: slots 0-1 take notes of the token covering `amount` (which the bundle burns) and
    /// slots 2-3 take RAND notes covering `fee`. Mirrors `Plan::select` with
    /// `Spend { asset, to: None, fee, burn_a: amount, burn_r: 0 }`.
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
        assert_eq!(plan.need, "600", "the token group's need is what the burn destroys");
        assert_eq!(plan.fee_change, (5_000_000_000u64 - gas::BRIDGE_BURN_FEE).to_string());
        assert_eq!(plan.fee, gas::BRIDGE_BURN_FEE.to_string());
        assert_eq!(plan.proofs, 1, "one hidden-asset bundle, one proof");
    }

    /// A wallet can hold plenty of the token and still not be able to burn it: the fee is always
    /// RAND, from slots 2-3 of the same proof. The refusal has to say which of the two is missing.
    #[test]
    fn plan_burn_without_rand_for_fee_says_so() {
        let notes = vec![owned(0, 1, 5_000)];
        // No RAND at all: upstream's own sentence, which names the fee and RAND.
        let err = plan_burn(&notes, 1, 400, gas::BRIDGE_BURN_FEE).unwrap_err();
        assert_eq!(err, NO_SPENDABLE_RAND);
        assert!(err.contains("RAND") && err.contains("fee"), "{err}");

        // Some RAND, but not enough: the selection's own message, labelled as the fee's.
        let thin = vec![owned(0, 1, 5_000), owned(1, 0, 5)];
        let err = plan_burn(&thin, 1, 400, gas::BRIDGE_BURN_FEE).unwrap_err();
        assert!(err.starts_with("the RAND fee: "), "{err}");
        assert!(err.contains("insufficient"), "{err}");

        // And RAND held by a pending submission says "wait", not "go and get some".
        let mut held = vec![owned(0, 1, 5_000), owned(1, 0, 5_000_000_000)];
        held[1].pending = Some(3);
        let err = plan_burn(&held, 1, 400, gas::BRIDGE_BURN_FEE).unwrap_err();
        assert!(err.contains("held by a pending submission"), "{err}");
        assert!(err.contains("5 RAND"), "{err}");
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

    /// The shape the ledger checks, without paying for a proof: ONE bundle whose slots 0–1 hold
    /// the token and burn exactly `amount` of it (`burn_a == amount`, `burn_asset == asset`),
    /// whose slots 2–3 hold RAND and pay at least `BRIDGE_BURN_FEE` (`burn_r == 0`). Plus
    /// `check_bundle`'s own rule — all four nullifiers and all four commitments pairwise distinct —
    /// and the fact that a burn addresses no note to anybody else.
    #[test]
    fn a_burn_has_the_ledger_shape() {
        let req: BurnRequest = serde_json::from_value(fixture_burn_request("test").unwrap()).unwrap();
        let amount: u64 = req.amount.parse().unwrap();
        let (w, b) = build_burn_unproven(&req).unwrap();
        let bundle = b.tx.bundle.as_ref().expect("a burn carries a bundle");

        assert_eq!(b.proofs, 1, "chain 14 proves a burn once");
        assert_eq!(bundle.burn_a, amount, "a burn destroys exactly what the outbound message sends");
        assert_eq!(bundle.burn_r, 0, "a token burn never burns RAND");
        assert_eq!(bundle.burn_asset, req.asset, "a burn is a public boundary, so it names its asset");
        assert!(bundle.fee >= gas::BRIDGE_BURN_FEE, "{} < {}", bundle.fee, gas::BRIDGE_BURN_FEE);
        assert_eq!(bundle.fee, req.fee.parse::<u64>().unwrap());
        assert_eq!(u64::from(bundle.time), req.anchor_height);

        // `check_bundle`: four distinct nullifiers, four distinct commitments, dummies included.
        for i in 0..BUNDLE_SLOTS {
            for j in (i + 1)..BUNDLE_SLOTS {
                assert_ne!(bundle.nullifiers[i], bundle.nullifiers[j], "nullifiers {i} and {j} collide");
                assert_ne!(bundle.commitments[i], bundle.commitments[j], "commitments {i} and {j} collide");
            }
        }

        // A burn pays nobody inside the pool: slot 0 pays nobody, slots 1 and 2 are this wallet's
        // change in the two assets, slot 3 is a dummy. Exactly two of the four open for the sender.
        assert_eq!(b.prepared.change_a, FIXTURE_TOKEN_HELD - amount);
        assert_eq!(b.prepared.change_r, 3 * UNITS_PER_RAND - bundle.fee);
        assert_eq!(b.to[..12], [0u8; 12], "an EVM recipient is left-padded");
        assert_eq!(b.relayer_fee, req.relayer_fee.parse::<u64>().unwrap());
        assert!(b.relayer_fee <= amount, "the relayer fee is a portion of the amount");
        assert_eq!(b.spent_indices, vec![0, 1], "the token group's inputs first, then the RAND group's");

        let rows: Vec<CommitmentRow> = (0..BUNDLE_SLOTS)
            .map(|k| CommitmentRow {
                index: k as u64,
                cm: word8_to_hex(&bundle.commitments[k]),
                height: 41,
                envelope: EnvelopeHex {
                    kem_ct: hex::encode(&bundle.envelopes[k].kem_ct),
                    to_receiver: hex::encode(&bundle.envelopes[k].to_receiver),
                    to_sender: hex::encode(&bundle.envelopes[k].to_sender),
                    body: hex::encode(&bundle.envelopes[k].body),
                },
            })
            .collect();
        let scan = scan_page(&w, &rows).unwrap();
        assert_eq!(scan.received.len(), 2, "only the two change notes come back to this wallet");
        assert_eq!(scan.received.iter().filter(|n| n.asset == req.asset).count(), 1);
        assert_eq!(scan.received.iter().filter(|n| n.asset == 0).count(), 1);
        assert!(scan.sent.is_empty(), "a burn addresses no note to anybody else");
    }

    /// Chain 13's `Action::BridgeBurn` carried the burning bundle inside it (`asset_bundle`) and
    /// the transaction's own bundle paid the fee. Chain 14 has neither: there is exactly one
    /// bundle, it is the transaction's own, and the action is the five plain words plus `token`.
    #[test]
    fn a_burn_carries_one_bundle_and_an_action_of_plain_words() {
        let req: BurnRequest = serde_json::from_value(fixture_burn_request("test").unwrap()).unwrap();
        let amount: u64 = req.amount.parse().unwrap();
        let (_w, b) = build_burn_unproven(&req).unwrap();

        assert_eq!(b.tx.chain_id, DEFAULT_CHAIN_ID);
        let bundle = b.tx.bundle.as_ref().expect("a burn carries a bundle");
        assert_eq!(bundle.nullifiers.len(), BUNDLE_SLOTS, "four nullifiers, not two bundles' worth");
        assert!(bundle.proof.is_empty(), "the proof is made after the transaction exists, over its binding");

        let Action::BridgeBurn { asset, amount: act_amount, relayer_fee, to_chain, token, to } = &b.tx.action else {
            panic!("a bridge burn")
        };
        assert_eq!(*asset, req.asset);
        assert_eq!(*act_amount, amount, "the action's amount is the bundle's burn_a word");
        assert_eq!(*act_amount, bundle.burn_a);
        assert_eq!(*relayer_fee, req.relayer_fee.parse::<u64>().unwrap());
        assert_eq!(*to_chain, req.to_chain);
        assert_eq!(hex::encode(token), req.token, "`token` is plain bytes, carried through unchanged");
        assert_eq!(hex::encode(to), req.to, "`to` is plain bytes, carried through unchanged");
    }

    /// `to` and `token` keep the byte order they were written in, pinned on values that can tell.
    ///
    /// A value whose every four-byte group is uniform — the old fixture's twelve `0x00` then twenty
    /// `0x11` — is *invariant under a per-word byte reversal*: it round-trips identically whether or
    /// not something between the hex string and the action permutes bytes within a four-byte word,
    /// which is the class of mistake a refactor through a word-oriented decoder (`word8_from_hex`)
    /// would introduce. Only an asymmetric value can fail, so both assertions here use one.
    #[test]
    fn to_and_token_keep_their_byte_order_through_parsing_and_into_the_action() {
        let mut want = [0u8; 32];
        want[12..].copy_from_slice(&[
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11,
            0x12, 0x13, 0x14,
        ]);
        let hexed = "0000000000000000000000000102030405060708090a0b0c0d0e0f1011121314";
        assert_eq!(hexed.len(), 64);
        assert_eq!(parse_bytes32(hexed, "to").unwrap(), want, "the bytes come out in the order they were written");
        // The same string `0x`-prefixed and upper-cased is the same bytes, still in order.
        assert_eq!(
            parse_bytes32("0x0000000000000000000000000102030405060708090A0B0C0D0E0F1011121314", "to").unwrap(),
            want,
            "a 0x prefix and upper case are cosmetic"
        );

        // And the order survives all the way onto the action the chain reads — for both fields.
        let mut req = fixture_burn_request("test").unwrap();
        req["to"] = json!(hexed);
        let req: BurnRequest = serde_json::from_value(req).unwrap();
        let (_w, b) = build_burn_unproven(&req).unwrap();
        assert_eq!(b.to, want, "no re-ordering between the request and the build");
        assert_eq!(b.token, FIXTURE_BURN_TOKEN, "nor for the coin being redeemed");
        let Action::BridgeBurn { to, token, .. } = &b.tx.action else { panic!("a bridge burn") };
        assert_eq!(*to, want, "nor between the build and the action");
        assert_eq!(to[12], 0x01, "the recipient's first byte, not its word's last");
        assert_eq!(to[31], 0x14, "the recipient's last byte, not its word's first");
        assert_eq!(*token, FIXTURE_BURN_TOKEN);
        assert_eq!(token[0], 0x22, "the coin's first byte, not its word's last");
        assert_eq!(token[31], 0x12, "the coin's last byte, not its word's first");
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
        assert!(attempt(swapped).contains("holds asset 0, but this group spends asset 1"));
        // `token` is parsed exactly as `to` is, and refused exactly as strictly.
        assert!(attempt(json!({ "token": "1122" })).contains("token must be 32 bytes"));
        assert!(attempt(json!({ "token": "zz" })).contains("token is not hex"));
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
        assert_eq!(v["value"]["proofs"], 1, "chain 14 proves a burn once");
        assert_eq!(v["value"]["fee"], gas::BRIDGE_BURN_FEE.to_string());
        assert_eq!(v["value"]["need"], "400", "the token group must cover what is burned");
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
        assert_eq!(req["token"].as_str().unwrap().len(), 64, "chain 14 names the coin being redeemed");
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
        assert_eq!(v["rpl_transfer"], true, "chain 14 admits a shielded transfer of any asset");
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

        // A token transfer through the same door: admitted on chain 14, with the RAND note the
        // wallet already holds paying the fee from slots 2-3.
        let mixed = json!([
            notes[0].clone(),
            { "index": 1, "note": "", "cm": "", "nf": "", "amount": "500", "asset": 1,
              "time": 1, "from": "", "height": 1, "spent": false, "pending": null },
        ]);
        let rpl_params = json!({ "notes": mixed, "asset": 1, "amount": "100", "fee": gas::BUNDLE_BASE.to_string() });
        let v: Value = serde_json::from_str(&call("plan_transfer", &rpl_params.to_string())).unwrap();
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["value"]["inputs"][0]["asset"], 1);
        assert_eq!(v["value"]["fee_inputs"][0]["asset"], 0);
        assert_eq!(v["value"]["change"], "400");
        assert_eq!(v["value"]["fee_change"], (5_000_000_000u64 - gas::BUNDLE_BASE).to_string());
        assert_eq!(v["value"]["proofs"], 1);

        // With no RAND to pay the fee it is refused, before anything is proved.
        let no_rand = json!({ "notes": [mixed[1].clone()], "asset": 1, "amount": "100", "fee": gas::BUNDLE_BASE.to_string() });
        let v: Value = serde_json::from_str(&call("plan_transfer", &no_rand.to_string())).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], NO_SPENDABLE_RAND);

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
        assert_eq!(v["default_chain_id"], 14);
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
        assert_eq!(v["value"]["default_chain_id"], 14);
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
            asset: 0,
            amount: "1000000000".into(),
            fee: gas::BUNDLE_BASE.to_string(),
            anchor_height: 40,
            anchor_root: word8_to_hex(&root),
            inputs: vec![ProveInput { note: owned, path: path.iter().map(word8_to_hex).collect() }],
            fee_inputs: vec![],
            profile: "test".into(),
        };
        let res = prove_transfer(&req).unwrap();
        assert_eq!(res.change, (3_000_000_000u64 - 1_000_000_000 - gas::BUNDLE_BASE).to_string());
        assert_eq!(res.fee_change, "0", "a RAND transfer's change is `change`, not `fee_change`");
        assert_eq!(res.spent_indices, vec![1]);
        assert_eq!(res.proofs, 1);
        assert_eq!(res.payment_slot, 2, "a RAND transfer pays from slots 2-3");
        let tx = Transaction::decode(&hex::decode(&res.tx_hex).unwrap()).unwrap();
        assert_eq!(tx.hash().to_hex(), res.hash);
        let bundle = tx.bundle.as_ref().unwrap();
        assert_eq!(bundle.anchor, root);
        assert_eq!(bundle.time, 40);
        assert_eq!(bundle.burn_asset, 0);
        // Bob's wallet opens the payment envelope (slot 2); Alice's opens the change (slot 3).
        let rows: Vec<CommitmentRow> = (2..4)
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
        // Chain 14: the proof is verified against the transaction's own binding as well as the
        // pinned guest, so a proof copied onto any other transaction no longer verifies.
        let binding = tx.binding();
        exec.verify_bundle(&randprotocol_zkvm::executor::ZkExecutor::hc_bundle(), &bundle.proof, &binding).unwrap();
        assert!(
            open_with_tx_key(&rows[0].cm, &rows[0].envelope, &res.tx_keys[res.payment_slot]).unwrap().is_some(),
            "the payment slot's key opens the payment"
        );
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

    // ================================================================= chain 14: the hidden bundle
    //
    // Every test below runs on the *unproven* build split (`build_transfer_unproven` /
    // `build_burn_unproven`), so the whole module finishes in milliseconds rather than paying for
    // a ~100 s tier-14 proof per assertion. The three real proofs live in
    // `examples/prove_fixture.rs`, which puts each one in front of `Ledger::validate`.
    mod hidden_bundle_shape {
        use super::*;

        /// The slot layout a plan produced, as a row of labels — the readable form of upstream's
        /// `Plan::outputs`. `(Payee, amount)` is what the builder consumes, so reading it back is
        /// reading exactly the decision the bundle was built from.
        fn layout(plan: &BundlePlan) -> Vec<String> {
            plan.outputs()
                .unwrap()
                .iter()
                .map(|(payee, amount)| match payee {
                    Payee::To(_) => format!("pay {amount}"),
                    Payee::Me => format!("mine {amount}"),
                    Payee::Nobody => "nobody".to_string(),
                })
                .collect()
        }

        /// Who can actually open each output envelope, which is the layout's observable half: a
        /// dummy is sealed to a throwaway key, so neither the sender nor the recipient sees it.
        fn openers(w: &Wallet, to: &ShieldedAddress, b: &Bundle) -> Vec<&'static str> {
            (0..BUNDLE_SLOTS)
                .map(|k| {
                    let cm = b.commitments[k];
                    let env = EnvelopeHex {
                        kem_ct: hex::encode(&b.envelopes[k].kem_ct),
                        to_receiver: hex::encode(&b.envelopes[k].to_receiver),
                        to_sender: hex::encode(&b.envelopes[k].to_sender),
                        body: hex::encode(&b.envelopes[k].body),
                    }
                    .decode()
                    .unwrap();
                    match classify(w, cm, &env) {
                        Found::Received(_) => "mine",
                        // A note this wallet *sent*: the payment, addressed to somebody else.
                        Found::Sent(n) if n.pk == to.pk => "pay",
                        Found::Sent(_) => "sent-elsewhere",
                        Found::Skipped => "nobody",
                    }
                })
                .collect()
        }

        /// A RAND transfer's four output slots are `[nobody, nobody, pay, change_r]` (upstream
        /// `Plan::outputs`' asset-0 arm) and it burns nothing at all.
        #[test]
        fn a_rand_transfer_pays_from_slots_two_and_three() {
            let req: ProveRequest = serde_json::from_value(fixture_prove_request("test", 0).unwrap()).unwrap();
            let amount: u64 = req.amount.parse().unwrap();
            let (w, build) = build_transfer_unproven(&req).unwrap();
            let dest = ShieldedAddress::parse(&req.to).unwrap();
            let b = build.tx.bundle.as_ref().unwrap();

            assert_eq!(b.burn_a, 0, "a transfer burns nothing");
            assert_eq!(b.burn_r, 0);
            assert_eq!(b.burn_asset, 0, "a non-burning action must publish burn_asset == 0");
            assert_eq!(b.fee, req.fee.parse::<u64>().unwrap());
            assert_eq!(b.nullifiers.len(), BUNDLE_SLOTS);
            assert_eq!(b.envelopes.len(), BUNDLE_SLOTS);
            assert!(matches!(build.tx.action, Action::None));

            let change = 5 * UNITS_PER_RAND - amount - b.fee;
            assert_eq!(
                layout(&build.plan),
                vec!["nobody".to_string(), "nobody".into(), format!("pay {amount}"), format!("mine {change}")],
                "upstream Plan::outputs' asset-0 arm"
            );
            assert_eq!(openers(&w, &dest, b), vec!["nobody", "nobody", "pay", "mine"]);
            assert_eq!(build.plan.payment_slot(), 2);
            assert_eq!(build.spent_indices, vec![0, 1], "both RAND notes, in leaf order");
        }

        /// A token transfer's four output slots are `[pay, change_a, change_r, nobody]`: the token
        /// in slots 0–1, the RAND fee and its change in slots 2–3, one proof.
        #[test]
        fn a_token_transfer_pays_from_slots_zero_and_one_and_fees_from_two_and_three() {
            let req: ProveRequest = serde_json::from_value(fixture_prove_request("test", 1).unwrap()).unwrap();
            assert_eq!(req.asset, 1);
            assert!(!req.fee_inputs.is_empty(), "a token transfer names RAND notes for its fee");
            let amount: u64 = req.amount.parse().unwrap();
            let (w, build) = build_transfer_unproven(&req).unwrap();
            let dest = ShieldedAddress::parse(&req.to).unwrap();
            let b = build.tx.bundle.as_ref().unwrap();

            assert_eq!(b.burn_a, 0);
            assert_eq!(b.burn_r, 0);
            assert_eq!(b.burn_asset, 0, "a token transfer is not a burn");
            assert_eq!(b.fee, req.fee.parse::<u64>().unwrap(), "the fee is always RAND");
            assert_eq!(
                layout(&build.plan),
                vec![
                    format!("pay {amount}"),
                    format!("mine {}", FIXTURE_TOKEN_HELD - amount),
                    format!("mine {}", 3 * UNITS_PER_RAND - b.fee),
                    "nobody".to_string(),
                ],
                "upstream Plan::outputs' token arm: the fee and its change are slots 2-3"
            );
            assert_eq!(openers(&w, &dest, b), vec!["pay", "mine", "mine", "nobody"]);
            assert_eq!(build.plan.payment_slot(), 0);
            assert_eq!(A_SLOTS, 2);
            assert_eq!(build.proofs, 1, "one hidden bundle, one proof");
        }

        /// The fee is always RAND (spec §3.9): a wallet holding plenty of the token and no
        /// spendable RAND is refused before anything is proved, in upstream's own words.
        #[test]
        fn a_token_transfer_without_rand_is_refused_before_proving() {
            let notes = vec![owned(0, 1, 5_000)];
            let err = plan_transfer(&notes, 1, 400, gas::BUNDLE_BASE).unwrap_err();
            assert_eq!(err, NO_SPENDABLE_RAND);
            assert!(err.contains("a transfer pays its fee in RAND"), "{err}");
        }

        /// A burn is ONE bundle now: `burn_a == amount`, `burn_r == 0`, `burn_asset == asset`, and
        /// the action carries `token` byte for byte.
        #[test]
        fn a_burn_is_one_bundle_carrying_the_token_byte_exact() {
            let req: BurnRequest = serde_json::from_value(fixture_burn_request("test").unwrap()).unwrap();
            let amount: u64 = req.amount.parse().unwrap();
            let (_w, build) = build_burn_unproven(&req).unwrap();
            let b = build.tx.bundle.as_ref().unwrap();

            assert_eq!(build.proofs, 1, "chain 14 proves a burn once");
            assert_eq!(b.burn_a, amount);
            assert_eq!(b.burn_r, 0);
            assert_eq!(b.burn_asset, req.asset);
            assert!(b.fee >= gas::BRIDGE_BURN_FEE);

            let Action::BridgeBurn { asset, amount: act, relayer_fee, to_chain, token, to } = &build.tx.action else {
                panic!("a bridge burn")
            };
            assert_eq!(*asset, req.asset);
            assert_eq!(*act, amount);
            assert_eq!(*relayer_fee, req.relayer_fee.parse::<u64>().unwrap());
            assert_eq!(*to_chain, req.to_chain);
            assert_eq!(hex::encode(token), req.token, "token is plain bytes, carried through unchanged");
            assert_eq!(hex::encode(to), req.to);
        }

        /// `token` is parsed exactly as `to` is — plain bytes, `hex::decode` — pinned on an
        /// asymmetric value that a per-word byte reversal would visibly scramble.
        #[test]
        fn token_keeps_its_byte_order() {
            let hexed = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
            let want: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
            assert_eq!(parse_bytes32(hexed, "token").unwrap(), want);
            let mut req = fixture_burn_request("test").unwrap();
            req["token"] = json!(hexed);
            let req: BurnRequest = serde_json::from_value(req).unwrap();
            let (_w, build) = build_burn_unproven(&req).unwrap();
            let Action::BridgeBurn { token, .. } = &build.tx.action else { panic!("a burn") };
            assert_eq!(*token, want);
            assert_eq!(token[0], 0x01, "the token's first byte, not its word's last");
            assert_eq!(token[31], 0x20);
        }

        /// The one hard backward-compatibility rule: a `prove_transfer` request shaped exactly as
        /// today's JS, Swift and Java callers send it — no `asset`, no `fee_inputs` — still proves
        /// a RAND transfer.
        #[test]
        fn a_legacy_shaped_prove_transfer_request_is_still_accepted() {
            let mut req = fixture_prove_request("test", 0).unwrap();
            let obj = req.as_object_mut().unwrap();
            obj.remove("asset");
            obj.remove("fee_inputs");
            assert!(obj.get("asset").is_none() && obj.get("fee_inputs").is_none());
            let req: ProveRequest = serde_json::from_value(req).unwrap();
            assert_eq!(req.asset, 0, "asset defaults to RAND");
            assert!(req.fee_inputs.is_empty());
            let (w, build) = build_transfer_unproven(&req).unwrap();
            let dest = ShieldedAddress::parse(&req.to).unwrap();
            let b = build.tx.bundle.as_ref().unwrap();
            assert_eq!(b.burn_asset, 0);
            assert_eq!(openers(&w, &dest, b), vec!["nobody", "nobody", "pay", "mine"]);

            // And the same through the JSON door, which is how the JS, Swift and Java callers
            // reach it: `plan_transfer` and `select_inputs` with no `asset` at all.
            let notes = json!([{
                "index": 0, "note": "", "cm": "", "nf": "", "amount": "5000000000", "asset": 0,
                "time": 1, "from": "", "height": 1, "spent": false, "pending": null,
            }]);
            let params = json!({ "notes": notes, "amount": "1000000000", "fee": gas::BUNDLE_BASE.to_string() });
            let v: Value = serde_json::from_str(&call("plan_transfer", &params.to_string())).unwrap();
            assert_eq!(v["ok"], true, "{v}");
            assert_eq!(v["value"]["need"], (1_000_000_000u64 + gas::BUNDLE_BASE).to_string());
            assert_eq!(v["value"]["fee_inputs"].as_array().unwrap().len(), 0);
            assert_eq!(v["value"]["fee_change"], "0");
        }

        /// Chain 14 renders every RPC amount as a decimal string, `bridge_attest`'s included.
        #[test]
        fn rebuilt_deposit_reads_a_string_amount() {
            let w = wallet(41);
            let note = Note::new(w.vk.pk(), [0; 8], 2_000_000_000, 1, 7);
            let action = json!({
                "kind": "bridge_attest",
                "recipient": w.address.to_string(),
                "amount": note.amount.to_string(),
                "asset_index": note.asset,
                "time": note.time,
                "r": word8_to_hex(&note.r),
                "commitment": word8_to_hex(&note.commitment()),
            });
            let got = rebuilt_deposit(&w, &action).expect("a string amount is chain 14's shape");
            assert_eq!(got.amount, "2000000000");
            assert_eq!(got.asset, 1);
        }

        /// `plan_transfer` and `max_sendable` must agree for a token too, not only for RAND.
        #[test]
        fn plan_and_max_agree_for_a_token() {
            let fee = gas::BUNDLE_BASE;
            let cases: Vec<Vec<OwnedNote>> = vec![
                vec![owned(0, 1, 500), owned(1, 0, 5_000_000_000)],
                vec![owned(0, 1, 500), owned(1, 1, 300), owned(2, 0, 5_000_000_000)],
                vec![owned(0, 1, 100), owned(1, 1, 100), owned(2, 1, 100), owned(3, 0, 5_000_000_000)],
                vec![owned(0, 1, 500)],
                vec![owned(0, 0, 5_000_000_000)],
            ];
            for (i, notes) in cases.iter().enumerate() {
                let max = max_sendable(notes, 1, fee).unwrap();
                let m: u64 = max.amount.parse().unwrap();
                if m > 0 {
                    let plan = plan_transfer(notes, 1, m, fee).unwrap_or_else(|e| panic!("case {i}: {e}"));
                    assert_eq!(plan.change, "0", "case {i}");
                    assert!(plan_transfer(notes, 1, m + 1, fee).is_err(), "case {i}: one unit more must fail");
                    assert!(!plan.fee_inputs.is_empty(), "case {i}: a token transfer names RAND fee notes");
                    assert_eq!(plan.proofs, 1);
                } else {
                    assert!(plan_transfer(notes, 1, 1, fee).is_err(), "case {i}");
                    // A zero max has exactly two causes, and they are distinguishable: no RAND to
                    // pay the fee (which says so) or simply no notes of the token (which does not).
                    let no_rand = spendable_of(notes, 0).is_empty();
                    assert_eq!(max.reason.is_some(), no_rand, "case {i}: a fee-blocked max says why");
                    if !no_rand {
                        assert!(spendable_of(notes, 1).is_empty(), "case {i}: otherwise the max would be positive");
                    }
                }
            }
        }

        /// Every amount addition on a money path is checked, on both groups.
        #[test]
        fn every_amount_addition_is_checked() {
            let notes = vec![owned(0, 1, u64::MAX), owned(1, 1, u64::MAX), owned(2, 0, 5_000_000_000)];
            assert!(plan_transfer(&notes, 1, 10, gas::BUNDLE_BASE).unwrap_err().contains("overflow"));
            assert!(max_sendable(&notes, 1, gas::BUNDLE_BASE).unwrap_err().contains("overflow"));
            let rand = vec![owned(0, 1, 5), owned(1, 0, u64::MAX), owned(2, 0, u64::MAX)];
            assert!(plan_transfer(&rand, 1, 1, gas::BUNDLE_BASE).unwrap_err().contains("overflow"));
            assert!(plan_burn(&notes, 1, 10, gas::BRIDGE_BURN_FEE).unwrap_err().contains("overflow"));
        }

        /// The same note handed in twice would nullify one leaf in two slots — a bundle spending
        /// the same money twice. The guest taints on it and the ledger refuses it
        /// (`DuplicateNullifierInBundle`), so upstream's `build_bundle` stops on it before a proof
        /// is paid for, and so does this one.
        #[test]
        fn one_note_in_two_slots_is_refused_before_proving() {
            let mut req = fixture_prove_request("test", 0).unwrap();
            let first = req["inputs"][0].clone();
            req["inputs"] = json!([first.clone(), first]);
            let req: ProveRequest = serde_json::from_value(req).unwrap();
            let e = match build_transfer_unproven(&req) {
                Ok(_) => panic!("one note in two slots should have been refused"),
                Err(e) => e,
            };
            assert!(e.contains("repeat a nullifier or a commitment"), "{e}");

            // And across the two groups of a token bundle, where the notes are of different assets
            // and so cannot be the same leaf, the four slots are still pairwise distinct.
            let req: ProveRequest = serde_json::from_value(fixture_prove_request("test", 1).unwrap()).unwrap();
            let (_w, b) = build_transfer_unproven(&req).unwrap();
            let bundle = b.tx.bundle.as_ref().unwrap();
            for i in 0..BUNDLE_SLOTS {
                for j in (i + 1)..BUNDLE_SLOTS {
                    assert_ne!(bundle.nullifiers[i], bundle.nullifiers[j], "slots {i} and {j}");
                    assert_ne!(bundle.commitments[i], bundle.commitments[j], "slots {i} and {j}");
                }
            }
        }

        /// A `rand_getBridgeState` reply as chain 14 renders it: one row per backing, `locked` a
        /// decimal string, `decimals` the source coin's own.
        fn bridge_state(rows: Value) -> Value {
            json!({ "enabled": true, "assets": rows })
        }

        fn backing(index: u32, chain: u16, token: &str, decimals: u64, locked: &str) -> Value {
            json!({ "index": index, "chain": chain, "token": token, "decimals": decimals, "locked": locked })
        }

        /// Upstream's `burn_is_possible`, ported whole: the five things only the chain knows, each
        /// of which would otherwise cost a proof to discover. One bridged token, several backings.
        #[test]
        fn burn_is_possible_screens_what_only_the_chain_knows() {
            let usdt_eth = "22".repeat(32);
            let usdc_eth = "33".repeat(32);
            let usdt_tron = "44".repeat(32);
            let eth = decode(&usdt_eth);
            let state = bridge_state(json!([
                backing(1, 2, &usdt_eth, 6, "1000000000"),
                backing(1, 2, &usdc_eth, 6, "500"),
                backing(1, 4, &usdt_tron, 6, "700000000"),
            ]));

            // 6 decimals => a release unit of 10^(8-6) = 100. A whole number of them, within what
            // that one coin is holding, is possible.
            assert!(burn_is_possible(&state, 1, 2, &eth, 400, 100).is_ok());

            // Not a whole release unit — neither the amount nor the relayer fee.
            let e = burn_is_possible(&state, 1, 2, &eth, 450, 100).unwrap_err();
            assert!(e.contains("multiples of 100"), "{e}");
            let e = burn_is_possible(&state, 1, 2, &eth, 400, 50).unwrap_err();
            assert!(e.contains("multiples of 100"), "{e}");

            // More than THAT coin is holding, even though the token's other backings would cover
            // it — the far side would refuse to release it.
            let e = burn_is_possible(&state, 1, 2, &decode(&usdc_eth), 1000, 0).unwrap_err();
            assert!(e.contains("only 500 is locked"), "{e}");

            // A coin that backs nothing, and one that backs a different chain's row.
            let e = burn_is_possible(&state, 1, 2, &decode(&"99".repeat(32)), 400, 100).unwrap_err();
            assert!(e.contains("does not back asset 1"), "{e}");
            let e = burn_is_possible(&state, 1, 5, &eth, 400, 100).unwrap_err();
            assert!(e.contains("does not back asset 1"), "{e}");

            // An index nothing was registered under, and a chain with no bridge at all.
            let e = burn_is_possible(&state, 7, 2, &eth, 400, 100).unwrap_err();
            assert!(e.contains("not in this chain's registry") && e.contains("registered: 1"), "{e}");
            let e = burn_is_possible(&json!({ "enabled": false }), 1, 2, &eth, 400, 100).unwrap_err();
            assert!(e.contains("no bridge"), "{e}");

            // A pre-chain-14 node renders `locked` as a number; both are read.
            let older = bridge_state(json!([json!({
                "index": 1, "chain": 2, "token": usdt_eth, "decimals": 6, "locked": 1_000_000_000u64,
            })]));
            assert!(burn_is_possible(&older, 1, 2, &eth, 400, 100).is_ok());
        }

        fn decode(s: &str) -> [u8; 32] {
            parse_bytes32(s, "token").unwrap()
        }

        /// The dispatch door: amounts are strings, `to_chain` and `asset` are numbers, `token` is
        /// 64 hex characters of plain bytes.
        #[test]
        fn dispatch_burn_is_possible_round_trips_json() {
            let token = "22".repeat(32);
            let state = bridge_state(json!([backing(1, 2, &token, 8, "5000")]));
            let params = json!({
                "bridge_state": state, "asset": 1, "to_chain": 2, "token": token,
                "amount": "400", "relayer_fee": "100",
            });
            let v: Value = serde_json::from_str(&call("burn_is_possible", &params.to_string())).unwrap();
            assert_eq!(v["ok"], true, "{v}");
            assert_eq!(v["value"], true);

            let mut over = params.clone();
            over["amount"] = json!("6000");
            let v: Value = serde_json::from_str(&call("burn_is_possible", &over.to_string())).unwrap();
            assert_eq!(v["ok"], false);
            assert!(v["error"].as_str().unwrap().contains("only 5000 is locked"), "{v}");

            // An amount sent as a bare JSON number is refused like every other amount.
            let mut numeric = params.clone();
            numeric["amount"] = json!(400);
            let v: Value = serde_json::from_str(&call("burn_is_possible", &numeric.to_string())).unwrap();
            assert_eq!(v["ok"], false);
            assert!(v["error"].as_str().unwrap().contains("decimal strings"), "{v}");
        }

        /// `version` reports chain 14's own constants.
        #[test]
        fn version_reports_chain_fourteen() {
            let v = constants();
            assert_eq!(v["default_chain_id"], 14);
            assert_eq!(v["chain_build"], "9c142c1");
            assert_eq!(v["rpl_transfer"], true);
            assert_eq!(v["bridge_burn"], true);
            assert_eq!(v["bridge_burn_proofs"], 1);
            assert_eq!(v["transfer_proofs"], 1);
            assert_eq!(v["bridge_burn_fee"], gas::BRIDGE_BURN_FEE.to_string());
            assert_eq!(v["bundle_slots"], BUNDLE_SLOTS);
            assert_eq!(v["bundle_asset_slots"], A_SLOTS);
            assert_eq!(v["bundle_inputs"], BUNDLE_INPUTS, "still two notes per group");
            // The guest changed with the chain, so every artefact must be rebuilt: chain 13's was
            // `4a27356f…`.
            assert_ne!(v["hc_bundle"].as_str().unwrap(), "", "the pinned guest digest is reported");
        }
    }
}
