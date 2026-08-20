import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  clampSidebarWidth,
  computeViewBounds,
} from "../src/main/core/layout.js";

test("layout constants match the documented sidebar range", () => {
  assert.equal(SIDEBAR_MIN_WIDTH, 400);
  assert.equal(SIDEBAR_MAX_WIDTH, 820);
});

test("clampSidebarWidth clamps to min/max and rounds", () => {
  assert.equal(clampSidebarWidth(100), 400);
  assert.equal(clampSidebarWidth(9999), 820);
  assert.equal(clampSidebarWidth(512.6), 513);
  assert.equal(clampSidebarWidth(480), 480);
});

test("normal layout: view sits right of the sidebar, below the toolbar", () => {
  assert.deepEqual(
    computeViewBounds({ fullscreen: false, windowWidth: 1440, windowHeight: 900, sidebarWidth: 480 }),
    { x: 488, y: 44, width: 952, height: 856 },
  );
});

test("html fullscreen: view covers the whole window regardless of sidebar", () => {
  assert.deepEqual(
    computeViewBounds({ fullscreen: true, windowWidth: 1440, windowHeight: 900, sidebarWidth: 820 }),
    { x: 0, y: 0, width: 1440, height: 900 },
  );
});

test("degenerate window sizes never produce negative bounds", () => {
  const bounds = computeViewBounds({ fullscreen: false, windowWidth: 100, windowHeight: 20, sidebarWidth: 480 });
  assert.equal(bounds.x, 488);
  assert.equal(bounds.width, 0);
  assert.equal(bounds.height, 0);
});
