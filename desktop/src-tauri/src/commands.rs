//! Every Tauri command the desktop wallet has. There are deliberately very few.
//!
//! The wallet's logic — scanning, the note store, chain-identity verification, the unlock throttle,
//! the whole trust boundary task 1.6 hardened over five rounds — is `ui/engine/*.js`, running
//! unmodified in the webview. It is not ported here and must not be: a second implementation of a
//! security boundary is a second thing to get right. What Rust is for in this app is the two
//! things a webview genuinely cannot do — call the real `wallet-core` crate (so a bundle proof can
//! run at all), and look at the machine — plus somewhere to keep bytes.
//!
//! In particular there is **no** `http_post` command: `ui/engine/rpc.js` takes an injectable
//! `fetch` and the webview's own `fetch()` already satisfies it, so every JSON-RPC call to a node
//! goes straight from JavaScript, with no native code in the path. Nothing here interprets a
//! node's reply, because nothing here ever sees one.

use crate::storage::{Session, Storage};
use tauri::State;

/// The one call into the chain crypto: `wallet-core`'s own JSON-string-in, JSON-string-out entry
/// point, verbatim.
///
/// No validation and no interpretation, on purpose. `wallet-core` is a local, trusted crate
/// compiled into this binary — not the network — and the JS engine already validates every reply
/// that came from a *node*. Anything this wrapper decided to check would be a second opinion about
/// code that is in the same process.
pub fn core_call_sync(method: &str, params: &str) -> String {
    wallet_core::call(method, params)
}

/// `core_call(method, params) -> String`.
///
/// **`spawn_blocking`, and that is the whole point of this function.** A Tauri command written as
/// a plain synchronous `fn` runs on the **main thread**, and `prove_transfer` is a CPU-bound
/// STARK that takes minutes and peaks around 5.7 GB. On the main thread it would freeze the entire
/// window — no progress, no repaint, no cancel — for the length of the proof, and the operating
/// system would offer to kill the app. An `async fn` alone would be no better for a blocking call:
/// it would occupy an async-runtime worker instead. `spawn_blocking` puts it on the blocking pool,
/// where a multi-minute call belongs, and the webview stays live to paint the phase the engine is
/// reporting.
#[tauri::command]
pub async fn core_call(method: String, params: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || core_call_sync(&method, &params))
        .await
        .map_err(|e| format!("the wallet core did not finish: {e}"))
}

/// This machine's total RAM in GiB. Used by exactly one thing: `canProve()` in
/// `ui/engine/backend-native.js`, which refuses to start a proof on a machine that cannot hold one.
pub fn system_memory_gib_value() -> f64 {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    system.total_memory() as f64 / (1024.0 * 1024.0 * 1024.0)
}

#[tauri::command]
pub fn system_memory_gib() -> f64 {
    system_memory_gib_value()
}

/// `platform.version` — the app's own version, for the Settings screen.
#[tauri::command]
pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

// ------------------------------------------------------------------- the persistent half ------
// `value` is whatever the engine passed to `storage.set`, already `JSON.stringify`d; `get` hands
// back the same form. Nothing here knows what a vault or a note store looks like.
//
// The persistent commands are `async fn` so Tauri runs them off the main thread: a scan persists
// after every page, and a whole-file rewrite with an fsync has no business freezing the window.
// (The session commands stay sync: a HashMap read has no business on a thread pool either.)

#[tauri::command]
pub async fn storage_get(store: State<'_, Storage>, key: String) -> Result<Option<String>, String> {
    store.get(&key)
}

#[tauri::command]
pub async fn storage_set(store: State<'_, Storage>, key: String, value: String) -> Result<(), String> {
    store.set(&key, &value)
}

#[tauri::command]
pub async fn storage_remove(store: State<'_, Storage>, key: String) -> Result<(), String> {
    store.remove(&key)
}

/// `wallet.wipe()`. The session goes with the file: a wipe that left the unlocked spend key in
/// memory would be a wipe in name only — and so would one that left a crashed write's `tmp` twin
/// on disk (see `Storage::clear`).
pub fn wipe(store: &Storage, session: &Session) -> Result<(), String> {
    let cleared = store.clear();
    session.clear()?;
    cleared
}

#[tauri::command]
pub async fn storage_clear(store: State<'_, Storage>, session: State<'_, Session>) -> Result<(), String> {
    wipe(&store, &session)
}

// ---------------------------------------------------------------------- the session half ------

