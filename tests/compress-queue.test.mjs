import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createExportQueue, buildFinishedNotice } from "../src/main/core/export-queue.js";
import { compressFolder as realCompressFolder } from "../src/main/core/archive.js";

const base = fileURLToPath(new URL("./tmp-compress-queue/", import.meta.url));
const settle = () => new Promise((resolve) => setTimeout(resolve, 350));

function makeQueue(updates, compressFolder = realCompressFolder) {
  return createExportQueue({
    settingsStore: { load: () => ({ saveDir: base, exportConcurrency: 2 }) },
    digestCache: { load: () => null },
    onTaskUpdate: (task) => updates?.push(task),
    compressFolder,
  });
}

function writeLibrary() {
  rmSync(base, { recursive: true, force: true });
  for (const name of ["合集A", "合集B"]) {
    mkdirSync(join(base, name, "视频_BV1111111111"), { recursive: true });
    writeFileSync(join(base, name, "视频_BV1111111111", "视频_2026-01-01_10-00.md"), `# ${name}`);
  }
  // 261 字节的路径：84 个汉字的目录名 + "abcde.md"。
  const longFolder = join(base, "长名字合集", "中".repeat(84));
  mkdirSync(longFolder, { recursive: true });
  writeFileSync(join(longFolder, "abcde.md"), "# 超长");
  mkdirSync(join(base, "空文件夹"), { recursive: true });
  return {
    a: join(base, "合集A"),
    b: join(base, "合集B"),
    long: join(base, "长名字合集"),
    empty: join(base, "空文件夹"),
    longFile: join(longFolder, "abcde.md"),
  };
}

const zipsInBase = () => readdirSync(base).filter((name) => name.endsWith(".zip"));

test("压缩任务：勾选几个文件夹就压几个，进度和结果都在任务里", async () => {
  const { a, b } = writeLibrary();
  const updates = [];
  const queue = makeQueue(updates);
  const enqueued = queue.enqueueCompress({ items: [{ dirPath: a }, { dirPath: b }] });
  assert.equal(enqueued.success, true, enqueued.error);
  assert.equal(enqueued.task.type, "compress");
  assert.equal(enqueued.task.status, "running");

  await settle();
  const [task] = queue.list();
  assert.equal(task.status, "done");
  assert.deepEqual(
    task.results.map((result) => [result.title, result.status, !!result.file]),
    [
      ["合集A", "done", true],
      ["合集B", "done", true],
    ],
  );
  assert.equal(zipsInBase().length, 2);
  assert.ok(task.results.every((result) => result.file.startsWith(join(base, `${result.title}_`))));
  // 任务页能看到「正在压缩」的进度，而不是只在结束时跳一下。
  assert.ok(
    updates.some((update) => update.results.some((result) => result.status === "running" && result.detail === "正在压缩…")),
    "应有一条正在压缩的进度更新",
  );
  assert.ok(
    updates.some((update) => update.results.some((result) => result.status === "running" && result.detail === "正在压缩… 1/1")),
    "压完的文件数也报进任务里",
  );
  assert.deepEqual(buildFinishedNotice(task), {
    kind: "compress",
    ok: true,
    title: "压缩完成（2 个压缩包）",
    file: task.results[0].file,
  });
  rmSync(base, { recursive: true, force: true });
});

test("压缩任务：任务里带着压完的文件数（正在压缩… n/总数）", async () => {
  const { a } = writeLibrary();
  for (const name of ["b.md", "c.md"]) writeFileSync(join(a, "视频_BV1111111111", name), "# 更多");
  const updates = [];
  const queue = makeQueue(updates);
  queue.enqueueCompress({ items: [{ dirPath: a }] });
  await settle();
  const details = updates.flatMap((update) => update.results.map((result) => result.detail)).filter(Boolean);
  assert.ok(details.includes("正在压缩…"), "开工时先报一条「正在压缩…」");
  // 中间的更新会限流，但第一个和最后一个文件压完必报。
  assert.ok(details.includes("正在压缩… 1/3"), details.join(" | "));
  assert.ok(details.includes("正在压缩… 3/3"), details.join(" | "));
  rmSync(base, { recursive: true, force: true });
});

