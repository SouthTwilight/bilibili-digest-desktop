import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HEAD_MAX,
  cleanTitle,
  clip,
  composeName,
  identityHead,
  partMarker,
  partText,
  videoDirName,
  collectionDirName,
  uploaderDirName,
  exportDocBase,
  summaryBase,
  parseDocName,
  parseVideoDirName,
} from "../src/main/core/naming.js";
import { sanitizeName, exportFileName } from "../src/main/core/export-render.js";

test("cleanTitle 只清理不截断：去掉非法字符、全角符号、控制字符，合并空白", () => {
  assert.equal(cleanTitle('AI课|A/B\\C:D*E?F"G<H>I|J'), "AI课ABCDEFGHIJ");
  assert.equal(cleanTitle("你好：世界／测试＊"), "你好世界测试");
  assert.equal(cleanTitle("  a \t\n b  "), "a b");
  assert.equal(cleanTitle("字".repeat(300)).length, 300, "清理本身不限长");
  assert.equal(cleanTitle(null), "");
  assert.equal(cleanTitle(undefined), "");
});

test("clip 按码点截断：不切开 emoji，不留末尾空格或点", () => {
  const emoji = "😀"; // 一个码点，两个 UTF-16 码元
  assert.equal(clip("字".repeat(100), 16).length, 16);
  assert.equal(clip(emoji.repeat(10), 5), emoji.repeat(5));
  assert.equal(clip("a b c d e f", 4), "a b", "第 4 个字符是空格，截掉");
  assert.equal(clip("名称...", 60), "名称", "末尾的点会被 Windows 丢掉，所以不留");
  assert.equal(clip("字".repeat(59) + emoji, 60), "字".repeat(59) + emoji);
  assert.equal(clip("短", 60), "短");
});

test("composeName：任何长度的标题，后缀都完整接在截断之后", () => {
  for (let n = 0; n <= 300; n += 1) {
    const title = `标题${"字".repeat(n)}`;
    const name = composeName(title, HEAD_MAX, "_P75", "_2026-11-23_21-47", ".md");
    assert.ok(name.endsWith("_P75_2026-11-23_21-47.md"), `n=${n}: ${name}`);
    assert.ok(name.length <= HEAD_MAX + "_P75_2026-11-23_21-47.md".length, `n=${n}`);
  }
  assert.equal(composeName("  视频  ", HEAD_MAX, "_BV1"), "视频_BV1");
});

test("identityHead 去掉会被读成标记的结尾；标题中间的同类文本不受影响", () => {
  assert.equal(identityHead("教程_P12"), "教程");
  assert.equal(identityHead("视频_BV1xwVr6FEh4"), "视频");
  assert.equal(identityHead("合集_全部P"), "合集");
  assert.equal(identityHead("视频_2026-11-23_21-47"), "视频");
  assert.equal(identityHead("第3期 P12 讲解"), "第3期 P12 讲解");
  assert.equal(identityHead("字".repeat(58) + "_P12"), "字".repeat(58), "截断切出残缺标记也清掉");
  assert.equal(identityHead("_P12"), "");
});

test("目录名：视频带 _BV号，合集/UP 空名有兜底，标题段不超过 60", () => {
  assert.equal(videoDirName("你好：世界/测试*", "BV1234567890"), "你好世界测试_BV1234567890");
  assert.equal(videoDirName("", "BV1234567890"), "未命名视频_BV1234567890");
  assert.equal(videoDirName("字".repeat(100), "BV1"), "字".repeat(60) + "_BV1");
  assert.equal(collectionDirName(" 我的 合集 "), "我的 合集");
  assert.equal(collectionDirName("///"), "合集");
  assert.equal(collectionDirName("字".repeat(80)), "字".repeat(60));
  assert.equal(uploaderDirName(""), "其他UP主");
  assert.equal(uploaderDirName("字".repeat(80)), "字".repeat(60));
});

test("导出文件名：P1 无标记，P2 起带 _Pn，标题再长标记也不丢", () => {
  assert.equal(partMarker(1), "");
  assert.equal(partMarker(2), "_P2");
  assert.equal(partMarker("all"), "_全部P");
  assert.equal(exportDocBase("视频", 1, "2026-01-01_10-00"), "视频_2026-01-01_10-00");
  assert.equal(exportDocBase("视频", 12, "2026-01-01_10-00"), "视频_P12_2026-01-01_10-00");
  assert.equal(exportDocBase("", 1, "2026-01-01_10-00"), "bilibili-digest_2026-01-01_10-00");
  assert.equal(exportDocBase("字".repeat(100), 75, "2026-11-23_21-47"), "字".repeat(60) + "_P75_2026-11-23_21-47");
  assert.equal(exportDocBase("教程_P12", 3, "s"), "教程_P3_s", "标题自带的假标记不进入文件名");
  assert.equal(exportDocBase("AI总结", 2, "s"), "视频_AI总结_P2_s", "不会被读成一份总结文件");
  assert.equal(parseDocName("视频_AI总结_P2_s.md").kind, "doc");
});

