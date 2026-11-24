import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTitleCondenser,
  normalizeCondensed,
  needsCondense,
  CONDENSE_ABOVE,
  CONDENSE_MAX,
} from "../src/main/core/title-condense.js";
import { exportTargetPath } from "../src/main/core/export-queue.js";

const TMP = fileURLToPath(new URL("./tmp-title-condense/", import.meta.url));
const keyed = { provider: "glm", aiApiKeys: { glm: "key" }, condenseLongTitles: true };
// 这次事故里的真实标题：80 个字。
const longTitle =
  "【全748集】目前B站最全最细的AI Agent开发零基础教程，2026最新版，包含所有干货！七天就能从小白到大神！少走99%的弯路！学完即就业，带你玩转AI！";
const shortTitle = "Codex服务器连接配置";

function condenserWith(requestCompletion, settings = keyed, timeoutMs) {
  return createTitleCondenser({ settingsResolver: () => settings, requestCompletion, timeoutMs });
}

test("阈值：超过 30 个字才算超长，浓缩到 16 个字以内", () => {
  assert.equal(CONDENSE_ABOVE, 30);
  assert.equal(CONDENSE_MAX, 16);
  assert.equal(needsCondense("字".repeat(30)), false);
  assert.equal(needsCondense("字".repeat(31)), true);
  assert.equal(needsCondense(longTitle), true);
  assert.equal(needsCondense("   "), false);
});

test("normalizeCondensed：取首个有效行，去掉代码围栏、标签、引号、非法字符，压到 16 个字", () => {
  assert.equal(normalizeCondensed("AI Agent开发教程"), "AI Agent开发教程");
  assert.equal(normalizeCondensed("「AI Agent开发教程」\n\n以上是浓缩结果。"), "AI Agent开发教程");
  assert.equal(normalizeCondensed("```\nAI Agent开发教程\n```"), "AI Agent开发教程");
  assert.equal(normalizeCondensed("标题：AI Agent开发教程"), "AI Agent开发教程");
  assert.equal(normalizeCondensed("教程：入门篇"), "教程：入门篇".replace("：", ""), "标题正文里的冒号不是标签");
  assert.equal(normalizeCondensed("教程/P1:入门"), "教程P1入门");
  assert.equal(normalizeCondensed("字".repeat(100)).length, 16);
  assert.equal(normalizeCondensed("😀".repeat(40)), "😀".repeat(16), "按码点截，不切 emoji");
  assert.equal(normalizeCondensed("教程_P12"), "教程", "不会被读成分P标记");
  assert.equal(normalizeCondensed(""), "");
  assert.equal(normalizeCondensed("```\n```"), "");
  assert.equal(normalizeCondensed("///"), "");
});

test("30 个字以内的标题原样使用，不调用模型", async () => {
  let calls = 0;
  const decide = condenserWith(async () => {
    calls += 1;
    return "不该被调用";
  });
  assert.equal(await decide(shortTitle, "BV1", TMP), shortTitle);
  assert.equal(calls, 0);
});

test("超过 30 个字：调用一次模型，提示词带标题、UP主和字数上限，结果成为标题段", async () => {
  let prompt = "";
  let args = null;
  const decide = condenserWith(async (request) => {
    ({ messages: [{ content: prompt }] } = request);
    args = request;
    return "AI Agent开发零基础教程";
  });
  const head = await decide(longTitle, "BV2", TMP, { channelName: "AI大模型码农" });
  assert.equal(head, "AI Agent开发零基础教程");
  assert.ok(prompt.includes(longTitle), "完整标题进入提示词");
  assert.ok(prompt.includes("不超过 16 个字"), prompt);
  assert.ok(prompt.includes("AI大模型码农"), "UP主作为上下文");
  assert.equal(args.temperature, 0, "同一标题尽量得到同一个结果");
});

test("降级：没配 Key、设置关闭、请求失败、超时、结果不可用，都回退为 60 字截断且不抛错", async () => {
  const fallback = longTitle.slice(0, 60);
  const cases = [
    ["没配 Key", condenserWith(async () => "x", { provider: "glm", aiApiKeys: {} })],
    ["设置关闭", condenserWith(async () => "x", { ...keyed, condenseLongTitles: false })],
    ["请求失败", condenserWith(async () => { throw new Error("429 rate limited"); })],
    ["超时", condenserWith(() => new Promise(() => {}), keyed, 20)],
    ["空结果", condenserWith(async () => "   ")],
    ["只有符号", condenserWith(async () => "///")],
  ];
  for (const [name, decide] of cases) {
    const started = Date.now();
    assert.equal(await decide(longTitle, `BV-${name}`, TMP), fallback, name);
    assert.ok(Date.now() - started < 1000, `${name}：回退不能拖住写入`);
  }
});

test("结果超过 16 个字时压到 16 个字，而不是弃用", async () => {
  const decide = condenserWith(async () => "字".repeat(100));
  assert.equal((await decide(longTitle, "BV-long", TMP)).length, 16);
});

test("去重：同一视频本次会话内只定一次名；并发的相同请求只发一次", async () => {
  let calls = 0;
  const decide = condenserWith(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return `浓缩结果${calls}`;
  });
  const [a, b] = await Promise.all([decide(longTitle, "BV-same", TMP), decide(longTitle, "BV-same", TMP)]);
  assert.equal(calls, 1, "并发的两次调用共用一次请求");
  assert.equal(a, b);
  assert.equal(await decide(longTitle, "BV-same", TMP), a, "之后再问直接复用");
  assert.equal(calls, 1);
});

test("接入目录定位：新视频的目录用浓缩名、文件标题段跟目录名；已有目录不再调用模型", async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const context = {
    base: TMP,
    collectionTitle: "我的合集",
    channelName: "某UP",
    videoTitle: longTitle,
    bvid: "BV1newvideo",
    pageCount: 3,
    page: 2,
  };

  const decide = condenserWith(async () => "AI Agent开发教程");
  const file = await exportTargetPath(context, { page: 2, decideVideoHead: decide });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "# t", "utf8");
  assert.equal(basename(dirname(file)), "AI Agent开发教程_BV1newvideo");
  assert.match(basename(file), /^AI Agent开发教程_P2_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.md$/);
  assert.ok(!file.includes("【全748集】"), `浓缩后的路径里不再有 60 字的机械前缀：${file}`);

  // 目录已存在：标题变了也不重新起名，文件标题段取自目录名。
  let later = 0;
  const decideAgain = condenserWith(async () => {
    later += 1;
    return "另一个名字";
  });
  const again = await exportTargetPath(
    { ...context, videoTitle: "UP主后来改的标题", page: 3 },
    { page: 3, decideVideoHead: decideAgain },
  );
  assert.equal(later, 0, "已有目录不再调用模型");
  assert.equal(dirname(again), dirname(file), "仍然写进同一个目录");
  assert.match(basename(again), /^AI Agent开发教程_P3_/);
  rmSync(TMP, { recursive: true, force: true });
});
