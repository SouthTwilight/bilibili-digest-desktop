import { test } from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_ENTRY_BYTES, utf8Bytes, compressFolder } from "../src/main/core/archive.js";

const base = fileURLToPath(new URL("./tmp-archive/", import.meta.url));
const bytes = utf8Bytes;

function write(path, content = "# 内容") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function fixture() {
  rmSync(base, { recursive: true, force: true });
  const a = join(base, "合集A");
  const b = join(base, "合集B");
  const up = join(base, "某UP主");
  write(join(a, "视频一_BV1111111111", "视频一_2026-01-01_10-00.md"), "# 视频一字幕");
  write(join(a, "视频一_BV1111111111", "AI总结_视频一.md"), "# 视频一总结");
  write(join(a, "视频一_BV1111111111", "笔记_视频一_2026-01-02_09-00.md"), "# 笔记");
  write(join(a, "视频一_BV1111111111", "notes.json"), "{}");
  write(join(a, "视频一_BV1111111111", "picture", "01-02_abcd1234.jpg"), "jpg");
  write(join(b, "视频二_BV2222222222", "视频二_P2_2026-01-01_10-00.md"), "# P2 字幕");
  write(join(up, "视频三_BV3333333333", "视频三_2026-01-01_10-00.html"), "<p>网页</p>");
  return { a, b, up };
}

const zipsInBase = () => readdirSync(base).filter((name) => name.endsWith(".zip"));
const entriesOf = (file) => new AdmZip(file).getEntries().map((entry) => entry.entryName).sort();
const textOf = (file, name) => new AdmZip(file).readAsText(name);

test("compressFolder：一个文件夹压成一个 zip，包内是全部内容、真实相对路径，不区分类型", async () => {
  const { a } = fixture();
  const result = await compressFolder({ saveDir: base, dirPath: a });
  assert.equal(result.success, true, result.error);
  assert.ok(result.file.startsWith(join(base, "合集A_")) && result.file.endsWith(".zip"), result.file);
  assert.deepEqual(entriesOf(result.file), [
    "视频一_BV1111111111/AI总结_视频一.md",
    "视频一_BV1111111111/notes.json",
    "视频一_BV1111111111/picture/01-02_abcd1234.jpg",
    "视频一_BV1111111111/笔记_视频一_2026-01-02_09-00.md",
    "视频一_BV1111111111/视频一_2026-01-01_10-00.md",
  ]);
  assert.equal(textOf(result.file, "视频一_BV1111111111/视频一_2026-01-01_10-00.md"), "# 视频一字幕");
  assert.equal(textOf(result.file, "视频一_BV1111111111/AI总结_视频一.md"), "# 视频一总结");
  assert.equal(readFileSync(join(a, "视频一_BV1111111111", "notes.json"), "utf8"), "{}", "原文件不动");
  assert.equal(result.files, 5);
  // 名字原样保留：包里没有清单文件，也没有任何被改过的路径。
  assert.ok(!entriesOf(result.file).some((entry) => /manifest/i.test(entry)));
  rmSync(base, { recursive: true, force: true });
});

test("compressFolder：勾选几个就出几个压缩包，各管各的内容", async () => {
  const { a, b, up } = fixture();
  const ra = await compressFolder({ saveDir: base, dirPath: a });
  const rb = await compressFolder({ saveDir: base, dirPath: b });
  const rup = await compressFolder({ saveDir: base, dirPath: up });
  assert.deepEqual([ra.success, rb.success, rup.success], [true, true, true]);
  assert.equal(zipsInBase().length, 3);
  assert.deepEqual(entriesOf(rb.file), ["视频二_BV2222222222/视频二_P2_2026-01-01_10-00.md"]);
  assert.deepEqual(entriesOf(rup.file), ["视频三_BV3333333333/视频三_2026-01-01_10-00.html"]);
  rmSync(base, { recursive: true, force: true });
});

