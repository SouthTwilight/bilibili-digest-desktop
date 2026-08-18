import { ipcMain, dialog, shell, BrowserWindow } from "electron";
import { fetchTranscript } from "./core/transcript-service.js";
import { getVideoDetails, getCollectionInfo } from "./core/bilibili.js";
import { analyzeTranscript } from "./core/ai.js";

function pushProgress(payload) {
  BrowserWindow.getAllWindows()[0]?.webContents.send("digest:progress", payload);
}

function onProgress(phase) {
  return (title, subtitle) => pushProgress({ phase, title, subtitle });
}

export function registerIpcHandlers({ settingsStore, digestCache, getBrowserView }) {
  ipcMain.handle("settings:get", () => settingsStore.load());
  ipcMain.handle("settings:set", (_event, input) => settingsStore.save(input || {}));

  ipcMain.handle("settings:pick-save-dir", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "选择导出文件默认保存位置",
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("video:details", (_event, videoId) =>
    getVideoDetails(videoId).catch((error) => ({ success: false, error: error.message })),
  );

  ipcMain.handle("video:collection-info", (_event, videoId) =>
    getCollectionInfo(videoId).catch((error) => ({ inCollection: false, error: error.message })),
  );

  // Transcript for the sidebar: cache-first, then subtitle/ASR. `mode`
  // ("auto" | "asr" | "subtitle") lets the user override the default
  // subtitle-first order; successful overrides replace the cache entry.
  ipcMain.handle("transcript:get", async (_event, { videoId, page, mode }) => {
    const page_ = Math.max(1, Number(page) || 1);
    const cacheKey = `${videoId}@p${page_}`;

    if (mode !== "asr" && mode !== "subtitle") {
      const cached = digestCache.load(cacheKey);
      if (cached?.transcript?.success) {
        return { success: true, fromCache: true, transcript: cached.transcript };
      }
    }
    try {
      const settings = settingsStore.load();
      const transcript = await fetchTranscript({
        settings,
        videoId,
        page: page_,
        mode: mode || "auto",
        onProgress: onProgress("transcript"),
      });
      if (transcript.success) {
        const existing = digestCache.load(cacheKey) || {};
        const details = existing.details?.title
          ? existing.details
          : await getVideoDetails(videoId).catch(() => null);
        digestCache.save(cacheKey, { ...existing, transcript, details });
      }
      return transcript;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("digest:analyze", async (_event, { videoId, page }) => {
    const page_ = Math.max(1, Number(page) || 1);
    const cacheKey = `${videoId}@p${page_}`;
    try {
      const cached = digestCache.load(cacheKey);
      if (cached?.analysis && cached?.transcript?.success) {
        return { success: true, fromCache: true, analysis: cached.analysis };
      }

      const settings = settingsStore.load();
      let transcript = cached?.transcript;
      if (!transcript?.success) {
        const result = await fetchTranscript({
          settings,
          videoId,
          page: page_,
          onProgress: onProgress("transcript"),
        });
        if (!result.success) {
          return { success: false, error: result.error, message: result.message };
        }
        transcript = result;
      }

      pushProgress({ phase: "analysis", title: "正在生成 AI 总结", subtitle: "长视频通常需要一到两分钟" });
      const details = (cached?.details?.title ? cached.details : null) || (await getVideoDetails(videoId));
      const result = await analyzeTranscript({ settings, videoDetails: details, transcript });
      if (result.success) {
        digestCache.save(cacheKey, { transcript, analysis: result.analysis, details });
      }
      return result;
    } catch (error) {
      if (error.status === 401) {
        return { success: false, error: "INVALID_AI_KEY", message: "API key 被拒绝，请检查设置。" };
      }
      if (error.status === 429) {
        return { success: false, error: "RATE_LIMITED", message: "请求被限流，请稍后重试。" };
      }
      return { success: false, error: error.code || error.message, message: error.message };
    }
  });

  // Jump the embedded browser view's video to a timestamp.
  ipcMain.handle("video:seek", (_event, seconds) => {
    const view = getBrowserView();
    if (!view) return { success: false };
    const safe = Math.max(0, Math.floor(Number(seconds) || 0));
    view.webContents
      .executeJavaScript(
        `(() => { const v = document.querySelector('video'); if (v) { v.currentTime = ${safe}; if (v.paused) v.play().catch(() => {}); } })()`,
      )
      .catch(() => {});
    return { success: true };
  });

  ipcMain.handle("shell:reveal", (_event, filePath) => {
    shell.showItemInFolder(filePath);
    return { success: true };
  });

  // ---- browser view navigation (toolbar) --------------------------------

  ipcMain.handle("nav:go", (_event, direction) => {
    const view = getBrowserView();
    if (!view) return { success: false };
    const history = view.webContents.navigationHistory ?? view.webContents;
    if (direction === "back" && history.canGoBack?.()) history.goBack?.() ?? view.webContents.goBack();
    if (direction === "forward" && history.canGoForward?.()) history.goForward?.() ?? view.webContents.goForward();
    return { success: true };
  });

  ipcMain.handle("nav:reload", () => {
    getBrowserView()?.webContents.reload();
    return { success: true };
  });

  ipcMain.handle("nav:home", () => {
    getBrowserView()?.webContents.loadURL("https://www.bilibili.com/").catch(() => {});
    return { success: true };
  });
}
