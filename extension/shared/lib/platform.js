// The `platform` group of the extension's Backend: everything the UI is allowed to ask the
// browser for, and nothing else. Each member is here because a screen uses it; every optional
// one is genuinely optional and a screen that does not find it renders no control for it rather
// than a control that does nothing.
//
// Its own file, not part of backend-extension.js, because its logic is testable under plain
// Node (extension/test/backend-extension.test.mjs) while that file's import graph only resolves
// inside the packed extension.
import { ext, IS_FIREFOX } from './browser.js';

export function makePlatform() {
  const platform = {
    name: IS_FIREFOX ? 'firefox' : 'chrome',
    // A new tab, never this popup's window: an explorer must get no handle on the wallet.
    openExternal: (url) => { ext.tabs.create({ url: String(url) }); },
    copy: (text) => navigator.clipboard.writeText(String(text ?? '')),

    /**
     * OPTIONAL in the contract, and the reason it exists: an extension may only reach a host it
     * has permission for, and Firefox grants one only while it is still handling the user's own
     * click. The settings screen calls this inside its submit handler, before saving a new RPC
     * URL, and abandons the save when it answers false.
     *
     * A pattern that is not requestable (a host the build granted outright, like the default
     * nodes) makes `permissions.request` throw rather than answer — as does an origin nothing
     * covers, like a plain-http LAN node. The two are told apart by reality, not assumed: only
     * an origin the extension can actually reach is a "yes".
     */
    ensureHostPermission: async (url) => {
      let origin;
      try { origin = `${new URL(String(url)).origin}/*`; } catch { return false; }
      try { return await ext.permissions.request({ origins: [origin] }); } catch {
        try { return await ext.permissions.contains({ origins: [origin] }); } catch { return false; }
      }
    },
  };
  // Reading the clipboard needs a permission some contexts will not have: where it is missing the
  // send screen offers no Paste button at all.
  if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
    platform.paste = () => navigator.clipboard.readText();
  }
  return platform;
}
