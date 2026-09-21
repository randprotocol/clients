//! `core_call` over stdin/stdout, for the Task 6.4 end-to-end run: the JS engine's
//! `backend-native.js` wants a `core.call(method, paramsJson) -> replyJson` function, and this
//! is exactly that, one JSON line per direction, built on the real `wallet-core`.
//!
//! Not shipped: a test harness alongside `prove_fixture`.
use std::io::{BufRead, Write};

fn main() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let parsed: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                writeln!(out, "{}", serde_json::json!({"ok": false, "error": format!("bad request line: {e}")})).unwrap();
                out.flush().unwrap();
                continue;
            }
        };
        let method = parsed["method"].as_str().unwrap_or("").to_string();
        let params = parsed["params"].to_string();
        writeln!(out, "{}", wallet_core::call(&method, &params)).unwrap();
        out.flush().unwrap();
    }
}
