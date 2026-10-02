// The `platform` group of the extension's Backend: everything the UI is allowed to ask the
// browser for, and nothing else. Each member is here because a screen uses it; every optional
// one is genuinely optional and a screen that does not find it renders no control for it rather
// than a control that does nothing.
//
// Its own file, not part of backend-extension.js, because its logic is testable under plain
// Node (extension/test/backend-extension.test.mjs) while that file's import graph only resolves
// inside the packed extension.
import { ext, IS_FIREFOX } from './browser.js';
import { makePasskey } from './passkey.js';

/**
 * Firefox's data-collection permission the RandProtocol prover needs (the manifest's
 * `data_collection_permissions.optional`): a job sent to it carries this wallet's viewing key to
 * the developer's own service, so Firefox's consent is asked before the first one — never assumed.
 */
export const PROVER_DATA_COLLECTION = Object.freeze({ data_collection: ['financialAndPaymentInfo'] });

/**
 * `t` is ui/i18n.js's, handed down to the passkey's labels (backend-extension.js passes it; this
 * file and lib/passkey.js import nothing from ui/ so extension/test/backend-extension.test.mjs can
 * load them under plain Node, where the labels stay English).
 */
export function makePlatform({ firefox = IS_FIREFOX, t } = {}) {
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
  // Firefox only (Chrome has no data-collection permissions): whether the user let this wallet
  // send its viewing key to the RandProtocol prover, and the request — made from the first-send
  // notice's own click, synchronously (Firefox grants nothing outside the user's gesture), so
  // `permissions.request` is called before this function awaits anything.
  if (firefox) {
    platform.hasDataCollectionConsent = async () => {
      try { return (await ext.permissions.contains({ data_collection: [...PROVER_DATA_COLLECTION.data_collection] })) === true; } catch { return false; }
    };
    platform.requestDataCollectionConsent = () => {
      let asked;
      try { asked = ext.permissions.request({ data_collection: [...PROVER_DATA_COLLECTION.data_collection] }); } catch { return Promise.resolve(false); }
      return Promise.resolve(asked).then((granted) => granted === true, () => false);
    };
  }
  // The side panel: Chrome's `sidePanel` (the manifest's `side_panel`, Chrome 116+) or Firefox's
  // `sidebarAction` (`sidebar_action`). Both open only inside the user's own click, so the call is
  // made synchronously from it — which is why Chrome's window id is looked up now, ahead of any
  // click, rather than awaited inside one. The popup closes itself once the panel has the wallet.
  if (ext.sidePanel && typeof ext.sidePanel.open === 'function') {
    let windowId = null;
    const known = ext.windows && typeof ext.windows.getCurrent === 'function'
      ? ext.windows.getCurrent().then((w) => { windowId = w.id; }).catch(() => {})
      : Promise.resolve();
    platform.openSidebar = async () => {
      if (windowId === null) await known;
      if (windowId === null) throw new Error('no browser window to open the side panel in');
      await ext.sidePanel.open({ windowId });
      window.close();
    };
  } else if (ext.sidebarAction && typeof ext.sidebarAction.open === 'function') {
    platform.openSidebar = async () => {
      await ext.sidebarAction.open();
      window.close();
    };
  }
  // Reading the clipboard needs a permission some contexts will not have: where it is missing the
  // send screen offers no Paste button at all.
  if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
    platform.paste = () => navigator.clipboard.readText();
  }
  // Unlock with a passkey (Touch ID): Chrome only, see lib/passkey.js.
  const passkey = makePasskey(ext, t ? { t } : {});
  if (passkey) platform.passkey = passkey;
  return platform;
}
