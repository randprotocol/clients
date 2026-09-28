//! `e2e-fixtures`: the bridge fixtures a JavaScript end-to-end test needs to mint a bridged token
//! to a wallet on a local one-validator Rand test chain, so the wallet can then burn it.
//!
//! The guardian material is the node test suite's (`crates/randprotocol-node/tests/common/
//! bridge.rs`): six ECDSA guardian secrets `[i; 32]` for `i` in `1..=6`, six Dilithium2 PQ
//! guardian keys from seeds `[0x70 + i; 32]`, the pause key from seed `[0x7f; 32]`, and each
//! source chain's emitter `[chain; 32]`. Those helpers are a test module and unreachable from a
//! binary, so they are copied here, built on the same public API.
//!
//! Subcommands:
//!
//! - `genesis`: splice a `bridge` section and a `tokens` section listing one bridged token (zUSD,
//!   backed by chain 2 USDT) into a genesis file `rand-node genesis` wrote.
//! - `attest`: write a guardian-signed transfer attestation (`attestation.hex`) and the PQ
//!   guardians' co-signatures over it (`pq.json`), exactly what `rand bridge-mint @attestation.hex
//!   --pq @pq.json` takes.
//! - `guardians`: print the guardian addresses, PQ public keys and the pause key as JSON.
//! - `recipient-hash`: the 32-byte `to` a deposit names a `rand1…` address by.

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use randprotocol_core::bridge::{
    digest, guardian_address, pq_cosign, sign_digest, Attestation, Body, BridgeConfig, Payload, PqSignature, Transfer,
    CHAIN_RAND,
};
use randprotocol_core::genesis::{Genesis, GenesisBacking, GenesisToken, TokensConfig};
use randprotocol_core::notes::ShieldedAddress;
use randprotocol_core::Keypair;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Chain 2 (Ethereum) USDT, the mainnet wire address: twelve zero bytes then the twenty-byte
/// contract address.
const USDT2_HEX: &str = "000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7";

/// One zUSD: a bridged token has eight decimals on Rand whatever its backings have at home.
const ZUSD: u64 = 100_000_000;

/// The daily mint cap per backing the genesis lists: 10 000 zUSD, in eight-decimal units.
const MINT_CAP: u64 = 10_000 * ZUSD;

/// What a `RegisterBridgedToken` owes after genesis: 1 RAND (nine decimals).
const REGISTRATION_FEE: u64 = randprotocol_core::UNITS_PER_RAND;

// ---------------------------------------------------------------- the test guardians

/// The six guardian secrets of a bridged test chain. Five signatures is a quorum for six keys.
fn guardian_secrets() -> Vec<[u8; 32]> {
    (1u8..=6).map(|i| [i; 32]).collect()
}

/// The six PQ guardians' Dilithium2 keys, index-aligned with [`guardian_secrets`].
fn pq_guardian_keys() -> Vec<Keypair> {
    (0..6u8).map(|i| Keypair::from_seed([0x70 + i; 32]).expect("a fixed seed makes a key")).collect()
}

/// The genesis `bridge.pause_key`'s keypair: it signs `M_pause` and nothing else.
fn pause_keypair() -> Keypair {
    Keypair::from_seed([0x7f; 32]).expect("a fixed seed makes a key")
}

/// A source chain's registered emitter address on a test chain: 32 bytes of the chain id.
fn emitter_of(chain: u16) -> [u8; 32] {
    [chain as u8; 32]
}

/// A `bridge` section naming those guardians, the PQ set and the pause key, with `emitter` as
/// Rand's own outbound emitter and every chain in `source_chains` registered at [`emitter_of`].
fn bridge_config_for(emitter: [u8; 32], source_chains: &[u16]) -> BridgeConfig {
    BridgeConfig {
        emitter,
        guardians: guardian_secrets().iter().map(guardian_address).collect(),
        emitters: source_chains.iter().map(|c| (*c, emitter_of(*c))).collect::<BTreeMap<_, _>>(),
        pq_guardians: pq_guardian_keys().iter().map(|k| k.public_key().clone()).collect(),
        pause_key: Some(pause_keypair().public_key().clone()),
        rules_v2: None,
        guardian_set_index: None,
        burn_sequence: None,
        min_inbound_sequence: None,
    }
}

