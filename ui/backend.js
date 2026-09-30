// The contract every shell (Tauri desktop, browser extension, local wasm web wallet) implements
// and every screen in ui/ talks to. Screens never touch browser-extension APIs, Tauri or
// IndexedDB directly — only this shape.
/**
 * Shapes the screens read out of the methods below. Amounts are decimal strings of *units* and
 * are only ever handled as BigInt (`formatUnits`), never `Number()`.
 *
 * `assets.list()` → `[{index, id, symbol, decimals, balance, pending, name?, idText?, backings?,
 * unlisted?}]`, index 0 (RAND, the native token) first; every other index is an RPL token, read
 * from the chain's own token registry.
 *  - `name?`     — OPTIONAL. A display name ("Shielded USD"). Screens fall back to `symbol`.
 *  - `idText?`   — OPTIONAL. The token id in its checksummed text form (`rpl1…`, bech32m over the
 *                  32 id bytes). For showing and for copying; `id` is the same 32 bytes as hex.
 *  - `backings?` — OPTIONAL, `[{chain, token, locked, decimals}]`. The coins on other chains that
 *                  hold this token's value: `chain` a bridge chain id, `token` that coin's address
 *                  there (32 bytes hex), `locked` a units string of how much of it that coin is
 *                  holding, `decimals` that coin's OWN precision on its own chain (not the
 *                  token's on Rand). **A withdrawal names one of them** — `bridge.withdraw`'s
 *                  `toChain` and `token` are a backing's two fields — because one token can be
 *                  backed by several coins and burning to a pair that does not back it, or to one
 *                  that is not holding enough, is refused by the chain. Present only where the
 *                  node listed at least one; absent for a native RPL token and for RAND.
 *  - `unlisted?` — OPTIONAL, `true`. This wallet holds notes of this index but the node's registry
 *                  does not list it, so `symbol` is the wallet's own `RPL#<index>` fallback and
 *                  `decimals` a guess. The balance is real; the name is not the chain's word, and
 *                  a screen may say so. Such a row never carries `backings`.
 *
 * Screens treat returned objects as read-only; backends may return cached objects.
 *
 * `sync.cached()` / `sync.scan(onProgress, options?)` → `{notes, activity, scannedHeight, head,
 * lastSyncMs, recovered?, behind?, wrongChain?, otherTab?}`.
 *  - `recovered?` — OPTIONAL, and `true` at most once. The backend found its local note store
 *    unusable (a cursor that was not a block height — `NaN`, `null`, a string) and reset it for a
 *    full rescan, keeping the notes it already had. Nothing was lost that the chain cannot supply
 *    again, but the wallet is re-reading from the start, so the UI says so quietly (home shows an
 *    informational banner) rather than silently looking slow. A backend that cannot detect this
 *    simply never sets it.
 *  - `wrongChain?` — OPTIONAL, `{expected: {chainId, genesis}, got: {chainId, genesis}}`. The node
 *    is not on the chain this wallet's notes came from, so **nothing was read and nothing was
 *    merged** — a note store is a cache of one chain's tree, and merging another chain's into it
 *    invents history. The rest of the reply is the cached data, unchanged. Home shows a blocking
 *    banner offering the two real ways out: change the node in Settings, or `sync.rescan({forChain:
 *    true})`. Every field of it is node-controlled text and is escaped like any other.
 *  - `behind?` — OPTIONAL, `{tip, wallet}`. The node's tip is *below* what this wallet has already
 *    read, on the same chain: a lagging replica, or one restored from a snapshot. Not an error and
 *    not a reason to move any cursor — the reply is the cached data and scanning resumes by itself
 *    once the node catches up. Home says so quietly.
 *  - `staleNode?` — OPTIONAL, `true`. The scan was a *consistent* scan of the node it started
 *    against, but the wallet is pointed at a different one now (the user saved a new RPC URL while
 *    it ran — a scan uses the wallet **session's** signal, so it keeps going across screens). The
 *    data is sound and worth keeping; what it is not is the current node's view, so the UI must
 *    not present that tip as this node's. Home starts a fresh scan instead. Nothing was recorded
 *    about the new node: a verdict belongs to the node that earned it.
 *  - `otherTab?` — OPTIONAL, `true`. Another tab of the same wallet is scanning and this one chose
 *    to wait rather than race it; the wait ran out, so this is the cached data. The scanning tab's
 *    result arrives through `sync.onChanged?` — a backend that sets this should offer that too,
 *    or the banner promises a refresh nothing will deliver.
 *  - `bridgeUnknown?` — OPTIONAL, `true`. The node would not answer for every block the search
 *    for bridge deposits asked about this scan — the bridge's state, a page of headers, or a
 *    block — so the bridge-deposit cursor stopped at the last block it WAS answered about
 *    (advancing it further would skip blocks that were never examined). Nothing is wrong with the
 *    data, and the notes and spends were read regardless; the next scan carries on from there.
 *  - `identityUnknown?` — OPTIONAL, `true`. **Blocking**, like `wrongChain`: the node would not
 *    say which chain it is on (neither a chain id nor a genesis hash), and this wallet has none
 *    recorded yet — so nothing was read and nothing merged. A wallet that adopted an unnamed chain
 *    could never afterwards notice it had been moved to another one, which is the whole of the
 *    wrong-chain protection. The UI says so and offers Settings.
 *  - `behind.walletAhead?` — OPTIONAL, on the `behind` object, and **emphasis only**: another node
 *    has reported the same thing this session, or the gap is large. Which side is wrong is not
 *    knowable from a wallet, so the UI always offers both ways out (try another node, rescan) and
 *    assigns no blame; this flag only decides which button is primary.
 * `options` is OPTIONAL and today carries one OPTIONAL field:
 *  - `signal?` — an `AbortSignal` that aborts when the wallet session the scan was started under
 *    ends (a lock, a wipe, an unlock, a new wallet, or the UI being torn down). A backend that
 *    honours it should stop the work and reject with an `AbortError` (an error whose `name` is
 *    `'AbortError'`); the UI treats that as "no longer wanted", never as a node failure. A backend
 *    that ignores it is still correct — the UI discards the result either way.
 * An **activity item** is `{kind, asset, amount, time, hash?, index?}` where `kind` is one of
 * `'in' | 'out' | 'faucet' | 'pending'`, `asset` is an asset index, `amount` is a units string and
 * `time` is a unix timestamp in **seconds** (`lastSyncMs` and every other `*Ms` field is
 * milliseconds, as named). These further fields are **OPTIONAL** — a backend may supply none of
 * them, and every screen renders each one only when it is present:
 *  - `address?` — the counterparty's shielded address (`rand1…`).
 *  - `block?`   — the block height the transaction landed in.
 *  - `fee?`     — the fee paid, a units string in the *native* asset (index 0).
 *  - `txKey?`   — the transaction key. A secret: it must never reach a URL, storage, the console,
 *                 `ctx.state` or a DOM attribute (see ui/screens/detail.js).
 *  - `status?`  — for `kind: 'pending'` only, where the transaction is in the pipeline
 *                 (`'pending' | 'proving' | 'submitting' | 'confirming'`).
 *  - `memo?`    — the memo sealed with the payment (spec 2026-09-26 §2.3), a non-empty string;
 *                 absent when there is none. The sender's text: screens render it as a text node
 *                 only, never as markup.
 * A **note** is `{index, asset, amount, blockHeight, spent, commitment, time, memo?}` — `memo?`
 * exactly as on an activity item.
 *
 * `settings.get()` → `{rpcUrl, rpcUrls, theme, autoLockMin, explorerUrl, chainId, prover}`.
 * `explorerUrl` may be empty, in which case no explorer link is offered at all; `chainId` is the
 * network's own id and is the only source of any network label (no screen writes a chain number).
 * `prover` is `{mode: 'device'}` until a prover is paired, then `{mode: 'remote', name, url, kemEk,
 * fingerprint, own}` (delegated proving, spec 2026-09-28 §4.1). It is **read-only** through
 * `settings.set` — only the optional `prover` group writes it — and it never carries the pairing
 * token. It is DISPLAY ONLY: the token, key and URL a job is sealed to and sent to live together in
 * the vault (and, unlocked, the session), so a tampered `settings.prover` cannot redirect a job.
 *
 * The node is two fields, not one (task 5.0). `rpcUrls` is the **default endpoint set** the
 * wallet moves between on its own when one of them is unreachable; `rpcUrl` is the user's single
 * **override**, empty unless they saved one, and it replaces the whole set while it is there.
 * `settings.set({rpcUrl: ''})` is therefore how a shell goes back to the defaults. Only `rpcUrl`
 * is editable — a screen shows `rpcUrls`, it never writes them.
 *
 * ---- sending (task 1.5) ----
 *
 * A **send request** is `{asset, to, amount, memo?}` — `asset` an asset index, `to` a `rand1…`
 * address (never a link or a contact name: the screen resolves those first), `amount` a units
 * string **in units of `asset`**, `memo` the text sealed with the payment (`''` or absent for
 * none; at most 510 UTF-8 bytes, and only on a chain whose `send.limits()` reports an envelope
 * size — the core refuses a memo on any other chain before proving). Every index can be transferred: chain 14's
 * bundle carries a private asset in slots 0–1 and RAND in slots 2–3, so a token transfer is one
 * transaction and one proof, exactly like a RAND one. Its fee is still RAND, out of the same
 * bundle, so a wallet holding a token and no RAND cannot send that token; the backend refuses
 * with the core's own sentence before any work is done.
 *
 * `send.canProve()` → `{ok, reason?, via?}`. The device is asked first; where it cannot prove (the
 * wasm shells: the proof needs ~5.7 GB and wasm32 stops at 4 GiB; a desktop without the memory) a
 * prover the user paired **as their own** that answers `prover.probe()` makes it `{ok: true, via:
 * 'prover'}`. `ok: false` means neither can; `reason` is shown to the user verbatim, so it is
 * written for them, not for a log (the wasm shells' names both ways out: pair a prover, or use the
 * desktop app). It may ask the paired prover, never the node. **A shell whose `canProve()` is
 * false never simulates a send**: `send.send` rejects there, before anything is selected, whatever
 * the asset.
 *
 * `send.estimate(req)` → `{fee, inputs, feeInputs, change, feeChange, proofs}`. `fee` and
 * `feeChange` are units strings in the *native* asset; `change` is in units of `asset`. `inputs`
 * is how many notes of `asset` would be spent and `feeInputs` how many RAND notes would pay the
 * fee — always 0 for a RAND transfer, whose fee comes out of `inputs` itself. `proofs` is the
 * number of proofs the transfer needs, from the chain rather than from a constant; on chain 14 it
 * is 1 for a transfer of anything and 1 for a withdrawal. A request that cannot be built — this
 * chain spends exactly two notes per group, so an amount that would need three — **rejects**, and
 * its message is written for the user (the UI shows it verbatim, escaped): it is what tells them
 * to consolidate first, or that they hold no RAND for the fee.
 *
 * `send.send(req, onPhase, options?)` → `{hash, txKey}`.
 *  - `onPhase(phase, detail?)` is called as the transfer moves through
 *    `'selecting' | 'witness' | 'proving' | 'submitting' | 'confirming'`. **The phase is how the UI
 *    decides what a failure means** (see the rejection fields below), so a backend must report
 *    `'submitting'` before it hands the transaction to the node, not after. `detail` is OPTIONAL
 *    and today only accompanies `'proving'` on a paired prover: `{position, prover}` while the job
 *    waits in its queue (1-based), `{prover}` while it is being proved — `prover` the pairing's
 *    name. A screen that reads one argument sees exactly what it always did.
 *  - While a remote proof is pending (see `send.pending?`), `send.send` rejects `definite` with
 *    "A proof is still pending — resume or cancel it." rather than start a second one.
 *  - `options` is OPTIONAL and today carries one OPTIONAL field:
 *    - `signal?` — an `AbortSignal`. It aborts when the wallet session ends (a lock, a wipe, an
 *      unlock, a new wallet, the UI being torn down) and when the user cancels, which the UI only
 *      offers before `'submitting'`. A backend that honours it should stop and reject with an
 *      `AbortError` (`err.name === 'AbortError'`); one that ignores it is still correct, and the
 *      UI simply keeps waiting. A backend must never abandon a transfer it has already submitted.
 *  - `txKey` is the per-transaction key. A secret, exactly like an activity item's: it must never
 *    reach a URL, storage, the console, `ctx.state` or a DOM attribute.
 *  - **On rejection**, two OPTIONAL fields on the error change what the user is told, because a
 *    failure after the transaction left this device may mean it *landed*:
 *    - `definite?` — `true` when the backend knows the transfer did not happen: the node answered
 *      and refused it (a JSON-RPC error reply to the submit), or nothing was ever broadcast. The
 *      UI then says "not sent" and offers a retry. Without it, a failure at `'submitting'` or
 *      `'confirming'` is treated as an **unknown outcome**: the UI refuses to offer a resend and
 *      sends the user to Activity first, because sending twice would pay twice.
 *    - `hash?` — the transaction hash, when the backend got far enough to have one before failing.
 *      Node-controlled, so the UI validates it before it reaches a URL.
 *
 * `send.maxSendable?({asset, to?})` → `{amount, fee, reason?}` — OPTIONAL. The largest amount that
 * can actually be sent, and the fee that would be paid, both units strings. A backend that knows
 * how it selects notes can answer this exactly; the UI's "Max" button uses it when it is there.
 * Where it is missing the UI falls back to estimating a one-unit transfer to learn the fee and
 * subtracting that from the balance, which is why `send.estimate` must answer for a one-unit
 * request even when the balance could not cover a real one. `amount` may be `'0'`.
 *  - For a TOKEN the fee is RAND out of the other half of the bundle, so it is **not** subtracted:
 *    the answer is what those notes hold.
 *  - `reason?` — OPTIONAL, and set only when `amount` is `'0'` **because the RAND fee cannot be
 *    paid**. A zero with no reason simply means the wallet holds none of that asset. A screen
 *    showing "you can send 0" has this sentence to show with it.
 *
 * ---- what a failed unlock can mean ----
 *
 * `wallet.unlock(password)` rejects three different ways, and the lock screen tells them apart by
 * `err.code` (or `err.name`), never by matching the message:
 *  - no code — **wrong password**. Always exactly `'wrong password'`, one shape whatever was
 *    wrong, and the only one that counts as an attempt against the backend's backoff.
 *  - `code: 'VAULT_DAMAGED'` (`VaultDamagedError`) — the stored record is not a usable vault at
 *    all. No password can ever open it, so it is **not** counted as an attempt (otherwise the
 *    backoff grows for someone who can do nothing about it) and the UI offers wipe-and-restore
 *    instead of another password box.
 *  - `code: 'VAULT_VERSION'` (`VaultVersionError`) — a vault written by a newer build of this
 *    wallet. Also not counted, also recoverable by restoring from the recovery key.
 * Both carry `recoverable: true`. `wallet.verifyPassword` answers `false` for a wrong password but
 * **rejects** with these two, for the same reason.
 *
 * `wallet.verifyPassword(password)` → boolean. Re-authentication *without* unlocking: the screens
 * put the viewing key and the spend-key export behind it. `wallet.unlock()` cannot be used for
 * this — the shell treats every `unlock` as a new wallet session and tears the current one down
 * (see ui/app.js) — so a shell implements this as "does this password decrypt the vault?" and
 * changes no state at all. It returns `false` for a wrong password rather than throwing.
 * **It must cost exactly what `unlock` costs**: the same KDF, with the same parameters, over the
 * real vault. A cheaper check — a stored hash, a fast comparison, an early exit — turns this into
 * an oracle that tests passwords far faster than unlocking ever could, which is the whole of the
 * wallet's at-rest security. Backends apply the same attempt throttling and backoff they apply to
 * `unlock`; the UI deliberately implements no lockout of its own.
 *
 * `rpc.call(method, params?)` is the raw JSON-RPC escape hatch (the explore screen's lookups).
 * The settings screen uses exactly two methods, and treats every field of either answer as
 * untrusted text:
 *  - `rand_status`   → `{height, …}` — `height` the node's current block height.
 *  - `rand_chainId`  → the chain's own id (a number or a string).
 *
 * `rpc.probe(url)` → `{url, chainId, height}` — a reachability check against ONE URL, for the
 * settings screen's Test and Save. It answers what the node CLAIMS (its chain id and height) or
 * rejects with the same error taxonomy as a scan; it is not the chain gate and changes nothing
 * the gate decides, so the caller compares the claim against the configured chain id itself.
 *
 * ---- send and faucet are gated on a verified chain ----
 *
 * A backend must not act on the notes until it has established, **against the node it is pointed
 * at right now**, that the chain matches the one those notes came from. Three states, per RPC URL,
 * for the session: *unknown* (nothing checked yet — right after a URL change, or a fresh session
 * before its first scan), *ok*, *wrong*. While unknown, `send.estimate`, `send.maxSendable`,
 * `send.send` and `faucet.request` run the cheap identity check themselves (two RPC calls, never a
 * scan) and proceed only on *ok*. On *wrong* they reject with the definite refusal above; on a
 * check that could not complete they reject with `retryable: true` and 'Could not verify this
 * node's chain — check your connection and try again.'
 * A shell that structurally cannot prove a transfer answers that first (`send.canProve`), because
 * that answer can never be wrong and does not need the network. The desktop backend, which can
 * send, inherits the gate by reusing the same engine.
 *
 * A proof commits to the identity the gate verified, not to whatever `settings.chainId` says
 * (they can diverge silently — the configured id is only compared when an identity is first
 * adopted). When the gate's verdict for this URL carries no identity — reachable only if a
 * caller bypasses `requireVerifiedChain()`'s own cache, which always fills it in on an `ok`
 * verdict — the engine falls back to the note store's own `chain_id`, safe only because that id
 * was itself just verified by the scan that wrote it.
 *
 * `sync.onChanged?(cb)` → an unsubscribe function. OPTIONAL, and **synchronous** — like
 * `wallet.onLocked`, it registers rather than does, so the shell forwards it unwrapped. Fires when
 * *another tab* of the same wallet finished a scan or reset the store, with `{reason: 'scan' |
 * 'reset'}`. A screen uses it to refresh from `sync.cached()` — never to start a scan of its own.
 * It is what makes the `otherTab` banner's "this will refresh when that finishes" true.
 *
 * ---- acting on a wallet whose node is on another chain ----
 *
 * While the last scan reported `wrongChain`, `send.estimate`, `send.maxSendable`, `send.send` and
 * `faucet.request` **reject** with `definite: true` and a message written for the user ('This node
 * is on a different chain — switch node or rescan.'). Mixing one chain's notes with another
 * chain's fee, anchor or faucet is not a transfer anyone can make sense of. The refusal is cleared
 * by a scan that does not report `wrongChain`, by `sync.rescan`, and by changing the RPC URL (then
 * re-evaluated on the next scan).
 *
 * `sync.rescan?(options?)` → the same shape as `sync.scan`. OPTIONAL. Forgets how far the wallet
 * has read and reads it again — **without touching the keys**: the vault, the address and the
 * settings all survive, so this is a cache reset, not a wipe. `options.forChain === true` also
 * drops the notes and history, which is what a `wrongChain` answer needs (they describe a chain
 * this wallet is no longer pointed at). `options.signal` and `options.onProgress` behave as
 * `sync.scan`'s. Settings offers it behind a confirmation; the `wrongChain` banner calls it with
 * `forChain: true`. Where it is missing, neither control is rendered.
 *
 * ---- what a failed unlock costs, across tabs ----
 *
 * The backoff counter is *shared*: it is one number in the wallet's own storage, so a second tab
 * does not get a fresh budget, and each tab pays the delay the shared count has earned. Where the
 * shell's storage offers a conditional write the increment uses it, so two tabs failing at the
 * same instant still count as two. What it is not is a global rate limit across processes: N tabs
 * can each have one attempt in flight, so the *rate* scales with open tabs even though the delay
 * does not reset. The at-rest security is the KDF; this is there to make bulk guessing tedious.
 *
 * ---- optional, per shell ----
 * These are NOT in BACKEND_SHAPE and are not required; screens feature-detect them.
 *  - `platform.version?` — a version string for the About section. Omitted → no version is shown.
 *  - `platform.ensureHostPermission?(url)` → boolean. Browser-extension shells must ask for
 *    permission to reach a new host, and Firefox only grants it while it is still handling the
 *    user's own click. The settings screen calls it inside the submit handler, before saving a new
 *    RPC URL, and abandons the save if it resolves false.
 *  - `platform.openFlowInTab?(flow)` — a popup shell escaping its 360×600 window for a long flow.
 *  - `platform.openSidebar?()` — a browser extension moving the wallet from its popup into the
 *    browser's side panel (Chrome `sidePanel`, Firefox `sidebarAction`). Must be called straight
 *    from the user's click — both browsers open a panel only inside a gesture — and closes the
 *    popup on success. Home offers it only in `mode: 'popup'` and only where it exists.
 *  - `platform.paste?()` → string. Reads the clipboard, for the send screen's Paste affordance
 *    (a shielded address is pasted, never typed). Optional because reading the clipboard needs a
 *    permission some shells will not have: where it is missing, no Paste button is offered at all
 *    rather than one that does nothing. May resolve to `''`.
 *  - `wallet.noteActivity?()` — **the shell calls this on user input** (a pointer, a key, a scroll
 *    or a touch on the app container, throttled to at most once every 5 s). Backends use it, and
 *    only it, to restart their idle timer; **nothing else restarts it**. Deliberately not "any
 *    backend call": a screen that re-scans on a timer, or any background refresh, would otherwise
 *    keep an abandoned, unlocked wallet unlocked indefinitely. It must be cheap, synchronous and
 *    fire-and-forget — the shell ignores whatever it returns and never waits on it.
 *    A backend may still postpone a lock it has decided on while a *user-initiated* operation is
 *    in flight (a transfer being proved), so a proof is never cut in half; a scan does not count.
 *  - `bridge?` — a whole OPTIONAL GROUP, for withdrawing an RPL token out of the shielded pool as
 *    a `BridgeBurn`, releasing one of the coins that back it on that coin's own chain. Present
 *    only on a shell that can carry one out; most cannot, which is why it is here and not in
 *    BACKEND_SHAPE. **A screen must feature-detect the group before it offers anything** —
 *    `ctx.backend.bridge?.canWithdraw` — and then honour `canWithdraw()`'s answer, exactly as the
 *    send flow honours `send.canProve()`.
 *     · `bridge.state()` → `{enabled, chains, mintPaused}`. Whether this chain has a bridge at
 *       all, which destination chain ids it knows, and whether minting is paused. `chains` is
 *       **derived**: the node's `rand_getBridgeState` has no such field — it carries an `emitters`
 *       map keyed by chain id, and that map's keys are the answer (see `checkBridgeState`,
 *       ui/engine/validate.js). `mintPaused` is the bridge refusing *deposits*; burns are
 *       unaffected, which is why it is reported rather than folded into `enabled`.
 *     · `bridge.canWithdraw()` → `{ok, reason?, via?}`, in the same shape and with the same rules as
 *       `send.canProve()`. It asks two questions in a fixed order: can this device prove at all (a
 *       burn is ONE bundle proof, the same one a transfer is — ~5.7 GB, about two minutes;
 *       the answer is `send.canProve()`'s own sentence, verbatim), and is the bridge enabled. Both
 *       must pass. On a wasm shell with no paired prover the first is false, so this is too, and no
 *       node is asked; with one, the burn is proved by the prover exactly as a transfer is.
 *     · `bridge.estimate({asset, amount, relayerFee, toChain, token, to})` → `{fee, relayerFee,
 *       receive, change, feeChange, proofs}`. `toChain` and `token` are one of the asset's
 *       `backings` — the coin this withdrawal releases. `fee` is RAND; `relayerFee` is in units of
 *       the asset and is taken **on the destination chain**, out of `amount`, so `receive` is
 *       `amount - relayerFee`. `proofs` comes from the plan, not from a constant, and is 1 on
 *       chain 14. Rejects — before anything is proved — for asset 0, a zero amount, a relayer fee
 *       larger than the amount, an index the chain's registry does not list, a coin that does not
 *       back this asset, a coin that is not holding enough of it, an amount or relayer fee that is
 *       not a whole release unit of that coin, and any note selection that cannot be built.
 *     · `bridge.withdraw(req, onPhase, options?)` → `{hash}`. `req` is `estimate`'s object plus an
 *       optional `fee` (pass back whatever `estimate` returned, so the plan and the proof agree).
 *       `onPhase` receives `'selecting' | 'witness' | 'proving' | 'submitting' | 'confirming'` —
 *       the same five a transfer reports, because since chain 14 a burn is the same single bundle
 *       and the same single proof. (`'proving-asset'` named the first of chain 13's two and is no
 *       longer part of this contract; a backend must not report it.) Rejections carry `definite`
 *       exactly as `send.send`'s do, and **it refuses exactly what `estimate` refuses, before a
 *       proof starts** — the two run one shared list, because a gate on one and not the other is
 *       a proof spent on a transaction the chain was always going to refuse.
 *  - `prover?` — a whole OPTIONAL GROUP, delegated proving (spec 2026-09-28, Phase 1): a prover
 *    the user runs (the desktop app's, or `rand-prover` on their own machine) proves for a device
 *    that cannot. Phase 1 sends a spend-key job only to a pairing whose link says `own`.
 *     · `prover.preview(link)` → `{url, fingerprint, own, warning?}`: the link read by the core and
 *       held to the URL rule, nothing saved, nobody asked, no password. A screen calls it first, to
 *       learn the host to ask permission for (inside the same click) and to show the fingerprint.
 *       `warning` — a sentence for the user — is there exactly when `own` is false: Phase 1 never
 *       sends such a prover a job. Never carries the token. Rejects with the core's sentence.
 *     · `prover.pair(link, password, {name}?)` → the new `settings.prover`. The password is checked
 *       first (the token, key and URL are sealed under it together, as a second vault record); the `randprover:` link is
 *       parsed by the core; its URL must be https, or http to this machine only; the prover must
 *       answer `prover_info` with the key the link names, or nothing is stored. Re-pairing
 *       replaces the pairing in the vault and in the unlocked session. Rejects with a sentence.
 *       Before calling it a screen must show the spec §4.4 warning (this prover receives the spend
 *       key each time it proves; pair only a machine you run yourself).
 *     · `prover.probe()` → `{ok: true, queue: {depth, max, proving}, witnessKinds, fee, hcBundles}`
 *       or `{ok: false, reason}`; never rejects.
 *     · `prover.forget()` — removes `settings.prover`, the vault's token and the session's copy.
 *  - `send.pending?()` → `{job, name, kind, startedAt}` or `null`: a remote proof still in flight —
 *    typically a popup closed mid-proof. It lives in session storage and is forgotten on lock.
 *  - `send.resume?(onPhase, options?)` → `{hash, txKey}` (a transfer) or `{hash}` (a withdrawal):
 *    carries the pending proof on — the SAME job — and submits it once, with `send.send`'s phases
 *    (from `'proving'`) and rejection fields. A screen calls it on mount when `pending()` reports
 *    one.
 *  - `send.cancelPending?()` → boolean: cancels the pending job on the prover (best effort) and
 *    forgets it.
 *  - `send.limits?()` → `{envelopeBytes}`: the chain's `envelope_bytes` from `rand_getLimits`
 *    (spec 2026-09-26 §2.4), or `null` where the chain carries no memo or the node predates the
 *    method — and `null`, whatever the node claimed, on a chain whose genesis sets no envelope
 *    size (fullnode issue #64: chains 14–17, `ui/lib/memo.js`'s `LEGACY_ENVELOPE_CHAIN_IDS`),
 *    where a believed claim would tag every transaction the wallet sent. The send screen offers
 *    a memo field only when this is a number.
 *  - `address?` — a whole OPTIONAL GROUP, the address-sharing formats, every one the core's own
 *    code (spec 2026-09-26 §2); pure — no node, no key:
 *     · `address.fingerprint(address)` → `'XXXX-XXXX-XXXX-XXXX'`, 80 bits of the address in
 *       Crockford base32. Display only; always recomputed from the address in hand.
 *     · `address.parseLink(uri)` → `{address, amount, asset, memo, fingerprint}` for a `randpay:`
 *       link (absent parameters `null`; `amount` the display decimal as written), or a rejection
 *       with the core's sentence.
 *     · `address.formatLink({address, amount?, asset?, memo?})` → the link; empty fields are left
 *       out.
 *  - `contacts?` — a whole OPTIONAL GROUP, the address book (ui/lib/contacts.js; stored under
 *    `contacts` beside the other keys, cleared by a wipe), with the CLI's rules: a name is 1–64
 *    characters, never starts with `rand1`/`randpay:` in any case, is unique, and an address lives
 *    under one name. `list()` → `[{name, address}]` by name; `add(name, address)` (the address is
 *    checked by the core first); `remove(name)`; `nameOf(address)` / `addressOf(name)` → string or
 *    `null`. Rejections carry the CLI's sentences.
 *  - `platform.scanQr?()` → the text of a scanned QR code, for a native shell with a camera. Where
 *    it is missing the screens use the browser's `BarcodeDetector` (ui/lib/scan-qr.js) if there
 *    is one, and offer no scan button at all otherwise.
 *  - `platform.share?({title, text})` → the system share sheet, for the receive screen's payment
 *    link. Where it is missing no Share button is offered.
 *  - `platform.proverHost?` — the desktop app only (spec 2026-09-28 §5): the fullnode's prover
 *    service run inside the app on 127.0.0.1, one proof at a time, spend-key jobs accepted.
 *    `start()` / `stop()` / `status()` → `{running, addr, fingerprint, proving, error?, note?}`
 *    (`start` rejects with a sentence on too little memory or a busy port); `link()` → the
 *    `randprover:` link of its one `own` pairing, the same until `rotate()` → a new link (the old
 *    token stops working). The link carries the pairing token: show it, never store or log it.
 *    Where it is missing Settings offers no "Prove for my other devices" toggle.
 *  - `dispose?()` — OPTIONAL, on the **backend itself**, not a group. Releases whatever it holds
 *    outside its own object (a BroadcastChannel, a port, a watcher). The shell calls it from
 *    `destroy()`, last, after the wallet session has ended; it must be idempotent and must not
 *    throw. A disposed backend is not required to keep working.
 *  - `wallet.onLocked?(cb)` → an unsubscribe function. For a backend that can lock the wallet **on
 *    its own** — every real shell does, on an idle timer built from `settings.autoLockMin`. The
 *    shell subscribes at mount and, when `cb` fires, ends the wallet session and routes to
 *    `#lock`, exactly as it does for a lock the user asked for. Without it a backend-initiated
 *    lock would leave the previous wallet's screen on display, with its data on it, until
 *    something happened to re-render.
 *    `cb` is called with no arguments the UI reads (a backend may pass a `{reason}` object for a
 *    log). It is **not** called for a lock the shell itself asked for: the shell already knows.
 *    Unsubscribed on `destroy()`.
 */
export const BACKEND_SHAPE = {
  wallet: ['exists', 'create', 'import', 'unlock', 'verifyPassword', 'lock', 'isUnlocked', 'info', 'parseAddress', 'viewingKey', 'exportSpendKey', 'wipe'],
  sync: ['scan', 'cached'],
  assets: ['list'],
  send: ['canProve', 'estimate', 'send'],
  faucet: ['request'],
  rpc: ['call', 'probe'],
  settings: ['get', 'set'],
  platform: ['openExternal', 'copy'], // plus string field platform.name
};

/** Throws if `b` does not implement every group/method in BACKEND_SHAPE, or lacks platform.name. */
export function assertBackend(b) {
  if (!b || typeof b !== 'object') throw new Error('backend missing');
  for (const [group, methods] of Object.entries(BACKEND_SHAPE)) {
    const g = b[group];
    if (!g || typeof g !== 'object') throw new Error(`backend.${group} missing`);
    for (const fn of methods) {
      if (typeof g[fn] !== 'function') throw new Error(`backend.${group}.${fn} missing`);
    }
  }
  if (typeof b.platform.name !== 'string' || b.platform.name === '') {
    throw new Error('backend.platform.name missing');
  }
  return b;
}
