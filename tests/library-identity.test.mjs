import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, renameSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exportTargetPath } from "../src/main/core/export-queue.js";
import { createNotesStore } from "../src/main/core/notes.js";
import {
  findVideoDir,
  videoHeadOf,
  scanFolderForSummary,
  scanLibraryForSummary,
  summaryTargetFor,
  markExported,
} from "../src/main/core/library.js";
import { summarizeExportedDoc, summarizeDocsBatch } from "../src/main/core/summarize-doc.js";
import { parseDocName, partText } from "../src/main/core/naming.js";

const TMP = fileURLToPath(new URL("./tmp-library-identity/", import.meta.url));
const settings = { provider: "glm", aiApiKeys: { glm: "key" } };

const ctx = (base, bvid, videoTitle, extra = {}) => ({
  base,
  collectionTitle: "我的合集",
  channelName: "某UP",
  videoTitle,
  bvid,
  pageCount: 1,
  page: 1,
  ...extra,
});
const noteFor = (bvid, videoTitle, extra = {}) => ({
  bvid,
  timestamp: 5,
  text: `笔记 ${bvid}`,
  videoTitle,
  channelName: "某UP",
  collectionTitle: "我的合集",
  ...extra,
});

// 把一份导出落盘，做法与导出队列一致。
async function exportDoc(context, page = 1) {
  const file = await exportTargetPath(context, { page });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# ${context.videoTitle}\n\n## 完整字幕\n第 ${page}P 的内容`, "utf8");
  return file;
}

// 把保存目录垫到指定长度，用来复现“很深的保存目录”。
function padTo(path, length) {
  if (path.length >= length) return path;
  const padded = join(path, "深".repeat(length - path.length - 1));
  mkdirSync(padded, { recursive: true });
  return padded;
}

// 模型把批量提示词里的 <<<文档 i/n：名字>>> 原样回成 <<<总结：名字>>>。
const echoMarkers = async ({ messages }) =>
  [...String(messages[0].content).matchAll(/<<<文档 \d+\/\d+：(.+?)>>>/g)]
    .map((match) => `<<<总结：${match[1]}>>>\n# ${match[1]} 的总结`)
    .join("\n\n");

test("一个视频一个目录：先导出后记笔记、先记笔记后导出、深路径被截短、手动移动，都是同一个目录", async () => {
  rmSync(TMP, { recursive: true, force: true });
  const base = join(TMP, "lib");
  let saveDir = base;
  const notesStore = createNotesStore({ saveDirResolver: () => saveDir, legacyPath: null });

  // 先导出，后记笔记。
  const exported = await exportDoc(ctx(base, "BV1exportfirst", "视频一"));
  await notesStore.add(noteFor("BV1exportfirst", "视频一"));
  assert.ok(existsSync(join(dirname(exported), "notes.json")), "笔记写进了导出目录");

  // 先记笔记，后导出。
  await notesStore.add(noteFor("BV1notesfirst", "视频二"));
  const afterNotes = await exportDoc(ctx(base, "BV1notesfirst", "视频二"));
  assert.ok(existsSync(join(dirname(afterNotes), "notes.json")), "导出写进了笔记所在目录");

  // 标题变了（UP主改名、上下文来源不同）也还是同一个目录，文件标题段取自目录名。
  const retitled = await exportDoc(ctx(base, "BV1notesfirst", "UP主改过的新标题"));
  assert.equal(dirname(retitled), dirname(afterNotes));
  assert.ok(basename(retitled).startsWith("视频二_"), basename(retitled));

  // 在资源管理器里把目录改名、挪到别的合集下面。
  const moved = join(base, "我整理过的合集", "我改的名字_BV1exportfirst");
  mkdirSync(dirname(moved), { recursive: true });
  renameSync(dirname(exported), moved);
  const afterMove = await exportDoc(ctx(base, "BV1exportfirst", "视频一"));
  assert.equal(dirname(afterMove), moved, "照样找得到被移动的目录");
  assert.equal(videoHeadOf(dirname(afterMove)), "我改的名字", "文件标题段跟着目录名");
  assert.equal(findVideoDir(base, "bv1EXPORTfirst"), moved, "BV 号不分大小写");

  // 很深的保存目录：导出时目录名被截短，之后记笔记不能再算出一个没截短的目录。
  const deep = padTo(join(TMP, "deep"), 150);
  saveDir = deep;
  const deepTitle = "很长的标题".repeat(12);
  const deepFile = await exportDoc(ctx(deep, "BV1deep", deepTitle));
  assert.ok(basename(dirname(deepFile)).endsWith("_BV1deep"), "目录再短，_BV号 不丢");
  assert.ok(basename(dirname(deepFile)).length < 73, "目录名确实被截短过");
  await notesStore.add(noteFor("BV1deep", deepTitle));
  assert.ok(existsSync(join(dirname(deepFile), "notes.json")), "笔记写进了被截短的那个目录");
  assert.ok(!existsSync(join(deep, "我的合集", `${deepTitle.slice(0, 60)}_BV1deep`)), "没有另建第二个目录");
  assert.equal(findVideoDir(deep, "BV1deep"), dirname(deepFile));

  // 同一视频第二个分P的导出也落在这里。
  const deepP2 = await exportDoc(ctx(deep, "BV1deep", deepTitle, { pageCount: 2, page: 2 }), 2);
  assert.equal(dirname(deepP2), dirname(deepFile));
  rmSync(TMP, { recursive: true, force: true });
});

