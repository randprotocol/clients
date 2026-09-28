//! "Prove for my other devices" (delegated-proving spec 2026-09-28 §5).
//!
//! Turning the Settings toggle on runs the fullnode's own prover service — the crate
//! `randprotocol-prover`, vendored with the rest of the chain code — inside this process: its
//! ML-KEM key, its pairing store, its one-job-at-a-time queue and its `prover_*` JSON-RPC
//! listener. Nothing about proving is re-implemented here; this module decides only
//!
//!   * **where** — `127.0.0.1:8600` by default, and a busy port is refused with a sentence, never
//!     moved to a random one: the pairing link embeds the URL, so a port that changed under it
//!     would silently break every wallet already paired;
//!   * **what it accepts** — spend-key witnesses (this is the owner's own machine: the link is
//!     marked `own`), one proof at a time, and not at all on a machine without the memory for one
//!     (`memory_check(1)`, over `randprotocol_prover::memory`: one tier-14 bundle's peak plus a
//!     gigabyte, the spec's "8 GB");
//!   * **the one pairing** — labelled `desktop`, minted the first time the prover starts.
//!
//! The pairing token is a bearer secret the prover itself keeps only as a hash, yet the link must
//! be showable again (a user opens Settings on the phone next week, not now). So the token is kept
//! in the app's own store (`Storage`, key [`TOKEN_KEY`]) — the same file, the same directory and
//! the same owner-only mode as the encrypted vault, i.e. the same trust level as the rest of this
//! app's data on this machine. It never enters `settings.get()` (the engine reads named keys, and
//! this is not one), a log line, or a status reply; it leaves Rust only inside the link that
//! [`pairing_link`] returns for the screen to show. A wipe (which removes the store file) forgets
//! it, and the next link mints a fresh one and retires the old pairing.
//!
//! The logic takes a directory and an address rather than an app handle, so the tests below run it
//! against a temporary directory on `127.0.0.1:0` without a window.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use randprotocol_prover::http;
use randprotocol_prover::key::ProverKey;
use randprotocol_prover::pairing::{PairingLink, Pairings};
use randprotocol_prover::service::{Config, Shared};
use serde::Serialize;

use crate::storage::Storage;

/// Where the listener binds unless told otherwise: this machine only (spec §5: "bound to
/// 127.0.0.1 by default"). Another device needs a reachable TLS address — out of scope (§5).
pub const DEFAULT_ADDR: SocketAddr = SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 8600);
/// The store key the desktop pairing's token lives under (see the module comment).
pub const TOKEN_KEY: &str = "prover.desktop_token";
/// The one pairing this app mints, for the owner's own wallets.
pub const LABEL: &str = "desktop";
const KEY_FILE: &str = "prover.key.json";
const PAIRINGS_FILE: &str = "pairings.json";

/// `<data dir>/prover`: the prover's key and pairing store, beside the wallet's own file.
pub fn dir() -> PathBuf {
    crate::storage::data_dir().join("prover")
}

/// A running service: the bound address (`:0` resolves here), the service (for its queue), the
/// listener task (aborting it closes the port) and the pairings it admits against.
struct Running {
    addr: SocketAddr,
    svc: Shared,
    task: tokio::task::JoinHandle<()>,
    pairings: Arc<RwLock<Pairings>>,
    fingerprint: String,
}

/// Managed state: at most one service per process.
///
/// `inner` is an async lock because `start` holds it across the bind and the service start, so two
/// clicks cannot start two listeners. `draining` keeps a stopped service whose proof was still
/// running: stopping aborts the listener, but a proof already on its blocking thread cannot be
/// interrupted and finishes (its reply is never collected — nothing is listening). Until it does,
/// the status says so, because the memory is still in use.
#[derive(Default)]
pub struct ProverState {
    inner: tokio::sync::Mutex<Option<Running>>,
    draining: Mutex<Option<Shared>>,
}

