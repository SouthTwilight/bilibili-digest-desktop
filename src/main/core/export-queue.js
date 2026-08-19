import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { fetchTranscript } from "./transcript-service.js";
import { getVideoDetails } from "./bilibili.js";
import { buildMarkdownExport, buildHtmlExport, exportFileName } from "./export-render.js";
import { videoFolderName } from "./notes.js";

function sanitizeDirName(name) {
  return String(name || "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[＼／：＊？＂＜＞｜]/g, "")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 60);
}

// Export task queue. Two lanes with different concurrency:
//   subtitle lane — videos with Bilibili subtitle tracks, concurrency from
//     settings.exportConcurrency (free API calls, safe to parallelize);
//   asr lane — videos the user opted into ASR, strictly serial (Doubao has a
//     concurrency quota; Bailian bills per task).
// Tasks survive browsing: the queue lives in the main process and keeps
// running no matter what page the browser view shows.
export function createExportQueue({ settingsStore, digestCache, onTaskUpdate }) {
  const tasks = new Map();
  const subtitleLane = [];
  const asrLane = [];
  let subtitleRunning = 0;

  function notify(task) {
    onTaskUpdate?.(serializeTask(task));
  }

  function serializeTask(task) {
    return {
      id: task.id,
      type: task.type,
      collectionTitle: task.collectionTitle,
      status: task.status,
      done: task.items.filter((item) => item.itemStatus === "done" || item.itemStatus === "failed").length,
      total: task.items.length,
      results: task.items.map((item) => ({
        title: item.title,
        bvid: item.bvid,
        page: item.page || 1,
        status: item.itemStatus,
        file: item.file || null,
        error: item.error || null,
      })),
      createdAt: task.createdAt,
    };
  }

  function targetFile(task, item, format) {
    const base = settingsStore.load().saveDir || ".";
    const videoDir = videoFolderName(item.videoTitle || item.title, item.bvid);
    const folder = task.collectionTitle
      ? join(base, sanitizeDirName(task.collectionTitle) || "合集", videoDir)
      : join(base, videoDir);
    return join(folder, `${exportFileName(item.videoTitle || item.title)}.${format}`);
  }

  async function runItem(task, item) {
    item.itemStatus = "running";
    notify(task);
    try {
      // Source resolution: ASR exports reuse the paid cache slot; subtitle
      // exports always fetch fresh (subtitles are cheap, uncached API calls
      // whose content regenerates server-side).
      const cacheKey = `${item.bvid}@p${item.page || 1}`;
      const cached = digestCache.load(cacheKey);
      const asrSlot = cached?.transcripts?.asr?.success ? cached.transcripts.asr : null;
      let transcript = null;
      const wantsAsr = item.useAsr || item.sourceMode === "asr" ||
        (!item.useAsr && item.sourceMode !== "subtitle" && cached?.sourceOverride === "asr");
      if (wantsAsr && asrSlot) {
        transcript = asrSlot;
      }
      if (!transcript) {
        const settings = settingsStore.load();
        transcript = await fetchTranscript({
          settings,
          videoId: item.bvid,
          page: item.page || 1,
          mode: wantsAsr ? "asr" : "subtitle",
          // Follow the user's per-video track choice (native CC vs AI);
          // fall back to "ai" when no preference was ever set.
          track: item.track || cached?.trackOverride || "ai",
        });
      }
      if (!transcript.success) {
        throw new Error(transcript.message || "获取字幕失败");
      }
      const details = await getVideoDetails(item.bvid).catch(() => ({}));
      const video = {
        title: details.title || item.videoTitle || item.title,
        channelName: details.channelName || "",
        url: `https://www.bilibili.com/video/${item.bvid}/`,
        description: details.description || "",
        language: transcript.language,
        transcript: transcript.transcript,
        analysis: cached?.analysis || null,
      };
      const format = item.format || task.format || "md";
      const content =
        format === "html" ? buildHtmlExport(video) : buildMarkdownExport(video);
      const file = targetFile(task, { ...item, videoTitle: video.title }, format);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, content, "utf8");
      item.itemStatus = "done";
      item.file = file;
    } catch (error) {
      item.itemStatus = "failed";
      item.error = error.message || String(error);
    }
    notify(task);
  }

  function maybeFinish(task) {
    if (task.items.every((item) => item.itemStatus !== "pending" && item.itemStatus !== "running")) {
      task.status = "done";
      notify(task);
    }
  }

  function pumpSubtitleLane() {
    while (subtitleRunning < Math.max(1, settingsStore.load().exportConcurrency || 4)) {
      const next = subtitleLane.shift();
      if (!next) return;
      const { task, item } = next;
      if (task.status === "canceled") continue;
      subtitleRunning += 1;
      runItem(task, item)
        .catch(() => {})
        .finally(() => {
          subtitleRunning -= 1;
          maybeFinish(task);
          pumpSubtitleLane();
        });
    }
  }

  let asrBusy = false;
  function pumpAsrLane() {
    if (asrBusy) return;
    const next = asrLane.shift();
    if (!next) return;
    asrBusy = true;
    const { task, item } = next;
    const run = task.status === "canceled" ? Promise.resolve() : runItem(task, item);
    run
      .catch(() => {})
      .finally(() => {
        asrBusy = false;
        maybeFinish(task);
        pumpAsrLane();
      });
  }

  function enqueueItems(task) {
    for (const item of task.items) {
      item.itemStatus = "pending";
      const payload = { task, item };
      if (item.useAsr) asrLane.push(payload);
      else subtitleLane.push(payload);
    }
    pumpSubtitleLane();
    pumpAsrLane();
  }

  return {
    enqueue({ type, collectionTitle = "", format = "md", items }) {
      const task = {
        id: randomUUID(),
        type,
        collectionTitle,
        format,
        status: "running",
        items: items.map((item) => ({ ...item, format: item.format || format })),
        createdAt: Date.now(),
      };
      tasks.set(task.id, task);
      notify(task);
      enqueueItems(task);
      return serializeTask(task);
    },

    list() {
      return Array.from(tasks.values())
        .map(serializeTask)
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    // Re-enqueue failed items with ASR inside the SAME task, so the original
    // task record is kept and the retried work shows up in place.
    retryAsr(taskId, itemIndexes = null) {
      const task = tasks.get(taskId);
      if (!task) return { success: false, error: "任务不存在" };
      if (task.status === "canceled") return { success: false, error: "已取消的任务不能重试" };
      const indexes = new Set(Array.isArray(itemIndexes) ? itemIndexes.map(Number) : []);
      const targets = task.items
        .map((item, index) => ({ item, index }))
        .filter(
          ({ item, index }) =>
            item.itemStatus === "failed" && (indexes.size === 0 || indexes.has(index)),
        );
      if (!targets.length) return { success: false, error: "没有可重试的失败项" };

      task.status = "running";
      for (const { item } of targets) {
        item.itemStatus = "pending";
        item.error = null;
        item.file = null;
        item.sourceMode = "asr";
        item.useAsr = true;
      }
      notify(task);
      for (const { item } of targets) asrLane.push({ task, item });
      pumpAsrLane();
      return { success: true, task: serializeTask(task) };
    },

    cancel(id) {
      const task = tasks.get(id);
      if (!task) return { success: false };
      task.status = "canceled";
      task.items.forEach((item) => {
        if (item.itemStatus === "pending") item.itemStatus = "canceled";
      });
      notify(task);
      return { success: true };
    },
  };
}
