// What the withdraw window calls the money that arrives: "9.99 USDT on Ethereum", not "9.99 zUSD".
// The burn asset (zUSD) is what leaves the wallet; what the user receives is a coin on another
// chain, and printing the burn asset's name next to the receive figure would misstate it at the one
// screen where the user decides. The asset list's `backings` carry a chain, a token address and
// decimals but no symbol, so the wallet keeps its own short table of the coins it knows by
// (chain, token) — the seven that back zUSD on chain 20 (deploy/genesis-chain20.json) — and says
// "token 0x…" for anything else rather than guess.
//
// Units: `estimate.receive` is in the burn asset's own units (the wallet's wire units, 8 decimals
// for zUSD): it is `amount - relayerFee` after the bridge fee, and the chain refuses a burn that is
// not a whole release unit of the coin. The NUMBER is therefore the coin amount, and is formatted
// with the asset's decimals; the coin's own decimals (6 for USDT, 18 for BSC) only set how fine the
// release can be. Pure, no DOM: importable under plain Node, tested in test/withdraw-label.test.mjs.
// `../ui/` exists only in the packed tree (extension/README.md), so the formatters are handed in
// by the window rather than imported: this file must load under plain Node.

/** Bridge chain ids (bridge-codec CHAIN_*) → the name the coin's own chain goes by. */
export const BRIDGE_CHAIN_NAMES = Object.freeze({ 2: 'Ethereum', 3: 'BNB Chain', 4: 'Tron', 5: 'Solana' });

// 32-byte hex, lower case, no 0x. EVM addresses are left-padded; Tron's 20 bytes are the address
// without its 0x41 prefix; Solana's are the mint's public key.
const pad = (h) => h.padStart(64, '0');
const COINS = Object.freeze({
  [`2:${pad('dac17f958d2ee523a2206206994597c13d831ec7')}`]: 'USDT',
  [`2:${pad('a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')}`]: 'USDC',
  [`3:${pad('55d398326f99059ff775485246999027b3197955')}`]: 'USDT',
  [`3:${pad('8ac76a51cc950d9822d68b83fe1ad97b32cd580d')}`]: 'USDC',
  [`4:${pad('a614f803b6fd780986a42c78ec9c7f77e6ded13c')}`]: 'USDT',
  [`5:ce010e60afedb22717bd63192f54145a3f965a33bb82d2c7029eb2ce1e208264`]: 'USDT',
  [`5:c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61`]: 'USDC',
});

/**
 * `{receive, chain, matched}` for the Receive line. `receive` is the amount with the coin's symbol
 * when (toChain, token) is known, else the bare amount and "token 0x…"; `chain` is the chain's
 * name, else `fallbackChain(toChain)`. `t` is ui/i18n.js's; `assetDecimals` the burn asset's;
 * `formatUnits` and `shortHex` are ui/lib/format.js's.
 */
export function receiveLabel({ toChain, token, receive, assetDecimals, t, fallbackChain, formatUnits, shortHex }) {
  const amount = formatUnits(receive || '0', Number(assetDecimals) || 0, Number(assetDecimals) || 0);
  const key = `${Number(toChain)}:${String(token || '').replace(/^0x/i, '').toLowerCase()}`;
  const symbol = COINS[key] || null;
  return {
    receive: symbol ? `${amount} ${symbol}` : `${amount} ${t('token {token}', { token: shortHex(token, 10) })}`,
    chain: BRIDGE_CHAIN_NAMES[Number(toChain)] || fallbackChain(toChain),
    matched: symbol !== null,
  };
}
