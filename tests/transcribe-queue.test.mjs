import { test } from "node:test";
import assert from "node:assert/strict";
import { createExportQueue, buildFinishedNotice } from "../src/main/core/export-queue.js";

// Manual sidebar ASR runs as a queue task ("transcribe"): strictly-serial ASR
// lane, paid result persisted into the digest cache, task visible on the
// tasks page, idempotent enqueue while live.

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

function makeQueue({ fetchTranscript } = {}) {
  const updates = [];
  const saved = [];
  const queue = createExportQueue({
    settingsStore: {
      load: () => ({ saveDir: "", exportConcurrency: 2, aiApiKeys: {}, asrProvider: "bailian" }),
    },
    digestCache: {
      load: () => null,
      save: (key, entry) => saved.push({ key, entry }),
    },
    onTaskUpdate: (t) => updates.push(t),
    ...(fetchTranscript ? { fetchTranscript } : {}),
  });
  return { queue, updates, saved };
}

test("transcribe 任务完成后写入付费缓存槽并产生完成通知", async () => {
  const { queue, saved } = makeQueue({
    fetchTranscript: async ({ mode }) => {
      assert.equal(mode, "asr", "transcribe 任务必须以 asr 模式取字幕");
      return {
        success: true,
        source: "doubao-bigasr",
        language: "zh",
        transcript: [{ text: "识别句", start: 1 }],
      };
    },
  });
  const enqueued = queue.enqueueTranscribe({ bvid: "BV1111111111", page: 2, track: "ai", title: "无字幕视频" });
  assert.equal(enqueued.success, true);
  assert.equal(enqueued.task.type, "transcribe");
  assert.equal(enqueued.task.status, "running");

  await new Promise((r) => setTimeout(r, 100));
  const settled = queue.list()[0];
  assert.equal(settled.status, "done");
  assert.equal(settled.results[0].status, "done");
  assert.equal(settled.results[0].file, null, "转写不产出文件");

  assert.equal(saved.length, 1);
  assert.equal(saved[0].key, "BV1111111111@p2");
  assert.equal(saved[0].entry.sourceOverride, "asr");
  assert.equal(saved[0].entry.transcripts.asr.success, true);
  assert.equal(saved[0].entry.trackOverride, "ai");

  const notice = buildFinishedNotice(settled);
  assert.equal(notice.kind, "transcribe");
  assert.equal(notice.ok, true);
  assert.equal(notice.title, "语音识别完成：无字幕视频");
});

test("transcribe 失败：任务落定、错误可见、通知 ok=false", async () => {
  const { queue } = makeQueue({
    fetchTranscript: async () => ({ success: false, message: "豆包并发配额已满" }),
  });
  queue.enqueueTranscribe({ bvid: "BVfail00000000", page: 1, title: "失败视频" });
  await new Promise((r) => setTimeout(r, 100));
  const settled = queue.list()[0];
  assert.equal(settled.status, "done");
  assert.equal(settled.results[0].status, "failed");
  assert.equal(settled.results[0].error, "豆包并发配额已满");
  const notice = buildFinishedNotice(settled);
  assert.equal(notice.kind, "transcribe");
  assert.equal(notice.ok, false);
  assert.equal(notice.title, "语音识别失败：失败视频");
});

test("同一视频分P的进行中 transcribe 幂等附身，不重复计费", async () => {
  const gate = deferred();
  const { queue } = makeQueue({
    fetchTranscript: () => gate.promise,
  });
  const first = queue.enqueueTranscribe({ bvid: "BVsame00000000", page: 3, title: "同视频" });
  const again = queue.enqueueTranscribe({ bvid: "BVsame00000000", page: 3, title: "同视频" });
  assert.equal(again.task.id, first.task.id, "重复发起应附身到进行中的任务");
  const other = queue.enqueueTranscribe({ bvid: "BVsame00000000", page: 4, title: "同视频" });
  assert.notEqual(other.task.id, first.task.id, "不同分P是不同任务");
  gate.resolve({ success: true, source: "doubao-bigasr", transcript: [] });
  await new Promise((r) => setTimeout(r, 100));
});

test("sourceMode=asr 的导出项走串行 ASR 道（修复并发分道错）", async () => {
  // 单视频导出只带 sourceMode（无 useAsr），历史上被 useAsr 判定漏进
  // 并发字幕道；串行道语义：同一时刻最多一个 ASR 在跑。
  let live = 0;
  let maxLive = 0;
  const gate = deferred();
  const { queue } = makeQueue({
    fetchTranscript: async () => {
      live += 1;
      maxLive = Math.max(maxLive, live);
      await gate.promise;
      live -= 1;
      return { success: false, message: "stub 失败，防止写文件" };
    },
  });
  queue.enqueue({
    type: "single",
    items: [
      { bvid: "BVasrA00000000", title: "A", sourceMode: "asr", page: 1 },
      { bvid: "BVasrB00000000", title: "B", sourceMode: "asr", page: 1 },
    ],
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(maxLive, 1, "两个 ASR 导出项必须串行");
  gate.resolve();
  await new Promise((r) => setTimeout(r, 100));
  const settled = queue.list()[0];
  assert.equal(settled.status, "done");
});

test("transcribe 失败项可在原任务内重试", async () => {
  let calls = 0;
  const { queue } = makeQueue({
    fetchTranscript: async () => {
      calls += 1;
      return calls === 1
        ? { success: false, message: "首次失败" }
        : { success: true, source: "aliyun-fun-asr", transcript: [{ text: "句", start: 0 }] };
    },
  });
  const first = queue.enqueueTranscribe({ bvid: "BVretry00000000", page: 1, title: "重试视频" });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(queue.list()[0].results[0].status, "failed");

  const retry = queue.retryAsr(first.task.id, [0]);
  assert.equal(retry.success, true);
  await new Promise((r) => setTimeout(r, 100));
  const settled = queue.list()[0];
  assert.equal(settled.status, "done");
  assert.equal(settled.results[0].status, "done", "重试走 transcribe runner 而非导出逻辑");
});
