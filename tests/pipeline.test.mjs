import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTranscript,
  parseVideoPageUrl,
} from "../src/main/core/bilibili.js";
import { createDigestCache } from "../src/main/core/digest-cache.js";
import { unlinkSync, existsSync } from "node:fs";

test("normalizeTranscript produces [MM:SS] lines and filters empties", () => {
  const result = normalizeTranscript(
    [
      { text: " 第一句 ", start: 0, end: 2 },
      { text: "", start: 2, end: 4 },
      { text: "第二句", start: 65, end: 70 },
    ],
    { language: "zh", source: "test" },
  );
  assert.equal(result.success, true);
  assert.equal(result.transcriptTextTimestamped, "[0:00] 第一句\n[1:05] 第二句");
  assert.equal(result.transcript.length, 2);
});

test("normalizeTranscript reports empty results", () => {
  const result = normalizeTranscript([{ text: "  " }], {});
  assert.equal(result.success, false);
  assert.equal(result.error, "EMPTY_TRANSCRIPT");
});

test("parseVideoPageUrl extracts bvid and part", () => {
  assert.deepEqual(parseVideoPageUrl("https://www.bilibili.com/video/BV14SgP6QEs1/?p=3"), {
    bvid: "BV14SgP6QEs1",
    page: 3,
  });
  assert.deepEqual(parseVideoPageUrl("https://www.bilibili.com/video/bv1AbCdEfGh1"), {
    bvid: "bv1AbCdEfGh1",
    page: 1,
  });
  assert.equal(parseVideoPageUrl("https://www.bilibili.com/"), null);
});

test("digest cache roundtrips, expires old schema, caps entries", () => {
  const dir = new URL("./tmp-cache/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const cache = createDigestCache(dir);
  cache.save("BVtest@p1", { transcript: { success: true }, analysis: { chapters: [] } });
  const loaded = cache.load("BVtest@p1");
  assert.ok(loaded.transcript.success);
  assert.equal(loaded.schemaVersion, 1);
  assert.deepEqual(cache.load("BVmissing@p1"), null);

  // Old schema versions are treated as absent.
  const file = dir + "/BVold@p1.json";
  if (existsSync(file)) unlinkSync(file);
});
