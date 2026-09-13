# Rand Wallet for Chrome

Code lives in `../extension/shared`; this directory is the manifest, the packager and the store notes.

```bash
../core/scripts/build-wasm.sh   # once, or after a core change
./pack.sh                       # → ../dist/chrome/ and ../dist/rand-wallet-chrome-<version>.zip
```

- **Try it**: chrome://extensions → Developer mode → Load unpacked → `dist/chrome`.
- **Publish**: Chrome Web Store Developer Dashboard → New item → upload the zip. Fill in the
  listing from `STORE.md`. The privacy tab's answers are there too (no data collected, no remote
  code). Bump `version` in `manifest.json` for every upload.
- Requires Chrome 116+ (`storage.session`, MV3 CSP `wasm-unsafe-eval`).
