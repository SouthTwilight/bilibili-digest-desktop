import { ipcMain, dialog, shell, BrowserWindow } from "electron";
import { fetchTranscript } from "./core/transcript-service.js";
import { getVideoDetails, getCollectionInfo, collectionVideosFromView, fetchBilibiliView } from "./core/bilibili.js";
import { analyzeTranscript } from "./core/ai.js";
import { translateTranscriptBatch } from "./core/translation.js";
import { explainSelection, cleanupNoteText } from "./core/explain.js";
import { scanLibrary, readLibraryFile } from "./core/library.js";

function pushProgress(payload) {
  BrowserWindow.getAllWindows()[0]?.webContents.send("digest:progress", payload);
}

function onProgress(phase) {
  return (title, subtitle) => pushProgress({ phase, title, subtitle });
}

export function registerIpcHandlers({ settingsStore, digestCache, notesStore, exportQueue, getBrowserView, setBrowserViewVisible, resizeSidebar }) {
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

  // Transcript for the sidebar. Caching policy:
  //   - Bilibili subtitles are NEVER cached — they are cheap API calls, and
  //     B站 serves slightly different (regenerating) AI subtitle content over
  //     time, so caching them only risks stale or cross-wired data. Every
  //     open fetches fresh, which also means bad data never persists.
  //   - ASR transcripts ARE cached (transcripts.asr slot) — recognition is
  //     slow and billed, so it must survive reopens. A user's explicit ASR
  //     choice is stored as `sourceOverride` and survives auto-reloads.
  ipcMain.handle("transcript:get", async (_event, { videoId, page, mode }) => {
    const page_ = Math.max(1, Number(page) || 1);
    const cacheKey = `${videoId}@p${page_}`;
    const cached = digestCache.load(cacheKey) || {};
    const asrSlot = cached.transcripts?.asr?.success ? cached.transcripts.asr : null;
    const asrTranslations = cached.translationsBySource?.asr || {};
    let sourceOverride = cached.sourceOverride || null;

    const wantAsr = mode === "asr";
    const wantSubtitle = mode === "subtitle";
    if (wantAsr) sourceOverride = "asr";
    if (wantSubtitle) sourceOverride = "subtitle";

    // Explicit user-triggered CDP fallback: bypass subtitle cache and normal
    // auto logic, and run only the CDP capture path.
    if (mode === "subtitle-cdp") {
      try {
        const settings = settingsStore.load();
        return await fetchTranscript({
          settings,
          videoId,
          page: page_,
          mode: "subtitle-cdp",
          onProgress: onProgress("transcript"),
        });
      } catch (error) {
        return { success: false, error: error.message };
      }
    }

    const persistAsr = (transcript) => {
      digestCache.save(cacheKey, {
        ...cached,
        transcripts: { ...(cached.transcripts || {}), asr: transcript },
        translationsBySource: cached.translationsBySource || {},
        sourceOverride,
      });
    };
    const persistOverride = () => {
      digestCache.save(cacheKey, { ...cached, sourceOverride });
    };

    // ASR results are always served from the paid cache when present.
    if (wantAsr && asrSlot) {
      persistOverride();
      return { success: true, fromCache: true, transcript: asrSlot, translations: asrTranslations };
    }

    try {
      const settings = settingsStore.load();

      // auto/subtitle: fresh subtitle fetch, unless the user's standing
      // choice is ASR and a paid transcript exists.
      if (!wantAsr && sourceOverride === "asr" && asrSlot) {
        persistOverride();
        return { success: true, fromCache: true, transcript: asrSlot, translations: asrTranslations };
      }

      const transcript = await fetchTranscript({
        settings,
        videoId,
        page: page_,
        mode: wantAsr ? "asr" : "subtitle",
        onProgress: onProgress("transcript"),
      });
      if (transcript.success) {
        if (wantAsr || transcript.source !== "bilibili-subtitle") {
          persistAsr(transcript);
        } else {
          persistOverride();
        }
        return {
          success: true,
          transcript,
          // Subtitle content is not cached, so neither are its translations
          // (segment ids would not stay aligned across regenerations).
          translations: wantAsr ? asrTranslations : {},
        };
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
      const cached = digestCache.load(cacheKey) || {};
      // Analyses are stable summaries — cache them independent of the
      // (no longer cached) subtitle transcript.
      if (cached.analysis) {
        return { success: true, fromCache: true, analysis: cached.analysis };
      }

      const settings = settingsStore.load();
      // Subtitle transcripts are not cached: analyze the paid ASR slot when
      // the user's standing choice is ASR, otherwise fetch a fresh subtitle.
      let transcript = cached.sourceOverride === "asr" ? cached.transcripts?.asr : null;
      if (!transcript?.success) {
        const result = await fetchTranscript({
          settings,
          videoId,
          page: page_,
          mode: cached.sourceOverride === "asr" ? "asr" : "subtitle",
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
        digestCache.save(cacheKey, {
          ...(transcript.source === "bilibili-subtitle"
            ? cached
            : { ...cached, transcripts: { ...(cached.transcripts || {}), asr: transcript } }),
          analysis: result.analysis,
          details,
        });
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

  // Read the browser view player's current time (for manual note-taking).
  ipcMain.handle("video:current-time", async () => {
    const view = getBrowserView();
    if (!view) return { success: false, seconds: null };
    try {
      const seconds = await view.webContents.executeJavaScript(
        `(() => { const v = document.querySelector('video'); return v ? Math.max(0, Math.floor(v.currentTime)) : null; })()`,
      );
      return { success: seconds != null, seconds };
    } catch {
      return { success: false, seconds: null };
    }
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

  ipcMain.handle("notes:list", (_event, scope) =>
    scope === "all" ? notesStore.listAll() : [],
  );
  ipcMain.handle("notes:list-for", (_event, video) => notesStore.listFor(video || {}));
  ipcMain.handle("notes:add", (_event, note) => notesStore.add(note || {}));
  ipcMain.handle("notes:delete", (_event, id) => notesStore.remove(id));

  // Polish a note's transcript excerpt into a clean sentence (best-effort).
  ipcMain.handle("notes:polish", (_event, payload) => {
    const settings = settingsStore.load();
    return cleanupNoteText({ settings, ...payload });
  });

  // ---- export queue / library ---------------------------------------------

  // Single-video export keeps collection context: a video that belongs to a
  // collection ALWAYS lands in {saveDir}/{合集名}/{视频名_BV号}/ — the same
  // layout the collection export writes — so the library never shows the
  // same video in two places depending on which button exported it.
  ipcMain.handle("export:single", async (_event, { bvid, page, format, sourceMode }) => {
    const info = await getCollectionInfo(bvid).catch(() => null);
    return exportQueue.enqueue({
      type: "single",
      collectionTitle: info?.inCollection ? info.collectionTitle : "",
      format: format === "html" ? "html" : "md",
      items: [{ bvid, page: page || 1, sourceMode: sourceMode || "subtitle" }],
    });
  });

  // Collection export preview: only fetch the collection video list. Per-video
  // subtitle availability is deliberately NOT probed here — the user picks the
  // source explicitly (Bilibili subtitle or ASR) and failures are retried with
  // ASR from the task record.
  ipcMain.handle("export:collection-preview", async (_event, videoId) => {
    try {
      const collection = collectionVideosFromView(await fetchBilibiliView(videoId));
      if (!collection) return { success: false, error: "当前视频不在合集中。" };
      return {
        success: true,
        collectionTitle: collection.collectionTitle,
        videos: collection.videos.map((video) => ({ ...video, page: 1 })),
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("export:collection-confirm", (_event, { collectionTitle, format, items }) => {
    return exportQueue.enqueue({
      type: "collection",
      collectionTitle: collectionTitle || "",
      format: format === "html" ? "html" : "md",
      items,
    });
  });

  // Retry failed items with ASR inside the original task.
  ipcMain.handle("export:retry-asr", (_event, { taskId, itemIndexes }) =>
    exportQueue.retryAsr(taskId, itemIndexes),
  );

  ipcMain.handle("export:tasks", () => exportQueue.list());
  ipcMain.handle("export:cancel", (_event, id) => exportQueue.cancel(id));

  ipcMain.handle("library:list", () => scanLibrary(settingsStore.load().saveDir));
  ipcMain.handle("library:read", (_event, filePath) =>
    readLibraryFile(settingsStore.load().saveDir, filePath),
  );
  ipcMain.handle("library:reveal", (_event, filePath) => {
    shell.showItemInFolder(filePath);
    return { success: true };
  });

  // Hide/show the embedded browser view while an app-level modal is open.
  ipcMain.handle("view:set-visible", (_event, visible) => {
    setBrowserViewVisible?.(!!visible);
    return { success: true };
  });

  // Sidebar drag-resize: the renderer streams the desired width.
  ipcMain.handle("layout:resize-sidebar", (_event, width) => {
    resizeSidebar?.(Number(width) || 480);
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
