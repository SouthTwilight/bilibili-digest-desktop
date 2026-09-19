import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFinishedNotice } from "../src/main/core/export-queue.js";

const singleTask = {
  status: "done",
  type: "single",
  results: [{ title: "A", status: "done", file: "D:/x/A.md" }],
};

test("running/canceled/空任务不产生完成通知", () => {
  assert.equal(buildFinishedNotice({ status: "running" }), null);
  assert.equal(buildFinishedNotice({ status: "canceled" }), null);
  assert.equal(buildFinishedNotice(null), null);
});

test("单视频全部成功", () => {
  const n = buildFinishedNotice(singleTask);
  assert.equal(n.ok, true);
  assert.equal(n.title, "字幕导出完成");
  assert.equal(n.file, "D:/x/A.md");
});

test("合集全部成功标题带数量", () => {
  const n = buildFinishedNotice({
    status: "done",
    type: "collection",
    results: [
      { status: "done", file: "a" },
      { status: "done", file: "b" },
    ],
  });
  assert.equal(n.ok, true);
  assert.equal(n.title, "合集导出完成（2 个视频）");
});

test("合集部分失败：ok=false 且标题含成功/失败计数", () => {
  const n = buildFinishedNotice({
    status: "done",
    type: "collection",
    results: [
      { status: "done", file: "a" },
      { status: "done", file: "b" },
      { status: "done", file: "c" },
      { status: "failed", error: "x" },
      { status: "failed", error: "y" },
    ],
  });
  assert.equal(n.ok, false);
  assert.match(n.title, /成功 3，失败 2/);
  assert.equal(n.file, "a");
});

test("全部失败：file 为 null", () => {
  const n = buildFinishedNotice({
    status: "done",
    type: "collection",
    results: [{ status: "failed", error: "x" }],
  });
  assert.equal(n.ok, false);
  assert.equal(n.file, null);
});
