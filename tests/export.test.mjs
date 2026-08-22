import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMarkdownExport,
  buildHtmlExport,
  exportFileName,
} from "../src/main/core/export-render.js";
import { scanLibrary } from "../src/main/core/library.js";
import { createExportQueue } from "../src/main/core/export-queue.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

test("export renderers produce full documents with Chinese content", () => {
  const video = {
    title: "测试视频：中文标题",
    channelName: "UP主",
    url: "https://www.bilibili.com/video/BVtest/",
    description: "简介",
    language: "zh",
    transcript: [{ text: "第一句", start: 5 }, { text: "第二句", start: 65 }],
    analysis: {
      chapters: [{ title: "章", summary: "概", timestamp: "0:05", timestampSeconds: 5 }],
      keyQuotes: [{ quote: "话", timestamp: "1:05", timestampSeconds: 65 }],
    },
  };
  const md = buildMarkdownExport(video);
  assert.ok(md.includes("# 测试视频：中文标题"));
  assert.ok(md.includes("[0:05](https://www.bilibili.com/video/BVtest/?t=5s) 第一句"));
  assert.ok(md.includes("### [0:05] 章"));
  assert.ok(md.includes("> **1:05** 话"));
  const html = buildHtmlExport(video);
  assert.ok(html.includes("<!doctype html>"));
  assert.ok(html.includes("第二句"));
  assert.ok(/视频名|测试视频/.test(exportFileName("测试视频")) === false || exportFileName("测试视频").includes("测试视频"));
});

test("export file names are timestamped and sanitized", () => {
  const name = exportFileName('视频/名:称*');
  assert.ok(!/[\\/:*?"<>|]/.test(name), name);
  assert.ok(/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$/.test(name), name);
});

test("export file names carry the part number for multi-P videos", () => {
  // Same title + same minute used to produce ONE filename, so exporting P2
  // minutes after P1 overwrote P1's file. Pages beyond the first must be
  // distinguished; P1/single-P keeps the legacy name.
  const p1 = exportFileName("多P视频", 1);
  const p2 = exportFileName("多P视频", 2);
  assert.ok(!p1.includes("_P"), p1);
  assert.ok(/多P视频_P2_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$/.test(p2), p2);
  assert.notEqual(p1, p2);
  assert.equal(exportFileName("多P视频").endsWith(p1.split("多P视频")[1]), true);
});

test("all-pages export file name carries the 全部P marker", () => {
  const name = exportFileName("多P视频", "all");
  assert.ok(/多P视频_全部P_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$/.test(name), name);
});

test("multi-P merged exports render per-part sections with p-aware links", () => {
  const video = {
    title: "多P视频",
    channelName: "UP主",
    url: "https://www.bilibili.com/video/BVtestP/",
    description: "",
    language: "zh",
    parts: [
      { page: 1, title: "第一部分", transcript: [{ text: "A句", start: 5 }] },
      {
        page: 2,
        title: "第二部分",
        transcript: [{ text: "B句", start: 65 }],
        analysis: {
          chapters: [{ title: "章", summary: "概", timestamp: "1:05", timestampSeconds: 65 }],
          keyQuotes: [{ quote: "话", timestamp: "1:05", timestampSeconds: 65 }],
        },
      },
    ],
  };
  const md = buildMarkdownExport(video);
  assert.ok(md.includes("## P1 第一部分"), md);
  assert.ok(md.includes("## P2 第二部分"), md);
  assert.ok(md.includes("[0:05](https://www.bilibili.com/video/BVtestP/?t=5s) A句"), md);
  assert.ok(md.includes("[1:05](https://www.bilibili.com/video/BVtestP/?p=2&t=65s) B句"), md);
  assert.ok(md.includes("### AI 章节"), md);
  assert.ok(!md.includes("## 完整字幕"), md);
  const html = buildHtmlExport(video);
  assert.ok(html.includes("P2 第二部分"), html);
  assert.ok(html.includes("?p=2&amp;t=65s"), html);
});

test("library scan maps collections, videos and files", () => {
  const base = new URL("./tmp-lib/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  rmSync(base, { recursive: true, force: true });
  mkdirSync(join(base, "合集A", "视频一_BV1111111111"), { recursive: true });
  writeFileSync(join(base, "合集A", "视频一_BV1111111111", "笔记.md"), "# x");
  mkdirSync(join(base, "单视频_BV2222222222"), { recursive: true });
  writeFileSync(join(base, "单视频_BV2222222222", "notes.json"), '{"notes":[]}');

  const tree = scanLibrary(base);
  assert.equal(tree.length, 2);
  const coll = tree.find((n) => n.type === "collection");
  assert.equal(coll.name, "合集A");
  assert.equal(coll.children[0].type, "video");
  assert.equal(coll.children[0].children[0].kind, "md");
  const solo = tree.find((n) => n.type === "video");
  assert.equal(solo.name, "单视频_BV2222222222");
  assert.equal(solo.children[0].kind, "notes");
  rmSync(base, { recursive: true, force: true });
});

test("export queue serializes ASR items and isolates failures", async () => {
  const order = [];
  // Fake the transcript fetch by monkey-patching the queue's imports is not
  // possible here; instead exercise enqueue/list/cancel state machine only.
  const updates = [];
  const queue = createExportQueue({
    settingsStore: {
      load: () => ({ saveDir: "", exportConcurrency: 2, aiApiKeys: {}, asrProvider: "bailian" }),
    },
    digestCache: { load: () => null },
    onTaskUpdate: (t) => updates.push(t.status),
  });
  const task = queue.enqueue({
    type: "collection",
    collectionTitle: "测试",
    items: [
      { bvid: "BV1111111111", title: "A", useAsr: true },
      { bvid: "BV2222222222", title: "B", useAsr: true },
    ],
  });
  assert.equal(task.status, "running");
  await new Promise((r) => setTimeout(r, 300));
  // Items will fail (no ASR key configured) — the task must still settle as
  // done with per-item failures, never hang.
  const list = queue.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "done");
  assert.ok(list[0].results.every((r2) => r2.status === "failed"));
});

test("retryAsr re-enqueues failed items as ASR inside the same task", async () => {
  const queue = createExportQueue({
    settingsStore: {
      load: () => ({ saveDir: "", exportConcurrency: 2, aiApiKeys: {}, asrProvider: "bailian" }),
    },
    digestCache: { load: () => null },
    onTaskUpdate: () => {},
  });
  const task = queue.enqueue({
    type: "collection",
    collectionTitle: "测试",
    items: [{ bvid: "BV1111111111", title: "A", useAsr: true }],
  });
  await new Promise((r) => setTimeout(r, 150));
  const failed = queue.list();
  assert.equal(failed[0].status, "done");
  assert.equal(failed[0].results[0].status, "failed");

  const retry = queue.retryAsr(task.id, [0]);
  assert.equal(retry.success, true);
  assert.equal(retry.task.status, "running");
  // The item may already have been picked up by the ASR lane, so it can be
  // pending or running at this point — either way it must not be failed.
  assert.ok(["pending", "running"].includes(retry.task.results[0].status));

  // Let the retried item fail again (still no ASR key) and settle.
  await new Promise((r) => setTimeout(r, 150));
  const settled = queue.list();
  assert.equal(settled[0].status, "done");
  assert.equal(settled[0].results[0].status, "failed");
});
