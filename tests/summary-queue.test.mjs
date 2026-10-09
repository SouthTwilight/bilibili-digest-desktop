import { test } from "node:test";
import assert from "node:assert/strict";
import { createExportQueue } from "../src/main/core/export-queue.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const base = fileURLToPath(new URL("./tmp-summary-queue/", import.meta.url));

function makeQueue(summarizeDoc, updates, summarizeDocsBatch) {
  return createExportQueue({
    settingsStore: { load: () => ({ saveDir: base, exportConcurrency: 2 }) },
    digestCache: { load: () => null },
    onTaskUpdate: (task) => updates?.push(task),
    summarizeDoc,
    summarizeDocsBatch,
  });
}

function writeSourceDir() {
  rmSync(base, { recursive: true, force: true });
  for (const name of ["视频A_BV1111111111", "视频B_BV2222222222", "视频C_BV3333333333"]) {
    mkdirSync(join(base, "合集", name), { recursive: true });
    writeFileSync(join(base, "合集", name, `${name}.md`), `# ${name}\n\n## 完整字幕\n内容`);
  }
}

const summaryItems = () =>
  [1, 2, 3].map((n) => ({
    title: `视频${"ABC"[n - 1]}`,
    filePath: join(base, "合集", `视频${"ABC"[n - 1]}_BV${String(n).repeat(10)}`, `视频${"ABC"[n - 1]}_BV${String(n).repeat(10)}.md`),
  }));

test("summary 车道把同任务短文档打包成组，一次请求总结多视频", async () => {
  writeSourceDir();
  const updates = [];
  const batches = [];
  const queue = makeQueue(
    async () => {
      throw new Error("分组存在时不应该走单文档路径");
    },
    updates,
    async ({ docs, onProgress, onUsage }) => {
      batches.push(docs.map((doc) => doc.filePath));
      onProgress?.("正在批量总结 3 个视频");
      onUsage?.({ prompt_tokens: 1000, completion_tokens: 120, prompt_tokens_details: { cached_tokens: 400 } });
      return {
        success: true,
        soloFallback: 0,
        results: docs.map((doc) => ({ filePath: doc.filePath, videoName: doc.title, file: `${doc.filePath}.AI总结.md` })),
      };
    },
  );
  const task = queue.enqueue({ type: "summary", collectionTitle: "合集", items: summaryItems() });
  assert.equal(task.type, "summary");
  assert.equal(task.total, 3);
  await new Promise((resolve) => setTimeout(resolve, 300));
  // 三个短文档合成一次批量请求（模板只付一次）。
  assert.equal(batches.length, 1, `batches=${JSON.stringify(batches)}`);
  assert.equal(batches[0].length, 3);
  const list = queue.list();
  assert.equal(list[0].status, "done");
  assert.ok(list[0].results.every((r) => r.status === "done" && r.file));
  // 批量进度（detail）在运行中可见，任务落定后清空；usage 随任务透出。
  assert.ok(updates.some((t) => t.results.some((r) => r.status === "running" && /批量总结 3 个视频/.test(r.detail || ""))));
  assert.ok(list[0].results.every((r) => r.detail === null));
  assert.deepEqual(list[0].usage, { input: 1000, output: 120, cached: 400 });
  rmSync(base, { recursive: true, force: true });
});