/// What `prover_status`, `prover_start` and `prover_stop` answer. No token, ever.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Status {
    pub running: bool,
    /// `127.0.0.1:8600` while running.
    pub addr: Option<String>,
    /// The prover key's fingerprint (`XXXX-XXXX-XXXX-XXXX`), once a key exists — the string a
    /// pairing wallet shows its user to compare.
    pub fingerprint: Option<String>,
    /// A proof is running (or, after a stop, still finishing).
    pub proving: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// A sentence for the screen, e.g. that a proof outlives the stop.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

const DRAINING_NOTE: &str = "Proofs this computer had already accepted are finishing in the background; their results will not be served.";

fn proving(svc: &Shared) -> bool {
    svc.info().queue.proving > 0
}

/// Accepted work not yet finished: proving, or queued behind it (a stopped service's worker still
/// takes the next queued job: the vendored `Service` gained `shutdown` at fullnode `e6d1327`, but
/// the stop path here does not call it yet — wiring it in is the final wave's job).
fn busy(svc: &Shared) -> bool {
    let q = svc.info().queue;
    q.proving + q.depth > 0
}

/// Owner-only on unix: the directory holds the prover's private key.
fn ensure_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("could not restrict {}: {e}", dir.display()))?;
    }
    Ok(())
}

/// The key at `<dir>/prover.key.json`, created (mode 0600, never overwritten) the first time.
fn load_or_create_key(dir: &Path) -> Result<ProverKey, String> {
    ensure_dir(dir)?;
    let path = dir.join(KEY_FILE);
    match ProverKey::load(&path) {
        Ok(k) => Ok(k),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let k = ProverKey::generate();
            k.save_new(&path).map_err(|e| format!("could not write the prover key: {e}"))?;
            Ok(k)
        }
        Err(e) => Err(format!("could not read the prover key: {e}")),
    }
}

/// The fingerprint of the key on disk, without creating one.
fn fingerprint_on_disk(dir: &Path) -> Option<String> {
    ProverKey::load(&dir.join(KEY_FILE)).ok().map(|k| k.fingerprint().to_string())
}

fn stored_token(store: &Storage) -> Option<[u8; 32]> {
    let raw = store.get(TOKEN_KEY).ok()??;
    let hex_text: String = serde_json::from_str(&raw).ok()?;
    let bytes = decode_hex32(&hex_text)?;
    Some(bytes)
}

fn decode_hex32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 { return None; }
    let mut out = [0u8; 32];
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
        let pair = std::str::from_utf8(chunk).ok()?;
        out[i] = u8::from_str_radix(pair, 16).ok()?;
    }
    Some(out)
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Mints the `desktop` pairing afresh — any older one under that label is removed first, so its
/// token stops being accepted — saves the store and keeps the new token. Returns the token.
fn mint(pairings: &mut Pairings, dir: &Path, store: &Storage) -> Result<[u8; 32], String> {
    pairings.unpair(LABEL);
    let token = pairings.pair(LABEL, true)?;
    pairings.save(&dir.join(PAIRINGS_FILE)).map_err(|e| format!("could not save the pairings: {e}"))?;
    store.set(TOKEN_KEY, &serde_json::Value::String(encode_hex(&token)).to_string())?;
    Ok(token)
}

/// The `desktop` pairing's token: the kept one while the store still admits it, else a new one.
fn ensure_pairing(pairings: &mut Pairings, dir: &Path, store: &Storage) -> Result<[u8; 32], String> {
    if let Some(token) = stored_token(store) {
        if pairings.lookup(&token).is_some_and(|p| p.label == LABEL && p.own) {
            return Ok(token);
        }
    }
    mint(pairings, dir, store)
}

/// Runs `f` on the pairings the prover admits against: the running service's own (so a change
/// takes effect at once) or, while stopped, the store on disk.
fn with_pairings<T>(
    running: Option<&Running>,
    dir: &Path,
    f: impl FnOnce(&mut Pairings) -> Result<T, String>,
) -> Result<T, String> {
    match running {
        Some(r) => {
            let mut guard = r.pairings.write().map_err(|_| "the pairing store lock is poisoned".to_string())?;
            f(&mut guard)
        }
        None => {
            ensure_dir(dir)?;
            let mut ps = Pairings::load(&dir.join(PAIRINGS_FILE)).map_err(|e| format!("could not read the pairings: {e}"))?;
            f(&mut ps)
        }
    }
}

