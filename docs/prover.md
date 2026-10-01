# Proving through a prover

A transfer on the Rand chain carries two proofs. The **bundle proof** is the big one: making it
peaks at about **6.2 GB** of memory, which the browser extension and the local web wallet cannot
fit (WebAssembly stops at 4 GiB), and most phones cannot either. The **authorisation proof** is
small (a few seconds on a computer, about half a minute in a browser), and the wallet always makes
it itself, from the spend key. This page is for wallet users: how to let another machine make the
big proof for you, and what that costs you in trust. The prover itself — its commands, options
and wire — is documented once, in the fullnode's
[`docs/prover.md`](https://github.com/randprotocol/fullnode/blob/v0.6.7/docs/prover.md)
(`../fullnode/docs/prover.md` in a checkout beside this one); this page points there rather than
repeating it.

## 1. What it is

The wallet becomes a **light client**: it still picks the notes, builds the outputs, seals the
envelopes, binds the transaction and authorises the spend, exactly as before, and a **prover**
only fills in the bundle proof. The wallet seals everything that proof needs into a job only that
prover can open, sends it, waits, checks the proof that comes back, and submits the transaction to
its own node itself. The prover sees what the proof needs — this payment's notes and amounts, and
your viewing key (§2) — but not the transaction it goes into, and it never talks to the chain. On
the chain this prover is the third role that proves or verifies, beside validators and
aggregators.

## 2. The trust model

Since **split authorisation** (fullnode v0.6.3; every chain since 17 — chain 18 and 19 are the
live ones), the bundle proof is made from the wallet's **viewing key** and a fresh salt, and a
second proof, made from the **spend key** and that salt, is what authorises the spend. The wallet
makes the second one on the device, always — through a prover or not — and the spend key never
leaves it. So a prover can be anybody's:

| the prover receives | it can read | it can spend | the wallet offers |
|---|---|---|---|
| the viewing key and a one-time salt, with each job | the whole history — every payment received and sent, before and after today | **no** | any prover you pair |

That is still a lot to hand over. The Settings screen shows this warning before a pairing is
saved, own or not, and it cannot be dismissed:

> This prover will be able to read this wallet's whole history — every payment received and
> sent, before and after today. It cannot spend. To keep your history private, run your own.

A pairing link marked `own=1` (one a machine you run made) is shown as "My own prover"; any other
as "Paired prover", with the same sentence under it. The earlier Phase 1 rule — a job that carried
the spend key, sent only to a prover marked as your own — applies only to chains without split
authorisation, which no public chain is any more; a wallet on such a chain still refuses to send a
spend-key job anywhere but an `own=1` pairing.

There is no directory of provers. A prover you pair exists in a wallet because you pasted its
pairing link into it. The one exception is the prover every client ships the address of — the
RandProtocol prover (§8) — which, from wallet 0.6.8, is the default where a device cannot prove,
after a one-time notice, and can be turned off.

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
   link carries a secret: paste it into your wallet and nowhere else. Regenerating invalidates
   every wallet paired with the old token at once — each must be paired again with the new link.
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

From then on, **Send** and **Withdraw** work in the browser. The proving step first reads
`Authorising the spend on this device…` — the wallet's own small proof, made from the spend key
before any job leaves the browser (about half a minute there) — then `Waiting at position N on
127.0.0.1:8600` while the job waits behind others in the prover's queue, then `Proving on
127.0.0.1:8600…` while the prover works on it (the name is the prover's address). The desktop app proves one job at a time. **Cancel** stops waiting and
cancels the job on the prover too. The wallet waits up to 30 minutes for a job to leave the
prover's queue and up to 20 minutes for it to be proved; past either it stops waiting, keeps the
job, and offers **Resume** (wait for the same job again) and **Cancel**.

**A closed popup loses nothing.** The job waits in the extension's session storage: reopen the
popup or the side panel and it opens on Send (or Withdraw, for a burn) and carries on polling
where it left off. Locking the wallet while the prover works forgets the job, and nothing is sent
("The pending proof was cleared (the wallet locked, or it was cancelled elsewhere), so nothing was
sent. Send again."). The web wallet keeps nothing across a reload, so reloading its tab mid-proof
is the same as locking it.

**Which pages may talk to a prover.** A prover answers a browser page only from an origin on its
allow-list, so that an arbitrary website cannot read its key and recognise your machine. By default
(fullnode `v0.6.2`, unchanged in `v0.6.7`) the list is browser extensions (`chrome-extension://*`, `moz-extension://*`,
`safari-web-extension://*`) and pages on this machine (`http://localhost:*`, `http://127.0.0.1:*`,
`http://[::1]:*`); the desktop app uses that default. The extension and the local web wallet
(served by `web/wallet/serve.sh` on `http://127.0.0.1:<port>`) are on it and need nothing more.
Anything else is refused with `-32007 origin not allowed`:

