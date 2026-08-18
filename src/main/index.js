import { app, BrowserWindow, WebContentsView, shell, session } from "electron";
import { join } from "node:path";
import { registerIpcHandlers } from "./ipc.js";
import { createSettingsStore } from "./core/settings-store.js";

// Sidebar hosts the Vue app (the window's own page); the browser view fills
// the remaining space and is the ONLY place Bilibili pages render.
const SIDEBAR_DEFAULT_WIDTH = 380;
const SIDEBAR_MIN_WIDTH = 300;
const SIDEBAR_MAX_WIDTH = 560;

let mainWindow = null;
let browserView = null;
let sidebarWidth = SIDEBAR_DEFAULT_WIDTH;

function isAllowedUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    // Top-level navigation is restricted to Bilibili domains; media CDNs are
    // only ever subresource requests and never navigate.
    return /(^|\.)bilibili\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

function layoutBrowserView() {
  if (!mainWindow || !browserView) return;
  const { width, height } = mainWindow.getContentBounds();
  browserView.setBounds({
    x: sidebarWidth,
    y: 0,
    width: Math.max(0, width - sidebarWidth),
    height,
  });
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
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("ready-to-show", () => mainWindow.show());

  mainWindow.on("resize", layoutBrowserView);

  // The Vue sidebar is the window page itself; it spans the full window and
  // leaves the right `sidebarWidth` px transparent for the browser view.
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  // Persistent, Bilibili-only browsing session. The UA is normalized so the
  // embedded Chromium does not advertise itself as Electron to risk control.
  const bilibiliSession = session.fromPartition("persist:bilibili");
  bilibiliSession.setUserAgent(
    bilibiliSession
      .getUserAgent()
      .replace(/\s*Electron\/\S+/i, "")
      .replace(/\s*bilibili-digest-desktop\/\S+/i, ""),
  );

  browserView = new WebContentsView({ webPreferences: { session: bilibiliSession } });
  mainWindow.contentView.addChildView(browserView);
  layoutBrowserView();

  const contents = browserView.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedUrl(url)) return { action: "allow", overrideBrowserWindowOptions: {} };
    shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (!isAllowedUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  contents.loadURL("https://www.bilibili.com/");

  mainWindow.on("closed", () => {
    mainWindow = null;
    browserView = null;
  });
}

app.whenReady().then(() => {
  const settingsStore = createSettingsStore(join(app.getPath("userData"), "settings.json"), {
    saveDir: join(app.getPath("documents"), "BilibiliDigest"),
  });
  registerIpcHandlers({ settingsStore, getBrowserView: () => browserView });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
