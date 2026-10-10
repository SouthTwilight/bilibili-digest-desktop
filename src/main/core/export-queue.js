import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { fetchTranscript } from "./transcript-service.js";
import { fetchBilibiliView } from "./bilibili.js";
import { buildMarkdownExport, buildHtmlExport, exportFileName } from "./export-render.js";
import { videoDirSegments } from "./notes.js";
import { fitUnder } from "./paths.js";
import { summarizeExportedDoc, summarizeDocsBatch as runSummarizeDocsBatch } from "./summarize-doc.js";

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
      ? `批量总结完成：${task.collectionTitle}`
      : `AI 总结完成：${succeeded[0]?.title || results[0]?.title || ""}`;
    const suffix =
      failed > 0
        ? `（成功 ${succeeded.length}，失败 ${failed}）`
        : results.length > 1
          ? `（${results.length} 个视频）`
          : "";
    return { kind: "summary", ok: failed === 0, title: `${scope}${suffix}`, file: succeeded[0]?.file || null };
  }
  const singleLabel =
    task.type === "summary"
      ? null
      : succeeded[0]?.title
        ? `字幕导出完成：${succeeded[0].title}`
        : "字幕导出完成";
  const title =
    failed > 0
      ? `导出完成：成功 ${succeeded.length}，失败 ${failed}`
      : task.type === "collection"
        ? `合集导出完成（${results.length} 个视频）`
        : singleLabel;
  return { kind: "export", ok: failed === 0, title, file: succeeded[0]?.file || null };
}

// Split a whole-video (multi-P) export item into ONE ITEM PER PART inside
// the same task — per-P progress/files/failures then show on the tasks page
// exactly like a collection's per-video items. Splices the original item
// out of task.items and returns the new pending items (lane routing and
// notification are the caller's job).
export function expandIntoPageItems(task, item, pages) {
  const index = task.items.indexOf(item);
  if (index === -1) return [];
  const videoTitle = item.videoTitle || item.title || "";
  const created = pages.map((pageEntry, i) => {
    const page = pageEntry.page || i + 1;
    return {
      ...item,
      title: `${videoTitle} P${page}`.trim(),
      videoTitle,
      page,
      allPages: false,
      itemStatus: "pending",
      file: null,
      error: null,
      detail: null,
    };
  });
  task.items.splice(index, 1, ...created);
  return created;
}

