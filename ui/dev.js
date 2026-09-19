// Developer harness for ui/dev.html. Not shipped in any shell — mounts the real app.js against
// the fake backend so screens can be eyeballed and screenshotted outside a browser extension.
//
// Query params:
//   ?mode=popup             — forces the 360x600 popup layout (default: 'app', responsive)
//   ?theme=dark|light       — forces a theme via backend.settings (default: whatever the OS reports)
//   ?state=new|locked|unlocked — wallet state before mount (default: 'new', i.e. onboarding)
//   #hash                   — an initial route, same as any real navigation
import { mount } from './app.js';
import { fakeBackend, unlockedBackend } from './test/fake-backend.mjs';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') === 'popup' ? 'popup' : 'app';
const theme = params.get('theme');
const state = params.get('state') || 'new';

async function init() {
  let backend;
  if (state === 'unlocked') {
    backend = unlockedBackend();
  } else {
    backend = fakeBackend();
    if (state === 'locked') {
      await backend.wallet.create('dev harness password');
      await backend.wallet.lock();
    }
  }
  if (theme) await backend.settings.set({ theme });

  window.__app = await mount(document.body, backend, { mode });
}

init();
