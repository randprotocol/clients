//! Prove one hidden-asset bundle on this machine and put it in front of the chain's own
//! admission: `cargo run --release --example prove_fixture [transfer|token|burn] [test|production]`.
//!
//! Prints the proving time and proof size; run under `/usr/bin/time -l` (macOS) or
//! `/usr/bin/time -v` (Linux) for the peak memory, which is what decides whether a device can
//! prove at all. Either argument may be given alone, in either order:
//! `prove_fixture -- test` is the transfer fixture under the fast profile, and
//! `prove_fixture -- burn` is the burn fixture under the production profile.
//!
//! The three fixtures are the three shapes a wallet builds, and since chain 14 all three are ONE
//! four-slot bundle and ONE proof:
//!
//! * `transfer` — RAND: `[nobody, nobody, pay, change]`, `burn_asset == 0`;
//! * `token`    — a registry token: `[pay, change_a, change_r, nobody]`, fee from slots 2–3;
//! * `burn`     — a bridge withdrawal: `burn_a == amount`, `burn_asset == asset`, `burn_r == 0`.
//!
//! Each is then handed to `randprotocol_core::Ledger::validate` — the same function every node
//! runs on a submitted transaction — against a ledger built to hold exactly the fixture's leaves
//! (and, for a burn, exactly its token and backing), so a mistake in the slot layout, the burn
//! words or the transaction binding fails here rather than on chain.
use std::collections::BTreeMap;
use std::time::Instant;

use randprotocol_core::bridge::BridgeState;
use randprotocol_core::ledger::tokens::{Backing, MintAuthority, TokenRegistry, BRIDGE_DECIMALS};
use randprotocol_core::notes::{word8_from_hex, Word8};
use randprotocol_core::{gas, Ledger, Transaction};
use randprotocol_zkvm::executor::ZkExecutor;
use randprotocol_zkvm::machine::FriProfile;
use wallet_core::{BurnRequest, ProveInput, ProveRequest};

/// The token index the token and burn fixtures use — the first one a registry hands out.
const FIXTURE_ASSET: u32 = 1;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let profile = args
        .iter()
        .find(|a| *a == "test" || *a == "production")
        .cloned()
        .unwrap_or_else(|| "production".into());
    let mut what = "transfer";
    for a in &args {
        match a.as_str() {
            "transfer" | "token" | "burn" => what = Box::leak(a.clone().into_boxed_str()),
            "test" | "production" => {}
            other => {
                eprintln!("usage: prove_fixture [transfer|token|burn] [test|production]; {other:?} is none of them");
                std::process::exit(2);
            }
        }
    }
    match what {
        "burn" => prove_burn_fixture(&profile),
        "token" => prove_transfer_fixture(&profile, FIXTURE_ASSET),
        _ => prove_transfer_fixture(&profile, 0),
    }
}

fn fri(profile: &str) -> FriProfile {
    match profile {
        "test" => FriProfile::Test,
        _ => FriProfile::Production,
    }
}

fn prove_transfer_fixture(profile: &str, asset: u32) {
    let req = wallet_core::fixture_prove_request(profile, asset).expect("fixture");
    let req: ProveRequest = serde_json::from_value(req).expect("request");
    let what = if asset == 0 { "RAND".to_string() } else { format!("asset {asset}") };
    eprintln!(
        "proving a fixture {what} transfer under the {profile} profile: one hidden-asset bundle, \
         four slots, one proof…"
    );
    let t = Instant::now();
    let r = match wallet_core::prove_transfer(&req) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("failed after {:.1}s: {e}", t.elapsed().as_secs_f64());
            std::process::exit(1);
        }
    };
    println!(
        "proved {} bundle in {:.1}s: tier {}, proof {} bytes, transaction {} bytes",
        r.proofs,
        t.elapsed().as_secs_f64(),
        r.tier,
        r.proof_bytes,
        r.tx_bytes
    );
    println!(
        "  sent {} of asset {}, change {}, fee {} RAND, RAND change {}, payment in slot {}",
        r.amount, r.asset, r.change, r.fee, r.fee_change, r.payment_slot
    );

    // The point of the exercise: the chain's own admission, not a hand-rolled check.
    let leaves: Vec<&ProveInput> = req.inputs.iter().chain(&req.fee_inputs).collect();
    let t = Instant::now();
    match admits(req.chain_id, req.anchor_height, &req.anchor_root, &leaves, &r.tx_hex, profile, None) {
        Ok(()) => println!("Ledger::validate accepts the transaction ({:.1}s)", t.elapsed().as_secs_f64()),
        Err(e) => {
            eprintln!("Ledger::validate REFUSED the transaction: {e}");
            std::process::exit(1);
        }
    }
}

