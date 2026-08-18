import { ipcMain, dialog, shell, BrowserWindow } from "electron";
import { fetchTranscript } from "./core/transcript-service.js";
import { getVideoDetails, getCollectionInfo } from "./core/bilibili.js";
import { analyzeTranscript } from "./core/ai.js";
import { translateTranscriptBatch } from "./core/translation.js";
import { explainSelection, cleanupNoteText } from "./core/explain.js";

function pushProgress(payload) {
  BrowserWindow.getAllWindows()[0]?.webContents.send("digest:progress", payload);
}

function onProgress(phase) {
  return (title, subtitle) => pushProgress({ phase, title, subtitle });
}

export function registerIpcHandlers({ settingsStore, digestCache, notesStore, getBrowserView }) {
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

  // Transcript for the sidebar: cache-first, then subtitle/ASR. Each source
  // keeps its own slot in the cache so switching back and forth never
  // re-fetches (and never re-pays for ASR). `mode` ("auto"|"asr"|"subtitle")
  // picks the source; the last loaded one stays the active transcript used
  // for analysis.
  ipcMain.handle("transcript:get", async (_event, { videoId, page, mode }) => {
    const page_ = Math.max(1, Number(page) || 1);
    const cacheKey = `${videoId}@p${page_}`;

    const cached = digestCache.load(cacheKey) || {};
    // Migrate single-transcript entries into per-source slots.
    const slots = cached.transcripts || {};
    if (!slots.subtitle && !slots.asr && cached.transcript?.success) {
      if (cached.transcript.source === "bilibili-subtitle") slots.subtitle = cached.transcript;
      else slots.asr = cached.transcript;
    }
    const translationsBySource = cached.translationsBySource || {};
    const translationsFor = (slot) =>
      slot === "asr" ? translationsBySource.asr || {} : translationsBySource.subtitle || {};

    const persist = (slotKey, transcript) => {
      slots[slotKey] = transcript;
      digestCache.save(cacheKey, {
        ...cached,
        transcript, // active transcript (analysis reads this)
        transcripts: slots,
        translationsBySource,
      });
    };

    const wantAsr = mode === "asr";
    const wantSubtitle = mode === "subtitle";

    // Cache hits for the explicitly requested source.
    if (wantAsr && slots.asr?.success) {
      return { success: true, fromCache: true, transcript: slots.asr, translations: translationsFor("asr") };
    }
    if (wantSubtitle && slots.subtitle?.success) {
      return { success: true, fromCache: true, transcript: slots.subtitle, translations: translationsFor("subtitle") };
    }

    try {
      const settings = settingsStore.load();

      // auto: subtitle slot first. When an ASR slot already exists, probe
      // subtitles only — a failed probe reuses the paid ASR transcript
      // instead of re-running recognition.
      if (!wantAsr) {
        if (slots.subtitle?.success) {
          persist("subtitle", slots.subtitle);
          return { success: true, fromCache: true, transcript: slots.subtitle, translations: translationsFor("subtitle") };
        }
        if (slots.asr?.success) {
          // When a paid ASR transcript already exists, probe subtitles only;
          // a failed probe reuses the ASR transcript instead of re-running
          // recognition.
          const probe = await fetchTranscript({ settings, videoId, page: page_, mode: "subtitle", onProgress: onProgress("transcript") }).catch(() => null);
          if (probe?.success) {
            persist("subtitle", probe);
            return { success: true, transcript: probe, translations: translationsFor("subtitle") };
          }
          persist("asr", slots.asr);
          return { success: true, fromCache: true, transcript: slots.asr, translations: translationsFor("asr") };
        }
      }

      const transcript = await fetchTranscript({
        settings,
        videoId,
        page: page_,
        mode,
        onProgress: onProgress("transcript"),
      });
      if (transcript.success) {
        const slotKey = transcript.source === "bilibili-subtitle" ? "subtitle" : "asr";
        const existingDetails = cached.details?.title
          ? cached.details
          : await getVideoDetails(videoId).catch(() => null);
        slots[slotKey] = transcript;
        digestCache.save(cacheKey, {
          ...cached,
          transcript,
          transcripts: slots,
          translationsBySource,
          details: existingDetails,
        });
        return { success: true, transcript, translations: translationsFor(slotKey) };
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

  // Persist per-segment Chinese translations alongside the digest cache so
  // revisiting a video does not re-pay for translation. Translations are
  // namespaced by transcript source because segment ids (s0, s1, …) only
  // align within one source.
  ipcMain.handle("digest:save-translations", (_event, { videoId, page, translations, source }) => {
    const cacheKey = `${videoId}@p${Math.max(1, Number(page) || 1)}`;
    const existing = digestCache.load(cacheKey) || {};
    const bySource = existing.translationsBySource || {};
    const slot = source === "asr" ? "asr" : "subtitle";
    bySource[slot] = translations || {};
    digestCache.save(cacheKey, { ...existing, translationsBySource: bySource });
    return { success: true };
  });

  // ---- translation / explain / notes ------------------------------------

  ipcMain.handle("transcript:translate", async (_event, { videoTitle, segments }) => {
    const settings = settingsStore.load();
    return translateTranscriptBatch({ settings, videoTitle, segments });
  });

  ipcMain.handle("explain", async (_event, { videoTitle, selectedText, transcriptContext }) => {
    const settings = settingsStore.load();
    return explainSelection({ settings, videoTitle, selectedText, transcriptContext });
  });

  ipcMain.handle("notes:list", (_event, videoId) => notesStore.list(videoId || null));
  ipcMain.handle("notes:add", (_event, note) => notesStore.add(note));
  ipcMain.handle("notes:delete", (_event, id) => notesStore.remove(id));

  // Polish a note's transcript excerpt into a clean sentence (best-effort).
  ipcMain.handle("notes:polish", (_event, payload) => {
    const settings = settingsStore.load();
    return cleanupNoteText({ settings, ...payload });
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
