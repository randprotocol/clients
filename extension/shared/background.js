// Background: the auto-lock alarm clears the in-memory unlock, and a fresh install opens the
// onboarding page. Runs as a service worker in Chrome and as an event page in Firefox; both
// load this file as a classic script, so no imports here.
const ext = globalThis.browser ?? globalThis.chrome;

ext.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'autolock') {
    try { await ext.storage.session.remove('unlocked'); } catch {}
  }
});

ext.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    try {
      const { wallet } = await ext.storage.local.get('wallet');
      if (!wallet) await ext.tabs.create({ url: ext.runtime.getURL('app.html#welcome') });
    } catch {}
  }
});

// A browser restart empties storage.session, so the wallet is locked; nothing else to do.
ext.runtime.onStartup?.addListener(() => {});
