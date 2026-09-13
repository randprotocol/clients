// The WebExtension API object: `browser` (Firefox, promise-based) or `chrome` (MV3, also
// promise-based for storage/alarms/tabs/permissions). One name for both.
export const ext = globalThis.browser ?? globalThis.chrome;
export const IS_FIREFOX = typeof globalThis.browser !== 'undefined' && !!globalThis.browser?.runtime?.getBrowserInfo;
