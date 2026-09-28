# Proving through your own prover

A transfer on the Rand chain is authorised by a bundle proof, and making one peaks at about
**5.7 GB** of memory. The browser extension and the local web wallet cannot fit that (WebAssembly
stops at 4 GiB), and most phones cannot either. This page is for wallet users: how to let a
machine you run make those proofs for you, and what that costs you in trust. The prover itself —
its commands, options and wire — is documented once, in the fullnode's
[`docs/prover.md`](https://github.com/randprotocol/fullnode/blob/e6d1327/docs/prover.md)
(`../fullnode/docs/prover.md` in a checkout beside this one); this page points there rather than
repeating it.

<!-- TODO(v0.6.2): point the fullnode links at the v0.6.2 tag once it is released. -->

## 1. What it is

The wallet becomes a **light client**: it still picks the notes, builds the outputs, seals the
envelopes and binds the transaction, exactly as before, and a **prover** only fills in the one
bundle proof. The wallet seals everything the proof needs into a job only that prover can open,
sends it, waits, checks the proof that comes back, and submits the transaction to its own node
itself. The prover sees what the proof needs — this payment's notes and amounts, and your spend
key (§2) — but not the transaction it goes into, and it never talks to the chain. On the chain this
prover is the third role that proves or verifies, beside validators and aggregators, and in this
phase it is one you run for yourself.

## 2. The trust model

Today's proof takes the spend key as a private input, so whoever makes it holds the key. That is
why there are two phases:

| | the prover receives | it can read | it can spend | the wallet offers |
|---|---|---|---|---|
| Phase 1 | the spend key | the whole history | **yes** | "My own prover" only |
| Phase 2 | the viewing key | the whole history | no | any prover the user pairs |

This release is Phase 1. The Settings screen shows this warning before a pairing is saved, and it
cannot be dismissed:

> This prover will receive your spend key each time it makes a proof. Anyone who controls it can
> spend your funds. Pair only a machine you run yourself.

Phase 2 will show this one for a prover that is not your own:

> This prover will be able to read this wallet's whole history — every payment received and
> sent, before and after today. It cannot spend. To keep your history private, run your own.

There is no default prover and no directory of provers: a prover exists in a wallet only because
its user pasted a pairing link into it.

## 3. Pair the desktop app with the extension or the web wallet

The simplest prover is the **Rand Wallet desktop app** on the same computer as the browser. It
listens on this computer only (`127.0.0.1:8600`), so nothing crosses the network and no
certificate is needed.

1. **In the desktop app**, open Settings and, in the **Prover** section, turn on **Prove for my
   other devices**. The app refuses to start it on a machine without the memory for one proof and
   says how much it needs and how much is available. Once it is on, the status line reads
   `On · 127.0.0.1:8600 · fingerprint XXXX-XXXX-XXXX-XXXX. Waiting for a proof to make.`, and a
   `randprover:` pairing link appears with its QR code. **Copy link** copies it; **Regenerate
   link** retires the old link (a wallet paired with it stops working) and shows a new one. The
   link carries a secret: paste it into your wallet and nowhere else.
2. **In the extension or the web wallet**, open Settings → **Prover**, paste the link into
   **Pairing link**, read the warning, enter the wallet's **Password** (the pairing is sealed
   under it) and press **Save**.
3. **The extension asks for permission** to reach `http://127.0.0.1` inside that same click — the
   browser's own prompt. Refusing it saves nothing ("Permission to reach that prover was not
   granted, so nothing was saved."). The web wallet has no such prompt.
4. Before saving, the wallet asks the prover for its key and refuses a prover whose key is not the
   one the link names. On success it says **Paired** and shows the prover's fingerprint: check
   that it matches the one the desktop app shows. Settings then reads "Proofs are made by: My own
   prover · 127.0.0.1:8600" and a line such as `Answering · 0 of 8 in its queue.` — the jobs
   waiting, out of the most it will queue.

From then on, **Send** and **Withdraw** work in the browser. While the proof is being made, the
proving step reads `Waiting at position N on 127.0.0.1:8600` while the job waits behind others
in the prover's queue, then `Proving on 127.0.0.1:8600…` while the prover works on it (the name
is the prover's address). The desktop app proves one job at a time. **Cancel** stops waiting and
cancels the job on the prover too.

**A closed popup loses nothing.** The job waits in the extension's session storage: reopen the
popup or the side panel and it opens on Send (or Withdraw, for a burn) and carries on polling
where it left off. Locking the wallet while the prover works forgets the job, and nothing is sent
("The wallet locked while your prover was working, so nothing was sent. Send again."). The web
wallet keeps nothing across a reload, so reloading its tab mid-proof is the same as locking it.

To stop using the prover, press **Forget this prover** in Settings; proofs go back to this device
(which, in a browser, means sending is unavailable again).

## 4. Run `rand-prover` on your own server

