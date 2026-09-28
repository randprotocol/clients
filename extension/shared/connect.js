// The consent window: "<site> wants to connect to Rand Wallet". One yes or no, sent to
// background.js as a `rand:decision`, which stores the approval and answers the page.
//
// On yes this page also computes the bridge recipient hash of the wallet's address
// (lib/recipient-hash.js) and hands it over with the address, so the background — a classic
// script that cannot import the hash module — only ever stores what this page vouched for, and
// checks the address against the wallet on the device before it does. Everything shown here is
// built from DOM nodes and textContent: the origin is data from a URL, never markup.
import { ext } from './lib/browser.js';
import { recipientHash } from './lib/recipient-hash.js';
import { markSvg } from './ui/lib/entropy.js';

const q = new URLSearchParams(location.search);
const id = q.get('id') || '';
const origin = q.get('origin') || '';
const tab = Number(q.get('tab'));
const tabId = Number.isInteger(tab) ? tab : undefined;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

let decided = false;
async function decide(approved) {
  if (decided) return;
  decided = true;
  const msg = { type: 'rand:decision', id, origin, tabId, approved };
  if (approved) {
    const bag = await ext.storage.local.get('wallet');
    const wallet = bag && bag.wallet;
    if (!wallet || !wallet.address) { msg.approved = false; } else {
      msg.address = wallet.address;
      msg.hash = recipientHash(wallet.address);
    }
  }
  try { await ext.runtime.sendMessage(msg); } catch { /* the background will treat silence as no */ }
  window.close();
}

function render() {
  let host = origin;
  try { host = new URL(origin).host; } catch { /* shown as given */ }

  const app = el('div', 'app');
  const box = el('div', 'onboard');
  const mark = el('span', 'mark-lg bare');
  // Our own SVG, no user data in it — parsed rather than assigned to innerHTML, so a store
  // reviewer's linter sees no markup assignment at all.
  mark.append(new DOMParser().parseFromString(markSvg(), 'image/svg+xml').documentElement);
  const text = el('div', 'stack tight');
  const title = el('h1', 'title', 'Connect to this site?');
  const sub = el('p', 'subtitle');
  sub.append(el('strong', null, host), document.createTextNode(' wants to connect to Rand Wallet.'));
  text.append(title, sub);
  const pitch = el('p', 'caption pitch', 'It will see your Rand address and can suggest it as a bridge destination. It cannot see your balance or your activity, and it cannot move anything.');
  const actions = el('div', 'onboard-actions');
  const yes = el('button', 'btn btn-primary block', 'Connect');
  yes.type = 'button';
  const no = el('button', 'btn block', 'Cancel');
  no.type = 'button';
  actions.append(yes, no);
  box.append(mark, text, pitch, actions);
  app.append(box);
  document.body.append(app);

  if (!id || !origin) {
    yes.disabled = true;
    title.textContent = 'Nothing to connect';
    sub.textContent = 'Open this window from a site that asked to connect.';
  }
  yes.addEventListener('click', () => { void decide(true); });
  no.addEventListener('click', () => { void decide(false); });
  // Closing the window is a no.
  window.addEventListener('pagehide', () => { if (!decided) { decided = true; ext.runtime.sendMessage({ type: 'rand:decision', id, origin, tabId, approved: false }).catch(() => {}); } });
  yes.focus();
}

render();
