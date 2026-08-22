import { test } from "node:test";
import assert from "node:assert/strict";
import { rememberFromDialog, CLOSE_RESPONSE } from "../src/main/core/close-policy.js";

test("close dialog responses map to stable button indices", () => {
  assert.equal(CLOSE_RESPONSE.MINIMIZE, 0);
  assert.equal(CLOSE_RESPONSE.QUIT, 1);
  assert.equal(CLOSE_RESPONSE.CANCEL, 2);
});

test("session memory only forms when the checkbox is ticked", () => {
  assert.equal(rememberFromDialog(CLOSE_RESPONSE.MINIMIZE, false), null);
  assert.equal(rememberFromDialog(CLOSE_RESPONSE.QUIT, false), null);
});

test("ticking the checkbox remembers the chosen action for this launch", () => {
  assert.equal(rememberFromDialog(CLOSE_RESPONSE.MINIMIZE, true), "minimize");
  assert.equal(rememberFromDialog(CLOSE_RESPONSE.QUIT, true), "quit");
});

test("cancel is never remembered, even with the checkbox ticked", () => {
  assert.equal(rememberFromDialog(CLOSE_RESPONSE.CANCEL, true), null);
});
