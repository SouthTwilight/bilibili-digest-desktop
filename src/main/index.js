import { app, BrowserWindow, WebContentsView, shell, session, ipcMain } from "electron";
import { join } from "node:path";
import { registerIpcHandlers } from "./ipc.js";
import { createSettingsStore } from "./core/settings-store.js";
import { createDigestCache } from "./core/digest-cache.js";
import { createNotesStore } from "./core/notes.js";
import { createExportQueue } from "./core/export-queue.js";
import { initBilibiliHttp, initPageContextFetch } from "./core/http.js";
import { parseVideoPageUrl } from "./core/bilibili.js";
import { isAllowedUrl } from "./core/url-policy.js";

// Sidebar hosts the Vue app (the window's own page); the browser view fills
// the remaining space and is the ONLY place Bilibili pages render. The Vue
// page also renders a thin navigation toolbar above the browser view area.
// The sidebar is drag-resizable via an 8px handle; the browser view MUST
// leave that strip uncovered or its native layer would swallow the mouse.
const SIDEBAR_DEFAULT_WIDTH = 480;
const SIDEBAR_MIN_WIDTH = 400;
const SIDEBAR_MAX_WIDTH = 820;
const SIDEBAR_RESIZER_WIDTH = 8;
const TOOLBAR_HEIGHT = 44;

let mainWindow = null;
let browserView = null;
let sidebarWidth = SIDEBAR_DEFAULT_WIDTH;
let pushLayout = () => {};

function layoutBrowserView() {
  if (!mainWindow || !browserView) return;
  const { width, height } = mainWindow.getContentBounds();
  const viewWidth = Math.max(0, width - sidebarWidth - SIDEBAR_RESIZER_WIDTH);
  browserView.setBounds({
    x: sidebarWidth + SIDEBAR_RESIZER_WIDTH,
    y: TOOLBAR_HEIGHT,
    width: viewWidth,
    height: Math.max(0, height - TOOLBAR_HEIGHT),
  });
}

// Bilibili pins per-breakpoint layout widths (homepage tier ≥1100px, video
// pages ~1080px). Instead of overriding each pinned width, scale the page:
// the layout viewport becomes viewWidth/zoom, so Bilibili renders its proper
// desktop tier and the whole page fits without horizontal scrolling. Zoom is
// reset whenever a navigation commits, so it must be re-applied after loads.
function applyBrowserZoom() {
  if (!mainWindow || !browserView) return;
  const { width } = mainWindow.getContentBounds();
  const viewWidth = Math.max(0, width - sidebarWidth - SIDEBAR_RESIZER_WIDTH);
  if (viewWidth > 0) {
    const zoom = Math.min(1, Math.max(0.55, viewWidth / 1140));
    try {
      browserView.webContents.setZoomFactor(zoom);
    } catch {
      // Zooming during teardown races are harmless.
    }
  }
}

