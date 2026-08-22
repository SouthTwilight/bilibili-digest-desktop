import { test } from "node:test";
import assert from "node:assert/strict";
import { splitDocIntoChunks } from "../src/main/core/summarize-doc.js";

test("short documents stay in one chunk, unchanged", () => {
  const content = "# 标题\n\n## 第一节\n内容";
  assert.deepEqual(splitDocIntoChunks(content, 1000), [content]);
});

test("long documents split at H2 boundaries and keep sections whole", () => {
  const section = (n) => `## P${n} 第${n}部分\n${`第${n}节的字幕行内容。\n`.repeat(20)}`;
  const content = ["# 多P视频导出", "", ...[1, 2, 3, 4].map(section)].join("\n");
  const chunks = splitDocIntoChunks(content, 300);
  assert.ok(chunks.length >= 2, `chunks=${chunks.length}`);
  // Nothing lost and order preserved.
  assert.equal(chunks.flatMap((c) => c.split("\n")).join("\n"), content);
  // A whole (small) section never straddles a chunk boundary.
  for (const chunk of chunks) {
    const heads = (chunk.match(/^## /gm) || []).length;
    const full = (chunk.match(/^## P\d+ 第\d+部分$/gm) || []).length;
    assert.equal(heads, full, chunk.slice(0, 60));
  }
});

test("a single oversized section is hard-split by lines", () => {
  const content = `## 巨型章节\n${"行内容。\n".repeat(200)}`;
  const chunks = splitDocIntoChunks(content, 200);
  assert.ok(chunks.length >= 2, `chunks=${chunks.length}`);
  assert.equal(chunks.flatMap((c) => c.split("\n")).join("\n"), content);
});
