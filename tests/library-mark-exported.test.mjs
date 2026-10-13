import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { exportedBvids, markExported } from "../src/main/core/library.js";

function makeLibrary(root) {
  // 合集目录：两个已导出视频
  mkdirSync(join(root, "GitHub一周热点汇总", "第110期标题_BV1aaa"), { recursive: true });
  mkdirSync(join(root, "GitHub一周热点汇总", "多P视频_BV1bbb"), { recursive: true });
  writeFileSync(join(root, "GitHub一周热点汇总", "第110期标题_BV1aaa", "第110期标题_2026-09-01_10-00.md"), "# t");
  // 多P视频：P1 无标记（单P旧导出）+ P2 标记文件 → 本地 P 集合 {1,2}
  writeFileSync(join(root, "GitHub一周热点汇总", "多P视频_BV1bbb", "多P视频_2026-09-01_10-00.md"), "# t");
  writeFileSync(join(root, "GitHub一周热点汇总", "多P视频_BV1bbb", "多P视频_P2_2026-09-01_10-00.md"), "# t");
  // 全库兜底目标：其他合集里的 BV1ccc
  mkdirSync(join(root, "别的合集", "某视频_BV1ccc"), { recursive: true });
  writeFileSync(join(root, "别的合集", "某视频_BV1ccc", "某视频_2026-09-01_10-00.md"), "# t");
}

test("exportedBvids collects BV suffixes from the collection dir", () => {
  const root = join("tests", "tmp-lib-mark");
  rmSync(root, { recursive: true, force: true });
  makeLibrary(root);
  const set = exportedBvids(root, "GitHub一周热点汇总");
  assert.ok(set.has("BV1aaa"));
  assert.ok(set.has("BV1bbb"));
  assert.ok(!set.has("BV1ccc")); // 不在本合集目录
  assert.equal(exportedBvids(root, "不存在的合集") instanceof Set, true);
  rmSync(root, { recursive: true, force: true });
});

test("markExported flags exported, falls back to whole-library, and diffs new P", () => {
  const root = join("tests", "tmp-lib-mark2");
  rmSync(root, { recursive: true, force: true });
  makeLibrary(root);
  const videos = [
    { bvid: "BV1aaa", title: "第110期标题", pageCount: 1 },
    { bvid: "BV1bbb", title: "多P视频", pageCount: 4 },
    { bvid: "BV1ccc", title: "某视频", pageCount: 1 }, // 在别的合集——全库兜底应命中
    { bvid: "BV1new", title: "新视频", pageCount: 1 },
    { bvid: "BV1nopages", title: "无P数据" }, // pageCount 缺失：不检测分P
  ];
  const marked = markExported(root, "GitHub一周热点汇总", videos);
  const by = (bv) => marked.find((v) => v.bvid === bv);
  assert.equal(by("BV1aaa").exported, true);
  assert.deepEqual(by("BV1aaa").newPages, []);
  assert.equal(by("BV1bbb").exported, true);
  assert.deepEqual(by("BV1bbb").newPages, [3, 4]); // 本地 {1,2}，远端 4P
  assert.equal(by("BV1ccc").exported, true); // 兜底命中
  assert.equal(by("BV1new").exported, false);
  assert.equal(by("BV1nopages").exported, false);
  assert.deepEqual(by("BV1nopages").newPages, []); // pageCount 缺失静默跳过
  rmSync(root, { recursive: true, force: true });
});

test("a 全部P file marks the video fully covered for P diff", () => {
  const root = join("tests", "tmp-lib-mark3");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "合集", "多P视频_BV1fff"), { recursive: true });
  writeFileSync(join(root, "合集", "多P视频_BV1fff", "多P视频_全部P_2026-09-01_10-00.md"), "# t");
  const [marked] = markExported(root, "合集", [{ bvid: "BV1fff", title: "多P视频", pageCount: 9 }]);
  assert.equal(marked.exported, true);
  assert.deepEqual(marked.newPages, []);
  rmSync(root, { recursive: true, force: true });
});
