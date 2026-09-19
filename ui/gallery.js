// Developer-page script for ui/gallery.html. Not shipped in any shell.
// Two jobs: the theme / layout toggles (also settable with ?theme=&layout= so a headless browser
// can capture a specific state), and the couple of live demos — the proving ring's percentage and
// the sheet / toast overlays.
//
// No inline script anywhere: every shell runs under `script-src 'self'`.

const params = new URLSearchParams(location.search);
const root = document.documentElement;

const stored = (key, fallback) => {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
};
const remember = (key, value) => {
  try { localStorage.setItem(key, value); } catch { /* private mode: fine */ }
};

function applyTheme(theme) {
  root.dataset.theme = theme;
  remember('gallery-theme', theme);
}

function applyLayout(layout) {
  document.body.classList.toggle('compact', layout === 'compact');
  document.body.classList.toggle('wide', layout === 'wide');
  remember('gallery-layout', layout);
}

const theme = params.get('theme') || stored('gallery-theme', 'system');
const layout = params.get('layout') || stored('gallery-layout', 'compact');
applyTheme(theme);
applyLayout(layout);

document.addEventListener('DOMContentLoaded', () => {
  const themeSelect = document.getElementById('theme-select');
  const layoutSelect = document.getElementById('layout-select');
  themeSelect.value = theme;
  layoutSelect.value = layout;
  themeSelect.addEventListener('change', (e) => applyTheme(e.target.value));
  layoutSelect.addEventListener('change', (e) => applyLayout(e.target.value));

  // Progress rings: read the percentage from data-pct and write it as a custom property through
  // the CSSOM, which CSP allows (an inline style attribute would not be).
  for (const ring of document.querySelectorAll('.ring[data-pct]')) {
    const pct = Number(ring.dataset.pct);
    ring.style.setProperty('--pct', String(pct));
    ring.setAttribute('aria-valuenow', String(Math.round(pct * 100)));
    const label = ring.querySelector('.ring-pct');
    if (label) label.textContent = `${Math.round(pct * 100)}%`;
  }

  // Registry-asset avatars: the hue is a property of the asset, not of the theme, so it is written
  // through the CSSOM exactly as a screen would do it from the asset id.
  for (const avatar of document.querySelectorAll('.avatar[data-hue]')) {
    avatar.style.setProperty('--hue', avatar.dataset.hue);
  }

  // Sync progress bar: same CSSOM convention as the ring above, --pct written from data-pct.
  for (const bar of document.querySelectorAll('.progress[data-pct]')) {
    bar.style.setProperty('--pct', bar.dataset.pct);
  }

  // Live overlay demo, so the slide-up and the scrim fade can be seen for real.
  const overlay = document.getElementById('live-sheet');
  const scrim = document.getElementById('live-scrim');
  const open = () => { overlay.hidden = false; scrim.hidden = false; };
  const close = () => { overlay.hidden = true; scrim.hidden = true; };
  document.getElementById('open-sheet').addEventListener('click', open);
  document.getElementById('close-sheet').addEventListener('click', close);
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  if (params.get('overlay') === 'sheet') open();

  // Live toast demo.
  const area = document.getElementById('live-toasts');
  document.getElementById('show-toast').addEventListener('click', () => {
    const toast = document.createElement('div');
    toast.className = 'toast positive';
    toast.setAttribute('role', 'status');
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.textContent = '✓';
    const text = document.createElement('span');
    text.textContent = 'Address copied';
    toast.append(ic, text);
    area.appendChild(toast);
    setTimeout(() => toast.remove(), 2600);
  });
});