/// One inbound transfer attestation, guardian set 0, signed by the lowest five guardians:
/// `amount` (eight-decimal wire units) of `token` native to `chain`, emitted by that chain's
/// registered emitter with `sequence`, addressed to the recipient hash `to`.
fn transfer_attestation(chain: u16, token: [u8; 32], to: [u8; 32], amount: u128, sequence: u64) -> Vec<u8> {
    let secrets = guardian_secrets();
    let body = Body {
        timestamp: 1,
        nonce: 0,
        emitter_chain: chain,
        emitter_address: emitter_of(chain),
        sequence,
        consistency_level: 0,
        payload: Payload::Transfer(Transfer {
            amount: Transfer::u256_from_u128(amount),
            token_address: token,
            token_chain: chain,
            to,
            to_chain: CHAIN_RAND,
            fee: Transfer::u256_from_u128(0),
        })
        .encode(),
    };
    let d = digest(&body.encode());
    let signatures = (0..5).map(|i| sign_digest(&secrets[i], i as u8, &d)).collect();
    Attestation { guardian_set_index: 0, signatures, body }.encode()
}

/// The lowest-five PQ co-signature quorum over `attestation`'s `mu` on chain `chain_id`.
fn pq_quorum(chain_id: u64, attestation: &[u8]) -> Vec<PqSignature> {
    let mu = Attestation::body_bytes(attestation).map(digest).expect("a decodable attestation");
    pq_guardian_keys().iter().take(5).enumerate().map(|(i, k)| pq_cosign(k, i as u8, chain_id, &mu)).collect()
}

// ---------------------------------------------------------------- the command line

#[derive(Parser)]
#[command(name = "e2e-fixtures", about = "Bridge fixtures for an end-to-end test on a local Rand chain", version)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Read a genesis file `rand-node genesis` wrote and write it back with a `bridge` section
    /// (the test guardians, the PQ set, the pause key, an emitter per source chain) and a
    /// `tokens` section listing one bridged token: zUSD, backed by chain 2 USDT.
    Genesis {
        /// The genesis file to read.
        #[arg(long = "in")]
        input: PathBuf,
        /// Where to write the bridged genesis (may be the same file).
        #[arg(long)]
        out: PathBuf,
        /// Rand's own outbound emitter, 64 hex characters.
        #[arg(long, default_value = "0101010101010101010101010101010101010101010101010101010101010101")]
        rand_emitter: String,
        /// The source chains to register an emitter for; repeatable. The listed token's backing
        /// is on the first one.
        #[arg(long, default_values_t = [2u16])]
        source_chain: Vec<u16>,
        /// The listed token's backing at home, 64 hex characters.
        #[arg(long, default_value = USDT2_HEX)]
        token: String,
        /// The backing's decimals at home (USDT on Ethereum: 6).
        #[arg(long, default_value_t = 6)]
        token_decimals: u8,
        /// The per-backing daily mint cap, in the token's eight-decimal units.
        #[arg(long, default_value_t = MINT_CAP)]
        mint_cap_per_day: u64,
        /// What a later `RegisterBridgedToken` pays, in RAND units (nine decimals).
        #[arg(long, default_value_t = REGISTRATION_FEE)]
        registration_fee: u64,
    },
    /// Write `attestation.hex` and `pq.json`: a guardian-signed transfer attestation (set 0, five
    /// ECDSA signatures) of `amount` wire units of `token` on `source-chain` to the recipient hash
    /// `to`, and the five PQ guardians' Dilithium2 co-signatures over it for `chain-id`.
    Attest {
        /// The recipient hash the deposit names, 64 hex characters (`recipient-hash` prints it).
        #[arg(long, conflicts_with = "to_address", required_unless_present = "to_address")]
        to: Option<String>,
        /// The recipient's `rand1…` address instead of its hash.
        #[arg(long)]
        to_address: Option<String>,
        /// The amount in eight-decimal wire units (1 zUSD = 100000000).
        #[arg(long)]
        amount: u128,
        /// The source emitter's message sequence; every deposit needs a fresh one.
        #[arg(long)]
        sequence: u64,
        /// The source chain the deposit was locked on.
        #[arg(long, default_value_t = 2)]
        source_chain: u16,
        /// The token locked there, 64 hex characters.
        #[arg(long, default_value = USDT2_HEX)]
        token: String,
        /// The Rand chain id the PQ co-signatures are bound to.
        #[arg(long, default_value_t = 16)]
        chain_id: u64,
        /// Where to write `attestation.hex` and `pq.json`.
        #[arg(long)]
        out_dir: PathBuf,
    },
    /// Print the guardian ECDSA addresses, the PQ public keys and the pause key as JSON.
    Guardians,
    /// Print the 32-byte recipient hash a bridge deposit names a `rand1…` address by.
    RecipientHash {
        /// The `rand1…` shielded address.
        address: String,
    },
}

fn hex32(s: &str) -> Result<[u8; 32]> {
    let s = s.trim();
    let bytes = hex::decode(s.strip_prefix("0x").unwrap_or(s)).with_context(|| format!("{s:?} is not hex"))?;
    <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| anyhow::anyhow!("{s:?} is {} bytes, not 32", bytes.len()))
}

