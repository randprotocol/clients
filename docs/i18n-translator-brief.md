# Translator brief (one language per agent)

Work ONLY in /Users/dendisuhubdy/Github/randprotocol/clients/.claude/worktrees/i18n. Never git
commit/stash/checkout/reset/add. Write only the files named for your language.

Read first: ui/locales/README.md (the rules: holes, plurals, glossary, register, script), ui/i18n.js
(how t() and plural objects work), ui/locales/en.js (the 1002 keys). For context on what a string
means, grep its key in ui/ and extension/shared/ and read the surrounding code.

Rand Wallet is a privacy wallet for a shielded blockchain: notes, viewing key, spend key, proof,
prover, bridge, withdraw, swap, pool, faucet, node, chain. Use the established crypto-wallet terms
of your language; be consistent across the file (one term per concept). Keep RAND, zUSD, RPL, Rand,
Rand Wallet, RandProtocol, USDT, USDC, STARK, randscan, durian.market, chain names, rand1… addresses,
randpay:/randprover: links, URLs, `rand send` and code-like tokens exactly as they are.

Deliverables:
1. ui/locales/<code>.js — `export default { "<English key>": "<translation>", … }` with EVERY key of
   en.js, same order as en.js. Keys with {n} or {count} where your language inflects by number may be
   plural objects with all of your language's CLDR categories. Write the file in several appends if
   it is long (e.g. 150 keys at a time), then check the count.
2. extension/shared/_locales/<chrome-dir>/messages.json — the five messages of
   extension/shared/_locales/en/messages.json translated ("message" only translated; keep
   "description" in English). Chrome dir: zh→zh_CN, zh-hk→zh_HK, pt→pt_BR, others = the code.
3. Verify: `node --test --test-name-pattern="dictionary <code>:" ui/test/i18n.test.mjs` must pass
   (key parity, holes, glossary, plural categories); `node --test extension/test/` must pass.
   Fix and rerun until green.

Report: key count, plural objects used, any keys you were unsure of (≤10, with your choice), tests.
