# addons.mozilla.org listing — Rand Wallet

**Name**: Rand Wallet
**Summary** (250 chars max): A shielded wallet for RAND on the Rand Protocol chain. Private balances and transfers proved in your browser, a testnet faucet, and viewing keys to open your history on randscan.org.
**Categories**: Privacy & Security; Other
**License**: Apache-2.0
**Homepage**: https://randprotocol.org/clients  **Support**: https://github.com/randprotocol

**Description**: same text as chrome/STORE.md.

**Add-on id**: wallet@randprotocol.org (in the manifest, required for MV3).

**Review notes**: plain ES modules, no bundler or minifier — the zip is the source. The wasm
file is built with wasm-pack from `core/crates/wallet-wasm` in the public repository; the
Rust source is included in the repository at the tagged version. No remote code; the only
network requests are JSON-RPC POSTs to the node URL in Settings (default
https://rpc.randprotocol.org). `'wasm-unsafe-eval'` is required to instantiate the bundled
module.

**Data collection** (privacy questionnaire): none — also declared in the manifest as `data_collection_permissions.required: ["none"]`.

**Linter notes**: `web-ext lint` reports two UNSAFE_VAR_ASSIGNMENT warnings in `lib/views.js` (screens are rendered as template strings into `innerHTML`). Every dynamic value passes through `escapeHtml` in `lib/format.js`; no HTML from the network or from storage is ever inserted unescaped. Not a data collector; no telemetry.

**Screenshots**: as in chrome/STORE.md.
