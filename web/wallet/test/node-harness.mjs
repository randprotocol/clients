// Shared pieces of the real-node end-to-end tests (prover.e2e.test.mjs, node.e2e.test.mjs): the
// wasm core under Node, an in-memory storage, a fetch that remembers what it was asked, a free
// loopback port, a bounded `until`, child-process handling and the genesis flags a given
// `rand-node` understands. Nothing here is a test; importing it starts nothing.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { makeWasmBackend } from '../../../ui/engine/backend-wasm.js';

// A release `rand-node` (fullnode v0.6.8 and later, #94) refuses a Test-profile genesis at `init`
// and `run` unless told it is a test harness; child processes inherit this. Older nodes ignore it.
process.env.RAND_ALLOW_TEST_FRI_PROFILE ??= '1';

export const CORE_JS = new URL('../../../extension/shared/core/rand_wallet.js', import.meta.url);
export const CORE_WASM = new URL('../../../extension/shared/core/rand_wallet_bg.wasm', import.meta.url);

/** The wasm core, initialised from disk, behind the `call(method, params)` every binding has. */
export async function realCore() {
  const mod = await import(CORE_JS.href);
  mod.initSync({ module: readFileSync(CORE_WASM) });
  return {
    async call(method, params = {}) {
      const reply = JSON.parse(mod.call(method, JSON.stringify(params)));
      if (!reply.ok) throw new Error(reply.error);
      return reply.value;
    },
  };
}

export function mapStorage() {
  const local = new Map();
  const session = new Map();
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    local,
    sessionMap: session,
    async get(k) { return clone(local.get(k)); },
    async set(k, v) { local.set(k, clone(v)); },
    async remove(k) { local.delete(k); },
    async clear() { local.clear(); session.clear(); },
    session: {
      async get(k) { return session.get(k); },
      async set(k, v) { session.set(k, v); },
      async remove(k) { session.delete(k); },
    },
  };
}

/** Real `fetch`, with every request's URL and body kept (for the key-leak scan, for replays). */
export function recordingFetch() {
  const requests = [];
  const wrapped = async (url, init = {}) => {
    requests.push({ url: String(url), body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body ?? null) });
    return fetch(url, init);
  };
  wrapped.requests = requests;
  return wrapped;
}

/** A wasm backend over the real core and real `fetch`, as a user's wallet is built. */
export async function wallet(core) {
  const storage = mapStorage();
  const fetchImpl = recordingFetch();
  const backend = makeWasmBackend({
    core, storage, fetch: fetchImpl,
    platform: { name: 'node-e2e', openExternal() {}, copy() {} },
    locks: null, broadcast: null,
  });
  return { backend, storage, fetch: fetchImpl };
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** One bare JSON-RPC call, outside the wallet's own client. */
export async function rpc(url, method, params = []) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const reply = await res.json();
  if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
  return reply.result;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `check` until it returns something truthy, or throws after `timeoutMs`. */
export async function until(what, check, { timeoutMs, everyMs = 1000 }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
}

/** A child process whose output is kept (and printed if the test fails), killed in `after`. */
export function launch(bin, args, label, options = {}) {
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  child.log = [];
  const keep = (chunk) => {
    child.log.push(chunk.toString());
    if (child.log.length > 400) child.log.splice(0, child.log.length - 400);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.label = label;
  return child;
}

export function stop(child) {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}

export const running = (child) => !!child && child.exitCode === null && child.signalCode === null;

/** Resolves when `child` has exited, or after `ms` — whichever is first; `true` if it exited. */
export function exited(child, ms) {
  if (!running(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.off('exit', done); resolve(false); }, ms);
    function done() { clearTimeout(timer); resolve(true); }
    child.once('exit', done);
  });
}

/** SIGTERM, wait up to `ms` for the exit, then SIGKILL and wait for that exit too. */
export async function stopAndWait(child, ms = 10_000) {
  if (!running(child)) return;
  stop(child);
  if (await exited(child, ms)) return;
  child.kill('SIGKILL');
  await exited(child, 5_000);
}

/**
 * What chain 18's genesis has beyond the defaults (fullnode v0.6.7): the `gas` section — the
 * prices, the bundle guest's pinned gas (20 479, the one value genesis accepts) and the in-circuit
 * meter (constraint set 8, spec 2026-09-28 §4.2) — and **split authorisation** (v0.6.3): bundle
 * guest v3 with the auth guest, which needs a block cap of at least three proof caps plus a MiB
 * (chain 18's 4 MiB proofs and 20 MiB blocks). So the node holds every transaction this wallet
 * makes to the live rules: the bundle proof to the gas pin, and an auth proof beside it made by
 * the wallet from its spend key. Only when the node knows the flags: an older `rand-node` (a
 * v0.6.2 build, say, passed as RAND_NODE_BIN) cuts a plain chain and the test still runs against
 * it — on a spend-key job, which then needs a prover started with --accept-spend-key.
 */
export function chainArgs(nodeBin) {
  const help = execFileSync(nodeBin, ['genesis', '--help'], { stdio: 'pipe' }).toString();
  const gas = help.includes('--bundle-gas-limit') ? ['--gas-price', '100', '--byte-price', '800', '--bundle-gas-limit', '20479'] : [];
  const auth = help.includes('--auth-guest')
    ? ['--bundle-guest', 'v3', '--auth-guest', '--max-proof-bytes', '4194304', '--max-block-bytes', '20971520']
    : [];
  // BIND-1: a chain after 19 binds its genesis hash, and this wallet builds every transaction for
  // one that way — so the test chain must say so, or its node expects the chain-id binding.
  const bind = help.includes('--binding-domain') ? ['--binding-domain', '1'] : [];
  // Extra `rand-node genesis` arguments, to run the same send on a chain with more sections — say
  // chain 21's `--fees F.json --multisig M.json` (fullnode v0.8.0). Space-separated; none by default.
  const extra = (process.env.RAND_E2E_GENESIS_ARGS || '').split(/\s+/).filter(Boolean);
  return [...gas, ...auth, ...bind, ...extra];
}

/** Whether the node cuts a split-authorisation chain (see `chainArgs`). */
export function splitAuthorisation(nodeBin) {
  return chainArgs(nodeBin).includes('--auth-guest');
}

/** Spendable RAND notes of a scan result. */
export const spendableRand = (scan) => (scan.notes || []).filter((n) => !n.spent && !n.pending && Number(n.asset) === 0);