function resizeSidebar(width) {
  sidebarWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
  layoutBrowserView();
  pushLayout();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: "#f6f7f9",
    title: "Bilibili Digest",
    autoHideMenuBar: true,
    icon: join(__dirname, "../../build/icon-256.png"),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("ready-to-show", () => mainWindow.show());

  mainWindow.on("resize", () => { layoutBrowserView(); applyBrowserZoom(); });

  // The Vue sidebar is the window page itself; it renders in the left column
  // and leaves the remaining width transparent for the browser view.
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
  const pushLayoutLocal = () =>
    mainWindow?.webContents.send("layout:update", { sidebarWidth });
  pushLayout = pushLayoutLocal;
  mainWindow.webContents.on("did-finish-load", pushLayoutLocal);

  // Persistent, Bilibili-only browsing session. The UA is normalized so the
  // embedded Chromium does not advertise itself as Electron to risk control.
  const bilibiliSession = session.fromPartition("persist:bilibili");
  bilibiliSession.setUserAgent(
    bilibiliSession
      .getUserAgent()
      .replace(/\s*Electron\/\S+/i, "")
      .replace(/\s*bilibili-digest-desktop\/\S+/i, ""),
  );

  // The Bilibili view stays pristine: no preload, no injected UI. Note
  // taking happens from the sidebar button only.
  browserView = new WebContentsView({
    webPreferences: { session: bilibiliSession },
  });
  mainWindow.contentView.addChildView(browserView);
  layoutBrowserView();

  const contents = browserView.webContents;
  // Bilibili card links use target="_blank"; opening a native child window
  // would escape the app shell, so deny popups and navigate in place.
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedUrl(url)) {
      contents.loadURL(url).catch(() => {});
      return { action: "deny" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (!isAllowedUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Keep the toolbar buttons and URL display in sync with the view.
  const pushNavState = () => {
    const history = contents.navigationHistory ?? contents;
    mainWindow?.webContents.send("nav:state", {
      url: contents.getURL(),
      canGoBack: history.canGoBack?.() ?? false,
      canGoForward: history.canGoForward?.() ?? false,
    });
  };
  contents.on("did-navigate", pushNavState);
  contents.on("did-navigate-in-page", pushNavState);
  contents.on("did-finish-load", pushNavState);

  // Watch for video-page navigation (SPA URL changes included) and tell the
  // sidebar which video/part is currently shown.
  const notifyVideoChange = () => {
    const parsed = parseVideoPageUrl(contents.getURL());
    mainWindow?.webContents.send(
      "video:changed",
      parsed ? { bvid: parsed.bvid, page: parsed.page } : null,
    );
  };
  contents.on("did-navigate", notifyVideoChange);
  contents.on("did-navigate-in-page", notifyVideoChange);

  // Bilibili's new homepage pins a large min-width on its root/header
  // (banner), which overflows the browser-view column and forces horizontal
  // scrolling. Re-inject a fit override after every navigation.
  const BILI_FIT_CSS =
    "html, body, #i_cecream { min-width: 0 !important; } " +
    // B站 pins the header bar's width per breakpoint (e.g. width:1100px on
    // the smallest tier); stretch it to the real viewport instead.
    ".bili-header, .bili-header__bar { width: 100% !important; min-width: 0 !important; max-width: 100% !important; } " +
    ".bili-header__center, .bili-header__banner, .browser-tip, .bili-feed4, .bili-video-card__wrap { min-width: 0 !important; max-width: 100% !important; } " +
    // The homepage banner ships 1728px-wide raw <img>s; cap them to the
    // viewport instead of letting them force horizontal scrolling.
    ".bili-banner img, .bili-header img, header.bili-header img, .v-img.banner-img { max-width: 100% !important; height: auto !important; }";
  let fitCssKey = null;
  const injectFitCss = async () => {
    try {
      // No removeCSS on this Electron build; re-inserting is idempotent and
      // stale injections die with their document anyway.
      fitCssKey = await contents.insertCSS(BILI_FIT_CSS, { cssOrigin: "author" });
    } catch {
      // Pre-navigation injection races are harmless; the next event retries.
    }
  };
  const afterNavigation = () => {
    applyBrowserZoom();
    injectFitCss();
  };
  contents.on("did-navigate", afterNavigation);
  contents.on("did-navigate-in-page", afterNavigation);
  contents.once("did-finish-load", afterNavigation);

  contents.loadURL("https://www.bilibili.com/");

  mainWindow.on("closed", () => {
    mainWindow = null;
    browserView = null;
  });
}

app.whenReady().then(() => {
  const bilibiliSession = session.fromPartition("persist:bilibili");
  initBilibiliHttp(bilibiliSession);
  // Fallback fetch executed inside the Bilibili page (signed + cookied by
  // the page itself); used when direct main-process calls get throttled.
  initPageContextFetch((url) =>
    browserView?.webContents.executeJavaScript(
      `fetch(${JSON.stringify(url)}, { credentials: "include" }).then((r) => r.json())`,
    ),
  );

  const settingsStore = createSettingsStore(join(app.getPath("userData"), "settings.json"), {
    saveDir: join(app.getPath("documents"), "BilibiliDigest"),
  });
  const digestCache = createDigestCache(join(app.getPath("userData"), "digest-cache"));
  const notesStore = createNotesStore({
    saveDirResolver: () => settingsStore.load().saveDir,
    legacyPath: join(app.getPath("userData"), "notes.json"),
  });
  const exportQueue = createExportQueue({
    settingsStore,
    digestCache,
    onTaskUpdate: (task) =>
      mainWindow?.webContents.send("export:task-update", task),
  });
  // App-level modals (collection export, explanations) live in the window
  // page, which the browser view would otherwise cover — hide the view while
  // a modal is open and restore it after.
  const setBrowserViewVisible = (visible) => {
    if (!mainWindow || !browserView) return;
    if (visible) {
      mainWindow.contentView.addChildView(browserView);
      layoutBrowserView();
    } else {
      mainWindow.contentView.removeChildView(browserView);
    }
  };

  registerIpcHandlers({
    settingsStore,
    digestCache,
    notesStore,
    exportQueue,
    getBrowserView: () => browserView,
    setBrowserViewVisible,
    resizeSidebar,
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
