import { test } from "node:test";
import assert from "node:assert/strict";
import {
  splitDocIntoChunks,
  sanitizeFocus,
  buildSynthesisFocusInstruction,
} from "../src/main/core/summarize-doc.js";

test("sanitizeFocus: 空值容错、去首尾、保留中间换行、500 字截断", () => {
  assert.equal(sanitizeFocus(undefined), "");
  assert.equal(sanitizeFocus(null), "");
  assert.equal(sanitizeFocus(123), "123");
  assert.equal(sanitizeFocus("  列出电影和配乐  "), "列出电影和配乐");
  assert.ok(sanitizeFocus("多行\n方向\n保留换行").includes("\n"));
  assert.equal(sanitizeFocus("x".repeat(600)).length, 500);
});

test("buildSynthesisFocusInstruction: 空方向返回空串，非空返回保留合并指令", () => {
  assert.equal(buildSynthesisFocusInstruction(""), "");
  assert.equal(buildSynthesisFocusInstruction("   "), "");
  const text = buildSynthesisFocusInstruction("列出电影和配乐");
  assert.match(text, /列出电影和配乐/);
  assert.match(text, /专属章节/);
  assert.match(text, /保留并合并/);
});