fn status_of(running: Option<&Running>, draining: Option<&Shared>, dir: &Path) -> Status {
    match running {
        Some(r) => Status {
            running: true,
            addr: Some(r.addr.to_string()),
            fingerprint: Some(r.fingerprint.clone()),
            proving: proving(&r.svc),
            error: None,
            note: None,
        },
        None => {
            let finishing = draining.is_some_and(busy);
            Status {
                running: false,
                addr: None,
                fingerprint: fingerprint_on_disk(dir),
                proving: finishing,
                error: None,
                note: finishing.then(|| DRAINING_NOTE.to_string()),
            }
        }
    }
}

impl ProverState {
    /// The draining service, dropped once its proof has returned.
    fn draining(&self) -> Option<Shared> {
        let mut g = self.draining.lock().unwrap_or_else(|p| p.into_inner());
        if g.as_ref().is_some_and(|s| !busy(s)) {
            *g = None;
        }
        g.clone()
    }
}

/// `prover_status`.
pub async fn status(state: &ProverState, dir: &Path) -> Status {
    let g = state.inner.lock().await;
    status_of(g.as_ref(), state.draining().as_ref(), dir)
}

/// The app's memory gate: `randprotocol_prover::memory`'s numbers, but the refusal is worded for
/// the GUI — the library's own advice names `rand-prover` command-line flags a desktop user has no
/// way to pass.
pub fn memory_check(slots: usize) -> Result<(), String> {
    use randprotocol_prover::memory::{available_bytes, required_bytes};
    let (need, have) = (required_bytes(slots), available_bytes());
    if have < need { Err(memory_refusal(need, have)) } else { Ok(()) }
}

fn memory_refusal(need: u64, have: u64) -> String {
    let gb = |b: u64| b as f64 / 1e9;
    format!(
        "proving needs {:.1} GB of available memory and this computer has {:.1} GB available — \
         close other applications or use a machine with more memory",
        gb(need),
        gb(have)
    )
}

/// `prover_start`: the memory gate, the key, the `desktop` pairing, the bind, the service. Already
/// running is not an error — the current status is the answer. `memory` is `memory_check` in the
/// app and a stand-in under test (a CI box need not hold a proof's worth of free memory to test
/// the plumbing).
pub async fn start(
    state: &ProverState,
    dir: &Path,
    store: &Storage,
    addr: SocketAddr,
    memory: impl FnOnce(usize) -> Result<(), String>,
) -> Result<Status, String> {
    let mut g = state.inner.lock().await;
    if g.is_none() {
        // One proof at a time (spec §5), so one slot's worth of memory.
        memory(1).map_err(|why| format!("This computer cannot prove for other devices right now: {why}"))?;
        let key = load_or_create_key(dir)?;
        let mut pairings = with_pairings(None, dir, |p| Ok(std::mem::take(p)))?;
        ensure_pairing(&mut pairings, dir, store)?;
        let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::AddrInUse {
                format!("{addr} is already in use by another program. Close it and turn this on again — the pairing link names this address, so the prover will not move to another port.")
            } else {
                format!("could not listen on {addr}: {e}")
            }
        })?;
        let fingerprint = key.fingerprint().to_string();
        let mut cfg = Config::new(key, pairings);
        cfg.accept_spend_key = true; // the owner's own machine; the link is marked `own`
        cfg.max_parallel = 1;
        let shared_pairings = cfg.pairings.clone();
        let (bound, svc, task) = http::serve_on(listener, cfg).await.map_err(|e| format!("the prover did not start: {e}"))?;
        *g = Some(Running { addr: bound, svc, task, pairings: shared_pairings, fingerprint });
    }
    Ok(status_of(g.as_ref(), state.draining().as_ref(), dir))
}

