# addons.mozilla.org listing — Rand Wallet

**Name**: Rand Wallet
**Summary** (250 chars max): A shielded wallet for RAND on the Rand Protocol chain. Private balances and transfers proved by your own paired prover, a testnet faucet, and viewing keys to open your history on randscan.org.
**Categories**: Privacy & Security; Other
**License**: GPL-3.0-only
**Homepage**: https://randprotocol.org/clients  **Support**: https://github.com/randprotocol

**Description**: same text as chrome/STORE.md.

**Add-on id**: wallet@randprotocol.org (in the manifest, required for MV3).

**Review notes**: plain ES modules, no bundler or minifier — the zip is the source. The wasm
file is built with wasm-pack from `core/crates/wallet-wasm` in the public repository; the
Rust source is included in the repository at the tagged version. No remote code; the only
network requests are JSON-RPC POSTs to the node URL in Settings, or, when that is empty, to
the default endpoint (https://rpc.randprotocol.org; https://rpc1.randprotocol.org,
https://rpc2.randprotocol.org and https://rpc3.randprotocol.org are the planned failover set —
whichever answers, one at a time) — and, only when the user pairs one in Settings → Prover, to
that prover's URL (the desktop app on `http://127.0.0.1`, or the user's own https server), which
receives the spend key inside a sealed job. `'wasm-unsafe-eval'` is
required to instantiate the bundled
module.

**Data collection** (privacy questionnaire): none — also declared in the manifest as `data_collection_permissions.required: ["none"]`.

**Linter notes**: `web-ext lint` reports UNSAFE_VAR_ASSIGNMENT warnings in `ui/screens/*.js` (a screen renders itself as a template string into `innerHTML`). Every dynamic value goes through the `h` tagged template in `ui/lib/dom.js`, which escapes what it interpolates; the only unescaped values are the `raw(…)` ones, which are markup this repository wrote. Nothing from the network or from storage is ever inserted unescaped. Not a data collector; no telemetry.

**Screenshots**: as in chrome/STORE.md.
