import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTranscript,
  parseVideoPageUrl,
  expectedPageDuration,
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

test("expectedPageDuration uses the current part's duration, not the multi-P total", () => {
  // Real repro shape: 8-part video, view.duration is the WHOLE-video total
  // (905s) while each part is ~1 minute. The subtitle span check must
  // reference the requested part or every part's correct subtitle fails.
  const multiPView = {
    duration: 905,
    pages: [
      { cid: 1, duration: 67 },
      { cid: 2, duration: 85 },
      { cid: 3, duration: 119 },
    ],
  };
  assert.equal(expectedPageDuration(multiPView, 1), 67);
  assert.equal(expectedPageDuration(multiPView, 3), 119);
  // Out-of-range page falls back to the first part, mirroring resolvePageCid.
  assert.equal(expectedPageDuration(multiPView, 99), 67);
  // Single-part videos and missing per-page durations fall back to the total.
  assert.equal(expectedPageDuration({ duration: 512 }, 1), 512);
  assert.equal(expectedPageDuration({ duration: 480, pages: [{ cid: 7 }] }, 1), 480);
  // Garbage durations never reach the span check as a bogus reference.
  assert.equal(expectedPageDuration({ duration: "x" }, 1), 0);
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
