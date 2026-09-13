//! Benchmark a bundle proof on this machine: `cargo run --release --example prove_fixture [test|production]`.
//! Prints the proving time and proof size; run under `/usr/bin/time -l` (macOS) or
//! `/usr/bin/time -v` (Linux) for the peak memory, which is what decides whether a device can
//! prove at all.
use std::time::Instant;

fn main() {
    let profile = std::env::args().nth(1).unwrap_or_else(|| "production".into());
    let req = wallet_core::fixture_prove_request(&profile).expect("fixture");
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
