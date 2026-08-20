// Layout math for the main window, extracted from index.js so the fullscreen
// takeover and sidebar clamping can be unit-tested without Electron. The
// Bilibili WebContentsView is positioned by computeViewBounds(); the window's
// own page (sidebar + toolbar) renders in the remaining space.
export const SIDEBAR_DEFAULT_WIDTH = 480;
export const SIDEBAR_MIN_WIDTH = 400;
export const SIDEBAR_MAX_WIDTH = 820;
export const SIDEBAR_RESIZER_WIDTH = 8;
export const TOOLBAR_HEIGHT = 44;

export function clampSidebarWidth(width) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

// Browser-view bounds inside the window. In HTML fullscreen the view takes
// over the whole window (sidebar + toolbar hide); otherwise it fills the space
// right of the sidebar and below the toolbar, leaving the 8px resizer strip
// uncovered — the view's native layer would otherwise swallow its mouse
// events.
export function computeViewBounds({ fullscreen, windowWidth, windowHeight, sidebarWidth }) {
  if (fullscreen) {
    return { x: 0, y: 0, width: Math.max(0, windowWidth), height: Math.max(0, windowHeight) };
  }
  return {
    x: sidebarWidth + SIDEBAR_RESIZER_WIDTH,
    y: TOOLBAR_HEIGHT,
    width: Math.max(0, windowWidth - sidebarWidth - SIDEBAR_RESIZER_WIDTH),
    height: Math.max(0, windowHeight - TOOLBAR_HEIGHT),
  };
}
