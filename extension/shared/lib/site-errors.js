// What a site is told when Rand Wallet refuses one of its requests: a code and a FIXED English
// sentence for that code — never the wallet's own reason. The reason the window shows can name a
// balance ("have 3, need 5"), a note's value, the user's own prover host, or a program's private
// inputs; none of that is the site's. The window keeps the full reason under "Not sent"; the site
// gets the code (the contract it branches on) and the sentence below, which holds no figures.
//
// A code a window answers with that is not listed for its kind becomes CANNOT_WITHDRAW or
// CANNOT_INVOKE. provider-host.js (a classic script, so it cannot import this) keeps the same
// table and applies it again to every answer it relays: a window cannot put anything else in
// front of the site. extension/test/site-errors.test.mjs checks that the two tables are one.

const SHARED = Object.freeze({
  USER_REJECTED: 'The request was not approved in Rand Wallet.',
  GONE: 'That request is no longer waiting.',
  LOCKED: 'Rand Wallet is locked.',
  BAD_REQUEST: 'Rand Wallet could not read that request.',
  PROVER_UNAVAILABLE: 'Rand Wallet has no prover it can use for this right now, so nothing was sent. Open Rand Wallet to see why.',
});

export const SITE_ERRORS = Object.freeze({
  withdraw: Object.freeze({
    ...SHARED,
    CANNOT_WITHDRAW: 'Rand Wallet cannot make this withdrawal. Open Rand Wallet to see why.',
    WRONG_CHAIN: 'This request is for a different Rand chain than this wallet is on.',
    UNAVAILABLE: 'Rand Wallet cannot reach or use the bridge right now. Nothing was sent.',
    BRIDGE_DISABLED: 'The bridge is off on this Rand chain. Nothing was sent.',
    PROOF_PENDING: 'An earlier proof is still waiting in Rand Wallet. Open Rand Wallet to resume or cancel it.',
    UNKNOWN_OUTCOME: 'Rand Wallet could not tell whether the burn was sent. Check its activity before trying again.',
  }),
  invoke: Object.freeze({
    ...SHARED,
    CANNOT_INVOKE: 'Rand Wallet cannot make this transaction. Open Rand Wallet to see why.',
    UNSUPPORTED: 'This Rand Wallet cannot run programs.',
    PROGRAMS_UNSUPPORTED: 'This chain does not run programs yet, so Rand Wallet cannot send this. Nothing was sent.',
    NO_PROGRAM: 'There is no such program on this chain. Nothing was sent.',
    STALE_READ: 'The pool changed since this page read it. Nothing was sent; the site can quote again.',
    PROGRAM_REFUSED: 'The program would not accept this request, so nothing was sent.',
    VAULT_SHORT: 'The pool does not hold enough to pay this out. Nothing was sent; the site can quote again.',
    UNKNOWN_OUTCOME: 'Rand Wallet could not tell whether the transaction was sent. Check its activity before trying again.',
  }),
});

/** The catch-all code of each kind. */
export const CANNOT = Object.freeze({ withdraw: 'CANNOT_WITHDRAW', invoke: 'CANNOT_INVOKE' });

/** `{code, message}` for the site: `code` if it is listed for `kind`, else the kind's catch-all. */
export function siteError(kind, code) {
  const table = SITE_ERRORS[kind];
  const known = typeof code === 'string' && Object.prototype.hasOwnProperty.call(table, code);
  const c = known ? code : CANNOT[kind];
  return { code: c, message: table[c] };
}
