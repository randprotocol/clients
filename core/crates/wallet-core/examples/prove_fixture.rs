//! Benchmark a bundle proof on this machine:
//! `cargo run --release --example prove_fixture [transfer|burn] [test|production]`.
//!
//! Prints the proving time and proof size; run under `/usr/bin/time -l` (macOS) or
//! `/usr/bin/time -v` (Linux) for the peak memory, which is what decides whether a device can
//! prove at all. Either argument may be given alone, in either order:
//! `prove_fixture -- test` is the transfer fixture under the fast profile, and
//! `prove_fixture -- burn` is the burn fixture under the production profile.
//!
//! `burn` is the chain's one two-bundle transaction, so it proves **twice** — sequentially, never
//! at once (two concurrent proofs would double the ~5.6 GB peak) — and then puts the result in
//! front of the chain's own admission, `randprotocol_core::Ledger::validate`. That is the same
//! function every node runs on a submitted transaction, reached here with a ledger built to hold
//! exactly the fixture's two leaves and a bridge registry holding exactly its asset, so a
//! mistake in the two-bundle shape fails here rather than on chain.
use std::collections::BTreeMap;
use std::time::Instant;

use randprotocol_core::bridge::{asset_id, AssetInfo, BridgeState};
use randprotocol_core::notes::{word8_from_hex, Word8};
use randprotocol_core::{Ledger, Transaction};
use randprotocol_zkvm::executor::ZkExecutor;
use randprotocol_zkvm::machine::FriProfile;
use wallet_core::BurnRequest;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let burn = args.iter().any(|a| a == "burn");
    let profile = args
        .iter()
        .find(|a| *a == "test" || *a == "production")
        .cloned()
        .unwrap_or_else(|| "production".into());
    for a in &args {
        if a != "burn" && a != "transfer" && a != "test" && a != "production" {
            eprintln!("usage: prove_fixture [transfer|burn] [test|production]; {a:?} is neither");
            std::process::exit(2);
        }
    }
    if burn {
        prove_burn_fixture(&profile)
    } else {
        prove_transfer_fixture(&profile)
    }
}

fn prove_transfer_fixture(profile: &str) {
    let req = wallet_core::fixture_prove_request(profile).expect("fixture");
    let req: wallet_core::ProveRequest = serde_json::from_value(req).expect("request");
    eprintln!("proving a fixture transfer under the {profile} profile…");
    let t = Instant::now();
    match wallet_core::prove_transfer(&req) {
        Ok(r) => println!(
            "proved in {:.1}s: tier {}, proof {} bytes, transaction {} bytes",
            t.elapsed().as_secs_f64(),
            r.tier,
            r.proof_bytes,
            r.tx_bytes
        ),
        Err(e) => {
            eprintln!("failed after {:.1}s: {e}", t.elapsed().as_secs_f64());
            std::process::exit(1);
        }
    }
}

fn prove_burn_fixture(profile: &str) {
    let req = wallet_core::fixture_burn_request(profile).expect("fixture");
    let req: BurnRequest = serde_json::from_value(req).expect("request");
    eprintln!(
        "proving a fixture bridge burn under the {profile} profile: two bundles, one after the \
         other (burning {} units of asset {} to chain {})…",
        req.amount, req.asset, req.to_chain
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
        "proved {} bundles in {:.1}s: tier {}, proofs {} bytes together, transaction {} bytes",
        r.proofs,
        t.elapsed().as_secs_f64(),
        r.tier,
        r.proof_bytes,
        r.tx_bytes
    );
    println!("  burned {} of asset {}, change {}, fee {} RAND, fee change {}", r.amount, r.asset, r.change, r.fee, r.fee_change);

    // The point of the exercise: the chain's own admission, not a hand-rolled check.
    let t = Instant::now();
    match admits(&req, &r.tx_hex, profile) {
        Ok(()) => println!("Ledger::validate accepts the transaction ({:.1}s)", t.elapsed().as_secs_f64()),
        Err(e) => {
            eprintln!("Ledger::validate REFUSED the transaction: {e}");
            std::process::exit(1);
        }
    }
}

/// Put the proved transaction in front of `Ledger::validate` — upstream's own admission, the
/// function a node runs on everything submitted to it (`randprotocol_core::ledger::Ledger`, which
/// routes `Action::BridgeBurn` to `ledger::bridge_notes::validate`: the asset bundle's shape, the
/// four-nullifier/four-commitment cross-check, `BridgeState::check_burn`, and finally both
/// bundles' proofs).
///
/// The ledger is built to be the one this fixture was witnessed against: the fixture's two leaves
/// appended in leaf-index order (so the recorded anchor is the request's `anchor_root`), the
/// height set to the request's `anchor_height` (so both bundles' `time` is in the window), and a
/// bridge registry holding exactly the fixture's asset on the fixture's chain (so `check_burn`
/// resolves it). Everything else is the chain's own rule, unmodified.
fn admits(req: &BurnRequest, tx_hex: &str, profile: &str) -> Result<(), String> {
    let profile = match profile {
        "test" => FriProfile::Test,
        _ => FriProfile::Production,
    };
    let exec = ZkExecutor::new(profile);
    let mut ledger = Ledger::new(req.chain_id, ZkExecutor::hc_bundle(), BTreeMap::new(), &exec);

    // The fixture's leaves, in leaf-index order: appending them reproduces the very tree the
    // witnesses were folded against.
    let mut leaves: Vec<(u64, Word8)> = req
        .inputs
        .iter()
        .chain(&req.fee_inputs)
        .map(|i| {
            let cm = word8_from_hex(&i.note.cm).ok_or_else(|| format!("leaf {} has no commitment", i.note.index))?;
            Ok((i.note.index, cm))
        })
        .collect::<Result<_, String>>()?;
    leaves.sort_by_key(|(index, _)| *index);
    for (index, cm) in &leaves {
        ledger.deposit(*cm, &exec).map_err(|e| format!("appending leaf {index}: {e}"))?;
    }
    // Only a recorded block-end root is an anchor (spec §7 item 4), and a bundle's `time` must be
    // this height at the latest and at most TIME_WINDOW behind it.
    ledger.record_anchor(1);
    ledger.set_height(req.anchor_height);
    ledger.set_timestamp_ms(1_000_000);
    let anchor = word8_from_hex(&req.anchor_root).ok_or("anchor_root is not 64 hex characters")?;
    if !ledger.is_anchor(&anchor) {
        return Err("the fixture's anchor is not this ledger's root — the two trees disagree".into());
    }

    // A registry holding exactly this burn's asset, on the chain the request names. Everything
    // else about the burn — that `to` is shaped for that chain, that the relayer fee is a portion
    // of the amount — is `BridgeState::check_burn`'s own and is left to it.
    let mut bridge = BridgeState::default();
    let token = [0x22u8; 32];
    bridge.assets.insert(asset_id(req.to_chain, &token), AssetInfo { chain: req.to_chain, token, index: req.asset });
    bridge.next_index = req.asset + 1;
    ledger.set_bridge(Some(bridge));

    let bytes = hex::decode(tx_hex).map_err(|e| format!("tx_hex is not hex: {e}"))?;
    let tx = Transaction::decode(&bytes).map_err(|e| format!("tx_hex does not decode as a transaction: {e}"))?;
    ledger.validate(&tx, &exec).map_err(|e| format!("{e:?}"))
}
