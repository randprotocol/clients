// The wallet core's error sentences, in the user's language.
//
// `wallet-core` (core/crates/wallet-core) refuses in English — "insufficient balance: have 1 RAND,
// need 2 RAND", "amount must be greater than zero" — and every shell surfaces that sentence as
// `err.message`, which the screens show as it is. The core knows nothing of the wallet's languages,
// and it must not: it is one crate for four shells and a CLI. So the translation happens here, at
// the one place a core reply becomes the Error the engine throws (`coreApi` in ./wallet.js), and a
// screen never has to know which of its errors came from Rust.
//
// Only the sentences a user can actually meet are mapped: the ones a send, a withdrawal, a swap or
// an invoke, an import, a pairing or a pasted link can run into. The core's own invariants
// ("… (wallet bug)"), its parameter-shape complaints ("missing parameter …", "unknown method …")
// and the checks the engine has already made before asking (`validate.js` holds a node's reply
// to shape first) are left as they are: an English sentence from a path no user reaches is better
// than a dictionary padded with keys no translator can ever see on a screen.
//
// The English string IS the dictionary key, exactly as everywhere else in ui/ (ui/i18n.js), so the
// mapping is a literal `t('…')` per message — one with holes where the core wrote a number, an
// amount or a name into it. A message with a variable part is matched by a regular expression over
// the core's own `format!` and the hole filled from the match; a message that composes another
// ("the RAND fee: insufficient balance …", "recipient: shielded address …") translates its inner
// part first. Anything unmatched comes back unchanged.
import { t } from '../i18n.js';

/** Exact sentences, as the core writes them (`bad("…")` and the crate's `pub const`s). */
const EXACT = new Map([
  // ---- importing a key (`import_key`) ----
  ['a spend key is 64 hex characters, or a wallet.key.json', () => t('a spend key is 64 hex characters, or a wallet.key.json')],
  ['key file must be version 2', () => t('key file must be version 2')],
  ['key file has no spend_key', () => t('key file has no spend_key')],
  ['spend_key must be 64 hex characters', () => t('spend_key must be 64 hex characters')],
  // ---- an address (`parse_address`, `uri_format`, `address_fingerprint`, a recipient) ----
  ['shielded address must start with rand1', () => t('shielded address must start with rand1')],
  ['shielded address is not base58', () => t('shielded address is not base58')],
  // ---- a randpay: link (`uri_parse`) ----
  ['not a randpay: link', () => t('not a randpay: link')],
  ['bad percent-encoding', () => t('bad percent-encoding')],
  // ---- an amount (`parse_amount`) ----
  ['not a number', () => t('not a number')],
  ['amount overflow', () => t('amount overflow')],
  ['amounts overflow', () => t('amounts overflow')],
  // ---- planning a transfer (`plan_transfer`, `max_sendable`) ----
  ['amount must be greater than zero', () => t('amount must be greater than zero')],
  ['a transfer pays its fee in RAND, and this wallet holds no spendable RAND: receive some RAND (on a testnet, `rand faucet`) and retry',
    () => t('a transfer pays its fee in RAND, and this wallet holds no spendable RAND: receive some RAND (on a testnet, `rand faucet`) and retry')],
  // ---- a bridge burn (`plan_burn`, `burn_is_possible`, `prove_burn`) ----
  ['a burn of zero moves nothing', () => t('a burn of zero moves nothing')],
  ['asset 0 is RAND, which is not a bridged asset and cannot be burned', () => t('asset 0 is RAND, which is not a bridged asset and cannot be burned')],
  ['this chain has no bridge, so there is nothing to burn to', () => t('this chain has no bridge, so there is nothing to burn to')],
  // ---- a memo on a chain that carries none (`prove_transfer`, `prepare_transfer`) ----
  ['this chain carries no memo: its envelopes predate it (send again with an empty memo)',
    () => t('this chain carries no memo: its envelopes predate it (send again with an empty memo)')],
  // ---- the prover's reply (`finish_proof`) ----
  ['the prover\'s reply is not hex', () => t('the prover\'s reply is not hex')],
  // ---- a pairing link (`parse_prover_link`) ----
  ['not a randprover: link', () => t('not a randprover: link')],
  ['the link has no ?url=…&token=… part', () => t('the link has no ?url=…&token=… part')],
  ['the link has no url', () => t('the link has no url')],
  ['the link has no token', () => t('the link has no token')],
  ['the link\'s url is empty', () => t('the link\'s url is empty')],
  // ---- an RPL-2 invoke (`dry_run_invoke`, `plan_invoke`, `prove_invoke`) ----
  ['a payout of zero creates nothing; the chain refuses it', () => t('a payout of zero creates nothing; the chain refuses it')],
  ['cell keys must be strictly ascending', () => t('cell keys must be strictly ascending')],
  ['the inflow is `none` exactly when the bundle burns no token (inflow.amount == 0)',
    () => t('the inflow is `none` exactly when the bundle burns no token (inflow.amount == 0)')],
]);