test("parseDocName：种类、分P身份、时间戳", () => {
  assert.deepEqual(pick(parseDocName("视频_2026-01-01_10-00.md")), {
    kind: "doc", head: "视频", part: "p1", stamp: "_2026-01-01_10-00", ext: ".md",
  });
  assert.equal(parseDocName("视频_P2_2026-01-01_10-00.md").part, "p2");
  assert.equal(parseDocName("视频_P1_2026-01-01_10-00.md").part, "p1", "_P1 与无标记是同一身份");
  assert.equal(parseDocName("视频_全部P_2026-01-01_10-00.md").part, "all");
  assert.equal(parseDocName("教程_P12.html").kind, "doc");
  assert.equal(parseDocName("AI总结_视频_P12.md").kind, "summary");
  assert.equal(parseDocName("AI总结_视频_P12.md").head, "视频");
  assert.equal(parseDocName("AI总结_视频_P12.md").derived, false);
  assert.equal(parseDocName("AI总结_AI总结_视频.md").derived, true);
  assert.equal(parseDocName("AI总结_视频 学习笔记.md").derived, true);
  assert.equal(parseDocName("笔记_视频_2026-01-01_10-00.md").kind, "notes");
  assert.equal(parseDocName("笔记_视频_2026-01-01_10-00.md").part, null);
  assert.equal(parseDocName("notes.json").kind, "other");
  assert.equal(parseDocName("").kind, "other");
  assert.equal(partText("p1"), "");
  assert.equal(partText("p12"), "_P12");
  assert.equal(partText("all"), "_全部P");
});

test("写出的名字都能原样读回：标题 0–300 字 × 对抗性标题 × 各分P", () => {
  const adversarial = [
    "", "视频", "教程_P12", "视频_BV1x4", "a/b:c", "  空格  标题 ", "emoji 😀 标题",
    "名字...", "字".repeat(300), "a|b*c?d", "AI总结", "笔记_课", "结尾是空格   ",
  ];
  const titles = [...adversarial, ...Array.from({ length: 301 }, (_, n) => `t${"字".repeat(n)}`)];
  for (const title of titles) {
    for (const page of [1, 2, 12, "all"]) {
      const where = `${JSON.stringify(title.slice(0, 20))}|${page}`;
      const base = exportDocBase(title, page, "2026-11-23_21-47");
      const doc = parseDocName(`${base}.md`);
      assert.equal(doc.kind, "doc", where);
      assert.equal(doc.stamp, "_2026-11-23_21-47", where);
      assert.equal(doc.part, page === 1 ? "p1" : page === "all" ? "all" : `p${page}`, where);
      assert.equal(doc.head + partText(doc.part) + doc.stamp, base, where);

      // 总结文件名跟着文档走，读回的是同一个身份。
      const summary = parseDocName(`${summaryBase(doc)}.md`);
      assert.equal(summary.kind, "summary", where);
      assert.equal(summary.part, doc.part, where);
      assert.equal(summary.derived, false, where);
    }
  }
});

test("parseVideoDirName：取最后一个 BV 号作身份，前面都算标题", () => {
  assert.deepEqual(parseVideoDirName("视频_BV1xwVr6FEh4"), { head: "视频", bvid: "BV1xwVr6FEh4" });
  assert.deepEqual(parseVideoDirName("BV1aa讲解_BV1bb"), { head: "BV1aa讲解", bvid: "BV1bb" });
  assert.equal(parseVideoDirName("我的合集"), null);
  assert.equal(parseVideoDirName("P12"), null);
});

test("sanitizeName / exportFileName 仍可用，并走同一套规则", () => {
  assert.equal(sanitizeName("AI游戏开发速成课|AI生成卡牌游戏美术素材"), "AI游戏开发速成课AI生成卡牌游戏美术素材");
  assert.equal(sanitizeName("字".repeat(100)).length, 60);
  assert.match(exportFileName("视频", 2), /^视频_P2_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$/);
  assert.doesNotMatch(exportFileName("视频", 1), /_P1_/);
});

function pick({ kind, head, part, stamp, ext }) {
  return { kind, head, part, stamp, ext };
}
