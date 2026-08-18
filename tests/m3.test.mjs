import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTranslatedSegmentBatch } from "../src/main/core/translation.js";
import { createNotesStore } from "../src/main/core/notes.js";
import { unlinkSync, existsSync } from "node:fs";

test("translation alignment drops bad rows and keeps valid ones", () => {
  const aligned = normalizeTranslatedSegmentBatch(
    {
      segments: [
        { id: "s0", text: "你好世界" },
        { id: "s1", text: "hello not chinese translation text here" },
        { id: "dup", text: "占位" },
        { id: "unknown-id", text: "未知" },
        { id: "s0", text: "重复ID应被忽略" },
      ],
    },
    [
      { id: "s0", text: "hello world and more text to satisfy latin letters" },
      { id: "s1", text: "another latin sentence for alignment checks here" },
    ],
  );
  assert.equal(aligned.segments[0].text, "你好世界");
  assert.equal(aligned.segments[0].error, "");
  assert.equal(aligned.segments[1].text, "");
  assert.notEqual(aligned.segments[1].error, "");
});

test("notes store add/list/delete roundtrip", () => {
  const path = new URL("./tmp-notes.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  if (existsSync(path)) unlinkSync(path);
  const store = createNotesStore(path);
  const note = store.add({ videoId: "BVx@p1", timestamp: 42, text: "要点", videoTitle: "T", channelName: "C" });
  assert.equal(store.list("BVx@p1").length, 1);
  assert.equal(store.list("BVy@p1").length, 0);
  assert.equal(store.list(null).length, 1);
  store.remove(note.id);
  assert.equal(store.list(null).length, 0);
  unlinkSync(path);
});
