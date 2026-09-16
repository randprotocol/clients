# Rand Wallet — Android (Java)

The Android client of the Rand Protocol RAND wallet: a Java app around the shared Rust core
(`../core`), which it loads as `librand_wallet.so` through one JNI method
(`org.randprotocol.wallet.core.NativeCore.call`). Design: `../docs/superpowers/specs/2026-09-13-rand-wallet-clients-design.md`.

```
app/src/main/java/org/randprotocol/wallet/
  core/       NativeCore (JNI), Core (typed JSON wrapper), CoreException
  rpc/        RpcClient: JSON-RPC 2.0 over HttpURLConnection
  store/      NoteStore (JSON cache of notes, sent rows, submissions), OwnedNote, SentRow, Submission
  wallet/     WalletService (scan / send / faucet), ProvingService (foreground service), SendMonitor
  security/   KeyVault (EncryptedSharedPreferences), Unlock (BiometricPrompt window), Prefs
  ui/         Launch, Welcome, CreateWallet, Import, Lock, Home, Receive, Send, Detail, Settings
  util/       Amounts
```

## Requirements

- JDK 17 or newer (`brew install openjdk`; `export JAVA_HOME=/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home`)
- Android SDK: platform 35, build-tools 35, NDK 27 (`sdkmanager "platforms;android-35" "build-tools;35.0.0" "ndk;27.2.12479018"`)
- Rust 1.98.1 with the Android targets and `cargo-ndk` (`../core/scripts/build-android.sh` installs both)
- `local.properties` with `sdk.dir=/path/to/Android/sdk` (gitignored)

## Build

```bash
# 1. The native core → app/src/main/jniLibs/{arm64-v8a,x86_64}/librand_wallet.so
ANDROID_NDK_HOME=$HOME/Library/Android/sdk/ndk/27.2.12479018 ../core/scripts/build-android.sh

# 2. The app
./gradlew assembleDebug            # app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest        # NoteStore + Amounts unit tests (no device, no .so needed)
```

## Run on the emulator

Create an arm64 or x86_64 AVD (API 35), then:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The app talks to a node's JSON-RPC. There is no public endpoint yet (see the root README), so
point it at one you can reach: with a `rand-node` on your laptop (`scripts/local-testnet.sh`
in the fullnode repo, faucet on), set **Settings → RPC URL** to `http://10.0.2.2:8545` (the
emulator's alias for the host) and **Test connection** should report chain id, height and peers.
A debug build allows cleartext HTTP to `10.0.2.2`, `127.0.0.1` and `localhost` only
(`res/xml/network_security_config.xml`); release builds are HTTPS-only.

Flow to try: Create wallet → save the spend key → Faucet (100 RAND lands after the mint
commits) → Send 1.5 RAND to a second wallet's address (a bundle proof takes a few minutes on
the emulator; a notification shows while it runs) → Activity → Disclose this payment → paste
the transaction key on randscan.org.

## Release for Google Play

1. Create a signing key once and keep it out of git:
   ```bash
   keytool -genkeypair -v -keystore release.jks -alias randwallet -keyalg RSA -keysize 4096 -validity 10000
   cp keystore.properties.example keystore.properties   # fill in the passwords; both files are gitignored
   ```
2. Build the bundle:
   ```bash
   ./gradlew bundleRelease           # app/build/outputs/bundle/release/app-release.aab
   ```
   R8 keeps `NativeCore` (proguard-rules.pro); the `.so` files are built with 16 KiB page
   alignment and packaged uncompressed (`useLegacyPackaging false`), which Play requires for
   targetSdk 35.
3. In the Play Console: create the app (`org.randprotocol.wallet`), upload the `.aab` to Internal
   testing, complete the Data safety form (no data collected; the only network peer is the RPC
   URL the user configures), the content rating, and the app category (Finance). Bump
   `versionCode`/`versionName` in `app/build.gradle` for each upload.

## What the app stores

- The spend key, in `EncryptedSharedPreferences` (AES-256-GCM, Keystore-backed master key).
  Never the viewing key: it is derived on demand.
- `files/notes.json`: the note cache (plaintext notes, nullifiers, leaf indices) and the
  submissions list with each payment's transaction key. App-private; rebuilt by a rescan.
- Settings (RPC URL, chain id, auto-lock, theme) in plain preferences.

Backup is disabled (`allowBackup=false`) so the vault never leaves the device through Google's
backup service.
