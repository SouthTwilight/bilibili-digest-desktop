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
      const settings = settingsStore.load();
      const transcript = await fetchTranscript({
        settings,
        videoId: item.bvid,
        page: item.page || 1,
        mode: item.useAsr ? "asr" : "subtitle",
      });
      if (!transcript.success) {
        throw new Error(transcript.message || "获取字幕失败");
      }
      // Attach a cached AI analysis when one exists; exports never trigger
      // new LLM calls.
      const cached = digestCache.load(`${item.bvid}@p${item.page || 1}`);
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
