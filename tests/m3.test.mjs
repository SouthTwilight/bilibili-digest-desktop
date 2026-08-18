import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTranslatedSegmentBatch } from "../src/main/core/translation.js";
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

