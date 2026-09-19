// Inline 24 px stroke icons for app.js and the screens, in the same visual language as the
// symbols in ui/gallery.html's sprite (stroke currentColor, width 2, round caps/joins). Each
// export returns a trusted SVG string — wrap it with raw() from ./dom.js wherever it is
// interpolated into an h`` template; never pass it through h`` unwrapped.
//
// Importable under plain Node: this module never touches `document`/`window`.

function svg(inner, { strokeWidth = 2 } = {}) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
}

export const icons = {
  home: () => svg('<path d="m4 11 8-7 8 7"/><path d="M6 10v9h12v-9"/>'),
  activity: () => svg('<circle cx="12" cy="12" r="8"/><path d="M12 8v4.5l3 1.8"/>'),
  compass: () => svg('<circle cx="12" cy="12" r="8"/><path d="m15 9-2 4-4 2 2-4z"/>'),
  settings: () => svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6l1.4 1.4m10 10 1.4 1.4m0-12.8-1.4 1.4m-10 10-1.4 1.4"/>'),
  arrowUpRight: () => svg('<path d="M7 17 17 7"/><path d="M9 7h8v8"/>'),
  arrowDownLeft: () => svg('<path d="M17 7 7 17"/><path d="M15 17H7V9"/>'),
  droplet: () => svg('<path d="M12 3.5s5.5 5.9 5.5 9.7a5.5 5.5 0 0 1-11 0C6.5 9.4 12 3.5 12 3.5z"/><path d="M9.6 13.6a2.6 2.6 0 0 0 2.4 2.6"/>'),
  bridge: () => svg('<path d="M3 18h18"/><path d="M4 18c0-4.4 3.6-8 8-8s8 3.6 8 8"/><path d="M12 18v-8"/><path d="M7.6 18v-4.7"/><path d="M16.4 18v-4.7"/>'),
  copy: () => svg('<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15"/>'),
  lock: () => svg('<rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>'),
  eye: () => svg('<path d="M2.6 12S6.4 5.8 12 5.8 21.4 12 21.4 12 17.6 18.2 12 18.2 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  // Two curved arrows chasing each other — "sync now", distinct from `activity`'s clock face.
  refresh: () => svg('<path d="M21.9 4.8v5.4h-5.4"/><path d="M2.1 19.2v-5.4h5.4"/><path d="M4.36 9.3a8.1 8.1 0 0 1 13.37-3.02l4.17 3.92"/><path d="m2.1 13.8 4.18 3.92a8.1 8.1 0 0 0 13.36-3.02"/>'),
  check: () => svg('<path d="m5 12.5 4.5 4.5L19 7"/>', { strokeWidth: 2.4 }),
  chevron: () => svg('<path d="m9 5 7 7-7 7"/>'),
  warning: () => svg('<path d="M12 4 2.8 20h18.4z"/><path d="M12 10v4"/><path d="M12 17.2h.01"/>'),
  shield: () => svg('<path d="M12 3.3 5 6v5.4c0 4.6 3 7.8 7 9.3 4-1.5 7-4.7 7-9.3V6z"/><path d="m9 12 2.2 2.2L15.5 9.5"/>'),
};
