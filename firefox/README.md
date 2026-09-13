# Rand Wallet for Firefox

Code lives in `../extension/shared`; this directory is the manifest, the packager and the store notes.

```bash
../core/scripts/build-wasm.sh   # once, or after a core change
./pack.sh                       # → ../dist/firefox/ and ../dist/rand-wallet-firefox-<version>.zip
npx web-ext lint --source-dir ../dist/firefox
```

- **Try it**: about:debugging → This Firefox → Load Temporary Add-on… → `dist/firefox/manifest.json`.
- **Publish**: https://addons.mozilla.org/developers/ → Submit a New Add-on → upload the zip
  ("On this site"). Firefox requires the add-on id in the manifest
  (`wallet@randprotocol.org`) and reviews the source; since nothing is minified or bundled,
  no separate source upload is needed. Listing text is in `STORE.md`.
- Requires Firefox 121+ (MV3 with `storage.session` and optional host permissions).
