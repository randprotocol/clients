# Delegated proving: light clients and a prover — design

Status: draft 2026-09-28, written from conversation; **not reviewed, not built**.
Scope: clients (this repo). Companion: `../fullnode/docs/superpowers/specs/2026-09-28-delegated-proving-design.md`,
which defines the prover service, the wire protocol and the consensus change. This spec does not
restate them.
Ships in: Phase 1 on any chain. Phase 2 needs a chain cut with split authorisation.

## 1. Problem

A bundle proof peaks at about 5.7 GB (`PROVER_PEAK_MEMORY_BYTES`). Today:

| shell | can send or withdraw |
|---|---|
| desktop (Tauri) | yes, with 8 GB or more |
| extension, web wallet | never — wasm32 stops at 4 GiB (`ui/engine/backend-wasm.js`) |
| iOS, Android | only on the few devices with enough memory |

The owner's direction: wallets become **light clients**, proving moves to a **prover**, and a
user who wants full privacy runs their own.

## 2. Decisions

1. **Two phases, because today's proof takes the spend key as a private input.**

   | | the prover receives | it can read | it can spend | the wallet offers |
   |---|---|---|---|---|
   | Phase 1 | the spend key | the whole history | **yes** | "My own prover" only |
   | Phase 2 | the viewing key | the whole history | no | any prover the user pairs |

2. **The wallet builds the transaction; the prover only fills in the proof.** Notes, outputs,
   envelopes and the binding are made on the device, as today.
3. **The wallet submits.** The proof comes back to the device, which checks it and sends the
   transaction to its own node. (Phase 2 with a paid prover: the prover broadcasts; §6.)
4. **No default prover and no directory.** A prover exists in a wallet only because its user
   paired it.
5. **The first deliverable is the extension proving through the desktop app on the same
   machine**: no network, no TLS, and `http://127.0.0.1` is already an optional host permission.

## 3. Core (`wallet-core`)

`build_transfer_unproven` already produces everything but the proof. Three methods expose the
split; none of them proves, so all three run in wasm:

| method | params | result |
|---|---|---|
| `prepare_transfer` | a `ProveRequest`, plus `prover: {kem_ek, token, witness_kind}` | `{sealed_hex, pending}` |
| `prepare_burn` | a `BurnRequest`, plus `prover` | `{sealed_hex, pending}` |
| `finish_proof` | `{pending, reply_hex}` | a `ProveResult` / `BurnResult`, exactly as `prove_transfer` returns |

- `sealed_hex` is the fullnode spec's sealed `ProveJob`. The spend key exists in it only under the
  prover's ML-KEM key.
- `pending` is opaque to JavaScript: the unproven transaction, the expected digest, the reply key
  and the result's metadata, encrypted under a key the core keeps for the session.
- `finish_proof` opens the reply, requires `digest == expected`, requires the proof to fit the
  chain's `max_proof_bytes`, verifies the proof where the target can (to be measured in wasm),
  inserts it and encodes the transaction. Any failure is a definite error and nothing is submitted.
- `version` gains `prover_wire: 1`.

`prove_transfer` and `prove_burn` stay for a device that proves for itself.

## 4. Engine and UI (`ui/`)

### 4.1 Backend contract

`settings.get()` gains `prover`:

```
prover: { mode: 'device' | 'remote', name, url, kemEk, fingerprint, own: boolean }
```

The pairing token is a secret: it is stored with the vault, not in `settings`, and is never
returned by `settings.get()`.

An optional group, feature-detected like `bridge`:

| method | does |
|---|---|
| `prover.pair(link)` | parses a `randprover:` link, calls `prover_info`, returns what Save will store |
| `prover.probe()` | `{ok, queue, witnessKinds, fee?}` — reachability, for Settings and for `canProve` |
| `prover.forget()` | removes the pairing and the token |

### 4.2 `send.canProve()`

Asked in this order, and the first yes wins:

