//! `call(method, paramsJson) -> replyJson`, see `wallet_core::call`. Built with
//! `wasm-pack build --target web` (scripts/build-wasm.sh); the extension loads it in a Web Worker
//! so a bundle proof never blocks the UI.

use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn call(method: &str, params_json: &str) -> String {
    wallet_core::call(method, params_json)
}

#[wasm_bindgen]
pub fn version() -> String {
    wallet_core::VERSION.to_string()
}
