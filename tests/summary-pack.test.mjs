import { test } from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import { mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packSummaries } from "../src/main/core/summary-pack.js";
import { scanFolderForSummary, scanLibraryForSummary } from "../src/main/core/library.js";

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

test("scanFolderForSummary 合集模式：每P一项、按P识别已有总结", () => {
  writeLibrary();
  const result = scanFolderForSummary(base, join(base, "合集"));
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

  const outside = scanFolderForSummary(base, "D:/elsewhere");
  assert.equal(outside.success, false);
  rmSync(base, { recursive: true, force: true });
});

test("scanFolderForSummary 独立多P视频文件夹：按导出文件直接条目化", () => {
  writeLibrary();
  const solo = join(base, "教程_BV9999999999");
  mkdirSync(solo, { recursive: true });
  writeFileSync(join(solo, "教程_P1_2026-01-01_10-00.md"), "# 教程 P1");
  writeFileSync(join(solo, "教程_P2_2026-01-01_10-00.md"), "# 教程 P2");
  writeFileSync(join(solo, "AI总结_教程_P1.md"), "# P1 总结");
  const result = scanFolderForSummary(base, solo);
  assert.equal(result.success, true);
  assert.equal(result.videos.length, 2);
  assert.equal(result.videos[0].name, "教程_P1");
  assert.equal(result.videos[1].name, "教程_P2");
  assert.equal(result.videos[0].hasSummary, true);
  assert.equal(result.videos[1].hasSummary, false);
  assert.equal(result.videos[0].dir, solo);
  rmSync(base, { recursive: true, force: true });
});

test("scanLibraryForSummary 全库递归：合集/UP/多P/旧布局全覆盖", () => {
  writeLibrary();
  // UP主分组：两个视频，其一已有总结。
  mkdirSync(join(base, "UP主甲", "视频甲_BV5555555555"), { recursive: true });
  mkdirSync(join(base, "UP主甲", "视频乙_BV6666666666"), { recursive: true });
  writeFileSync(join(base, "UP主甲", "视频甲_BV5555555555", "视频甲_2026-01-01_10-00.md"), "# 甲");
  writeFileSync(join(base, "UP主甲", "视频乙_BV6666666666", "视频乙_2026-01-01_10-00.md"), "# 乙");
  writeFileSync(join(base, "UP主甲", "视频乙_BV6666666666", "AI总结_视频乙.md"), "# 乙总结");
  // 多P视频：P1/P2 文件夹。
  mkdirSync(join(base, "教程_BV9999999999", "P1"), { recursive: true });
  mkdirSync(join(base, "教程_BV9999999999", "P2"), { recursive: true });
  writeFileSync(join(base, "教程_BV9999999999", "P1", "教程_P1_2026-01-01_10-00.md"), "# 教程 P1");
  writeFileSync(join(base, "教程_BV9999999999", "P2", "教程_P2_2026-01-01_10-00.md"), "# 教程 P2");
  // 旧布局：顶层独立视频文件夹直接放文件。
  mkdirSync(join(base, "旧视频_BV7777777777"), { recursive: true });
  writeFileSync(join(base, "旧视频_BV7777777777", "旧视频_2026-01-01_10-00.md"), "# 旧");

  const result = scanLibraryForSummary(base);
  assert.equal(result.success, true);
  const names = result.videos.map((v) => v.name);
  // writeLibrary 建的「合集」里 视频一 + 视频P（P1/P2），UP主 2 条，多P 2 条，旧布局 1 条。
  assert.ok(names.includes("合集/视频一_BV1111111111"), names.join(","));
  assert.ok(names.includes("合集/视频P_BV3333333333（P1）"), names.join(","));
  assert.ok(names.includes("UP主甲/视频甲_BV5555555555"), names.join(","));
  assert.ok(names.includes("教程_BV9999999999/P1"), names.join(","));
  assert.ok(names.includes("旧视频"), names.join(","));
  const upVideo = result.videos.find((v) => v.name === "UP主甲/视频乙_BV6666666666");
  assert.equal(upVideo.hasSummary, true);
  const part2 = result.videos.find((v) => v.name === "教程_BV9999999999/P2");
  assert.ok(part2.file.endsWith("教程_P2_2026-01-01_10-00.md"));
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

test("packSummaries 条目路径按 UTF-8 字节截短并保留 BV/_Pn 后缀（Explorer 256 字节限制）", () => {
  rmSync(base, { recursive: true, force: true });
  const long = "【全100集】已付费，允许白嫖！目前B站最全最细的WorkBuddy保姆级教程，2026最新《WorkBuddy》完整版";
  const videoDir = join(base, `${long}_BV1SRad6REzX`);
  mkdirSync(join(videoDir, "P1"), { recursive: true });
  writeFileSync(join(videoDir, "P1", `AI总结_${long}_P1.md`), "# P1");
  const result = packSummaries({ saveDir: base, collectionTitle: long, videoDirs: [videoDir] });
  assert.equal(result.success, true);
  assert.equal(result.files, 1);
  const zip = new AdmZip(readFileSync(result.file));
  const entry = zip.getEntries().find((e) => e.entryName.endsWith(".md"));
  assert.ok(entry, "总结条目存在");
  assert.ok(Buffer.byteLength(entry.entryName, "utf8") <= 240, `bytes=${Buffer.byteLength(entry.entryName, "utf8")}`);
  assert.match(entry.entryName, /\/P1\/AI总结_.*_P1\.md$/, entry.entryName);
  assert.match(entry.entryName, /_BV1SRad6REzX\//, "BV 后缀保留");
  assert.ok(result.file.split("\\").pop().length <= 60, result.file);
  rmSync(base, { recursive: true, force: true });
});

test("packSummaries 打包多P视频的 P 子文件夹（视频级入口）", () => {
  rmSync(base, { recursive: true, force: true });
  const videoDir = join(base, "多P_BV8888888888");
  mkdirSync(join(videoDir, "P1"), { recursive: true });
  mkdirSync(join(videoDir, "P2"), { recursive: true });
  writeFileSync(join(videoDir, "P1", "AI总结_多P_P1.md"), "# P1");
  writeFileSync(join(videoDir, "P2", "AI总结_多P_P2.md"), "# P2");
  const result = packSummaries({ saveDir: base, collectionTitle: "", videoDirs: [videoDir] });
  assert.equal(result.success, true);
  assert.equal(result.videos, 2);
  assert.equal(result.files, 2);
  const zip = new AdmZip(readFileSync(result.file));
  const names = zip.getEntries().map((e) => e.entryName);
  assert.ok(names.includes("多P_BV8888888888/P1/AI总结_多P_P1.md"), names.join(","));
  assert.ok(names.includes("多P_BV8888888888/P2/AI总结_多P_P2.md"), names.join(","));
  rmSync(base, { recursive: true, force: true });
});
