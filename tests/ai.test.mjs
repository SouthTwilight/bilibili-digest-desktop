import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLooseJson,
  validateAndFixTimestamps,
  loadPromptSection,
} from "../src/main/core/ai.js";

test("parseLooseJson tolerates fences, prose, and trailing commas", () => {
  assert.deepEqual(parseLooseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseLooseJson('好的，结果如下：{"a": [1, 2, ]} 以上'), { a: [1, 2] });
  assert.deepEqual(parseLooseJson('{"a": {"b": 2,}}'), { a: { b: 2 } });
});

test("validateAndFixTimestamps drops invalid entries and sorts the rest", () => {
  const fixed = validateAndFixTimestamps(
    {
      chapters: [
        { title: "B", timestampSeconds: 120, summary: "s" },
        { title: "A", timestampSeconds: 60 },
        { title: "bad", timestampSeconds: 99999 },
        { title: "no-time" },
      ],
      keyQuotes: [{ quote: "q", timestampSeconds: 30 }, { quote: "over", timestampSeconds: -5 }],
      keyMoments: [10, 99999, 20],
    },
    600,
  );
  assert.equal(fixed.chapters.length, 2);
  assert.equal(fixed.chapters[0].title, "A");
  assert.equal(fixed.chapters[0].timestamp, "1:00");
  assert.equal(fixed.chapters[1].timestamp, "2:00");
  assert.equal(fixed.keyQuotes.length, 1);
  assert.deepEqual(fixed.keyMoments, [10, 20]);
});

test("prompt sections load and substitute variables", () => {
  const prompt = loadPromptSection("analysis.md", "User prompt", {
    videoTitle: "测试视频",
    transcriptText: "[0:01] 你好",
  });
  assert.ok(prompt.includes("测试视频"));
  assert.ok(prompt.includes("[0:01] 你好"));
  assert.ok(!prompt.includes("{videoTitle}"));
  assert.ok(!prompt.includes("{transcriptText}"));
});
