# Rand Wallet — local web wallet

Rand Wallet running in a browser tab, on the real WebAssembly wallet core, served from your own
machine. Same screens as the browser extension and the desktop app (`ui/`), same chain crypto as
the `rand` CLI (`core/crates/wallet-core`, compiled to wasm) — just a different shell around them.

It is meant to be run **locally**, from this repository. See *A warning about origins* below.

```sh
web/wallet/serve.sh          # build, then serve at http://127.0.0.1:8787/
RAND_WALLET_PORT=9000 web/wallet/serve.sh
```

The first run builds the wasm core if it is not already there (`core/scripts/build-wasm.sh`,
a few minutes). After that a build is a file copy. Ctrl-C stops the server.

## What it does

- **Creates or imports a wallet.** The spend key is generated *inside* the core and encrypted
  into a vault before it is ever written anywhere.
- **Shows your address, with a QR code.** A shielded address is ~1 665 characters; the whole of it
  is on screen, because someone about to share theirs should be able to read back what they are
  sharing.
- **Scans the chain.** It pages the node's commitment tree, hands each page to the core to
  trial-decrypt with your viewing key, and keeps a local note store — so balances and history are
  computed here, not asked for. No account exists on this chain to ask about.
- **Estimates a transfer** — the node's own minimum bundle fee, the core's own coin selection —
  and tells you what a send would cost before it tells you it cannot make one.
- **The faucet, settings, the viewing key, the spend-key export**, and a wipe.

## What it cannot do: send

