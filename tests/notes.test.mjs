import { test } from "node:test";
import assert from "node:assert/strict";
import { createNotesStore, videoFolderName, resolveVideoDir } from "../src/main/core/notes.js";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TMP = fileURLToPath(new URL("./tmp-notes-dir/", import.meta.url));

function freshStore(saveDir) {
  rmSync(TMP, { recursive: true, force: true });
  return createNotesStore({ saveDirResolver: () => saveDir, legacyPath: null });
}

test("video folder names combine sanitized title and bvid", () => {
  assert.equal(videoFolderName("你好：世界/测试*", "BV1234567890"), "你好世界测试_BV1234567890");
  assert.equal(videoFolderName("", "BV1234567890"), "未命名视频_BV1234567890");
});

test("resolveVideoDir 三级结构：合集 / UP主分组 / 多P按P文件夹", () => {
  const base = "D:/save";
  assert.equal(
    resolveVideoDir({ base, collectionTitle: "合集", videoTitle: "视频", bvid: "BV1" }),
    join(base, "合集", "视频_BV1"),
  );
  assert.equal(
    resolveVideoDir({ base, channelName: "某UP", videoTitle: "视频", bvid: "BV1" }),
    join(base, "某UP", "视频_BV1"),
  );
  assert.equal(
    resolveVideoDir({ base, channelName: "某UP", videoTitle: "视频", bvid: "BV1", pageCount: 3, page: 2 }),
    join(base, "视频_BV1", "P2"),
  );
  // 未知 UP 名落到「其他UP主」，页码缺省回 P1。
  assert.equal(
    resolveVideoDir({ base, videoTitle: "视频", bvid: "BV1", pageCount: 2 }),
    join(base, "视频_BV1", "P1"),
  );
});

test("notes land in collection / uploader / per-P folders", () => {
  const store = freshStore(TMP);
  store.add({
    bvid: "BV1111111111",
    timestamp: 42,
    text: "合集视频笔记",
    videoTitle: "合集里的视频",
    channelName: "UP",
    collectionTitle: "我的合集",
  });
  store.add({
    bvid: "BV2222222222",
    timestamp: 7,
    text: "单视频笔记",
    videoTitle: "独立视频",
    channelName: "UP主甲",
    collectionTitle: "",
  });
  store.add({
    bvid: "BV3333333333",
    timestamp: 9,
    text: "P2 的笔记",
    videoTitle: "多P视频",
    channelName: "UP主乙",
    collectionTitle: "",
    pageCount: 3,
    page: 2,
  });

  const collFile = join(TMP, "我的合集", "合集里的视频_BV1111111111", "notes.json");
  const soloFile = join(TMP, "UP主甲", "独立视频_BV2222222222", "notes.json");
  const partFile = join(TMP, "多P视频_BV3333333333", "P2", "notes.json");
  assert.ok(existsSync(collFile), "collection layout");
  assert.ok(existsSync(soloFile), "uploader layout");
  assert.ok(existsSync(partFile), "per-P layout");

  const forVideo = store.listFor({ bvid: "BV1111111111", videoTitle: "合集里的视频", collectionTitle: "我的合集" });
  assert.equal(forVideo.length, 1);
  assert.equal(forVideo[0].text, "合集视频笔记");

  const forPart = store.listFor({ bvid: "BV3333333333", videoTitle: "多P视频", collectionTitle: "", channelName: "UP主乙", pageCount: 3, page: 2 });
  assert.equal(forPart.length, 1);
  assert.equal(forPart[0].videoId, "BV3333333333@p2");

  const all = store.listAll();
  assert.equal(all.length, 3);

  store.remove(all.find((n) => n.bvid === "BV2222222222").id);
  assert.equal(store.listAll().length, 2);
});

test("save dir change is picked up dynamically", () => {
  rmSync(TMP, { recursive: true, force: true });
  let dir = join(TMP, "a");
  const store = createNotesStore({ saveDirResolver: () => dir, legacyPath: null });
  store.add({ bvid: "BV3333333333", timestamp: 1, text: "x", videoTitle: "T", channelName: "", collectionTitle: "" });
  assert.ok(existsSync(join(TMP, "a", "其他UP主", "T_BV3333333333", "notes.json")));
  dir = join(TMP, "b");
  store.add({ bvid: "BV3333333333", timestamp: 2, text: "y", videoTitle: "T", channelName: "", collectionTitle: "" });
  assert.ok(existsSync(join(TMP, "b", "其他UP主", "T_BV3333333333", "notes.json")));
  rmSync(TMP, { recursive: true, force: true });
});

test("listAll 同时收集多P视频的旧直接 notes.json 与新 P*/notes.json", () => {
  const store = freshStore(TMP);
  // 旧布局：多P视频文件夹里直接有 notes.json。
  store.add({ bvid: "BV4444444444", timestamp: 1, text: "旧笔记", videoTitle: "多P旧", channelName: "", collectionTitle: "" });
  // 新布局：同一视频的 P2 文件夹里也有 notes.json。
  store.add({ bvid: "BV4444444444", timestamp: 2, text: "P2 新笔记", videoTitle: "多P旧", channelName: "", collectionTitle: "", pageCount: 2, page: 2 });
  const all = store.listAll();
  assert.equal(all.length, 2);
  assert.ok(all.some((n) => n.text === "旧笔记"));
  assert.ok(all.some((n) => n.text === "P2 新笔记"));
  rmSync(TMP, { recursive: true, force: true });
});