1. the device can prove (`backend-native`'s memory check) — unchanged;
2. a prover is paired and `prover.probe()` answers — new;
3. otherwise `{ok: false, reason}`. In a wasm shell the sentence becomes: *"This browser cannot
   make a transfer proof (it needs about 5.7 GB). Pair your own prover in Settings, or send from
   the desktop app."*

`bridge.canWithdraw()` follows it, as it does today.

### 4.3 The send flow

The phases do not change (`selecting → witness → proving → submitting → confirming`). In
`proving`, a remote job shows its queue position, then "Proving on *name*…". Cancel calls
`prover_cancel`. A popup that closes loses nothing: `pending` and the job id are kept in
`storage.session`, and the side panel or a reopened popup resumes polling.

### 4.4 Settings

A "Prover" section: **This device** / **My own prover**. Pairing is by pasted link or, on a
shell with a camera, `platform.scanQr`. Save verifies first (`prover.probe()`), as the node
setting does. The extension asks for the host permission inside the same click.

Copy, Phase 1, shown before the pairing is saved and not dismissible by default:

> This prover will receive your spend key each time it makes a proof. Anyone who controls it can
> spend your funds. Pair only a machine you run yourself.

Copy, Phase 2, for a prover that is not `own`:

> This prover will be able to read this wallet's whole history — every payment received and
> sent, before and after today. It cannot spend. To keep your history private, run your own.

### 4.5 Rules the tests hold

- The spend key reaches `fetch` only inside a sealed job. `assertKeyNeverLeaked` is extended to
  the prover's requests.
- A spend-key job is built only for a pairing with `own: true`.
- A reply with the wrong digest, an oversized proof, or a proof that does not verify never
  reaches `rand_sendTransaction`.
- A prover's URL follows the node's rule: `https` anywhere, `http` for `localhost` and
  `127.0.0.1` only.

## 5. The desktop app as a prover

Settings gains "Prove for my other devices". Turning it on starts the fullnode's prover service
inside the app, bound to `127.0.0.1` by default, with `--accept-spend-key`, and shows the pairing
link and its QR code. It proves one job at a time and refuses to start on less than 8 GB.

- Same machine (the extension, the web wallet): works as is.
- Another device (a phone): needs an address the phone can reach over TLS. Out of scope here
  (fullnode spec, open question 4).

## 6. Phase 2 on the client

- The wallet makes the **auth proof** itself: tier 10, estimated at seconds and about 0.4 GB.
  Whether wasm and phones manage it is the fullnode spec's spike (P2-0) and gates this phase.
- The job carries the viewing key, never the spend key.
- The "Prover" section gains a third choice, **Another prover**, with the second warning above.
- **Prover fee**: when `prover_info.fee` quotes one, the plan adds a RAND output to the prover's
  address (slot rules in the fullnode spec §5). Review shows it as its own line, "Prover fee",
  beside the network fee. A wallet with a single RAND note is told to split it first.
- With a paid prover the wallet sends the unproven transaction and the auth proof, and the prover
  broadcasts; the wallet then waits for the nullifier as it does for any send.

## 7. Tasks

Phase 1: C1-1 core `prepare_*` / `finish_proof` and their tests · C1-2 the engine's `prover`
group, `canProve`, the remote `proving` phase, resume after a closed popup · C1-3 Settings and
pairing · C1-4 the desktop prover toggle · C1-5 extension host permission and the end-to-end test
(extension → desktop prover → a node admits the transaction) · C1-6 iOS and Android settings.

Phase 2: C2-1 the auth proof in core, measured in wasm and on devices · C2-2 viewing-key jobs and
"Another prover" · C2-3 the prover fee in planning and review.

## 8. Open questions

1. Is a pairing per wallet or per install? (Per wallet is safer: forgetting a wallet forgets its
   prover.)
2. Does the mobile UI offer Phase 1 at all, given a phone cannot reach a desktop on `127.0.0.1`?
3. Should a wallet that delegates in Phase 2 be steered to a separate "spending" wallet, so the
   prover's view is limited to what was moved into it?