/// `prover_stop`: aborts the listener and waits until its socket is closed. A proof already
/// running cannot be interrupted; it finishes on its blocking thread and the status says so.
///
/// Aborting the listener task does not end a connection it already accepted (axum runs each on
/// its own task), so the stopped service's pairings are also emptied in memory — not on disk — and
/// a keep-alive connection that outlives the stop can submit nothing: every job is `Unpaired`.
pub async fn stop(state: &ProverState, dir: &Path) -> Status {
    let mut g = state.inner.lock().await;
    if let Some(r) = g.take() {
        r.task.abort();
        let _ = r.task.await; // the listener (and the port) is released when the task is dropped
        r.pairings.write().unwrap_or_else(|p| p.into_inner()).pairings.clear();
        if busy(&r.svc) {
            *state.draining.lock().unwrap_or_else(|p| p.into_inner()) = Some(r.svc);
        }
        // The service's idle workers keep a reference to it until the process exits (the vendored
        // `Service::start` does not hand back their handles): a few kilobytes per start, no port.
    }
    status_of(g.as_ref(), state.draining().as_ref(), dir)
}

fn link_for(dir: &Path, addr: SocketAddr, token: [u8; 32]) -> Result<String, String> {
    let key = load_or_create_key(dir)?;
    Ok(PairingLink { kem_ek: key.kem_ek().to_vec(), url: format!("http://{addr}"), token, own: true }.format())
}

/// `prover_pairing_link`: the `randprover:` link for the `desktop` pairing, the same one every time
/// (the kept token) until it is rotated or the wallet is wiped. The URL is the running listener's,
/// or `addr` (the default) while stopped.
pub async fn pairing_link(state: &ProverState, dir: &Path, store: &Storage, addr: SocketAddr) -> Result<String, String> {
    let g = state.inner.lock().await;
    let token = with_pairings(g.as_ref(), dir, |p| ensure_pairing(p, dir, store))?;
    link_for(dir, g.as_ref().map_or(addr, |r| r.addr), token)
}

