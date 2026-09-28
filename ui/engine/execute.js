// The two shell-independent executors a `makeSharedBackend` shell hands `send.send` and
// `bridge.withdraw` when a bundle proof CAN be made — on this machine (the desktop app, whose core
// is native) or by a paired prover (delegated proving, plan 2026-09-28, any shell). Moved here from
// `backend-native.js` unchanged in substance, so the wasm shells run exactly the code the desktop
// app runs once a prover is paired, instead of a second copy of the phase bookkeeping that decides
// whether a failure was "definitely not sent".
//
// Neither function proves anything itself: they call `ctx.sendTransfer` / `ctx.sendBurn`, which is
// `engine.send` / `engine.burn` (ui/engine/wallet.js), and the backend decides there whether the
// proof is made by the core or by a prover.
import { RpcError, isTransportFailure } from './rpc.js';

/**
 * `ui/engine/wallet.js`'s phase names → the ones `ui/backend.js` declares and `ui/screens/send.js`
 * labels (`ui/screens/send/state.js`). The engine's are the chain's vocabulary and the contract's
 * are the user's, and the mapping belongs here rather than in either of them: **the phase is how
 * the UI decides what a failure means** (see `classify` below), so a phase the UI does not know is
 * not a cosmetic problem.
 */
// Chain 14 retired `'prove-asset'`. It named the FIRST of a burn's two bundle proofs; a burn is
// now one bundle and one proof, exactly like a transfer, so `'proving'` covers both and there is
// no second half for a phase to name.
export const UI_PHASE = Object.freeze({
  select: 'selecting',
  witness: 'witness',
  prove: 'proving',
  submit: 'submitting',
  wait: 'confirming',
});

/** Phases at which nothing has left this device yet, so a failure is definitely "not sent". */
const BEFORE_THE_WIRE = Object.freeze(['select', 'witness', 'prove']);

/**
 * Decides whether a failed transfer is a **definite** failure, which is the difference between
 * the UI offering a retry and the UI refusing to (ui/backend.js: sending twice would pay twice).
 *
 * `definite` is claimed only where it is knowable:
 *   - before `'submit'`, because `wallet.js` reports `'submit'` *before* it hands the transaction
 *     to the node, so nothing can have been broadcast yet;
 *   - at `'submit'`, only when the node itself answered and refused — a JSON-RPC error reply,
 *     which `rpc.js` raises as an `RpcError` carrying the node's own code. A request that never
 *     got an answer at all (transport failure, HTTP status, timeout) is exactly the case where the
 *     transaction may well be in a mempool, and it is told apart by **`isTransportFailure`**, i.e.
 *     by `err.failure`, which `rpc.js` sets only where no JSON-RPC reply existed. It is NOT told
 *     apart by `err.code === -1`: that is the code `rpc.js` puts on such a failure, but it is also
 *     a legal application-defined JSON-RPC code (the reserved range is -32768..-32000), so a node
 *     answering `{"error":{"code":-1,…}}` used to be read here as a dead wire — and the user was
 *     denied a retry they could safely make, for a transfer the node had plainly refused.
 * Everything else — a transport failure at `'submit'`, anything at all during `'confirming'` — is
 * left unknown on purpose.
 *
 * An `AbortError` and an error that already decided for itself are passed through untouched.
 */
export function classify(err, phase) {
  if (!err || typeof err !== 'object') return err;
  if (err.name === 'AbortError') return err;
  if (err.definite !== undefined) return err;
  if (phase === null || BEFORE_THE_WIRE.includes(phase)) err.definite = true;
  else if (phase === 'submit' && err instanceof RpcError && !isTransportFailure(err)) err.definite = true;
  return err;
}

/**
 * The engine's `onPhase(phase, detail?)` → the contract's, remembering the phase for `classify`.
 * `detail` (plan ruling R3: `{position?, prover?}` while a remote prover has the job) is passed
 * through only when there is one, so a screen that reads one argument sees what it always did.
 */
export function makeReporter(onPhase, remember) {
  return (p, detail) => {
    remember(p);
    if (typeof onPhase !== 'function') return;
    if (detail === undefined) onPhase(UI_PHASE[p] || p);
    else onPhase(UI_PHASE[p] || p, detail);
  };
}

/**
 * Runs `work(report)` with the same bookkeeping the two executors use: the last phase `report`
 * saw decides, through `classify`, whether a failure is definite. For `send.resume`, which starts
 * part-way through (the proof is already on a prover) and must classify exactly as a send does.
 */
export async function runPhased(onPhase, work) {
  let phase = null;
  const report = makeReporter(onPhase, (p) => { phase = p; });
  try {
    return await work(report);
  } catch (err) {
    throw classify(err, phase);
  }
}

/**
 * The real transfer. Reached only with a client `requireVerifiedChain()` has proved is on this
 * wallet's chain, and that same client is used for every step — the fee, the anchor, the
 * witnesses, the broadcast, the confirmation wait and the re-scan afterwards. Nothing in here
 * resolves an RPC client of its own; that is task 1.6's invariant and it is the reason
 * `wallet.js`'s `send()` takes a `client` at all.
 */
