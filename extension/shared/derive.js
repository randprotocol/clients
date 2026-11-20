// The approval window for a site's first `deriveKey` of a purpose: "<site> asks Rand Wallet for a
// key of its own". One yes or no, sent to background.js as a `rand:deriveResult`, which stores the
// yes, makes the key and gives it to the asking tab. This window never sees the key: the
// background answers it `{ok: true}` and nothing more.
//
// The request is read from the background by id (`rand:deriveRequest`), as invoke.js reads its
// own: nothing in the URL is trusted beyond the id, so the site shown is the origin the background
// recorded from the message's sender. Closing the window is a no (background.js `windowClosed`).
// Everything shown is built from DOM nodes and textContent: the origin and the purpose are data,
// never markup.
//
// No app.js here, so the language is this page's own job (lib/window-locale.js), as in connect.js:
// the wallet's `settings.locale` is read straight from storage and nothing is rendered before the
// dictionary is in force. Every string shown goes through `t()`.
import { ext } from './lib/browser.js';
import { applyWindowLocale, sentenceWith } from './lib/window-locale.js';
import { markSvg } from './ui/lib/entropy.js';
import { t } from './ui/i18n.js';

const id = new URLSearchParams(location.search).get('id') || '';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

/** The wallet's language setting, from the settings the engine keeps under `settings`; nothing when unset. */
async function localeSetting() {
  try {
    const bag = await ext.storage.local.get('settings');
    const settings = bag && bag.settings;
    return settings && typeof settings === 'object' ? settings.locale : undefined;
  } catch { return undefined; }
}

const root = el('div', 'app');
let answered = false;
async function answer(approved) {
  if (answered) return;
  answered = true;
  try { await ext.runtime.sendMessage({ type: 'rand:deriveResult', id, approved }); } catch { /* closing answers for us */ }
  window.close();
}

function shell(titleText, subText) {
  root.replaceChildren();
  const box = el('div', 'onboard');
  const mark = el('span', 'mark-lg bare');
  // Our own SVG, no user data in it — parsed rather than assigned to innerHTML.
  mark.append(new DOMParser().parseFromString(markSvg(), 'image/svg+xml').documentElement);
  const head = el('div', 'stack tight');
  const title = el('h1', 'title', titleText);
  const sub = el('p', 'subtitle');
  if (subText != null) sub.append(subText);
  head.append(title, sub);
  box.append(mark, head);
  root.append(box);
  return box;
}

function nothing(reason) {
  const box = shell(t('Nothing to approve'), reason);
  const actions = el('div', 'onboard-actions');
  const close = el('button', 'btn block', t('Close'));
  close.type = 'button';
  close.addEventListener('click', () => window.close());
  actions.append(close);
  box.append(actions);
}

function review({ origin, purpose }) {
  let host = origin;
  try { host = new URL(origin).host; } catch { host = origin || t('A site'); }
  const box = shell(t('Give this site a key?'), sentenceWith(t('{host} asks Rand Wallet for a key of its own.'), 'host', el('strong', null, host)));
  const card = el('div', 'card');
  for (const [k, v] of [[t('Site'), origin], [t('Purpose'), purpose]]) {
    const kv = el('div', 'kv');
    kv.append(el('span', 'k', k), el('span', 'v mono', v));
    card.append(kv);
  }
  const what = el('p', 'caption pitch', t('The site can use the key to act for you on that site, for example to sign trades in your trading account there.') + ' '
    + t('Rand Wallet gives this site the same key every time, on any device with this wallet, and gives it to no other site.'));
  const safe = el('p', 'caption pitch', t('The key gives no access to this wallet’s funds, notes or address keys.') + ' '
    + t('You are asked once for each purpose; disconnecting the site forgets your answer.'));
  const actions = el('div', 'onboard-actions');
  const yes = el('button', 'btn btn-primary block', t('Approve'));
  yes.type = 'button';
  const no = el('button', 'btn block', t('Reject'));
  no.type = 'button';
  yes.addEventListener('click', () => { void answer(true); });
  no.addEventListener('click', () => { void answer(false); });
  actions.append(yes, no);
  box.append(card, what, safe, actions);
  yes.focus();
}

(async () => {
  await applyWindowLocale(await localeSetting());
  document.title = t('Approve in Rand Wallet');
  document.body.append(root);
  if (!id) { nothing(t('This window was not opened by a site.')); return; }
  shell(t('Reading the request…'), null);
  let res = null;
  try { res = await ext.runtime.sendMessage({ type: 'rand:deriveRequest', id }); } catch { /* shown as gone */ }
  const r = res && res.ok && res.result;
  if (!r || typeof r.origin !== 'string' || !r.request || typeof r.request.purpose !== 'string') {
    nothing(t('That request is no longer waiting.'));
    return;
  }
  review({ origin: r.origin, purpose: r.request.purpose });
})();