/**
 * Sentences with a variable part, each as `[regex over the core's format!, fill]`. The first match
 * wins, so a more specific pattern sits above a looser one. `inner` translates a composed sentence's
 * inner part through the whole table again.
 */
const PATTERNED = [
  // ---- composed: a prefix the core adds to another error ----
  [/^the RAND fee: ([\s\S]+)$/, (m, inner) => t('the RAND fee: {reason}', { reason: inner(m[1]) })],
  [/^recipient: ([\s\S]+)$/, (m, inner) => t('recipient: {reason}', { reason: inner(m[1]) })],
  [/^address: ([\s\S]+)$/, (m, inner) => t('address: {reason}', { reason: inner(m[1]) })],
  [/^bad address: ([\s\S]+)$/, (m, inner) => t('bad address: {reason}', { reason: inner(m[1]) })],
  [/^not a key file: ([\s\S]+)$/, (m) => t('not a key file: {reason}', { reason: m[1] })],
  // ---- an address ----
  [/^shielded address decodes to (\d+) bytes, expected (\d+)$/, (m) => t('shielded address decodes to {n} bytes, expected {expected}', { n: m[1], expected: m[2] })],
  // ---- a randpay: link ----
  [/^unknown parameter (.+)$/, (m) => t('unknown parameter {name}', { name: m[1] })],
  [/^parameter (.+) given twice$/, (m) => t('parameter {name} given twice', { name: m[1] })],
  [/^bad amount (.+)$/, (m) => t('bad amount {amount}', { amount: m[1] })],
  [/^bad asset (.+)$/, (m) => t('bad asset {asset}', { asset: m[1] })],
  [/^memo is (\d+) bytes, at most (\d+)$/, (m) => t('memo is {n} bytes, at most {max}', { n: m[1], max: m[2] })],
  // ---- an amount ----
  [/^too many decimal places \(max (\d+)\)$/, (m) => t('too many decimal places (max {n})', { n: m[1] })],
  [/^(\d+) units of asset (\d+)$/, (m) => t('{units} units of asset {asset}', { units: m[1], asset: m[2] })],
  // ---- selecting notes (`select_inputs`, through every plan) ----
  [/^insufficient balance: have (.+), need (.+)$/, (m, inner) => t('insufficient balance: have {have}, need {need}', { have: inner(m[1]), need: inner(m[2]) })],
  [/^need more than two notes; the largest two hold (.+) — consolidate first by sending to your own address$/,
    (m, inner) => t('need more than two notes; the largest two hold {amount} — consolidate first by sending to your own address', { amount: inner(m[1]) })],
  [/^a transfer pays its fee in RAND, and this wallet holds no spendable RAND: (.+) RAND is held by a pending submission — rescan once it commits \(or expires\) and retry$/,
    (m) => t('a transfer pays its fee in RAND, and this wallet holds no spendable RAND: {amount} RAND is held by a pending submission — rescan once it commits (or expires) and retry', { amount: m[1] })],
  [/^fee must be at least (.+) RAND \(the bundle floor\)$/, (m) => t('fee must be at least {fee} RAND (the bundle floor)', { fee: m[1] })],
  [/^fee must be at least (.+) RAND \(the bridge burn floor\)$/, (m) => t('fee must be at least {fee} RAND (the bridge burn floor)', { fee: m[1] })],
  [/^inputs hold (.+), but amount \+ fee is (.+)$/, (m) => t('inputs hold {held}, but amount + fee is {need}', { held: m[1], need: m[2] })],
  [/^inputs hold (.+), but fee \+ RAND deposit is (.+)$/, (m) => t('inputs hold {held}, but fee + RAND deposit is {need}', { held: m[1], need: m[2] })],
  [/^the notes of asset (\d+) hold (\d+) units, but the transfer is (\d+)$/, (m) => t('the notes of asset {asset} hold {held} units, but the transfer is {amount}', { asset: m[1], held: m[2], amount: m[3] })],
  [/^the notes of asset (\d+) hold (\d+) units, but the burn is (\d+)$/, (m) => t('the notes of asset {asset} hold {held} units, but the burn is {amount}', { asset: m[1], held: m[2], amount: m[3] })],
  [/^the notes of asset (\d+) hold (\d+) units, but the deposit is (\d+)$/, (m) => t('the notes of asset {asset} hold {held} units, but the deposit is {amount}', { asset: m[1], held: m[2], amount: m[3] })],
  [/^the RAND notes hold (.+), but the fee is (.+)$/, (m) => t('the RAND notes hold {held}, but the fee is {fee}', { held: m[1], fee: m[2] })],
  [/^the RAND notes hold (.+), but fee \+ RAND deposit is (.+)$/, (m) => t('the RAND notes hold {held}, but fee + RAND deposit is {need}', { held: m[1], need: m[2] })],
  // ---- a bridge burn ----
  [/^the relayer fee (\d+) is more than the (\d+) being burned$/, (m) => t('the relayer fee {fee} is more than the {amount} being burned', { fee: m[1], amount: m[2] })],
  [/^asset (\d+) is not in this chain's registry, so no note of it was ever deposited \(the registry is empty\)$/,
    (m) => t('asset {asset} is not in this chain\'s registry, so no note of it was ever deposited (the registry is empty)', { asset: m[1] })],
  [/^asset (\d+) is not in this chain's registry, so no note of it was ever deposited \(registered: (.+)\)$/,
    (m) => t('asset {asset} is not in this chain\'s registry, so no note of it was ever deposited (registered: {registered})', { asset: m[1], registered: m[2] })],
  [/^coin ([0-9a-f]+) on chain (\d+) does not back asset (\d+); its backings are: (.*)$/,
    (m) => t('coin {token} on chain {chain} does not back asset {asset}; its backings are: {backings}', { token: m[1], chain: m[2], asset: m[3], backings: m[4] })],
  [/^([0-9a-f]+) on chain (\d+) has (\d+) decimals: the amount and the relayer fee must be multiples of (\d+)$/,
    (m) => t('{token} on chain {chain} has {decimals} decimals: the amount and the relayer fee must be multiples of {unit}', { token: m[1], chain: m[2], decimals: m[3], unit: m[4] })],
  [/^only (\d+) is locked in that coin on chain (\d+); choose another backing or a smaller amount$/,
    (m) => t('only {locked} is locked in that coin on chain {chain}; choose another backing or a smaller amount', { locked: m[1], chain: m[2] })],
  // ---- a memo on a chain that carries none ----
  [/^chain (\d+) carries no memo: its genesis sets no envelope size, whatever the node claims \(send again with an empty memo\)$/,
    (m) => t('chain {chain} carries no memo: its genesis sets no envelope size, whatever the node claims (send again with an empty memo)', { chain: m[1] })],
  // ---- the chain's guests and gas, against this build's (`chain_guests`, every prove/prepare) ----
  [/^this chain pins every bundle at (\d+) gas, but this wallet's bundle guest declares (\d+); update the wallet$/,
    (m) => t('this chain pins every bundle at {theirs} gas, but this wallet\'s bundle guest declares {ours}; update the wallet', { theirs: m[1], ours: m[2] })],
  [/^this build does not carry the chain's bundle guest ([0-9a-f]+): update the wallet$/,
    (m) => t('this build does not carry the chain\'s bundle guest {guest}: update the wallet', { guest: m[1] })],
  [/^this chain names an auth guest but a v1\/v2 bundle guest \(([0-9a-f]+)\); the node is misconfigured or lying — refusing to prove$/,
    (m) => t('this chain names an auth guest but a v1/v2 bundle guest ({guest}); the node is misconfigured or lying — refusing to prove', { guest: m[1] })],
  [/^this chain's bundle guest is v3 \(split authorisation\) but the node names no auth guest \(rand_status has no hc_auth\); this wallet carries ([0-9a-f]+) — refusing to prove a bundle it cannot authorise$/,
    (m) => t('this chain\'s bundle guest is v3 (split authorisation) but the node names no auth guest (rand_status has no hc_auth); '
      + 'this wallet carries {ours} — refusing to prove a bundle it cannot authorise', { ours: m[1] })],
  [/^this chain's auth guest is ([0-9a-f]+); this wallet carries ([0-9a-f]+) — refusing to prove a v3 bundle it cannot authorise; update the wallet$/,
    (m) => t('this chain\'s auth guest is {theirs}; this wallet carries {ours} — refusing to prove a v3 bundle it cannot authorise; update the wallet', { theirs: m[1], ours: m[2] })],
  // ---- proving on this device ----
  [/^proving failed: ([\s\S]+)$/, (m) => t('proving failed: {reason}', { reason: m[1] })],
  [/^proving the spend authorisation failed: ([\s\S]+)$/, (m) => t('proving the spend authorisation failed: {reason}', { reason: m[1] })],
  [/^proving the call failed: ([\s\S]+)$/, (m) => t('proving the call failed: {reason}', { reason: m[1] })],
  // ---- a paired prover (`prepare_*`, `finish_proof`) ----
  [/^this prover charges (.+) RAND per proof, and this version of the wallet does not pay a prover's fee: pair a prover that charges nothing, or prove on this device$/,
    (m) => t('this prover charges {fee} RAND per proof, and this version of the wallet does not pay a prover\'s fee: pair a prover that charges nothing, or prove on this device', { fee: m[1] })],
  [/^the prover quotes a fee this wallet cannot read \(([\s\S]+)\); not sending it a job$/,
    (m) => t('the prover quotes a fee this wallet cannot read ({why}); not sending it a job', { why: m[1] })],
  [/^the prover's reply does not open: ([\s\S]+)$/, (m) => t('the prover\'s reply does not open: {reason}', { reason: m[1] })],
  [/^the prover's bundle proof is (\d+) bytes, over this chain's (\d+)-byte cap \(max_proof_bytes\); not using it$/,
    (m) => t('the prover\'s bundle proof is {n} bytes, over this chain\'s {cap}-byte cap (max_proof_bytes); not using it', { n: m[1], cap: m[2] })],
  [/^the proof published a digest this wallet did not build \(([0-9a-f]+) for ([0-9a-f]+)\); not using it$/,
    (m) => t('the proof published a digest this wallet did not build ({published} for {expected}); not using it', { published: m[1], expected: m[2] })],
  [/^the prover claimed digest ([0-9a-f]+) but its proof publishes ([0-9a-f]+); not using it$/,
    (m) => t('the prover claimed digest {claimed} but its proof publishes {published}; not using it', { claimed: m[1], published: m[2] })],
  [/^the prover reported tier (\d+), but a bundle proof is tier (\d+); not using it$/,
    (m) => t('the prover reported tier {tier}, but a bundle proof is tier {expected}; not using it', { tier: m[1], expected: m[2] })],
  [/^the prover's proof does not decode as a bundle proof, so its digest cannot be read: ([\s\S]+)$/,
    (m) => t('the prover\'s proof does not decode as a bundle proof, so its digest cannot be read: {reason}', { reason: m[1] })],
  [/^the prover's proof does not decode as a bundle proof, so its gas limit cannot be read: ([\s\S]+)$/,
    (m) => t('the prover\'s proof does not decode as a bundle proof, so its gas limit cannot be read: {reason}', { reason: m[1] })],
  [/^the prover's proof: ([\s\S]+)$/, (m, inner) => t('the prover\'s proof: {reason}', { reason: inner(m[1]) })],
  [/^the proof does not verify: ([\s\S]+)$/, (m) => t('the proof does not verify: {reason}', { reason: m[1] })],
  // ---- a pairing link ----
  [/^prover key is not base58: ([\s\S]+)$/, (m) => t('prover key is not base58: {reason}', { reason: m[1] })],
  [/^prover key is (\d+) bytes, expected (\d+)$/, (m) => t('prover key is {n} bytes, expected {expected}', { n: m[1], expected: m[2] })],
  [/^malformed parameter (.+)$/, (m) => t('malformed parameter {parameter}', { parameter: m[1] })],
  [/^token is not 64 hex digits: ([\s\S]+)$/, (m) => t('token is not 64 hex digits: {reason}', { reason: m[1] })],
  [/^own=(.+), expected 1 or absent$/, (m) => t('own={value}, expected 1 or absent', { value: m[1] })],
  // ---- an RPL-2 invoke ----
  [/^the program does not accept this transition: ([\s\S]+)$/, (m) => t('the program does not accept this transition: {reason}', { reason: m[1] })],
  [/^the node served code \((\d+) words\) and a public input \((\d+) words\) that do not hash to program ([0-9a-f]+); not proving against them$/,
    (m) => t('the node served code ({code} words) and a public input ({public} words) that do not hash to program {program}; not proving against them', { code: m[1], public: m[2], program: m[3] })],
  [/^the call proof is (\d+) bytes, over this chain's (\d+)-byte cap \(max_proof_bytes\); it would be refused, so nothing was built$/,
    (m) => t('the call proof is {n} bytes, over this chain\'s {cap}-byte cap (max_proof_bytes); it would be refused, so nothing was built', { n: m[1], cap: m[2] })],
  [/^a transition reads at most (\d+) cells and writes at most (\d+)$/, (m) => t('a transition reads at most {reads} cells and writes at most {writes}', { reads: m[1], writes: m[2] })],
  [/^a transition creates at most (\d+) notes \(pays and mints together\)$/, (m) => t('a transition creates at most {n} notes (pays and mints together)', { n: m[1] })],
];

/**
 * The core's `message` in the language in force; the message itself when it is not one this file
 * knows (or not a string). In English the answer is always the input, byte for byte.
 */
export function translateCoreError(message) {
  if (typeof message !== 'string' || message === '') return message;
  const exact = EXACT.get(message);
  if (exact) return exact();
  for (const [re, fill] of PATTERNED) {
    const m = re.exec(message);
    if (m) return fill(m, translateCoreError);
  }
  return message;
}

/**
 * An error from a core call, its message translated in place: the same object, so `code`, `name`
 * and whatever else a caller set on it survive. A rejection that is not an Error (a shell that
 * rejected with the bare string) becomes one. `coreApi` (./wallet.js) runs every core rejection
 * through this, which is why no other file has to.
 */
export function translatedCoreError(err) {
  if (err instanceof Error) {
    const message = translateCoreError(err.message);
    if (message !== err.message) {
      try { err.message = message; } catch { /* a frozen error keeps its English */ }
    }
    return err;
  }
  if (typeof err === 'string') return new Error(translateCoreError(err));
  return err;
}