test("保存目录深到放不下时报清楚的错（PATH_TOO_LONG）；放得下的文件照常写入", async () => {
  rmSync(TMP, { recursive: true, force: true });
  const isTooLong = (error) => error.code === "PATH_TOO_LONG" && /保存目录/.test(error.message);
  const title = "很长的标题".repeat(8);

  // 200 字符深：目录名压到最短后 notes.json 还放得下（241），导出文件压到最短也放不下。
  const tight = padTo(join(TMP, "tight"), 200);
  const notesStore = createNotesStore({ saveDirResolver: () => tight, legacyPath: null });
  await assert.rejects(exportDoc(ctx(tight, "BV1tight", title)), isTooLong);
  const note = await notesStore.add(noteFor("BV1tight", title));
  assert.ok(note.id, "notes.json 放得下，笔记照常保存");
  const notesFile = join(findVideoDir(tight, "BV1tight"), "notes.json");
  assert.ok(existsSync(notesFile) && notesFile.length <= 245, `notesFile=${notesFile.length}`);

  // 220 字符深：连 notes.json 都放不下，两件事都报错，而不是写坏或 ENOENT。
  const hopeless = padTo(join(TMP, "hopeless"), 220);
  const hopelessNotes = createNotesStore({ saveDirResolver: () => hopeless, legacyPath: null });
  await assert.rejects(exportDoc(ctx(hopeless, "BV1hopeless", title)), isTooLong);
  await assert.rejects(hopelessNotes.add(noteFor("BV1hopeless", title)), isTooLong);
  assert.equal(findVideoDir(hopeless, "BV1hopeless"), null, "没有留下半个目录");
  rmSync(TMP, { recursive: true, force: true });
});

test("总结按分P身份定位：已有总结沿用原文件名，首次总结跟着文档名，重跑原地覆盖", async () => {
  rmSync(TMP, { recursive: true, force: true });
  const dir = join(TMP, "我的合集", "视频_BV1summary");
  mkdirSync(dir, { recursive: true });
  // 导出文件名被路径预算截到 44 字，磁盘上却有一份按 60 字标题命名的旧总结（没有标记）。
  const docHead = "字".repeat(44);
  const doc = (name) => join(dir, name);
  writeFileSync(doc(`${docHead}_2026-11-23_21-47.md`), `# ${"字".repeat(80)}\n\n正文`, "utf8");
  writeFileSync(doc(`AI总结_${"字".repeat(60)}.md`), "# 旧总结");
  // P2：旧总结的标题段和文档毫无共同之处，只靠 _P2 标记对应。
  writeFileSync(doc(`${docHead}_P2_2026-11-23_21-47.md`), `# ${"字".repeat(80)}\n\n正文`, "utf8");
  writeFileSync(doc("AI总结_完全不同的标题_P2.md"), "# P2 旧总结");

  assert.equal(summaryTargetFor(doc(`${docHead}_2026-11-23_21-47.md`)), doc(`AI总结_${"字".repeat(60)}.md`));
  assert.equal(summaryTargetFor(doc(`${docHead}_P2_2026-11-23_21-47.md`)), doc("AI总结_完全不同的标题_P2.md"));

  // 重跑：覆盖原文件，不另起一个名字。
  const rerun = await summarizeExportedDoc({
    settings,
    filePath: doc(`${docHead}_P2_2026-11-23_21-47.md`),
    requestCompletion: async () => "# P2 新总结",
  });
  assert.equal(rerun.file, doc("AI总结_完全不同的标题_P2.md"));
  assert.equal(readFileSync(rerun.file, "utf8"), "# P2 新总结\n");

  // 还没有总结的 P3：新建，名字取自文档。
  writeFileSync(doc(`${docHead}_P3_2026-11-23_21-47.md`), `# ${"字".repeat(80)}\n\n正文`, "utf8");
  assert.equal(summaryTargetFor(doc(`${docHead}_P3_2026-11-23_21-47.md`)), doc(`AI总结_${docHead}_P3.md`));

  // 批量对话框：两条已有总结不再预勾选，P3 需要总结。
  const entries = scanFolderForSummary(TMP, join(TMP, "我的合集")).videos;
  assert.deepEqual(
    entries.map((entry) => [parseDocName(basename(entry.file)).part, entry.hasSummary]),
    [["p1", true], ["p2", true], ["p3", false]],
  );
  rmSync(TMP, { recursive: true, force: true });
});