fn parse_address(s: &str) -> Result<ShieldedAddress> {
    ShieldedAddress::parse(s.trim()).map_err(|e| anyhow::anyhow!("{s:?} is not a shielded address: {e}"))
}

fn main() -> Result<()> {
    match Cli::parse().cmd {
        Cmd::Genesis { input, out, rand_emitter, source_chain, token, token_decimals, mint_cap_per_day, registration_fee } => {
            let text = std::fs::read_to_string(&input).with_context(|| format!("reading {}", input.display()))?;
            let original: Value = serde_json::from_str(&text).context("the input is not JSON")?;
            let mut g = Genesis::from_json(&text).context("the input is not a genesis file")?;
            if source_chain.is_empty() {
                bail!("at least one --source-chain is needed");
            }
            g.bridge = Some(bridge_config_for(hex32(&rand_emitter)?, &source_chain));
            g.tokens = Some(TokensConfig {
                registration_fee,
                mint_cap_per_day,
                tokens: vec![GenesisToken {
                    name: "Rand USD".into(),
                    symbol: "zUSD".into(),
                    salt: [0u8; 32],
                    backings: vec![GenesisBacking { chain: source_chain[0], token: hex32(&token)?, decimals: token_decimals, locked: None }],
                }],
                max_tokens: None,
                burn_registration_fee: None,
                bound_note_value: None,
            });
            // The round trip: every field the input carried must come back as it was, so what is
            // written differs from `rand-node genesis`'s file by the two sections alone.
            let written = g.to_json();
            let mut back: Value = serde_json::from_str(&written)?;
            let obj = back.as_object_mut().context("a genesis serializes as an object")?;
            obj.remove("bridge");
            obj.remove("tokens");
            if back != original {
                bail!("the genesis did not round-trip: fields were lost or changed\n{back}\n!=\n{original}");
            }
            std::fs::write(&out, &written).with_context(|| format!("writing {}", out.display()))?;
            eprintln!("wrote {}: bridge section (guardian set 0, {} source chains) and tokens section (zUSD listed at index 1)", out.display(), source_chain.len());
        }
        Cmd::Attest { to, to_address, amount, sequence, source_chain, token, chain_id, out_dir } => {
            let to = match (to, to_address) {
                (Some(h), _) => hex32(&h)?,
                (None, Some(a)) => parse_address(&a)?.recipient_hash(),
                (None, None) => bail!("--to or --to-address is needed"),
            };
            let attestation = transfer_attestation(source_chain, hex32(&token)?, to, amount, sequence);
            let pq = pq_quorum(chain_id, &attestation);
            let rows: Vec<Value> = pq.iter().map(|s| json!({ "index": s.index, "signature": hex::encode(&s.signature) })).collect();
            std::fs::create_dir_all(&out_dir).with_context(|| format!("creating {}", out_dir.display()))?;
            let att_path = out_dir.join("attestation.hex");
            let pq_path = out_dir.join("pq.json");
            std::fs::write(&att_path, format!("{}\n", hex::encode(&attestation)))?;
            std::fs::write(&pq_path, format!("{}\n", serde_json::to_string_pretty(&rows)?))?;
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "attestation": att_path,
                    "pq": pq_path,
                    "to": hex::encode(to),
                    "amount": amount.to_string(),
                    "sequence": sequence,
                    "source_chain": source_chain,
                    "token": token,
                    "chain_id": chain_id,
                    "attestation_bytes": attestation.len(),
                    "digest": hex::encode(digest(Attestation::body_bytes(&attestation).unwrap())),
                }))?
            );
        }
        Cmd::Guardians => {
            let out = json!({
                "guardians": guardian_secrets().iter().map(|s| json!({
                    "secret": hex::encode(s),
                    "address": hex::encode(guardian_address(s)),
                })).collect::<Vec<_>>(),
                "pq_guardians": pq_guardian_keys().iter().map(|k| json!({
                    "seed": hex::encode(k.seed()),
                    "public_key": k.public_key().to_hex(),
                })).collect::<Vec<_>>(),
                "pause_key": { "seed": hex::encode(pause_keypair().seed()), "public_key": pause_keypair().public_key().to_hex() },
                "quorum": 5,
                "emitter_rule": "a source chain's emitter is 32 bytes of its chain id: chain 2 -> 0202…02",
            });
            println!("{}", serde_json::to_string_pretty(&out)?);
        }
        Cmd::RecipientHash { address } => {
            println!("{}", hex::encode(parse_address(&address)?.recipient_hash()));
        }
    }
    Ok(())
}
