//! Rand Wallet for Windows, Linux and macOS.
//!
//! The one shell in which a transfer can actually complete. A bundle proof peaks at about 5.7 GB
//! and wasm32 stops at 4 GiB, so the web wallet and the browser extension can do everything except
//! the proof itself; here the chain crypto is `wallet-core` compiled for this machine, with no
//! limit but its real RAM.
//!
//! What this binary is **not** is a second wallet. The screens, the scanning, the note store, the
//! JSON-RPC client and the verified-chain gate are `ui/` and `ui/engine/*.js`, running unmodified
//! in the webview — the same files the web wallet and the extension run, the same tests. This
//! process contributes four things and nothing else:
//!
//!   * `core_call`, a passthrough to `wallet_core::call` (see `commands.rs` on why it must not run
//!     on the main thread);
//!   * `system_memory_gib`, which is the whole of `send.canProve()`'s evidence;
//!   * `storage_*` / `storage_session_*`, a JSON file and a `HashMap` (see `storage.rs`);
//!   * a window, and `tauri-plugin-opener` for the two explorer links a screen may offer.
//!
//! There is no native HTTP: `ui/engine/rpc.js` takes an injectable `fetch` and the webview's own
//! satisfies it, so no node reply ever passes through Rust.

// A release build on Windows is a GUI app, not a console one.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod commands;
mod storage;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // The store is opened once, here, and handed to the commands as managed state: one path,
        // one lock, for the life of the process.
        .manage(storage::Storage::in_data_dir())
        .manage(storage::Session::default())
        .invoke_handler(tauri::generate_handler![
            commands::core_call,
            commands::system_memory_gib,
            commands::app_version,
            commands::storage_get,
            commands::storage_set,
            commands::storage_remove,
            commands::storage_clear,
            commands::storage_session_get,
            commands::storage_session_set,
            commands::storage_session_remove,
        ])
        .run(tauri::generate_context!())
        .expect("Rand Wallet could not start");
}