test("compressFolder：每压完一个文件报一次进度，数到（总数, 总数）为止", async () => {
  const { a } = fixture();
  const progress = [];
  const result = await compressFolder({
    saveDir: base,
    dirPath: a,
    onProgress: (done, total) => progress.push([done, total]),
  });
  assert.equal(result.success, true, result.error);
  assert.deepEqual(progress, [
    [1, 5],
    [2, 5],
    [3, 5],
    [4, 5],
    [5, 5],
  ]);
  // 不传回调也照常压缩。
  const plain = await compressFolder({ saveDir: base, dirPath: a });
  assert.equal(plain.success, true, plain.error);
  rmSync(base, { recursive: true, force: true });
});

test("compressFolder：压缩期间主线程是空闲的（界面不会卡住）", async () => {
  rmSync(base, { recursive: true, force: true });
  // 随机内容压不动，压缩要花上一会儿。
  const folder = join(base, "大文件夹");
  for (let i = 0; i < 40; i += 1) write(join(folder, "截图", `${i}.jpg`), randomBytes(512 * 1024));

  let ticks = 0;
  let ticksAtFirstFile = null;
  // 定时器只在主线程空闲时触发。第一个文件压完之后其余 39 个还在压缩，
  // 这段时间里它会跳几十次（本机实测 55 次）；一次性同步压缩的话一次都不会跳。
  const timer = setInterval(() => {
    ticks += 1;
  }, 5);
  try {
    const result = await compressFolder({
      saveDir: base,
      dirPath: folder,
      onProgress: (done) => {
        if (done === 1) ticksAtFirstFile = ticks;
      },
    });
    assert.equal(result.success, true, result.error);
    assert.equal(result.files, 40);
  } finally {
    clearInterval(timer);
  }
  assert.notEqual(ticksAtFirstFile, null);
  assert.ok(ticks - ticksAtFirstFile >= 5, `压缩期间主线程只跳了 ${ticks - ticksAtFirstFile} 次定时器`);
  rmSync(base, { recursive: true, force: true });
});

test("compressFolder：包内路径正好 260 字节可以压缩，路径一字不改", async () => {
  rmSync(base, { recursive: true, force: true });
  // 压缩包里的路径是相对被压缩文件夹的，所以长的那一段要放在文件夹里面：
  // 84 个汉字的子目录 = 252 字节，加斜杠 253；"abcd.md" 7 字节，正好 260。
  const folder = join(base, "合集");
  write(join(folder, "中".repeat(84), "abcd.md"), "# 边界");
  const inside = `${"中".repeat(84)}/abcd.md`;
  assert.equal(bytes(inside), 260);
  assert.equal(MAX_ENTRY_BYTES, 260, "资源管理器的实测上限：260 字节能列出，261 起整个压缩包打不开");
  const result = await compressFolder({ saveDir: base, dirPath: folder });
  assert.equal(result.success, true, result.error);
  assert.deepEqual(entriesOf(result.file), [inside]);
  rmSync(base, { recursive: true, force: true });
});

test("compressFolder：包内路径 261 字节就失败并说明原因，不写压缩包，也不缩短任何名字", async () => {
  rmSync(base, { recursive: true, force: true });
  // 261 字节：子目录 252 + 斜杠 1 + "abcde.md" 8。
  const folder = join(base, "合集");
  write(join(folder, "中".repeat(84), "abcde.md"), "# 超长");
  const inside = `${"中".repeat(84)}/abcde.md`;
  assert.equal(bytes(inside), 261);
  const before = readdirSync(join(folder, "中".repeat(84)));

  const result = await compressFolder({ saveDir: base, dirPath: folder });
  assert.equal(result.success, false);
  assert.ok(result.error.startsWith("1 个文件的路径超过 260 字节"), result.error);
  assert.match(result.error, /资源管理器/);
  assert.match(result.error, /已取消压缩/);
  assert.ok(result.error.includes("261 字节"), "指出超了多少：" + result.error);
  assert.ok(result.error.endsWith(inside), `错误末尾原样给出这个路径：${result.error}`);
  assert.deepEqual(zipsInBase(), [], "没有写出压缩包");
  assert.deepEqual(readdirSync(join(folder, "中".repeat(84))), before, "原文件夹一字未动");
  rmSync(base, { recursive: true, force: true });
});

