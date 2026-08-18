import { test } from "node:test";
import assert from "node:assert/strict";
import { createNotesStore, videoFolderName } from "../src/main/core/notes.js";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TMP = new URL("./tmp-notes-dir/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function freshStore(saveDir) {
  rmSync(TMP, { recursive: true, force: true });
  return createNotesStore({ saveDirResolver: () => saveDir, legacyPath: null });
}

test("video folder names combine sanitized title and bvid", () => {
  assert.equal(videoFolderName("你好：世界/测试*", "BV1234567890"), "你好世界测试_BV1234567890");
  assert.equal(videoFolderName("", "BV1234567890"), "未命名视频_BV1234567890");
});

test("notes land in collection/video folders inside the save dir", () => {
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
    channelName: "UP",
    collectionTitle: "",
  });

  const collFile = join(TMP, "我的合集", "合集里的视频_BV1111111111", "notes.json");
  const soloFile = join(TMP, "独立视频_BV2222222222", "notes.json");
  assert.ok(existsSync(collFile), "collection layout");
  assert.ok(existsSync(soloFile), "standalone layout");

  const forVideo = store.listFor({ bvid: "BV1111111111", videoTitle: "合集里的视频", collectionTitle: "我的合集" });
  assert.equal(forVideo.length, 1);
  assert.equal(forVideo[0].text, "合集视频笔记");

  const all = store.listAll();
  assert.equal(all.length, 2);

  store.remove(all.find((n) => n.bvid === "BV2222222222").id);
  assert.equal(store.listAll().length, 1);
});

test("save dir change is picked up dynamically", () => {
  rmSync(TMP, { recursive: true, force: true });
  let dir = join(TMP, "a");
  const store = createNotesStore({ saveDirResolver: () => dir, legacyPath: null });
  store.add({ bvid: "BV3333333333", timestamp: 1, text: "x", videoTitle: "T", channelName: "", collectionTitle: "" });
  assert.ok(existsSync(join(TMP, "a", "T_BV3333333333", "notes.json")));
  dir = join(TMP, "b");
  store.add({ bvid: "BV3333333333", timestamp: 2, text: "y", videoTitle: "T", channelName: "", collectionTitle: "" });
  assert.ok(existsSync(join(TMP, "b", "T_BV3333333333", "notes.json")));
  rmSync(TMP, { recursive: true, force: true });
});