test("回归：真实的 80 字标题 × 94 个分P × 文件名被截短的目录深度，94 份总结各带正确的 _Pn", async () => {
  rmSync(TMP, { recursive: true, force: true });
  const title =
    "【全748集】目前B站最全最细的AI Agent开发零基础教程，2026最新版，包含所有干货！七天就能从小白到大神！少走99%的弯路！学完即就业，带你玩转AI！";
  const collection = "【全748集】目前B站最全最细的AI Agent开发零基础教程，2026最新版，包含所有干货！";
  // 真实环境里保存目录 53 字 + 合集 47 字 + 视频目录 73 字 = 175 字，导出文件名被截短——
  // 触发原 bug 的条件（文件名标题段 44 字 ≠ H1 前 60 字）。
  const base = padTo(join(TMP, "lib"), 60);
  const context = { base, collectionTitle: collection, channelName: "AI大模型码农", videoTitle: title, bvid: "BV1xwVr6FEh4", pageCount: 94 };
  const docs = [];
  for (let page = 1; page <= 94; page += 1) docs.push(await exportDoc({ ...context, page }, page));

  // 前提：文件名确实被截短过。仓库检出得越深这里就越深——P1 的名字没有分P后缀，空间富余
  // 几格时它的标题段会比其他分P长，所以只要求都短于上限，不要求一样长。
  const docHeads = [...new Set(docs.map((file) => parseDocName(basename(file)).head.length))];
  assert.ok(Math.max(...docHeads) < 60, `前提：文件名标题段确实被截短过（${docHeads.join("/")} 字）`);
  assert.equal(docs.filter((file) => !/_P\d+_\d{4}-/.test(basename(file))).length, 1, "只有 P1 不带标记");

  // 前 47 份走单文档路径，其余每 8 份一组走批量路径——与任务队列的分组一致。
  for (const file of docs.slice(0, 47)) {
    await summarizeExportedDoc({ settings, filePath: file, requestCompletion: async () => "# 总结" });
  }
  for (let i = 47; i < docs.length; i += 8) {
    await summarizeDocsBatch({ settings, docs: docs.slice(i, i + 8).map((filePath) => ({ filePath })), requestCompletion: echoMarkers });
  }

  const summaries = readdirSync(dirname(docs[0])).filter((name) => /^AI总结_/.test(name));
  assert.equal(summaries.length, 94, `应当恰好 94 份总结，实际 ${summaries.length} 份`);
  const byPart = new Map(summaries.map((name) => [parseDocName(name).part, name]));
  assert.equal(byPart.size, 94, "每份总结对应一个不同的分P");
  for (const file of docs) {
    const doc = parseDocName(basename(file));
    assert.equal(byPart.get(doc.part), `AI总结_${doc.head}${partText(doc.part)}.md`, `P${doc.part} 的总结文件名`);
  }

  // 重新打开批量对话框：94 条都识别为已总结，不会再被预勾选、重复计费。
  const entries = scanFolderForSummary(base, dirname(docs[0])).videos;
  assert.equal(entries.length, 94);
  assert.ok(entries.every((entry) => entry.hasSummary), entries.filter((entry) => !entry.hasSummary).length.toString());
  const wholeLibrary = scanLibraryForSummary(base).videos.filter((entry) => entry.dir === dirname(docs[0]));
  assert.equal(wholeLibrary.length, 94);
  assert.ok(wholeLibrary.every((entry) => entry.hasSummary));
  rmSync(TMP, { recursive: true, force: true });
});

