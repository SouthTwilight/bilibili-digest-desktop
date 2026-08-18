import { test } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import {
  normalize,
  providerInfo,
  asrProviderInfo,
  createSettingsStore,
} from "../src/main/core/settings-store.js";

test("defaults: glm provider, bailian asr, injected save dir", () => {
  const s = normalize({}, { saveDir: "D:/exports" });
  assert.equal(s.provider, "glm");
  assert.equal(s.asrProvider, "bailian");
  assert.equal(s.saveDir, "D:/exports");
  assert.equal(s.exportConcurrency, 4);
});

test("legacy single keys migrate to per-provider maps", () => {
  const s = normalize({ aiApiKey: " sk-ds ", asrApiKey: "sk-bailian" });
  assert.equal(s.aiApiKeys.deepseek, "sk-ds");
  assert.equal(s.aiApiKeys.glm, "");
  assert.equal(s.asrApiKeys.bailian, "sk-bailian");
});

test("invalid providers fall back to defaults", () => {
  assert.equal(normalize({ provider: "x", asrProvider: "y" }).provider, "glm");
  assert.equal(asrProviderInfo("y").transcriptSource, "aliyun-fun-asr");
  assert.equal(providerInfo("x").model, "glm-5.2");
});

test("exportConcurrency is clamped", () => {
  assert.equal(normalize({ exportConcurrency: 99 }).exportConcurrency, 8);
  assert.equal(normalize({ exportConcurrency: 0 }).exportConcurrency, 4);
  assert.equal(normalize({ exportConcurrency: "2" }).exportConcurrency, 2);
});

test("settings store persists and reloads through the file system", () => {
  const path = new URL("./tmp-settings.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const store = createSettingsStore(path, { saveDir: "D:/exports" });
  const saved = store.save({ provider: "deepseek", aiApiKeys: { deepseek: "k" }, saveDir: "E:/x" });
  assert.equal(saved.provider, "deepseek");
  const reloaded = createSettingsStore(path, { saveDir: "D:/exports" }).load();
  assert.equal(reloaded.provider, "deepseek");
  assert.equal(reloaded.aiApiKeys.deepseek, "k");
  assert.equal(reloaded.saveDir, "E:/x");
  unlinkSync(path);
});