test("compressFolder：只要有一个文件超长，整个文件夹就取消压缩（不留半个包）", async () => {
  rmSync(base, { recursive: true, force: true });
  const folder = join(base, "合集");
  write(join(folder, "正常.md"), "# 正常");
  write(join(folder, `${"中".repeat(85)}_P12_2026-11-23_21-47.md`), "# 超长");
  const result = await compressFolder({ saveDir: base, dirPath: folder });
  assert.equal(result.success, false);
  // 任务页一行只显示得下开头十几个字，所以数量和上限放在最前面。
  assert.ok(result.error.startsWith("1 个文件的路径超过 260 字节，资源管理器打不开"), result.error);
  assert.deepEqual(zipsInBase(), []);
  rmSync(base, { recursive: true, force: true });
});

test("compressFolder：旧版本导出的长名字合集（94 分P那个的形态）会失败，新版本的短名字不会", async () => {
  rmSync(base, { recursive: true, force: true });
  // 47 字合集名下：60 字视频名 + 60 字文件名，路径 286 字节——旧版截断规则留下的样子。
  const old = join(base, "旧合集");
  const head = "字".repeat(60);
  write(join(old, `${head}_BV1xwVr6FEh4`, `${head}_P75_2026-11-23_21-47.md`), "# 旧名字");
  const failed = await compressFolder({ saveDir: base, dirPath: old });
  assert.equal(failed.success, false, "286 字节的路径超过上限");
  assert.match(failed.error, /_P75_2026-11-23_21-47\.md$/);

  // 新版浓缩后的名字：标题段最多 30 字。
  const fresh = join(base, "新合集");
  const short = "字".repeat(30);
  write(join(fresh, `${short}_BV1xwVr6FEh4`, `${short}_P75_2026-11-23_21-47.md`), "# 新名字");
  write(join(fresh, `${short}_BV1xwVr6FEh4`, `AI总结_${short}_P75.md`), "# 新总结");
  write(join(fresh, `${short}_BV1xwVr6FEh4`, "picture", "01-02_abcd1234.jpg"), "jpg");
  const ok = await compressFolder({ saveDir: base, dirPath: fresh });
  assert.equal(ok.success, true, ok.error);
  for (const entry of entriesOf(ok.file)) assert.ok(bytes(entry) <= MAX_ENTRY_BYTES, `${bytes(entry)}: ${entry}`);
  rmSync(base, { recursive: true, force: true });
});

test("compressFolder：同一分钟内重复压缩不覆盖上一个压缩包", async () => {
  const { a } = fixture();
  const first = await compressFolder({ saveDir: base, dirPath: a });
  utimesSync(first.file, new Date("2026-01-01"), new Date("2026-01-01"));
  const second = await compressFolder({ saveDir: base, dirPath: a });
  assert.notEqual(first.file, second.file);
  assert.match(second.file, / \(2\)\.zip$/);
  assert.equal(zipsInBase().length, 2);
  rmSync(base, { recursive: true, force: true });
});

test("compressFolder：只接受导出库根目录下的一级文件夹，空文件夹报错", async () => {
  const { a } = fixture();
  mkdirSync(join(base, "空文件夹"), { recursive: true });
  const reject = async (dirPath, message) => {
    const result = await compressFolder({ saveDir: base, dirPath });
    assert.equal(result.success, false, `${dirPath} 不应成功`);
    assert.match(result.error, message);
  };
  await reject(join(a, "视频一_BV1111111111"), /根目录/);
  await reject(join(base, "空文件夹"), /空的/);
  await reject(join(base, "..", "elsewhere"), /根目录/);
  await reject(join(base, "不存在"), /根目录/);
  assert.deepEqual(zipsInBase(), []);
  // 保存目录写成正斜杠、带不带末尾斜杠都认得出来。
  const ok = await compressFolder({ saveDir: `${base.replace(/\\/g, "/")}/`, dirPath: a.replace(/\\/g, "/") });
  assert.equal(ok.success, true, ok.error);
  assert.equal(zipsInBase().length, 1);
  rmSync(base, { recursive: true, force: true });
});