test("summary 任务失败项映射 NO_AI_KEY 且可原任务内重试", async () => {
  writeSourceDir();
  let fail = true;
  const queue = makeQueue(async ({ filePath }) => {
    if (fail) {
      const error = new Error("GLM 5.2 API key not configured. 请先在设置中填写。");
      error.code = "NO_AI_KEY";
      throw error;
    }
    return { success: true, file: `${filePath}.AI总结.md`, videoName: "名" };
  });
  const task = queue.enqueue({
    type: "summary",
    collectionTitle: "合集",
    items: [{ title: "视频A", filePath: join(base, "合集", "视频A_BV1111111111", "视频A_BV1111111111.md") }],
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  let list = queue.list();
  assert.equal(list[0].status, "done");
  assert.equal(list[0].results[0].status, "failed");
  assert.match(list[0].results[0].error, /未配置文本模型 API Key/);

  fail = false;
  const retry = queue.retrySummary(task.id);
  assert.equal(retry.success, true);
  assert.equal(retry.task.status, "running");
  await new Promise((resolve) => setTimeout(resolve, 200));
  list = queue.list();
  assert.equal(list[0].status, "done");
  assert.equal(list[0].results[0].status, "done");

  // 非 summary 任务不能走 summary 重试。
  const exportTask = queue.enqueue({ type: "single", items: [] });
  const bad = queue.retrySummary(exportTask.id);
  assert.equal(bad.success, false);
  rmSync(base, { recursive: true, force: true });
});

test("取消 summary 任务：pending 项取消，运行中项照常完成", async () => {
  // 大文件（超过分组字节上限）逐个走单文档路径，才能复现
  // 「两项运行中 + 一项等待」的取消语义。
  rmSync(base, { recursive: true, force: true });
  const items = [1, 2, 3].map((n) => {
    const name = `视频${"ABC"[n - 1]}_BV${String(n).repeat(10)}`;
    mkdirSync(join(base, "合集", name), { recursive: true });
    writeFileSync(join(base, "合集", name, `${name}.md`), "a".repeat(130_001));
    return { title: `视频${"ABC"[n - 1]}`, filePath: join(base, "合集", name, `${name}.md`) };
  });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const queue = makeQueue(async ({ filePath }) => {
    await gate;
    return { success: true, file: `${filePath}.AI总结.md`, videoName: "名" };
  });
  const task = queue.enqueue({ type: "summary", collectionTitle: "合集", items });
  await new Promise((resolve) => setTimeout(resolve, 100));
  queue.cancel(task.id);
  release();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const list = queue.list();
  assert.equal(list[0].status, "canceled");
  const statuses = list[0].results.map((r) => r.status);
  // 并发 2：前两项已在运行中照常完成，第三项 pending 被取消。
  assert.equal(statuses.filter((s) => s === "done").length, 2);
  assert.equal(statuses.filter((s) => s === "canceled").length, 1);
  rmSync(base, { recursive: true, force: true });
});

test("enqueueSummary 幂等：进行中的相同文档拒绝，完成后可重跑", async () => {
  writeSourceDir();
  const filePath = (n) =>
    join(base, "合集", `视频${"ABCD"[n - 1]}_BV${String(n).repeat(10)}`, `视频${"ABCD"[n - 1]}_BV${String(n).repeat(10)}.md`);
  mkdirSync(join(base, "合集", "视频D_BV4444444444"), { recursive: true });
  writeFileSync(filePath(4), "# 视频D", "utf8");

  let release;
  const gate = new Promise((resolve) => (release = resolve));
  // 短文档会走批量路径，批量函数挂在 gate 上保持任务「进行中」。
  const queue = makeQueue(
    async ({ filePath: fp }) => {
      await gate;
      return { success: true, file: `${fp}.AI总结.md`, videoName: "名" };
    },
    undefined,
    async ({ docs }) => {
      await gate;
      return {
        success: true,
        soloFallback: 0,
        results: docs.map((doc) => ({ filePath: doc.filePath, videoName: doc.title, file: `${doc.filePath}.AI总结.md` })),
      };
    },
  );

  const first = queue.enqueueSummary({
    collectionTitle: "合集",
    items: [1, 2, 3].map((n) => ({ title: `视频${"ABC"[n - 1]}`, filePath: filePath(n) })),
  });
  assert.equal(first.success, true);
  assert.equal(first.task.type, "summary");
  assert.equal(first.task.total, 3);
  assert.ok(first.task.results[0].title);

  // 任务仍在进行：相同源文件再入队被拒绝（无论套哪个合集名）。
  await new Promise((resolve) => setTimeout(resolve, 50));
  const dup = queue.enqueueSummary({
    collectionTitle: "合集",
    items: [{ title: "视频A", filePath: filePath(1) }],
  });
  assert.equal(dup.success, false);
  assert.match(dup.error, /进行中的总结任务/);

  // 不相交的文件不受影响，正常入队。
  const disjoint = queue.enqueueSummary({
    collectionTitle: "合集",
    items: [{ title: "视频D", filePath: filePath(4) }],
  });
  assert.equal(disjoint.success, true);

  release();
  await new Promise((resolve) => setTimeout(resolve, 300));
  // 全部落定后，同一文件可以重新总结。
  const again = queue.enqueueSummary({
    collectionTitle: "合集",
    items: [{ title: "视频A", filePath: filePath(1) }],
  });
  assert.equal(again.success, true);
  rmSync(base, { recursive: true, force: true });
});