#[tauri::command]
pub fn storage_session_get(session: State<'_, Session>, key: String) -> Result<Option<String>, String> {
    session.get(&key)
}

#[tauri::command]
pub fn storage_session_set(session: State<'_, Session>, key: String, value: String) -> Result<(), String> {
    session.set(&key, value)
}

#[tauri::command]
pub fn storage_session_remove(session: State<'_, Session>, key: String) -> Result<(), String> {
    session.remove(&key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn core_call_is_a_passthrough_to_wallet_core() {
        // Byte for byte what calling the crate directly would have returned: this wrapper adds
        // nothing and takes nothing away.
        assert_eq!(core_call_sync("version", "{}"), wallet_core::call("version", "{}"));

        // …and it really is the core, not an empty stub that happens to agree with itself.
        let reply: Value = serde_json::from_str(&core_call_sync("version", "{}")).unwrap();
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["value"]["default_chain_id"], wallet_core::DEFAULT_CHAIN_ID);
        assert_eq!(reply["value"]["token_symbol"], "RAND");
        assert!(reply["value"]["prover_peak_memory_bytes"].as_u64().unwrap() > 1_000_000_000);
    }

    #[test]
    fn a_bad_call_is_the_cores_own_error_reply_not_a_panic() {
        // The reply shape is `{"ok":false,"error":"…"}` whatever went wrong, including a panic
        // inside the prover — `wallet_core::call` catches it. A command that unwound instead would
        // take the app's blocking pool with it.
        let unknown: Value = serde_json::from_str(&core_call_sync("no_such_method", "{}")).unwrap();
        assert_eq!(unknown["ok"], false);
        assert!(unknown["error"].as_str().unwrap().contains("no_such_method"));

        let malformed: Value = serde_json::from_str(&core_call_sync("version", "{not json")).unwrap();
        assert_eq!(malformed["ok"], false);

        let missing: Value = serde_json::from_str(&core_call_sync("wallet_info", "{}")).unwrap();
        assert_eq!(missing["ok"], false, "a missing parameter must be an error reply, not a panic");
    }

    #[test]
    fn a_real_keypair_round_trips_through_the_passthrough() {
        // Proof that this is the whole core and not just its constants: generate a wallet, then
        // parse the address it produced. Both go through `core_call_sync` exactly as the webview
        // would send them.
        let generated: Value = serde_json::from_str(&core_call_sync("keygen", "{}")).unwrap();
        assert_eq!(generated["ok"], true);
        let address = generated["value"]["address"].as_str().unwrap();
        assert!(address.starts_with(wallet_core::ADDRESS_HRP), "{address}");

        let params = serde_json::json!({ "address": address }).to_string();
        let parsed: Value = serde_json::from_str(&core_call_sync("parse_address", &params)).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["value"]["valid"], true);
    }

    #[test]
    fn system_memory_is_a_plausible_positive_number() {
        let gib = system_memory_gib_value();
        assert!(gib > 0.0, "this machine reported {gib} GiB of memory");
        // Not an exact figure — it is whatever machine this is running on — but a number that
        // could be a computer's RAM. A unit mix-up (bytes, or kibibytes) lands far outside this.
        assert!(gib > 0.25 && gib < 100_000.0, "{gib} GiB is not a plausible amount of memory");
    }

    #[test]
    fn the_app_version_is_this_crates_version() {
        assert_eq!(app_version(), env!("CARGO_PKG_VERSION"));
        assert!(app_version().split('.').count() >= 2, "{}", app_version());
    }

    #[test]
    fn a_wipe_forgets_the_file_its_tmp_twin_and_the_unlocked_key_together() {
        let dir = std::env::temp_dir().join(format!("rand-wallet-wipe-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("wallet.json");
        let store = Storage::new(path.clone());
        store.set("vault", r#"{"ct":"AA"}"#).unwrap();
        // A write that died before its rename, and an unlocked wallet: all three must go as one.
        std::fs::write(path.with_extension("tmp"), br#"{"ct":"stale"}"#).unwrap();
        let session = Session::default();
        session.set("unlocked", r#"{"spend_key":"aa"}"#.into()).unwrap();

        wipe(&store, &session).unwrap();

        assert!(!path.exists(), "the store file survived a wipe");
        assert!(!path.with_extension("tmp").exists(), "a crashed write's tmp survived a wipe");
        assert_eq!(session.get("unlocked").unwrap(), None, "the unlocked key survived a wipe");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