test("批量总结：不同目录里标题相同的文档各写各的，不会被拼进同一份", async () => {
  rmSync(TMP, { recursive: true, force: true });
  const docA = join(TMP, "合集", "甲_BV1same", "文档A_2026-01-01_10-00.md");
  const docB = join(TMP, "合集", "乙_BV2same", "文档B_2026-01-01_10-00.md");
  for (const file of [docA, docB]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "# 同一个标题\n\n正文", "utf8");
  }
  const result = await summarizeDocsBatch({ settings, docs: [{ filePath: docA }, { filePath: docB }], requestCompletion: echoMarkers });
  assert.equal(result.soloFallback, 0);
  assert.equal(readFileSync(join(dirname(docA), "AI总结_文档A.md"), "utf8"), "# 同一个标题 的总结\n");
  assert.equal(readFileSync(join(dirname(docB), "AI总结_文档B.md"), "utf8"), "# 同一个标题 (2) 的总结\n");
  rmSync(TMP, { recursive: true, force: true });
});

test("拒绝对总结、笔记这类派生文件再做总结", async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  for (const name of ["AI总结_视频.md", "笔记_视频_2026-01-01_10-00.md", "notes.json"]) {
    writeFileSync(join(TMP, name), "# x", "utf8");
    await assert.rejects(
      summarizeExportedDoc({ settings, filePath: join(TMP, name), requestCompletion: async () => "x" }),
      (error) => error.code === "NOT_A_DOCUMENT",
      name,
    );
  }
  rmSync(TMP, { recursive: true, force: true });
});

test("findVideoDir：同一 BV 有多个目录时取文件最多的那个；没有则返回 null", () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, "合集", "甲_BV1dup"), { recursive: true });
  for (const name of ["a.md", "b.md", "c.md"]) writeFileSync(join(TMP, "合集", "甲_BV1dup", name), "# t");
  mkdirSync(join(TMP, "别的合集", "乙_BV1dup"), { recursive: true });
  writeFileSync(join(TMP, "别的合集", "乙_BV1dup", "a.md"), "# t");
  assert.equal(findVideoDir(TMP, "bv1DUP"), join(TMP, "合集", "甲_BV1dup"));
  assert.equal(findVideoDir(TMP, "BV1none"), null);
  assert.equal(findVideoDir(TMP, ""), null);
  assert.equal(findVideoDir("", "BV1dup"), null);
  rmSync(TMP, { recursive: true, force: true });
});

test("markExported：分P标记只认文件名末尾，标题里的 _P3 不算；P 子目录也算已导出", () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, "合集", "教程_P3入门_BV1intitle"), { recursive: true });
  writeFileSync(join(TMP, "合集", "教程_P3入门_BV1intitle", "教程_P3入门_2026-01-01_10-00.md"), "# t");
  mkdirSync(join(TMP, "多P视频_BV1folders", "P1"), { recursive: true });
  mkdirSync(join(TMP, "多P视频_BV1folders", "P2"), { recursive: true });
  writeFileSync(join(TMP, "多P视频_BV1folders", "P2", "多P视频_2026-01-01_10-00.md"), "# t");
  // 目录里有一份总结带着 _P4，但 P4 的文档并不存在。
  writeFileSync(join(TMP, "多P视频_BV1folders", "P2", "AI总结_多P视频_P4.md"), "# t");

  const [inTitle, folders] = markExported(TMP, "合集", [
    { bvid: "BV1intitle", pageCount: 5 },
    { bvid: "BV1folders", pageCount: 5 },
  ]);
  assert.deepEqual(inTitle.newPages, [2, 3, 4, 5], "标题里的 _P3 没有被当成已导出的 P3");
  assert.deepEqual(folders.newPages, [3, 4, 5], "P1、P2 子目录算已导出，总结里的 _P4 不算");
  rmSync(TMP, { recursive: true, force: true });
});