export function createExportQueue({ settingsStore, digestCache, onTaskUpdate, summarizeDoc = summarizeExportedDoc, summarizeDocsBatch = runSummarizeDocsBatch }) {
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
      // Summary tasks accumulate token usage so the cost of a batch (and of
      // batching) is visible on the tasks page.
      ...(task.usage && (task.usage.input || task.usage.output)
        ? { usage: { ...task.usage } }
        : {}),
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

  // Unified three-level layout (shared with notes/pictures via
  // videoDirSegments): collection videos under {合集}/{视频名_BV}/, standalone
  // multi-P videos under {视频名_BV}/P{n}/, standalone singles grouped by
  // uploader under {UP主}/{视频名_BV}/. fitUnder keeps the FULL path inside
  // Windows' 260-char budget, trimming only when over.
  function targetFile(task, item, format, page, view) {
    const title = view?.title || item.videoTitle || item.title;
    const fileName = `${exportFileName(title, page || item.page || 1)}.${format}`;
    return fitUnder(
      settingsStore.load().saveDir || ".",
      ...videoDirSegments({
        collectionTitle: task.collectionTitle || "",
        channelName: view?.owner?.name || "",
        videoTitle: title,
        bvid: item.bvid,
        pageCount: view?.pages?.length || 0,
        page: page || item.page || 1,
      }),
      fileName,
    );
  }

  async function runItem(task, item) {
    item.itemStatus = "running";
    notify(task);
    try {
      const settings = settingsStore.load();
      // One view fetch serves both the metadata and the multi-P page list.
      const view = await fetchBilibiliView(item.bvid).catch(() => null);
      // Whole-video exports (全部P / collection multi-P videos) split into
      // ONE ITEM PER PART at run time — the page count is only known here,
      // and per-P progress/files/failures then show on the tasks page
      // exactly like a collection's per-video items.
      if ((item.allPages || task.type === "collection") && (view?.pages?.length || 0) > 1) {
        const created = expandIntoPageItems(task, item, view.pages);
        notify(task);
        for (const pageItem of created) {
          (pageItem.useAsr ? asrLane : subtitleLane).push({ task, item: pageItem });
        }
        pumpSubtitleLane();
        pumpAsrLane();
        return;
      }

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

      const baseVideo = {
        title: view?.title || item.videoTitle || item.title,
        channelName: view?.owner?.name || "",
        url: `https://www.bilibili.com/video/${item.bvid}/`,
        description: view?.desc || "",
      };
      const format = item.format || task.format || "md";

      const page = item.page || 1;
      const { transcript, cached } = await fetchForPage(page);
      if (!transcript.success) {
        throw new Error(transcript.message || "获取字幕失败");
      }
      cacheAsr(page, transcript);
      const video = {
        ...baseVideo,
        page,
        language: transcript.language,
        transcript: transcript.transcript,
        analysis: cached?.analysis || null,
      };

      const content =
        format === "html" ? buildHtmlExport(video) : buildMarkdownExport(video);
      const file = targetFile(task, { ...item, videoTitle: video.title }, format, page, view);
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

  // Accumulate provider usage into the task record. Cached-token details
  // differ per provider: OpenAI-style prompt_tokens_details.cached_tokens vs
  // DeepSeek's prompt_cache_hit_tokens.
  function addUsage(task) {
    return (usage) => {
      if (!usage || typeof usage !== "object") return;
      task.usage = task.usage || { input: 0, output: 0, cached: 0 };
      task.usage.input += Number(usage.prompt_tokens) || 0;
      task.usage.output += Number(usage.completion_tokens) || 0;
      task.usage.cached +=
        Number(usage.prompt_tokens_details?.cached_tokens) || Number(usage.prompt_cache_hit_tokens) || 0;
    };
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
        onUsage: addUsage(task),
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

  // Short docs of the SAME task are packed into one completion request —
  // the fixed prompt template is billed once per group instead of once per
  // video. Caps keep a group comfortably inside the model context and the
  // 8192-token output budget (docs the model skips fall back solo anyway).
  const GROUP_MAX_ITEMS = 8;
  const GROUP_MAX_BYTES = 120_000;

  function fileBytes(filePath) {
    try {
      return statSync(filePath).size;
    } catch {
      return Number.POSITIVE_INFINITY; // unreadable → never group, solo reports
    }
  }

  function takeSummaryGroup() {
    const first = summaryLane.shift();
    if (!first) return null;
    const group = [first];
    let bytes = fileBytes(first.item.filePath);
    while (group.length < GROUP_MAX_ITEMS && bytes <= GROUP_MAX_BYTES) {
      const next = summaryLane[0];
      if (!next || next.task.id !== first.task.id) break;
      const size = fileBytes(next.item.filePath);
      if (bytes + size > GROUP_MAX_BYTES) break;
      group.push(summaryLane.shift());
      bytes += size;
    }
    return group;
  }

  async function runSummaryGroup(task, group) {
    if (group.length === 1) return runSummaryItem(task, group[0].item);
    const items = group.map((entry) => entry.item);
    for (const item of items) {
      item.itemStatus = "running";
      item.detail = `批量总结中（本组 ${items.length} 个视频共用一次请求）`;
    }
    notify(task);
    try {
      const result = await summarizeDocsBatch({
        settings: settingsStore.load(),
        docs: items.map((item) => ({ filePath: item.filePath, title: item.title })),
        focus: items[0].focus || "",
        onProgress: (title) => {
          for (const item of items) item.detail = title;
          notify(task);
        },
        onUsage: addUsage(task),
      });
      const fileByPath = new Map(result.results.map((r) => [r.filePath, r.file]));
      for (const item of items) {
        item.itemStatus = "done";
        item.file = fileByPath.get(item.filePath) || null;
      }
    } catch (error) {
      for (const item of items) {
        item.itemStatus = "failed";
        item.error =
          error.code === "NO_AI_KEY"
            ? "未配置文本模型 API Key，请先到设置页填写。"
            : error.message || String(error);
      }
    } finally {
      for (const item of items) item.detail = null;
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
      const group = takeSummaryGroup();
      if (!group) return;
      const { task } = group[0];
      if (task.status === "canceled") continue;
      summaryRunning += 1;
      runSummaryGroup(task, group)
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
