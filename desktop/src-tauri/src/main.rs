//! Rand Wallet for Windows, Linux and macOS.
//!
//! The one shell in which a transfer can actually complete. A bundle proof peaks at about 6.2 GB
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
//!   * a window, and `tauri-plugin-opener` for the two explorer links a screen may offer;
//!   * `prover_*`, the fullnode's own prover service run on 127.0.0.1 when the user turns on
//!     "Prove for my other devices" (see `prover.rs`).
//!
//! There is no native HTTP: `ui/engine/rpc.js` takes an injectable `fetch` and the webview's own
//! satisfies it, so no node reply ever passes through Rust.

// A release build on Windows is a GUI app, not a console one.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod commands;
mod prover;
mod storage;

use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

fn main() {
    tauri::Builder::default()
        // FIRST among the plugins, as tauri-plugin-single-instance requires. On Windows/Linux a
        // second `randpay:` click starts a second process with the link as its argument; without
        // this, that process would open the same store file (vault included) beside this one.
        // With the plugin's `deep-link` feature the second launch's argv is handed to this
        // process's deep-link plugin, which emits the same `deep-link://new-url` event the UI
        // already listens on (`ui-shell/main.js`), and the second process exits. All this
        // closure has to do is bring the running window forward.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.webview_windows().values().next() {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        // `randpay:` links (spec 2026-09-26 §3.3): the scheme is registered in tauri.conf.json's
        // `plugins.deep-link.desktop.schemes`. On macOS that registration is read from the built
        // bundle's Info.plist, so `cargo tauri dev` alone does not make the OS route `open
        // "randpay:…"` to a dev build; on Windows/Linux the OS instead relaunches this binary
        // with the link as its one argument, which is why `register_all()` is asked for here too
        // — an AppImage or a dev binary that was never "installed" the usual way still gets the
        // scheme. Either path, the plugin re-emits the link to the webview as the
        // `deep-link://new-url` event (macOS: `RunEvent::Opened`, below; Windows/Linux: the CLI
        // argument, at `init()`) — `ui-shell/main.js` is what listens and forwards it to the send
        // screen; nothing here parses the link itself.
        .plugin(tauri_plugin_deep_link::init())
        // The store is opened once, here, and handed to the commands as managed state: one path,
        // one lock, for the life of the process.
        .manage(storage::Storage::in_data_dir())
        .manage(storage::Session::default())
        // "Prove for my other devices" (prover.rs): off until the Settings toggle starts it.
        .manage(prover::ProverState::default())
        .setup(|app| {
            // Windows/Linux only (macOS/Android/iOS register the scheme from the bundle's own
            // config at build time and answer `Err(UnsupportedPlatform)` here — discarded, not
            // fatal): makes sure the scheme is registered even for a dev binary or an AppImage
            // that was never "installed" the usual way. A link the OS never routed here just
            // falls back to paste, exactly as a browser that refused registerProtocolHandler does
            // for the web wallet.
            let _ = app.deep_link().register_all();
            Ok(())
        })
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
            commands::prover_status,
            commands::prover_start,
            commands::prover_stop,
            commands::prover_pairing_link,
            commands::prover_rotate_pairing,
        ])
        .run(tauri::generate_context!())
        .expect("Rand Wallet could not start");
}
