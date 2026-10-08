import { test } from "node:test";
import assert from "node:assert/strict";
import { splitDocIntoChunks, summarizeExportedDoc } from "../src/main/core/summarize-doc.js";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

const tmp = fileURLToPath(new URL("./tmp-summarize-doc/", import.meta.url));
const settings = { provider: "glm", aiApiKeys: { glm: "key" } };

test("summarizeExportedDoc 单块：注入 focus、透传进度、写出 AI总结_", async () => {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const src = join(tmp, "视频A_BV1_2026-01-01_10-00.md");
  writeFileSync(src, "# 视频A\n\n## 完整字幕\n第一句", "utf8");
  const progress = [];
  const result = await summarizeExportedDoc({
    settings,
    filePath: src,
    focus: "  留意配置步骤  ",
    onProgress: (title, subtitle) => progress.push([title, subtitle]),
    requestCompletion: async ({ messages }) => {
      assert.ok(String(messages[0].content).includes("留意配置步骤"), "focus 进入提示词");
      assert.ok(String(messages[0].content).includes("视频A"), "文档标题进入提示词");
      return "# 总结结果\n内容";
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.videoName, "视频A");
  assert.ok(result.file.endsWith(join(tmp, "AI总结_视频A.md")), result.file);
  assert.equal(readFileSync(result.file, "utf8"), "# 总结结果\n内容\n");
  assert.ok(progress.length >= 1, "至少一条进度");
  rmSync(tmp, { recursive: true, force: true });
});

test("summarizeExportedDoc 长文档走分块 + 合成", async () => {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const src = join(tmp, "长视频_BV2.md");
  // 三个大节拼出超过 100k 字符的文档，强制分块。
  const section = (n) => `## P${n} 第${n}部分\n${`第${n}节的字幕内容行，补足长度用。\n`.repeat(2500)}`;
  const content = ["# 长视频", "", section(1), section(2), section(3)].join("\n");
  writeFileSync(src, content, "utf8");
  const expectedChunks = splitDocIntoChunks(content, 100_000);
  assert.ok(expectedChunks.length >= 2, `chunks=${expectedChunks.length}`);

  const subtitles = [];
  const calls = [];
  const result = await summarizeExportedDoc({
    settings,
    filePath: src,
    onProgress: (_title, subtitle) => subtitles.push(subtitle),
    requestCompletion: async ({ messages }) => {
      calls.push(String(messages[0].content));
      return "块总结";
    },
  });
  assert.equal(result.success, true);
  // 每块各一次 + 最终合成一次。
  assert.equal(calls.length, expectedChunks.length + 1, `calls=${calls.length}`);
  assert.match(calls[calls.length - 1], /综合成一份完整的总结文档/);
  assert.match(calls[calls.length - 1], /--- 第 1 块总结 ---/);
  assert.ok(subtitles.some((s) => /正在总结第 1\/\d+ 块/.test(s)), subtitles.join("|"));
  assert.ok(subtitles.includes("最后一步"));
  assert.ok(result.file.endsWith(join(tmp, "AI总结_长视频.md")), result.file);
  rmSync(tmp, { recursive: true, force: true });
});

test("summarizeExportedDoc 错误抛给调用方（NO_AI_KEY 保留错误码）", async () => {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const src = join(tmp, "视频B_BV3.md");
  writeFileSync(src, "# 视频B\n内容", "utf8");
  const noKey = new Error("GLM 5.2 API key not configured. 请先在设置中填写。");
  noKey.code = "NO_AI_KEY";
  await assert.rejects(
    summarizeExportedDoc({
      settings,
      filePath: src,
      requestCompletion: async () => {
        throw noKey;
      },
    }),
    (error) => error.code === "NO_AI_KEY",
  );
  rmSync(tmp, { recursive: true, force: true });
});
