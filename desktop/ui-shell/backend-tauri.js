// The desktop shell's Backend: `ui/engine/backend-native.js` wired to this app's Tauri commands.
//
// Everything here is plumbing. The wallet is `makeNativeBackend`, which is `makeSharedBackend`
// plus a real `canProve()` and a real send; this file only says where the four things that
// factory takes come from on a desktop — the core, the bytes, the platform, and how much memory
// this computer has. Nothing here is chain crypto and nothing here is a screen.
//
// Note what is NOT here: a `fetch`. `ui/engine/rpc.js` takes one and defaults to the global, and
// the webview's own `fetch()` already matches the shape it wants, so every JSON-RPC call goes
// straight from JavaScript to the node with no native code in the path. See `src-tauri/src/
// commands.rs` — there is deliberately no `http_post` command to pass one through.
import { makeNativeBackend } from './ui/engine/backend-native.js';

// `withGlobalTauri: true` in tauri.conf.json, so this is the API without a bundler or an npm
// dependency — the same "the files are the files" rule the web shell follows.
const { invoke } = window.__TAURI__.core;

/**
 * The core: `wallet-core` compiled for this machine, one command away.
 *
 * `core.call(method, params) -> Promise<value>` is the same contract the wasm shells' Web Worker
 * wrapper provides. The reply is `wallet-core`'s own `{ok, value}` / `{ok, error}` envelope, which
 * is unwrapped here so the engine sees a resolved value or a rejection and never the envelope.
 */
const core = {
  async call(method, params = {}) {
    const raw = await invoke('core_call', { method, params: JSON.stringify(params) });
    const reply = JSON.parse(raw);
    if (!reply || reply.ok !== true) throw new Error((reply && reply.error) || 'the wallet core failed');
    return reply.value;
  },
};

/**
 * The storage contract, over the two halves in `src-tauri/src/storage.rs`: a JSON file for what
 * survives a restart, a `HashMap` in the process for what must not.
 *
 * Values cross the IPC boundary as JSON text, so each side keeps its own types and neither has to
 * know the other's. `compareAndSet` is deliberately absent — it is OPTIONAL in the contract, and
 * the desktop app is one process with one webview: there is no second tab to lose a race to.
 */
const storage = {
  async get(key) {
    const raw = await invoke('storage_get', { key });
    return raw === null || raw === undefined ? undefined : JSON.parse(raw);
  },
  async set(key, value) { await invoke('storage_set', { key, value: JSON.stringify(value) }); },
  async remove(key) { await invoke('storage_remove', { key }); },
  async clear() { await invoke('storage_clear'); },
  session: {
    async get(key) {
      const raw = await invoke('storage_session_get', { key });
      return raw === null || raw === undefined ? undefined : JSON.parse(raw);
    },
    async set(key, value) { await invoke('storage_session_set', { key, value: JSON.stringify(value) }); },
    async remove(key) { await invoke('storage_session_remove', { key }); },
  },
};

/**
 * Everything the UI is allowed to ask this computer for. Each member is here because a screen
 * feature-detects it; nothing optional is faked.
 *
 * `openExternal` is scoped in `src-tauri/capabilities/default.json` to randscan.org and
 * randprotocol.org, so a URL from anywhere else — including one a node put in a reply — cannot
 * open anything. A user who points Settings at a different explorer will find its links do not
 * open; widening that scope is a deliberate decision, not an oversight to be patched at the call
 * site.
 */
async function makePlatform() {
  const platform = {
    name: 'desktop',
    openExternal: (url) => invoke('plugin:opener|open_url', { url: String(url ?? '') }),
    copy: (text) => navigator.clipboard.writeText(String(text ?? '')),
    paste: () => navigator.clipboard.readText(),
  };
  try { platform.version = String(await invoke('app_version')); } catch { /* the Settings line is then simply absent */ }
  return platform;
}

/** How much RAM this machine has, in GiB. The whole of `send.canProve()`'s evidence. */
const systemMemoryGiB = () => invoke('system_memory_gib');

export async function makeBackend() {
  return makeNativeBackend({ core, storage, platform: await makePlatform(), systemMemoryGiB });
}
