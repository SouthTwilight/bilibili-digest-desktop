import { test } from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import { mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packSummaries } from "../src/main/core/summary-pack.js";
import { scanCollectionForSummary } from "../src/main/core/library.js";

// fileURLToPath (not URL.pathname) so the path carries native separators —
// the modules under test compare it with startsWith against join()ed paths.
const base = fileURLToPath(new URL("./tmp-pack/", import.meta.url));

function writeLibrary() {
  rmSync(base, { recursive: true, force: true });
  const v1 = join(base, "合集", "视频一_BV1111111111");
  const v2 = join(base, "合集", "视频二_BV2222222222");
  const vp = join(base, "合集", "视频P_BV3333333333");
  mkdirSync(v1, { recursive: true });
  mkdirSync(v2, { recursive: true });
  mkdirSync(vp, { recursive: true });
  writeFileSync(join(v1, "视频一_2026-01-01_10-00.md"), "# 旧导出");
  writeFileSync(join(v1, "视频一_2026-02-01_10-00.md"), "# 新导出");
  // 同毫秒写入会让 mtime 相同——显式设定时间保证「取最新」可判定。
  utimesSync(join(v1, "视频一_2026-01-01_10-00.md"), new Date("2026-01-01"), new Date("2026-01-01"));
  utimesSync(join(v1, "视频一_2026-02-01_10-00.md"), new Date("2026-02-01"), new Date("2026-02-01"));
  writeFileSync(join(v1, "AI总结_视频一.md"), "# 视频一总结");
  writeFileSync(join(v2, "笔记_视频二.md"), "# 笔记不是输入");
  // 多P视频：每个P一份导出文档，P1 已有总结。
  writeFileSync(join(vp, "视频P_P1_2026-01-01_10-00.md"), "# P1 导出");
  writeFileSync(join(vp, "视频P_P2_2026-01-01_10-00.md"), "# P2 导出");
  writeFileSync(join(vp, "AI总结_视频P_P1.md"), "# P1 总结");
  return { v1, v2, vp };
}

test("scanCollectionForSummary 按文件条目化：每P一项、按P识别已有总结", () => {
  writeLibrary();
  const result = scanCollectionForSummary(base, join(base, "合集"));
  assert.equal(result.success, true);
  const one = result.videos.find((v) => v.name === "视频一_BV1111111111");
  assert.equal(one.hasSummary, true);
  assert.ok(one.file.endsWith("视频一_2026-02-01_10-00.md"), one.file);
  // 只有笔记的文件夹不产出条目（无可总结文档）。
  assert.ok(!result.videos.some((v) => v.name.startsWith("视频二")), result.videos.map((v) => v.name).join(","));
  // 多P文件夹：P1/P2 各一条，P1 已总结、P2 未总结，顺序按 P 编号。
  const parts = result.videos.filter((v) => v.dir === join(base, "合集", "视频P_BV3333333333"));
  assert.equal(parts.length, 2, parts.map((v) => v.name).join(","));
  assert.equal(parts[0].name, "视频P_BV3333333333（P1）");
  assert.equal(parts[1].name, "视频P_BV3333333333（P2）");
  assert.equal(parts[0].hasSummary, true);
  assert.equal(parts[1].hasSummary, false);
  assert.ok(parts[1].file.endsWith("视频P_P2_2026-01-01_10-00.md"));

  const outside = scanCollectionForSummary(base, "D:/elsewhere");
  assert.equal(outside.success, false);
  rmSync(base, { recursive: true, force: true });
});

test("packSummaries 输出含目录结构与 manifest 的 zip", () => {
  const { v1 } = writeLibrary();
  const result = packSummaries({
    saveDir: base,
    collectionTitle: "合集",
    videoDirs: [v1, join(base, "合集", "视频二_BV2222222222")],
  });
  assert.equal(result.success, true);
  assert.equal(result.videos, 1, "只有视频一有总结");
  assert.equal(result.files, 1);
  assert.ok(result.file.startsWith(base), result.file);
  assert.ok(/AI总结打包_合集_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.zip$/.test(result.file), result.file);

  const zip = new AdmZip(readFileSync(result.file));
  const entries = zip.getEntries().map((entry) => entry.entryName);
  assert.ok(entries.includes("合集/视频一_BV1111111111/AI总结_视频一.md"), entries.join(","));
  assert.ok(entries.includes("manifest.json"), entries.join(","));
  assert.equal(zip.readAsText("合集/视频一_BV1111111111/AI总结_视频一.md"), "# 视频一总结");
  const manifest = JSON.parse(zip.readAsText("manifest.json"));
  assert.equal(manifest.kind, "ai-summaries");
  assert.equal(manifest.collectionTitle, "合集");
  assert.deepEqual(manifest.videos, [{ folder: "视频一_BV1111111111", files: ["AI总结_视频一.md"] }]);
  rmSync(base, { recursive: true, force: true });
});

test("packSummaries 无任何总结文件时报错", () => {
  const { v2 } = writeLibrary();
  const result = packSummaries({ saveDir: base, collectionTitle: "合集", videoDirs: [v2] });
  assert.equal(result.success, false);
  assert.match(result.error, /还没有生成 AI 总结/);
  rmSync(base, { recursive: true, force: true });
});