- **A web wallet opened as a file** (`file://…/index.html`) sends `Origin: null`, which no list
  can allow. Serve it from `http://localhost:<port>` (or `127.0.0.1`) instead.
- **A web wallet on its own `https://` origin** needs that exact origin added on the prover:
  `rand-prover run --allow-origin https://wallet.example` (`--prover-allow-origin` on `rand-node`).
  `--allow-origin` replaces the default list rather than adding to it, so repeat it for every
  origin you still want; `*` allows every page and is only ever set explicitly. The desktop app has
  no such setting. Known limitation: Chrome's Private Network Access blocks a public `https://`
  page from calling a prover on this machine's loopback (`127.0.0.1`) even with its origin on the
  list — put the prover behind an `https://` proxy (§4) for such a wallet.

`prover_info` reports the list as `allowed_origins`
([fullnode `docs/prover.md` §6.1](https://github.com/randprotocol/fullnode/blob/v0.6.7/docs/prover.md#61-transport)).

To stop using the prover, press **Forget this prover** in Settings; proofs go back to this device
(which, in a browser, means sending is unavailable again).

## 4. Run `rand-prover` on your own server

Any machine with 8 GB of memory or more can run the fullnode's `rand-prover` for your wallets — a
home server proving for a laptop, say. Generate its key, mint a pairing (`--own` marks the link as
a machine of yours, which is what the wallet then calls it), and run it — without
`--accept-spend-key`: a viewing-key job is all a wallet on a split-authorisation chain sends, and
the desktop app's host takes nothing else either. Do not run it with `--fee`: this wallet pays no
prover fee and refuses a prover that quotes one. The commands, options, memory gate and service
unit are in [the fullnode's `docs/prover.md`, §3](https://github.com/randprotocol/fullnode/blob/v0.6.7/docs/prover.md#3-run-your-own);
a validator can also host one inside `rand-node` (§4 there).

Then pair it exactly as in §3 above, with the link `rand-prover pair` printed.

**The TLS rule:** a prover's address must be `https://` to any host; plain `http://` is accepted
only for a prover on this machine (`localhost`, `127.0.0.1`). The wallet refuses anything else
("Use https for a prover — plain http is only allowed for a prover on this machine."). The job is
sealed either way, but the pairing token travels inside it, and a network should not be able to
see or rewrite a proof on its way to you. `rand-prover` itself speaks plain HTTP on
`127.0.0.1:8600`, so to reach it from another machine put a TLS-terminating proxy in front of it
and pair with the proxy's `https://` URL ([fullnode `docs/prover.md` §7](https://github.com/randprotocol/fullnode/blob/v0.6.7/docs/prover.md#7-tls)).
The extension will ask for permission to reach that host when you save.

## 5. What the wallet checks on every reply

The prover is not trusted to be correct, and it need not be yours. The core (`finish_proof` in
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
nothing was submitted. Before a job is ever built the core also refuses a chain it cannot
authorise a spend on (a bundle guest whose auth guest the node does not name, or names
differently from this build's), and it holds, in its own code, the rule that a spend-key job — an
older chain's — goes only to a prover paired with `own=1`; on a split-authorisation chain no
spend-key job exists to send. The pending transaction the wallet keeps while the prover works
already carries the authorisation proof and never the spend key or the viewing key.

## 6. The mobile apps

A phone can use a prover too — but it must be reachable from the phone over TLS
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
   locked to the device. A link without `own=1` is paired too, and shown with what such a prover
   can read.
4. Settings then reads "Proofs are made by: My own prover · host:port" (or "Paired prover", for
   a link not marked own), its fingerprint, and a status line such as `Answering · 0 of 8 in its
   queue.` **Forget this prover** removes the pairing and its token; removing the wallet from the
   phone removes them too.

A phone with enough memory for a proof (about 8 GB) keeps proving for itself; the prover is used
only when it cannot. Then the review step says the paired prover will make the proof, and
**Send** checks that the prover answers with the paired key, takes a viewing-key job and charges
nothing before it builds anything — if not, the send stops with the reason and nothing is sent.
The phone makes the authorisation proof itself first (`Authorising the spend on this device…`),
then the proving screen reads `Waiting at position N on host:port`, then `Proving on host:port…`;
the reply is checked exactly as in §5 before the transaction is submitted. The mobile apps have
no Withdraw screen, so only transfers go through the prover.

The job lives only in the running app (on Android, in its proving service): if the system kills
the app mid-proof, that job is lost and nothing is sent — send again.

## 7. Fees

The fullnode's `rand-prover` can quote a fee (`rand-prover run --fee <RAND> --fee-address …`),
paid by one extra RAND output inside the bundle it proves. **This wallet does not pay prover
fees** in this release: paying one changes which notes a transfer selects and what the review step
shows, in every shell. A prover that quotes a fee is not offered as a way to prove (Settings and
the send both say so), and one that starts charging between the pairing and a job is refused
before the job is built; the prover's own refusal of an unpaid job (`-32006`) is reported in the
same words. Pair a prover that charges nothing, or run your own.

## 8. The RandProtocol prover

Every client ships with the address of one prover, run by the RandProtocol validators:
**`https://prover.randprotocol.org`**, key fingerprint **`RGTF-7HKJ-XZFV-GQ1J`**. It is a pool —
validator-hosted provers behind one name, every member holding the same prover key, so a job
reaches whichever answers — it takes viewing-key jobs only, and it charges nothing.

**From wallet 0.6.8 it is the default.** A wallet with no prover of its own that cannot make a
proof itself — the browser extension and the web wallet always (a bundle proof needs ~6.2 GB and
wasm stops at 4 GiB), a phone almost always, a desktop without 8 GB of memory — sends through it
at once, with nothing to pair. A desktop (or a phone) that has the memory keeps proving on the
device: the device is always asked first. Nothing is stored for it: the wallet reads the built-in
link through the core, holds it to the pinned fingerprint (`version.trusted_prover.fingerprint`),
the URL rule and `own=0`, asks the pool for its key — refusing it unless it is the pinned one — and
seals the job to that key.

**The first send through it shows a one-time notice**, before anything is built:

> This device cannot make the proof, so the prover RandProtocol runs for everyone makes it. It
> receives this wallet's viewing key, so it can read your whole history — every payment received
> and sent, past and future. It cannot spend. You are asked once; to keep your history to
> yourself, use your own prover instead.

with **I understand — continue** and **Use my own prover** (to Settings) right there. The
acknowledgement is remembered for that wallet; removing the wallet forgets it, and the engine
refuses a send through the pool until it is read.

In Settings → **Prover** it is named with its URL, fingerprint and what it sees. **Use no prover**
turns it off (proofs are then made on the device or not at all); **Use the RandProtocol prover**
turns it back on. A prover you pair yourself (§3, §4) is always preferred over it, and **Forget
this prover** falls back to it. When the pool does not answer, answers with another key, or is busy
(its queue is small; a busy answer is never retried in a loop), the wallet says so plainly —
"The RandProtocol prover cannot be reached right now (…)" / "The RandProtocol prover is busy; try
again in a minute, or pair your own prover in Settings."

What it learns is what §2 says of every prover that is not your own: the viewing key of every
wallet that uses it and a one-time salt with each job — that wallet's whole history, past and
future — and never a spend key. A `rand-prover` you run (§4), or the desktop app (§3), is what
keeps your history to yourself. The built-in link carries a token shared by every client, so it
identifies the wallet software, not you.

A `prover_submit` that never reached a prover — no connection, or an HTTP error page instead of an
answer — is offered again, three tries, 1 s then 3 s apart. A prover's own answer (busy included)
is final, and a job is never submitted twice once the prover has named it.
