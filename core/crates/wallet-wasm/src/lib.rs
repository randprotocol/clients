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

// The binding is plain Rust on the host (wasm-bindgen only generates glue on wasm32), so its
// surface is tested natively; the glue itself is exercised by the browser tests under web/.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_the_cores() {
        assert_eq!(version(), wallet_core::VERSION);
        assert!(!version().is_empty());
    }

    #[test]
    fn call_is_the_cores_call() {
        let reply = call("format_amount", r#"{"units":"1500000000"}"#);
        assert_eq!(reply, wallet_core::call("format_amount", r#"{"units":"1500000000"}"#));
        let v: serde_json::Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(v, serde_json::json!({ "ok": true, "value": "1.5" }));
    }

    #[test]
    fn call_reports_errors_as_json_replies() {
        let v: serde_json::Value = serde_json::from_str(&call("nope", "{}")).unwrap();
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap().contains("unknown method"), "{v}");
        let v: serde_json::Value = serde_json::from_str(&call("version", "{")).unwrap();
        assert!(v["error"].as_str().unwrap().contains("params is not JSON"), "{v}");
    }

    #[test]
    fn start_installs_the_panic_hook_without_panicking() {
        start();
        start(); // idempotent: set_once may be called again
    }
}