fn prove_burn_fixture(profile: &str) {
    let req = wallet_core::fixture_burn_request(profile).expect("fixture");
    let req: BurnRequest = serde_json::from_value(req).expect("request");
    eprintln!(
        "proving a fixture bridge burn under the {profile} profile: ONE hidden-asset bundle \
         (burning {} units of asset {} to chain {}, redeeming coin {})…",
        req.amount, req.asset, req.to_chain, req.token
    );
    let t = Instant::now();
    let r = match wallet_core::prove_burn(&req) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("failed after {:.1}s: {e}", t.elapsed().as_secs_f64());
            std::process::exit(1);
        }
    };
    println!(
        "proved {} bundle in {:.1}s: tier {}, proof {} bytes, transaction {} bytes",
        r.proofs,
        t.elapsed().as_secs_f64(),
        r.tier,
        r.proof_bytes,
        r.tx_bytes
    );
    println!("  burned {} of asset {}, change {}, fee {} RAND, RAND change {}", r.amount, r.asset, r.change, r.fee, r.fee_change);

    let amount: u64 = r.amount.parse().expect("an amount");
    let token = decode32(&r.token).expect("the coin");
    let leaves: Vec<&ProveInput> = req.inputs.iter().chain(&req.fee_inputs).collect();
    let t = Instant::now();
    let bridged = Some((req.asset, req.to_chain, token, amount));
    match admits(req.chain_id, req.anchor_height, &req.anchor_root, &leaves, &r.tx_hex, profile, bridged) {
        Ok(()) => println!("Ledger::validate accepts the transaction ({:.1}s)", t.elapsed().as_secs_f64()),
        Err(e) => {
            eprintln!("Ledger::validate REFUSED the transaction: {e}");
            std::process::exit(1);
        }
    }
}

fn decode32(s: &str) -> Option<[u8; 32]> {
    hex::decode(s).ok()?.try_into().ok()
}

/// Put the proved transaction in front of `Ledger::validate` — upstream's own admission, the
/// function a node runs on everything submitted to it. For a `BridgeBurn` it routes to
/// `ledger::bridge_notes::validate` (the burn words, `BridgeState::check_burn`, the token
/// registry's release rules) and for every action it ends at `check_bundle_proof`, which verifies
/// the proof against the pinned guest **and against the transaction's own binding**.
///
/// The ledger is built to be the one the fixture was witnessed against: the fixture's leaves
/// appended in leaf-index order (so the recorded anchor is the request's `anchor_root`), the height
/// set to `anchor_height` (so the bundle's `time` is in the window), and — only for a burn — a
/// bridge and a token registry holding exactly the fixture's bridged token with exactly its coin
/// backing it. Everything else is the chain's own rule, unmodified.
///
/// `bridged` is `(asset index, chain, coin, locked)` for a burn, `None` for a transfer: a transfer
/// of a token needs no registry at all, because the asset is a private witness word and the only
/// thing the ledger sees is `burn_asset == 0`.
fn admits(
    chain_id: u64,
    anchor_height: u64,
    anchor_root: &str,
    leaves: &[&ProveInput],
    tx_hex: &str,
    profile: &str,
    bridged: Option<(u32, u16, [u8; 32], u64)>,
) -> Result<(), String> {
    let exec = ZkExecutor::new(fri(profile));
    let mut ledger = Ledger::new(chain_id, ZkExecutor::hc_bundle(), BTreeMap::new(), &exec);

    // The fixture's leaves, in leaf-index order: appending them reproduces the very tree the
    // witnesses were folded against.
    let mut rows: Vec<(u64, Word8)> = leaves
        .iter()
        .map(|i| {
            let cm = word8_from_hex(&i.note.cm).ok_or_else(|| format!("leaf {} has no commitment", i.note.index))?;
            Ok((i.note.index, cm))
        })
        .collect::<Result<_, String>>()?;
    rows.sort_by_key(|(index, _)| *index);
    for (index, cm) in &rows {
        ledger.deposit(*cm, &exec).map_err(|e| format!("appending leaf {index}: {e}"))?;
    }
    // Only a recorded block-end root is an anchor (spec §7 item 4), and a bundle's `time` must be
    // this height at the latest and at most TIME_WINDOW behind it.
    ledger.record_anchor(1);
    ledger.set_height(anchor_height);
    ledger.set_timestamp_ms(1_000_000);
    let anchor = word8_from_hex(anchor_root).ok_or("anchor_root is not 64 hex characters")?;
    if !ledger.is_anchor(&anchor) {
        return Err("the fixture's anchor is not this ledger's root — the two trees disagree".into());
    }

    if let Some((index, chain, token, locked)) = bridged {
        // A bridge and a registry holding exactly this burn's token, backed by exactly the coin
        // the burn redeems and holding exactly what it redeems. Everything else about the burn —
        // that `to` is shaped for that chain, that the relayer fee is a portion of the amount,
        // that the amount is a whole release unit — is `BridgeState::check_burn`'s own and is left
        // to it. `lock` is what moves a backing's `locked` and the token's `total_supply`
        // together, which is the invariant `check_release` reads.
        let mut tokens = TokenRegistry::new(gas::BUNDLE_BASE);
        let backings = vec![Backing::new(chain, token, BRIDGE_DECIMALS)];
        let got = tokens
            .register(
                randprotocol_core::bridge::asset_id(chain, &token),
                "Fixture Coin".into(),
                "zFIX".into(),
                BRIDGE_DECIMALS,
                MintAuthority::Bridge { backings },
                1,
            )
            .map_err(|e| format!("registering the fixture token: {e:?}"))?;
        if got != index {
            return Err(format!("the registry handed out index {got}, but the fixture burns asset {index}"));
        }
        tokens.lock(index, chain, &token, locked, 0).map_err(|e| format!("locking the backing: {e:?}"))?;
        ledger.set_tokens(Some(tokens));
        ledger.set_bridge(Some(BridgeState::default()));
    }

    let bytes = hex::decode(tx_hex).map_err(|e| format!("tx_hex is not hex: {e}"))?;
    let tx = Transaction::decode(&bytes).map_err(|e| format!("tx_hex does not decode as a transaction: {e}"))?;
    ledger.validate(&tx, &exec).map_err(|e| format!("{e:?}"))
}