export async function executeTransfer({ req, onPhase, options, client, identity, sendTransfer, requireUnlocked, bundleFee }) {
  // Chain 14 admits a shielded→shielded transfer of an RPL token — one bundle, the token in slots
  // 0–1 and the RAND fee in slots 2–3 — so the blanket "RPL transfers are not available on this
  // network" refusal that used to stand here is gone. `asset` goes through to the engine, and the
  // only thing that can still refuse a token transfer is the core's own selection: a wallet with
  // no spendable RAND cannot pay the fee, and `plan_transfer` says so at the `'select'` phase,
  // before a witness is fetched.
  const asset = Number(req && req.asset) || 0;

  // The last phase the engine reported, which is what says whether the transaction can have left
  // this device. Recorded here rather than inferred from the error, because only the engine knows.
  // `null` means "not one phase has been reported yet", which `classify` reads as definitely-not-
  // sent — so everything that happens before the first phase belongs INSIDE this try. Reading the
  // session and asking the node for a fee were outside it, and a wallet locked or wiped between
  // the gate and here therefore rejected with no `definite` at all: the UI refused a retry it
  // could safely offer and sent the user looking for a transfer that was never begun.
  let phase = null;
  const report = makeReporter(onPhase, (p) => { phase = p; });

  try {
    const { spend_key: spendKey } = await requireUnlocked();
    const fee = await bundleFee(client);
    const submission = await sendTransfer(spendKey, {
      to: String((req && req.to) || ''),
      asset,
      amountUnits: String((req && req.amount) ?? '0'),
      feeUnits: fee.toString(),
      // Sealed with the payment (spec 2026-09-26 §2.3); `''` is no memo. The engine reads the
      // chain's envelope size from the same verified client, and the core refuses a memo on a
      // chain that carries none before anything is proved.
      memo: typeof (req && req.memo) === 'string' ? req.memo : '',
      wait: true,
      onPhase: report,
      signal: options && options.signal,
      // The verified client and the verified identity, both from the gate. `wallet.js` proves
      // against `identity.chainId` — the chain that was CHECKED — not against whatever
      // `settings.chainId` happens to say now.
      client,
      identity,
    });
    // `txKey` is a secret exactly like an activity item's (ui/backend.js): it is returned to the
    // caller and never written anywhere else. The whole submission record is deliberately not
    // returned — the contract asks for two fields, and the rest is already in the note store.
    return { hash: submission.hash, txKey: submission.tx_key };
  } catch (err) {
    throw classify(err, phase);
  }
}

/**
 * The real withdrawal: a `BridgeBurn`, which since chain 14 is **one bundle and one proof** — the
 * token burned from slots 0–1, the RAND fee paid from slots 2–3, about two minutes on this
 * machine rather than three and a half. Reached only after `bridge.withdraw`'s gates
 * (backend-shared.js) — this device can prove, this node is on this wallet's chain, and the core's
 * own `burn_is_possible` said the chain would accept it — so everything left here is the chain's
 * own business, and it is `wallet.js`'s `burn()` that does it, with `ctx.client` throughout.
 *
 * Memory: one bundle proof, measured at 5.64 GB peak — the same working set a transfer has, since
 * it is the same bundle. `MIN_PROVE_GIB` is therefore exactly as right a gate for a burn as for a
 * transfer, and `canProve()` exactly the right question; chain 13's caveat about keeping two
 * proofs sequential no longer applies, because there is only one.
 */
export async function executeBurn({ req, onPhase, options, client, identity, sendBurn, requireUnlocked }) {
  // `phase` starts `null` and everything before the first reported phase runs inside the try, for
  // the reason spelled out in `executeSend`: `classify(err, null)` is what makes a failure before
  // any work began a DEFINITE one, and reading the session outside it lost that.
  let phase = null;
  const report = makeReporter(onPhase, (p) => { phase = p; });

  try {
    const { spend_key: spendKey } = await requireUnlocked();
    const submission = await sendBurn(spendKey, {
      asset: Number(req.asset),
      amountUnits: String(req.amount ?? '0'),
      relayerFeeUnits: String(req.relayerFee ?? '0'),
      toChain: Number(req.toChain),
      // The coin being redeemed on the far side. One token can be backed by several, and
      // `Action::BridgeBurn` names the one this burn releases.
      token: String(req.token || ''),
      to: String(req.to || ''),
      feeUnits: String(req.fee),
      wait: true,
      onPhase: report,
      signal: options && options.signal,
      client,
      identity,
    });
    // No transaction key: a burn addresses no note to anybody else, so there is nothing to
    // disclose to a counterparty. What leaves the pool is public on the other chain instead.
    return { hash: submission.hash };
  } catch (err) {
    throw classify(err, phase);
  }
}

