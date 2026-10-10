import { test } from "node:test";
import assert from "node:assert/strict";
import { fitSegments, fitUnder } from "../src/main/core/paths.js";
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