test("压缩任务：路径超过 260 字节时这一项失败并在任务里说明原因，其他项照常压缩", async () => {
  const { a, long, empty } = writeLibrary();
  const queue = makeQueue();
  queue.enqueueCompress({ items: [{ dirPath: long }, { dirPath: a }, { dirPath: empty }] });
  await settle();
  const [task] = queue.list();
  assert.equal(task.status, "done", "失败也是任务的正常结束，不会卡在进行中");
  assert.deepEqual(
    task.results.map((result) => result.status),
    ["failed", "done", "failed"],
  );
  const [longResult, okResult, emptyResult] = task.results;
  assert.match(longResult.error, /超过 260 字节/);
  assert.match(longResult.error, /已取消压缩/);
  assert.ok(longResult.error.includes("abcde.md"), "错误里指出是哪个文件");
  assert.equal(longResult.file, null);
  assert.equal(okResult.file && okResult.file.endsWith(".zip"), true);
  assert.match(emptyResult.error, /空的/);
  assert.deepEqual(zipsInBase(), [okResult.file.split(/[\\/]/).pop()], "只写出成功那一个");

  const notice = buildFinishedNotice(task);
  assert.equal(notice.ok, false);
  assert.equal(notice.title, "压缩完成：成功 1，失败 2");
  assert.equal(notice.file, okResult.file, "完成通知仍能定位到成功的压缩包");
  rmSync(base, { recursive: true, force: true });
});

test("压缩任务：失败项改名后可以在原任务里重试", async () => {
  const { long, longFile } = writeLibrary();
  const queue = makeQueue();
  const { task } = queue.enqueueCompress({ items: [{ dirPath: long }] });
  await settle();
  assert.equal(queue.list()[0].results[0].status, "failed");

  renameSync(longFile, join(long, "中".repeat(84), "短.md"));
  const retried = queue.retryCompress(task.id);
  assert.equal(retried.success, true, retried.error);
  await settle();
  const [after] = queue.list();
  assert.equal(after.results[0].status, "done");
  assert.equal(zipsInBase().length, 1);
  assert.equal(buildFinishedNotice(after).ok, true);
  assert.equal(queue.retryCompress(task.id).success, false, "没有失败项时无可重试");
  rmSync(base, { recursive: true, force: true });
});

test("压缩任务：一次只压一个文件夹；排队中的同一文件夹不能重复入队", async () => {
  const { a, b } = writeLibrary();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started = 0;
  const slow = async ({ dirPath }) => {
    started += 1;
    await gate;
    return realCompressFolder({ saveDir: base, dirPath });
  };
  const queue = makeQueue([], slow);

  const first = queue.enqueueCompress({ items: [{ dirPath: a }] });
  assert.equal(first.success, true, first.error);
  await settle();
  assert.equal(started, 1);
  assert.equal(queue.list()[0].results[0].status, "running");

  // 同一个文件夹正在压缩时不能再次入队；别的文件夹可以，但要排队。
  const again = queue.enqueueCompress({ items: [{ dirPath: a }] });
  assert.equal(again.success, false);
  assert.match(again.error, /正在压缩/);
  assert.equal(queue.list().length, 1, "被拒绝的那次没有产生任务");

  const second = queue.enqueueCompress({ items: [{ dirPath: b }] });
  assert.equal(second.success, true, second.error);
  assert.deepEqual(second.task.results.map((result) => result.status), ["pending"]);
  await settle();
  assert.equal(started, 1, "第一个还没压完，第二个任务不开工");

  release();
  await settle();
  await settle();
  assert.deepEqual(
    queue.list().map((task) => [task.status, task.results.map((result) => result.status).join(",")]),
    [
      ["done", "done"],
      ["done", "done"],
    ],
    "后入队的任务排在前一个完成之后",
  );
  assert.equal(zipsInBase().length, 2);
  rmSync(base, { recursive: true, force: true });
});

test("压缩任务：取消后排队中的项不再压缩，也不产生压缩包", async () => {
  const { a, b } = writeLibrary();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const slow = async ({ dirPath }) => {
    await gate;
    return realCompressFolder({ saveDir: base, dirPath });
  };
  const queue = makeQueue([], slow);
  queue.enqueueCompress({ items: [{ dirPath: a }] });
  await settle();
  const queued = queue.enqueueCompress({ items: [{ dirPath: b }] });
  queue.cancel(queued.task.id);

  release();
  await settle();
  await settle();
  const [second, first] = queue.list();
  assert.equal(first.status, "done");
  assert.equal(second.status, "canceled", "取消的任务保持取消，不会被完成通知翻回已完成");
  assert.deepEqual(second.results.map((result) => result.status), ["canceled"]);
  assert.equal(zipsInBase().length, 1, "只有没被取消的那个产生了压缩包");
  assert.equal(buildFinishedNotice(second), null, "取消的任务不发完成通知");
  rmSync(base, { recursive: true, force: true });
});

test("压缩任务：不是导出库根目录下一级文件夹的项在任务里失败（接口层会先过滤掉这类项）", async () => {
  const { a } = writeLibrary();
  const queue = makeQueue();
  const enqueued = queue.enqueueCompress({ items: [{ dirPath: join(a, "视频_BV1111111111") }, {}] });
  assert.equal(enqueued.success, true);
  assert.equal(enqueued.task.total, 1, "没有路径的项直接丢弃");
  await settle();
  const [task] = queue.list();
  assert.match(task.results[0].error, /根目录/);
  assert.deepEqual(zipsInBase(), []);
  rmSync(base, { recursive: true, force: true });
});