Any machine with 8 GB of memory or more can run the fullnode's `rand-prover` for your wallets — a
home server proving for a laptop, say. Generate its key, mint a pairing **with `--own`** (a link
without `own=1` is saved but never sent a job, because every job in this phase carries your spend
key), and run it with `--accept-spend-key`. The commands, options, memory gate and service unit
are in [the fullnode's `docs/prover.md`, §3](https://github.com/randprotocol/fullnode/blob/e6d1327/docs/prover.md#3-run-your-own);
a validator can also host one inside `rand-node` (§4 there).

Then pair it exactly as in §3 above, with the link `rand-prover pair` printed.

**The TLS rule:** a prover's address must be `https://` to any host; plain `http://` is accepted
only for a prover on this machine (`localhost`, `127.0.0.1`). The wallet refuses anything else
("Use https for a prover — plain http is only allowed for a prover on this machine."). The job is
sealed either way, but the pairing token travels inside it, and a network should not be able to
see or rewrite a proof on its way to you. `rand-prover` itself speaks plain HTTP on
`127.0.0.1:8600`, so to reach it from another machine put a TLS-terminating proxy in front of it
and pair with the proxy's `https://` URL ([fullnode `docs/prover.md` §7](https://github.com/randprotocol/fullnode/blob/e6d1327/docs/prover.md#7-tls)).
The extension will ask for permission to reach that host when you save.

## 5. What the wallet checks on every reply

The prover is not trusted to be correct, only to be yours. The core (`finish_proof` in
`core/crates/wallet-core`) checks every reply before anything is submitted, in this order:

1. the reply opens under the key this job was sealed with;
2. the proof fits the chain's proof-size cap (`rand_getLimits.max_proof_bytes`);
3. the digest **read off the proof itself** is the one the wallet computed from its own
   transaction, and the digest the prover claims is that same one;
4. the tier the prover reports is 14, the one tier a bundle proof has (the proof is then verified
   at that pinned tier);
5. the proof verifies, on this device, against the chain's bundle guest and this transaction's
   binding.

A reply that fails any of these never reaches the node: the send ends with a definite error and
nothing was submitted. Two more rules hold before a job is ever built: a spend-key job goes only
to a prover paired with `own=1`, and the spend key leaves the device only inside the sealed job,
never in clear.

## 6. The mobile apps

Phase 1 lets a phone use a prover you run, too — but it must be reachable from the phone over TLS
(an `https://` address, §4): the desktop app's prover listens on its own computer only
(`127.0.0.1`), which a phone cannot reach, so a phone pairs with your own `rand-prover` behind a
TLS-terminating proxy. Plain `http://` is accepted only for `localhost`/`127.0.0.1`, which on a
phone means the phone itself (in practice, the simulator or emulator during development).

1. **In the iOS or Android app**, open Settings → **Prover**. It reads "Proofs are made by: This
   device" until something is paired.
2. Paste the `randprover:` link into **Pairing link**, or press **Scan** (iOS: the QR button
   beside the field; Android: **Scan QR code**) and point the camera at the prover's QR code. The
   warning in §2 is shown under the field, before **Save**, every time.
3. **Save** reads the link through the core, holds its address to the TLS rule, asks the prover
   for its key and refuses one whose key is not the link's (the same checks as §3 step 4). On
   success it says **Paired** with the fingerprint — check it against the one your prover shows.
   The token is kept in the Keychain (iOS) or the encrypted key vault (Android), beside the spend
   key, never in the app's settings; there is no password step, because those stores are already
   locked to the device. A link without `own=1` is saved but never sent a job ("Saved; not usable
   in this build").
4. Settings then reads "Proofs are made by: My own prover · host:port", its fingerprint, and a
   status line such as `Answering · 0 of 8 in its queue.` **Forget this prover** removes the
   pairing and its token; removing the wallet from the phone removes them too.

A phone with enough memory for a proof (about 8 GB) keeps proving for itself; the prover is used
only when it cannot. Then the review step says the paired prover will make the proof, and
**Send** checks that the prover answers with the paired key and takes a spend-key job before it
builds anything — if not, the send stops with the reason and nothing is sent. While the proof is
made the proving screen reads `Waiting at position N on host:port`, then `Proving on host:port…`;
the reply is checked exactly as in §5 before the transaction is submitted. The mobile apps have
no Withdraw screen, so only transfers go through the prover.

The job lives only in the running app (on Android, in its proving service): if the system kills
the app mid-proof, that job is lost and nothing is sent — send again.

## 7. Phase 2

Phase 2 needs a chain cut. The wallet will make a small authorisation proof itself and send the
prover a job that carries the **viewing key** instead of the spend key, so a prover can no longer
spend and the wallet can offer **any** prover you pair, not only your own — with a fee line when
the prover charges one. It is not private: a prover holding the viewing key can read the wallet's
whole history, which is what the second warning in §2 says. To keep your history private, run
your own.
