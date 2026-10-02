// The language of a window that does not mount app.js — connect.html and invoke.html build their
// own DOM — chosen the way app.js's `applyLocale` chooses it: the wallet's setting (`settings.locale`,
// `'auto'` or a code), else the device's languages, else English; a dictionary that fails to load
// is reported to the console and the window comes up in English rather than not at all. `<html
// lang dir>` is set from the language in force, and the caller renders only after this resolves.
//
// `../ui/` exists only in the packed tree (extension/README.md), as for lib/boot.js.
import { setLocale, resolveLocale, localeInfo } from '../ui/i18n.js';

/** Puts the language for `setting` in force; returns its code. */
export async function applyWindowLocale(setting) {
  const device = (typeof navigator !== 'undefined' && navigator.languages) || [];
  const code = resolveLocale(setting, device);
  let inForce = code;
  try {
    await setLocale(code);
  } catch (err) {
    console.error(`rand-wallet: the ${code} dictionary could not be loaded`, err);
    inForce = await setLocale('en');
  }
  const info = localeInfo(inForce);
  document.documentElement.lang = info.tag;
  document.documentElement.dir = info.dir;
  return inForce;
}

/**
 * A translated sentence with one `{hole}` rendered as a DOM node — "<strong>host</strong> wants to
 * connect" — as a fragment: `t()` leaves a hole it is given no value for, so the sentence is
 * translated with the hole in place and split around it here. A translation that dropped the hole
 * shows the sentence alone.
 */
export function sentenceWith(text, hole, node) {
  const frag = document.createDocumentFragment();
  const s = String(text);
  const i = s.indexOf(`{${hole}}`);
  if (i === -1) { frag.append(s); return frag; }
  frag.append(s.slice(0, i), node, s.slice(i + hole.length + 2));
  return frag;
}
