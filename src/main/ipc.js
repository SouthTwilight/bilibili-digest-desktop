import { ipcMain, dialog, shell, BrowserWindow } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { fetchTranscript } from "./core/transcript-service.js";
import { getVideoDetails, getCollectionInfo, collectionVideosFromView, fetchBilibiliView } from "./core/bilibili.js";
import { analyzeTranscript, requestAiCompletion, loadPromptSection } from "./core/ai.js";
import { splitDocIntoChunks } from "./core/summarize-doc.js";
import { translateTranscriptBatch } from "./core/translation.js";
import { explainSelection, cleanupNoteText } from "./core/explain.js";
import { scanLibrary, readLibraryFile } from "./core/library.js";
import { exportFileName } from "./core/export-render.js";

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
  ipcMain.handle("transcript:get", async (_event, { videoId, page, mode, track }) => {
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
    // Persist the user's track choice (native CC vs AI) so the digest
    // analysis and other consumers follow what the sidebar displays.
    const trackOverride = track === "cc" ? "cc" : track === "ai" ? "ai" : cached.trackOverride || null;

    const persistAsr = (transcript) => {
      digestCache.save(cacheKey, {
        ...cached,
        transcripts: { ...(cached.transcripts || {}), asr: transcript },
        translationsBySource: cached.translationsBySource || {},
        sourceOverride,
        trackOverride,
      });
    };
    const persistOverride = () => {
      digestCache.save(cacheKey, { ...cached, sourceOverride, trackOverride });
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
        track: trackOverride || "ai",
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
      // the user's standing choice is ASR, otherwise fetch a fresh subtitle
      // with the user's preferred track (native CC vs AI).
      let transcript = cached.sourceOverride === "asr" ? cached.transcripts?.asr : null;
      if (!transcript?.success) {
        const result = await fetchTranscript({
          settings,
          videoId,
          page: page_,
          mode: cached.sourceOverride === "asr" ? "asr" : "subtitle",
          track: cached.trackOverride === "cc" ? "cc" : "ai",
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

  // Capture the currently playing video frame as a JPEG base64. Canvas first
  // (clean frame, no player UI); falls back to capturing the video element's
  // page rect when the canvas is tainted.
  ipcMain.handle("video:capture-frame", async () => {
    const view = getBrowserView();
    if (!view) return { success: false };
    const wc = view.webContents;
    try {
      const canvasData = await wc.executeJavaScript(`(() => {
        const v = document.querySelector('video');
        if (!v || !v.videoWidth) return null;
        const c = document.createElement('canvas');
        c.width = v.videoWidth; c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0);
        try { return c.toDataURL('image/jpeg', 0.85); } catch { return null; }
      })()`);
      if (canvasData) return { success: true, imageBase64: canvasData.split(",")[1] };
      const rect = await wc.executeJavaScript(`(() => {
        const v = document.querySelector('video');
        if (!v) return null;
        const r = v.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`);
      if (!rect) return { success: false };
      const image = await wc.capturePage(rect);
      return { success: true, imageBase64: image.toDataURL().split(",")[1] };
    } catch {
      return { success: false };
    }
  });

  // Compile a video's notes (with picture links) into a markdown document
  // inside the video folder.
  ipcMain.handle("notes:export", (_event, video) => {
    try {
      const notes = notesStore.listFor(video || {});
      if (!notes.length) return { success: false, error: "当前视频还没有笔记。" };
      const dir = notesStore.videoDir(video || {});
      const lines = [`# ${(video?.videoTitle || "视频") + " 学习笔记"}`, ""];
      for (const note of notes.slice().sort((a, b) => a.timestamp - b.timestamp)) {
        const mm = String(Math.floor(note.timestamp / 60)).padStart(2, "0");
        const ss = String(note.timestamp % 60).padStart(2, "0");
        const url = `https://www.bilibili.com/video/${note.bvid}/?t=${note.timestamp}s`;
        lines.push(`- [${mm}:${ss}](${url}) ${note.text}`);
        if (note.picture) lines.push(`  ![](${note.picture})`);
      }
      lines.push("", "---", "由 Bilibili Digest 桌面版整理");
      const file = join(dir, `笔记_${exportFileName(video?.videoTitle || "")}.md`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, lines.join("\n"), "utf8");
      return { success: true, file };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

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
  ipcMain.handle("export:single", async (_event, { bvid, page, format, sourceMode, track, allPages }) => {
    const info = await getCollectionInfo(bvid).catch(() => null);
    return exportQueue.enqueue({
      type: "single",
      collectionTitle: info?.inCollection ? info.collectionTitle : "",
      format: format === "html" ? "html" : "md",
      items: [{ bvid, page: page || 1, sourceMode: sourceMode || "subtitle", track, allPages: !!allPages }],
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

  // Multi-P videos inside a collection used to export ONLY P1 — pages beyond
  // the first were silently dropped. Before enqueueing, probe each selected
  // video: multi-P items are marked allPages so the queue exports one merged
  // whole-video document instead. A failed probe degrades to the old
  // single-part behavior rather than blocking the export.
  ipcMain.handle("export:collection-confirm", async (_event, { collectionTitle, format, items }) => {
    const expanded = await Promise.all(
      (Array.isArray(items) ? items : []).map(async (item) => {
        const view = await fetchBilibiliView(item.bvid).catch(() => null);
        return view?.pages?.length > 1 ? { ...item, allPages: true } : { ...item };
      }),
    );
    return exportQueue.enqueue({
      type: "collection",
      collectionTitle: collectionTitle || "",
      format: format === "html" ? "html" : "md",
      items: expanded,
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

  // Open a library file with the OS default application (Typora for .md etc).
  ipcMain.handle("library:open", async (_event, { filePath }) => {
    const result = await shell.openPath(filePath);
    return result ? { success: false, error: result } : { success: true };
  });

  // Summarize a library markdown document with the configured text model and
  // store the result next to it as AI总结_视频名.md.
  ipcMain.handle("library:summarize", async (_event, { filePath }) => {
    const base = settingsStore.load().saveDir;
    if (!String(filePath || "").startsWith(String(base || "\u0000"))) {
      return { success: false, error: "文件不在当前保存目录内。" };
    }
    try {
      const content = readFileSync(filePath, "utf8");
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const videoName = (titleMatch?.[1] || basename(filePath, extname(filePath)))
        .replace(/[_-]\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$/, "")
        .slice(0, 60);
      const settings = settingsStore.load();
      // Whole-video multi-P exports can exceed the model's context window.
      // Split at section boundaries, summarize each chunk with the same
      // four-layer prompt, then synthesize — no silent truncation.
      const chunks = splitDocIntoChunks(content, 100_000);
      let text;
      if (chunks.length <= 1) {
        pushProgress({ phase: "summary", title: "正在生成 AI 总结", subtitle: "长文档需要一两分钟" });
        const systemPrompt = loadPromptSection("summary.md", "System prompt", {
          title: videoName,
          content,
        });
        text = await requestAiCompletion({
          settings,
          maxTokens: 8192,
          messages: [{ role: "user", content: systemPrompt }],
        });
      } else {
        const partSummaries = [];
        for (let i = 0; i < chunks.length; i += 1) {
          pushProgress({
            phase: "summary",
            title: "正在生成 AI 总结",
            subtitle: `长文档已分 ${chunks.length} 块，正在总结第 ${i + 1}/${chunks.length} 块`,
          });
          const systemPrompt = loadPromptSection("summary.md", "System prompt", {
            title: `${videoName}（第 ${i + 1}/${chunks.length} 块）`,
            content: chunks[i],
          });
          partSummaries.push(
            await requestAiCompletion({
              settings,
              maxTokens: 8192,
              messages: [{ role: "user", content: systemPrompt }],
            }),
          );
        }
        pushProgress({ phase: "summary", title: "正在汇总各块总结", subtitle: "最后一步" });
        text = await requestAiCompletion({
          settings,
          maxTokens: 8192,
          messages: [
            {
              role: "user",
              content:
                `以下是一份长文档（约 ${content.length} 字符）按顺序分块总结的结果。请把它们综合成一份完整的总结文档，` +
                "遵循与分块总结相同的结构（快速概览 / 结构化深度总结 / 总结与行动项）：合并各块中重复的主题，" +
                "按内容自然脉络重新组织分节，保留所有时间戳链接和关键原话，不要遗漏任何一块的要点。\n\n" +
                partSummaries.map((s, i) => `--- 第 ${i + 1} 块总结 ---\n${s}`).join("\n\n"),
            },
          ],
        });
      }
      const outFile = join(dirname(filePath), `AI总结_${videoName}.md`);
      writeFileSync(outFile, text.trim() + "\n", "utf8");
      return { success: true, file: outFile };
    } catch (error) {
      if (error.code === "NO_AI_KEY") {
        return { success: false, error: "未配置文本模型 API Key，请先到设置页填写。" };
      }
      return { success: false, error: error.message };
    }
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