/// `prover_rotate_pairing`: "Regenerate link" — the old token stops being accepted at once (the
/// running service reads the same store) and a new link is returned.
pub async fn rotate_pairing(state: &ProverState, dir: &Path, store: &Storage, addr: SocketAddr) -> Result<String, String> {
    let g = state.inner.lock().await;
    let token = with_pairings(g.as_ref(), dir, |p| mint(p, dir, store))?;
    link_for(dir, g.as_ref().map_or(addr, |r| r.addr), token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::io::{Read, Write};
    use std::sync::atomic::{AtomicU32, Ordering};

    static NEXT: AtomicU32 = AtomicU32::new(0);

    /// A data directory of its own per test: the prover dir and the wallet store beside it.
    struct Fixture { root: PathBuf, dir: PathBuf, store: Storage }

    impl Fixture {
        fn new() -> Fixture {
            let root = std::env::temp_dir().join(format!(
                "rand-wallet-prover-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            let store = Storage::new(root.join("wallet.json"));
            Fixture { dir: root.join("prover"), root, store }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); }
    }

    fn any_port() -> SocketAddr { "127.0.0.1:0".parse().unwrap() }
    fn enough_memory(_: usize) -> Result<(), String> { Ok(()) }
    fn block_on<F: std::future::Future>(f: F) -> F::Output { tauri::async_runtime::block_on(f) }

    fn parse_link(link: &str) -> Value {
        let reply: Value = serde_json::from_str(&wallet_core::call("parse_prover_link", &json!({ "link": link }).to_string())).unwrap();
        assert_eq!(reply["ok"], true, "{reply}");
        reply["value"].clone()
    }

    /// One JSON-RPC call over a plain socket: a hand-written HTTP/1.1 POST, no client library.
    fn rpc(addr: &str, method: &str) -> Value {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": [] }).to_string();
        let mut s = std::net::TcpStream::connect(addr).unwrap();
        s.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
        write!(
            s,
            "POST / HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        let (head, body) = out.split_once("\r\n\r\n").expect("an HTTP reply");
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        serde_json::from_str(body.trim()).unwrap_or_else(|e| panic!("{e}: {body:?}"))
    }

    #[test]
    fn it_starts_serves_the_owners_spend_key_jobs_links_itself_and_stops_freeing_the_port() {
        let fx = Fixture::new();
        let state = ProverState::default();

        let started = block_on(start(&state, &fx.dir, &fx.store, any_port(), enough_memory)).unwrap();
        assert!(started.running, "{started:?}");
        assert!(!started.proving);
        let addr = started.addr.clone().unwrap();
        assert!(addr.starts_with("127.0.0.1:"), "{addr}");
        assert_ne!(addr, "127.0.0.1:0", "the status names the bound port, not the one asked for");
        assert_eq!(block_on(status(&state, &fx.dir)), started);

        // The link: the core reads it, it is marked own, and it names this key and this listener.
        let key = ProverKey::load(&fx.dir.join(KEY_FILE)).unwrap();
        let link = block_on(pairing_link(&state, &fx.dir, &fx.store, DEFAULT_ADDR)).unwrap();
        let parsed = parse_link(&link);
        assert_eq!(parsed["own"], true);
        assert_eq!(parsed["fingerprint"], key.fingerprint().to_string());
        assert_eq!(started.fingerprint.as_deref(), Some(key.fingerprint().to_string().as_str()));
        assert_eq!(parsed["url"], format!("http://{addr}"));

        // The service itself answers, and takes spend-key witnesses, one proof at a time.
        let info = rpc(&addr, "prover_info");
        assert_eq!(info["result"]["witness_kinds"], json!(["spend_key"]), "{info}");
        assert_eq!(info["result"]["kem_fingerprint"], key.fingerprint().to_string());

        // Stopped: the listener is gone and the port can be bound again.
        let admitted = block_on(state.inner.lock()).as_ref().unwrap().pairings.clone();
        assert_eq!(admitted.read().unwrap().pairings.len(), 1);
        let stopped = block_on(stop(&state, &fx.dir));
        assert!(admitted.read().unwrap().pairings.is_empty(), "a connection that outlived the stop could still submit");
        assert_eq!(Pairings::load(&fx.dir.join(PAIRINGS_FILE)).unwrap().pairings.len(), 1, "the stop unpaired on disk");
        assert!(!stopped.running, "{stopped:?}");
        assert_eq!(stopped.addr, None);
        assert_eq!(stopped.fingerprint, started.fingerprint, "the key outlives the stop");
        std::net::TcpListener::bind(&addr).expect("the port is free after stop");
    }

    #[test]
    fn the_link_is_the_same_after_a_restart_and_rotating_retires_the_old_token() {
        let fx = Fixture::new();
        let state = ProverState::default();
        block_on(start(&state, &fx.dir, &fx.store, any_port(), enough_memory)).unwrap();
        let first = parse_link(&block_on(pairing_link(&state, &fx.dir, &fx.store, DEFAULT_ADDR)).unwrap());
        block_on(stop(&state, &fx.dir));

        // Stopped, the link is still showable and names the default address.
        let stopped = parse_link(&block_on(pairing_link(&state, &fx.dir, &fx.store, DEFAULT_ADDR)).unwrap());
        assert_eq!(stopped["token"], first["token"]);
        assert_eq!(stopped["url"], "http://127.0.0.1:8600");

        block_on(start(&state, &fx.dir, &fx.store, any_port(), enough_memory)).unwrap();
        let again = parse_link(&block_on(pairing_link(&state, &fx.dir, &fx.store, DEFAULT_ADDR)).unwrap());
        assert_eq!(again["token"], first["token"], "the token was minted once and kept");
        assert_eq!(again["fingerprint"], first["fingerprint"], "the key was created once and kept");

        let rotated = parse_link(&block_on(rotate_pairing(&state, &fx.dir, &fx.store, DEFAULT_ADDR)).unwrap());
        assert_ne!(rotated["token"], first["token"]);
        assert_eq!(rotated["own"], true);
        // The running service admits the new token and not the old one: it reads the same store.
        let old = decode_hex32(first["token"].as_str().unwrap()).unwrap();
        let new = decode_hex32(rotated["token"].as_str().unwrap()).unwrap();
        {
            let g = block_on(state.inner.lock());
            let ps = g.as_ref().unwrap().pairings.read().unwrap();
            assert!(ps.lookup(&old).is_none(), "the old token is still paired");
            assert!(ps.lookup(&new).is_some_and(|p| p.label == LABEL && p.own));
            assert_eq!(ps.pairings.len(), 1);
        }
        let on_disk = Pairings::load(&fx.dir.join(PAIRINGS_FILE)).unwrap();
        assert!(on_disk.lookup(&old).is_none() && on_disk.lookup(&new).is_some(), "the rotation was not saved");
        block_on(stop(&state, &fx.dir));
    }

    #[test]
    fn a_wiped_store_mints_a_new_pairing_and_the_old_one_stops_working() {
        let fx = Fixture::new();
        let state = ProverState::default();
        let first = parse_link(&block_on(pairing_link(&state, &fx.dir, &fx.store, DEFAULT_ADDR)).unwrap());
        fx.store.clear().unwrap(); // wallet.wipe()
        let second = parse_link(&block_on(pairing_link(&state, &fx.dir, &fx.store, DEFAULT_ADDR)).unwrap());
        assert_ne!(second["token"], first["token"]);
        let ps = Pairings::load(&fx.dir.join(PAIRINGS_FILE)).unwrap();
        assert!(ps.lookup(&decode_hex32(first["token"].as_str().unwrap()).unwrap()).is_none());
        assert_eq!(ps.pairings.len(), 1);
    }

    #[test]
    fn a_busy_port_is_refused_with_a_sentence_not_moved() {
        let fx = Fixture::new();
        let state = ProverState::default();
        let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = taken.local_addr().unwrap();
        let err = block_on(start(&state, &fx.dir, &fx.store, addr, enough_memory)).unwrap_err();
        assert!(err.contains(&addr.to_string()) && err.contains("already in use"), "{err}");
        assert!(!block_on(status(&state, &fx.dir)).running);
    }

    #[test]
    fn the_memory_refusal_keeps_both_numbers_and_names_no_command_line_flag() {
        let msg = memory_refusal(6_740_000_000, 3_210_000_000);
        assert!(msg.contains("6.7 GB") && msg.contains("3.2 GB"), "{msg}");
        assert!(msg.contains("close other applications or use a machine with more memory"), "{msg}");
        assert!(!msg.contains("--"), "a GUI message names no CLI flag: {msg}");
    }

    #[test]
    fn too_little_memory_refuses_to_start_and_binds_nothing() {
        let fx = Fixture::new();
        let state = ProverState::default();
        let mut asked = None;
        let err = block_on(start(&state, &fx.dir, &fx.store, any_port(), |n| {
            asked = Some(n);
            Err("1 proving slot(s) need 6.7 GB".into())
        }))
        .unwrap_err();
        assert_eq!(asked, Some(1), "one proof at a time, so one slot's memory");
        assert!(err.contains("6.7 GB"), "{err}");
        assert!(!block_on(status(&state, &fx.dir)).running);
    }

    #[test]
    fn the_token_is_in_no_status_reply_and_never_in_settings() {
        let fx = Fixture::new();
        let state = ProverState::default();
        let running = block_on(start(&state, &fx.dir, &fx.store, any_port(), enough_memory)).unwrap();
        let link = parse_link(&block_on(pairing_link(&state, &fx.dir, &fx.store, DEFAULT_ADDR)).unwrap());
        let token = link["token"].as_str().unwrap().to_string();
        let stopped = block_on(stop(&state, &fx.dir));
        for s in [running, stopped] {
            let text = serde_json::to_string(&s).unwrap();
            assert!(!text.contains(&token), "a status carried the token: {text}");
        }
        // It is kept under its own key, which the engine's `settings` never reads.
        assert!(fx.store.get(TOKEN_KEY).unwrap().unwrap().contains(&token));
        assert_eq!(fx.store.get("settings").unwrap(), None);
    }

    #[test]
    fn starting_twice_is_the_same_service() {
        let fx = Fixture::new();
        let state = ProverState::default();
        let a = block_on(start(&state, &fx.dir, &fx.store, any_port(), enough_memory)).unwrap();
        let b = block_on(start(&state, &fx.dir, &fx.store, any_port(), |_| Err("not asked".into()))).unwrap();
        assert_eq!(a, b);
        block_on(stop(&state, &fx.dir));
    }
}
