import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { fetchTranscript } from "./transcript-service.js";
import { fetchBilibiliView } from "./bilibili.js";
import { buildMarkdownExport, buildHtmlExport, exportFileName } from "./export-render.js";
import { videoFolderName } from "./notes.js";
import { summarizeExportedDoc } from "./summarize-doc.js";

function sanitizeDirName(name) {
  return String(name || "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[＼／：＊？＂＜＞｜]/g, "")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 60);
}

// Task queue for exports and AI summaries. Three lanes with different
// concurrency:
//   subtitle lane — videos with Bilibili subtitle tracks, concurrency from
//     settings.exportConcurrency (free API calls, safe to parallelize);
//   asr lane — videos the user opted into ASR, strictly serial (Doubao has a
//     concurrency quota; Bailian bills per task);
//   summary lane — AI summaries of exported documents (type "summary"),
//     concurrency also from settings.exportConcurrency (text-model calls).
// Tasks survive browsing: the queue lives in the main process and keeps
// running no matter what page the browser view shows.

// Turn a serialized task (the onTaskUpdate payload shape) into a completion
// notice for the main-process router (in-app toast vs OS notification).
// Running and user-canceled tasks produce no notice.
export function buildFinishedNotice(task) {
  if (!task || task.status !== "done") return null;
  const results = Array.isArray(task.results) ? task.results : [];
  const succeeded = results.filter((item) => item.status === "done");
  const failed = results.length - succeeded.length;
  if (task.type === "summary") {
    const scope = task.collectionTitle
      ? `合集总结完成：${task.collectionTitle}`
      : `AI 总结完成：${succeeded[0]?.title || results[0]?.title || ""}`;
    const suffix =
      failed > 0
        ? `（成功 ${succeeded.length}，失败 ${failed}）`
        : results.length > 1
          ? `（${results.length} 个视频）`
          : "";
    return { kind: "summary", ok: failed === 0, title: `${scope}${suffix}`, file: succeeded[0]?.file || null };
  }
  const title =
    failed > 0
      ? `导出完成：成功 ${succeeded.length}，失败 ${failed}`
      : task.type === "collection"
        ? `合集导出完成（${results.length} 个视频）`
        : "字幕导出完成";
  return { kind: "export", ok: failed === 0, title, file: succeeded[0]?.file || null };
}

export function createExportQueue({ settingsStore, digestCache, onTaskUpdate, summarizeDoc = summarizeExportedDoc }) {
  const tasks = new Map();
  const subtitleLane = [];
  const asrLane = [];
  const summaryLane = [];
  let subtitleRunning = 0;
  let summaryRunning = 0;

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
        detail: item.detail || null,
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
    // "all" labels a merged whole-video export covering every part.
    const pageLabel = item.allPages ? "all" : item.page || 1;
    return join(folder, `${exportFileName(item.videoTitle || item.title, pageLabel)}.${format}`);
  }

  async function runItem(task, item) {
    item.itemStatus = "running";
    notify(task);
    try {
      const settings = settingsStore.load();
      // One view fetch serves both the metadata and the multi-P page list.
      const view = await fetchBilibiliView(item.bvid).catch(() => null);
      // Collection exports cover every part of multi-P videos (one merged
      // document) — decided here at run time instead of a slow pre-enqueue
      // probe; single-video exports keep their explicit allPages choice.
      const wantsAllPages =
        item.allPages || (task.type === "collection" && (view?.pages?.length || 0) > 1);
      const pages = wantsAllPages && view?.pages?.length ? view.pages : null;

      // Source resolution: ASR exports reuse the paid cache slot; subtitle
      // exports always fetch fresh (subtitles are cheap, uncached API calls
      // whose content regenerates server-side).
      const fetchForPage = async (page) => {
        const cacheKey = `${item.bvid}@p${page}`;
        const cached = digestCache.load(cacheKey);
        const asrSlot = cached?.transcripts?.asr?.success ? cached.transcripts.asr : null;
        const wantsAsr = item.useAsr || item.sourceMode === "asr" ||
          (!item.useAsr && item.sourceMode !== "subtitle" && cached?.sourceOverride === "asr");
        if (wantsAsr && asrSlot) return { transcript: asrSlot, cached, wantsAsr };
        const transcript = await fetchTranscript({
          settings,
          videoId: item.bvid,
          page,
          mode: wantsAsr ? "asr" : "subtitle",
          // Follow the user's per-video track choice (native CC vs AI);
          // fall back to "ai" when no preference was ever set.
          track: item.track || cached?.trackOverride || "ai",
        });
        return { transcript, cached, wantsAsr };
      };
      // Cache ASR results so the paid transcript survives reopens; the
      // sidebar, retry flows and future exports all reuse it.
      const cacheAsr = (page, transcript) => {
        if (transcript.source === "bilibili-subtitle") return;
        const cacheKey = `${item.bvid}@p${page}`;
        const existing = digestCache.load(cacheKey) || {};
        digestCache.save(cacheKey, {
          ...existing,
          transcripts: { ...(existing.transcripts || {}), asr: transcript },
          sourceOverride: "asr",
        });
      };

      const video = {
        title: view?.title || item.videoTitle || item.title,
        channelName: view?.owner?.name || "",
        url: `https://www.bilibili.com/video/${item.bvid}/`,
        description: view?.desc || "",
      };

      if (pages) {
        // Whole-video export: one document, one section per part, with the
        // part's cached AI chapters (if any) inside its section.
        const parts = [];
        for (const [index, pageEntry] of pages.entries()) {
          const page = pageEntry.page || index + 1;
          const { transcript, cached, wantsAsr } = await fetchForPage(page);
          if (!transcript.success) {
            throw new Error(`P${page}：${transcript.message || "获取字幕失败"}`);
          }
          cacheAsr(page, transcript);
          parts.push({
            page,
            title: pageEntry.part,
            transcript: transcript.transcript,
            language: transcript.language,
            analysis: cached?.analysis || null,
          });
        }
        video.language = parts[0]?.language;
        video.parts = parts;
      } else {
        const page = item.page || 1;
        const { transcript, cached, wantsAsr } = await fetchForPage(page);
        if (!transcript.success) {
          throw new Error(transcript.message || "获取字幕失败");
        }
        cacheAsr(page, transcript);
        video.language = transcript.language;
        video.transcript = transcript.transcript;
        video.analysis = cached?.analysis || null;
      }

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

  // AI summaries read the already-exported markdown from disk, so an item is
  // just a file path; intra-item chunk progress rides `item.detail` into the
  // task payload instead of the global running card.
  async function runSummaryItem(task, item) {
    item.itemStatus = "running";
    item.detail = null;
    notify(task);
    try {
      const result = await summarizeDoc({
        settings: settingsStore.load(),
        filePath: item.filePath,
        focus: item.focus || "",
        onProgress: (_title, subtitle) => {
          item.detail = subtitle || null;
          notify(task);
        },
      });
      item.itemStatus = "done";
      item.file = result.file;
    } catch (error) {
      item.itemStatus = "failed";
      item.error =
        error.code === "NO_AI_KEY"
          ? "未配置文本模型 API Key，请先到设置页填写。"
          : error.message || String(error);
    } finally {
      item.detail = null;
      notify(task);
    }
  }

  function maybeFinish(task) {
    if (task.items.every((item) => item.itemStatus !== "pending" && item.itemStatus !== "running")) {
      // A canceled task whose running items finish afterwards stays canceled —
      // flipping it to done would fire a completion notice the user cancelled.
      if (task.status !== "canceled") task.status = "done";
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

  function pumpSummaryLane() {
    while (summaryRunning < Math.max(1, settingsStore.load().exportConcurrency || 4)) {
      const next = summaryLane.shift();
      if (!next) return;
      const { task, item } = next;
      if (task.status === "canceled") continue;
      summaryRunning += 1;
      runSummaryItem(task, item)
        .catch(() => {})
        .finally(() => {
          summaryRunning -= 1;
          maybeFinish(task);
          pumpSummaryLane();
        });
    }
  }

  function enqueueItems(task) {
    for (const item of task.items) {
      item.itemStatus = "pending";
      const payload = { task, item };
      if (task.type === "summary") summaryLane.push(payload);
      else if (item.useAsr) asrLane.push(payload);
      else subtitleLane.push(payload);
    }
    pumpSubtitleLane();
    pumpAsrLane();
    pumpSummaryLane();
  }

  // Shared retry core: failed items go back to pending INSIDE the same task
  // record so the retried work shows up in place. `prepare` mutates the item
  // for its retry mode; `requeue` routes it into a lane and pumps it.
  function retryFailed(taskId, itemIndexes, prepare, requeue) {
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
      item.detail = null;
      prepare?.(item);
    }
    notify(task);
    for (const { item } of targets) requeue(task, item);
    return { success: true, task: serializeTask(task) };
  }

  function enqueueTask({ type, collectionTitle = "", format = "md", items }) {
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
    return task;
  }

  return {
    enqueue(payload) {
      return serializeTask(enqueueTask(payload));
    },

    // Summary enqueues are idempotent while work is live: a source file that
    // is still pending/running inside a running summary task cannot be
    // enqueued again — duplicate batches otherwise burn tokens whenever an
    // impatient double-click or a failed-looking enqueue gets retried.
    enqueueSummary({ collectionTitle = "", items }) {
      const wanted = new Set(
        (Array.isArray(items) ? items : []).map((item) => String(item?.filePath || "")),
      );
      wanted.delete("");
      for (const task of tasks.values()) {
        if (task.type !== "summary" || task.status !== "running") continue;
        const clash = task.items.find(
          (item) =>
            wanted.has(item.filePath) &&
            (item.itemStatus === "pending" || item.itemStatus === "running"),
        );
        if (clash) {
          return {
            success: false,
            error: task.collectionTitle
              ? `「${task.collectionTitle}」已有进行中的总结任务（${clash.title}），请等它完成、或在任务页取消后再试。`
              : `「${clash.title}」的总结正在进行中，请等它完成、或在任务页取消后再试。`,
          };
        }
      }
      return {
        success: true,
        task: serializeTask(enqueueTask({ type: "summary", collectionTitle, items })),
      };
    },

    list() {
      return Array.from(tasks.values())
        .map(serializeTask)
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    // Re-enqueue failed items with ASR inside the SAME task, so the original
    // task record is kept and the retried work shows up in place.
    retryAsr(taskId, itemIndexes = null) {
      return retryFailed(
        taskId,
        itemIndexes,
        (item) => {
          item.sourceMode = "asr";
          item.useAsr = true;
        },
        (task, item) => {
          asrLane.push({ task, item });
          pumpAsrLane();
        },
      );
    },

    // Retry failed summary items as-is (e.g. after fixing the API key) —
    // same-task semantics, routed to the summary lane.
    retrySummary(taskId, itemIndexes = null) {
      const task = tasks.get(taskId);
      if (task && task.type !== "summary") return { success: false, error: "不是总结任务" };
      return retryFailed(taskId, itemIndexes, null, (task2, item) => {
        summaryLane.push({ task: task2, item });
        pumpSummaryLane();
      });
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
