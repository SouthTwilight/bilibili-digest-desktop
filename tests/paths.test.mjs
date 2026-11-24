import { test } from "node:test";
import assert from "node:assert/strict";
import { fitSegments, fitUnder, fitDirUnder, assertFits, MIN_FILE_RESERVE } from "../src/main/core/paths.js";
import { join } from "node:path";

test("fitSegments 放行正常长度路径（零改动、零迁移成本）", () => {
  const segments = ["合集A", "视频一_BV1111111111", "视频一_P2_2026-01-01_10-00.md"];
  assert.deepEqual(fitSegments("D:\\save", segments), segments);
});

test("fitSegments 超预算时先截文件名（保留 _Pn/时间戳/扩展名），再截视频文件夹（保留 _BV）", () => {
  const long = "字".repeat(60);
  const segments = [
    long, // 合集
    `${long}_BV1SRad6REzX`, // 视频文件夹
    `P12`,
    `${long}_P12_2026-01-01_10-00.md`, // 文件名
  ];
  const fitted = fitSegments("D:\\cache\\bilibili_degest", segments);
  const total = join("D:\\cache\\bilibili_degest", ...fitted).length;
  assert.ok(total <= 245, `total=${total}`);
  assert.match(fitted[3], /_P12_2026-01-01_10-00\.md$/, fitted[3]);
  assert.match(fitted[1], /_BV1SRad6REzX$/, fitted[1]);
  assert.equal(fitted[2], "P12", "P 文件夹永不截短");
});

test("fitUnder 返回拼接好的路径且超深 saveDir 不崩溃（尽力而为）", () => {
  const deep = ["D:\\", ...Array(20).fill("很深的目录名")].join("\\");
  const path = fitUnder(deep, "合集", "视频_BV1SRad6REzX", "视频_2026-01-01_10-00.md");
  assert.ok(typeof path === "string" && path.length > 0);
  // 常规场景等于普通 join。
  assert.equal(fitUnder("D:\\s", "a", "b.md"), join("D:\\s", "a", "b.md"));
});

test("建目录时按文件夹规则截短，给最小文件名留出空间，_BV 不丢", () => {
  const long = "字".repeat(60);
  const base = `D:\\${"很深的目录名".repeat(20)}`; // 143 字符
  const fitted = fitSegments(base, [long, `${long}_BV1SRad6REzX`, "P12"], 245, {
    reserve: MIN_FILE_RESERVE,
    dirsOnly: true,
  });
  assert.ok(join(base, ...fitted).length + MIN_FILE_RESERVE <= 245, `dir=${join(base, ...fitted).length}`);
  assert.match(fitted[1], /_BV1SRad6REzX$/, "视频文件夹的身份后缀保留");
  assert.equal(fitted[2], "P12", "P 文件夹永不截短");
  // 留出的空间确实放得下一个压到最短的导出文件。
  const shortest = "字".repeat(16) + "_P12_2026-01-01_10-00.html";
  assert.ok(join(join(base, ...fitted), shortest).length <= 245);
  assert.equal(fitDirUnder("D:\\s", "a", "b"), join("D:\\s", "a", "b"), "常规长度原样返回");
});

test("截断按码点进行：emoji 不被切成半个，_全部P 标记保留，末尾不留空格", () => {
  const base = `D:\\${"深".repeat(200)}`;
  // 30 个 emoji = 60 个 UTF-16 码元，正好是一个完整标题段的长度。
  const emojiName = `${"😀".repeat(30)}_全部P_2026-01-01_10-00.md`;
  const [fittedEmoji] = fitSegments(base, [emojiName]);
  assert.ok(fittedEmoji.isWellFormed(), `半个代理对: ${fittedEmoji.length}`);
  // 后缀共 24 个码元，标题段按 8 个码元一档往下截：60→52→44→36→28→20，再往下
  // 会跌破 16 码元的下限，所以停在 16 码元 = 8 个完整的 emoji。
  assert.equal(fittedEmoji, `${"😀".repeat(8)}_全部P_2026-01-01_10-00.md`);
  assert.equal(join(base, fittedEmoji).length, 244, "结果必须在预算之内");

  // 第 52 个字符是空格：截到 52 位后不能以空格结尾（Windows 会把它丢掉）。
  const spaced = `${"字".repeat(51)} ${"字".repeat(8)}_2026-01-01_10-00.md`;
  const [fittedSpaced] = fitSegments(base, [spaced]);
  assert.ok(!/ _2026-01-01_10-00\.md$/.test(fittedSpaced), fittedSpaced.slice(-30));
  assert.match(fittedSpaced, /_2026-01-01_10-00\.md$/);
});

test("assertFits：放得下原样返回，放不下抛出带说明的 PATH_TOO_LONG 而不是 ENOENT", () => {
  assert.equal(assertFits("D:\\s\\a.md"), "D:\\s\\a.md");
  assert.throws(
    () => assertFits(`D:\\${"字".repeat(300)}`),
    (error) => error.code === "PATH_TOO_LONG" && /260/.test(error.message),
  );
});

test("不变量：保存目录 0–200 字符深 × 纯汉字/含 emoji/带空格的长文件名，能放下就一定放得下", () => {
  const heads = ["字".repeat(60), "😀".repeat(30), `${"字".repeat(30)}😀${"字".repeat(28)}`, "a b ".repeat(12).trim()];
  const suffixes = ["_P12_2026-01-01_10-00.md", "_2026-01-01_10-00.html", ".md"];
  for (let depth = 0; depth <= 200; depth += 1) {
    const base = `D:\\${"深".repeat(depth)}`;
    for (const head of heads) {
      for (const suffix of suffixes) {
        // 一个下限长度的文件名放得下，就说明这条路本来能放下。
        const shortest = `${"字".repeat(16)}${suffix}`;
        const achievable = join(base, shortest).length <= 245;
        if (!achievable) continue;
        const where = `depth=${depth} head=${Array.from(head).length} suffix=${suffix}`;
        const [fitted] = fitSegments(base, [`${head}${suffix}`]);
        assert.ok(fitted.isWellFormed(), `半个代理对 ${where}`);
        assert.ok(fitted.endsWith(suffix), `后缀丢失 ${where}: ${fitted}`);
        assert.ok(!/[ .]_\d{4}|[ .]\.[a-z0-9]+$/i.test(fitted), `末尾残留空格 ${where}`);
        assert.ok(join(base, fitted).length <= 245, `超预算 ${where}: ${join(base, fitted).length}`);
      }
    }
  }
});