A transfer on this chain is a STARK proof of a 2-in-2-out bundle. The prover peaks at about
**5.6 GB** of memory (`wallet-core`'s `PROVER_PEAK_MEMORY_BYTES`, re-measured on constraint set 6)
and a browser gives WebAssembly a **4 GiB** address space. There is no way to fit one in the
other, so this shell does not try: `send.canProve()` answers `false`, and the Send flow walks you
through recipient, amount and review and then explains the wall instead of offering a Prove
button. Nothing is half-started and no proof is attempted — in wasm it would grind for minutes and
then abort with an out-of-memory trap.

To actually send: export your spend key from Settings and import it into the **Rand Wallet desktop
app**, which proves natively. The key is the wallet; the notes are the same notes.

The same limit applies to the browser extension. It is not a property of this shell.

## Security model

**Your keys never leave this machine.** There is no server-side anything: `serve.mjs` hands over
static files and nothing else. The only network traffic the wallet itself makes is JSON-RPC to the
Rand node you name in Settings.

**Where the spend key can exist**, and nowhere else:

1. inside the wasm core, for the duration of a call it is a parameter of;
2. in `idb.js`'s **session** — a `Map` in a module, so it dies with the page;
3. in a local variable of the one backend method using it, for that call.

It is never in IndexedDB, never in `localStorage` or `sessionStorage`, never in a URL, never in an
error message and never in anything handed to `fetch`. A reload therefore loses the session and
the lock screen comes back — that is the design, not a limitation.

**The vault.** The spend key at rest is AES-256-GCM under a key derived from your password with
PBKDF2-SHA256 at **600 000 iterations** (OWASP 2023), fresh salt and IV per encryption. That, and
your password, is the whole of the at-rest security: a stolen laptop is exactly as safe as the
password is good.

**Unlocking is throttled.** A wrong password answers `wrong password` and nothing else — one
message whatever was wrong with it — and the failure count is *persisted*, so a reload does not
reset it. The next attempt waits `0, 0, 0.5 s, 1 s, 2 s, 4 s …` up to 30 s, **before** the attempt,
because a delay that only followed a failure would cost an attacker nothing. A success clears it.
Re-authenticating to see a key (Settings) costs the same full KDF as unlocking: it is not a
cheaper oracle.

**Auto-lock.** Settings › *Lock automatically after* arms a timer in the backend, rearmed by every
use of the wallet. When it fires, the session is dropped and the lock screen appears.

**What is stored persistently**: the encrypted vault, your address and public key, your settings,
the note store (a cache of public chain data, rebuildable from leaf 0) and the bridge's asset
registry. Nothing there is a secret.

**If the password stops working.** Three things can go wrong, and the lock screen tells them
apart. A wrong password says so and costs you the next backoff step. A vault that is *structurally
damaged*, or one written by a newer build of this wallet, can never be opened by any password — so
it says that instead, does **not** count as a failed attempt, and points you at wipe-and-restore.
Your funds are on chain; your recovery key is what brings them back.

## Changing node, and rescanning

A note store is a cache of **one chain's** tree, so the wallet records which chain it read (the
chain id and the node's genesis hash) and checks it on every sync. Point Settings at a node on a
different chain and nothing is merged: home says so and offers the two real ways out — go back to
a node on your chain, or rescan for the new one. A node that is simply *behind* your wallet (a
lagging replica, one restored from a snapshot, or a chain that is halted) is not an error either:
the wallet says so quietly and carries on by itself once that node catches up.

**Settings → Network → Rescan wallet** forgets how far the wallet has read and reads the node
again from the start. It is not a wipe: your keys, your password and your settings are untouched,
and nothing on chain changes. It is the cure for a wallet that has got ahead of the chain it is
pointed at, and it is what the wrong-chain banner's *Rescan* uses (that one also drops the other
chain's history, which no longer describes anything).

## More than one tab

The wallet is a normal web page, so you can open two of them. They share one IndexedDB, and the
wallet is built for it:

- **One tab scans at a time.** Whichever takes the `rand-wallet-scan` Web Lock does the paging; the
  others wait for its "done" on a `BroadcastChannel` and then simply read what it wrote, rather
  than racing it to the node. Both APIs are feature-detected — without them every tab scans, which
  is wasteful but still correct, because of the next point.
- **The note store is written conditionally.** Each save carries the revision it was loaded at and
  lands only if nothing else has written since; a tab that loses the race merges in what the other
  one wrote and retries. Without this the last writer would silently erase the other's whole scan.

**The server.** `serve.mjs` is deliberately small and deliberately rude:

- binds **127.0.0.1 only** — never `0.0.0.0`, so it is not on your Wi-Fi;
- refuses any request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`, which is what
  stops a hostile site from pointing its own domain at 127.0.0.1 and loading this origin under its
  name (DNS rebinding);
- refuses any path that escapes the built directory, symlinks included (the check is on the real
  path);
- `GET`/`HEAD` only, `Cache-Control: no-store`, correct `application/wasm`;
- and sets:

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';
                         img-src 'self' data:; font-src 'self'; connect-src *; worker-src 'self';
                         base-uri 'none'; form-action 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=(), usb=()
```

`script-src 'self' 'wasm-unsafe-eval'` is exactly enough to run the core and nothing else: no
inline script, no remote script. `connect-src *` is the one thing left open, because you get to
choose which Rand node you trust.

## A warning about origins

**A wallet is only as trustworthy as the origin serving it.** Whoever controls the origin controls
the code in your browser, and this wallet's code has your spend key in it. An origin that is
compromised — or that simply decides to — can serve a build that sends the key away, and no
amount of client-side care prevents that. This is the ordinary, unavoidable problem with every web
wallet; it is why this one is built to be run from a checkout of this repository, on your own
machine, reading files you can diff.

If you find Rand Wallet at some remote URL, treat it with exactly as much trust as you extend to
whoever operates it. For anything that matters, use the desktop app or the browser extension,
which you install once and can check once.

## Layout

```
web/wallet/
  index.html   the page — no inline script, no inline style
  main.js      the only web-specific code: worker wrapper, platform object, mount
  idb.js       storage: IndexedDB for what survives a reload, a Map for what must not
  worker.js    the wasm core, off the UI thread
  serve.mjs    the local static server (also `node web/wallet/serve.mjs`)
  build.sh     assembles dist/ — no bundler
  serve.sh     build.sh && serve.mjs
  test/        idb, server, and an integration test on the real wasm core
```

Everything else is shared: `ui/` (screens, shell, design tokens), `ui/engine/` (the vault, the
JSON-RPC client, the scan/send orchestration, and `backend-wasm.js` — the Backend the extension
uses too), `core/crates/wallet-core` (all chain crypto).

```sh
node --test ui/test web/wallet/test
```

## Licence

GPL-3.0-only, like the rest of this repository. See `LICENSE`.
