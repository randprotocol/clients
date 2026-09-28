// The side panel: the shared UI in its sidebar mode — one column, the window's full height —
// on the extension's Backend. Opened from the popup (`platform.openSidebar`) or the browser's
// own side-panel menu.
import { boot } from './lib/boot.js';

boot('sidebar');
