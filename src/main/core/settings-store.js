import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Registry of supported text-model providers. All endpoints speak the
// OpenAI-compatible chat/completions format. Ported 1:1 from the extension's
// settings.js so both projects stay in behavioural sync.
export const PROVIDERS = Object.freeze({
  glm: Object.freeze({
    id: "glm",
    label: "GLM 5.2",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.2",
  }),
  deepseek: Object.freeze({
    id: "deepseek",
    label: "DeepSeek Flash",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
  }),
});
export const DEFAULT_PROVIDER = "glm";

export const ASR_PROVIDERS = Object.freeze({
  bailian: Object.freeze({
    id: "bailian",
    label: "阿里百炼 Fun-ASR",
    transcriptSource: "aliyun-fun-asr",
  }),
  doubao: Object.freeze({
    id: "doubao",
    label: "豆包录音识别（火山引擎）",
    transcriptSource: "doubao-bigasr",
  }),
});
export const DEFAULT_ASR_PROVIDER = "bailian";

export function providerInfo(providerId) {
  return PROVIDERS[providerId] ?? PROVIDERS[DEFAULT_PROVIDER];
}

export function asrProviderInfo(providerId) {
  return ASR_PROVIDERS[providerId] ?? ASR_PROVIDERS[DEFAULT_ASR_PROVIDER];
}

export function normalizeProvider(input) {
  return PROVIDERS[input] ? input : DEFAULT_PROVIDER;
}

export function normalizeAsrProvider(input) {
  return ASR_PROVIDERS[input] ? input : DEFAULT_ASR_PROVIDER;
}

function trimKey(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeApiKeys(input = {}) {
  const keys = { glm: trimKey(input.glm), deepseek: trimKey(input.deepseek) };
  // Migrate the extension-era single-key field (always a DeepSeek key).
  if (!keys.deepseek && trimKey(input.aiApiKey)) {
    keys.deepseek = trimKey(input.aiApiKey);
  }
  return keys;
}

function normalizeAsrApiKeys(input = {}, legacyAsrKey = "") {
  const keys = { bailian: trimKey(input.bailian), doubao: trimKey(input.doubao) };
  // Migrate the extension-era single ASR key (always a Bailian key).
  if (!keys.bailian && trimKey(legacyAsrKey)) {
    keys.bailian = trimKey(legacyAsrKey);
  }
  return keys;
}

export function normalize(input = {}, defaults = {}) {
  return {
    provider: normalizeProvider(input.provider),
    aiApiKeys: normalizeApiKeys(input.aiApiKeys || { glm: "", deepseek: input.aiApiKey }),
    asrProvider: normalizeAsrProvider(input.asrProvider),
    asrApiKeys: normalizeAsrApiKeys(input.asrApiKeys, input.asrApiKey),
    asrDoubaoAppKey: trimKey(input.asrDoubaoAppKey),
    saveDir: trimKey(input.saveDir) || defaults.saveDir || "",
    // Doubao enforces a concurrency quota; 1 serializes ASR tasks by default.
    exportConcurrency: Math.min(8, Math.max(1, Number(input.exportConcurrency) || 4)),
    supadataApiKey: "",
  };
}

export function createSettingsStore(filePath, defaults = {}) {
  function load() {
    try {
      if (existsSync(filePath)) {
        return normalize(JSON.parse(readFileSync(filePath, "utf8")), defaults);
      }
    } catch (error) {
      console.warn("[settings] failed to read, falling back to defaults:", error.message);
    }
    return normalize({}, defaults);
  }

  function persist(normalized) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(normalized, null, 2), "utf8");
    return normalized;
  }

  return {
    load,
    // Accepts partial raw input, normalizes, writes, and returns the result.
    save(input) {
      return persist(normalize(input, { ...defaults, saveDir: load().saveDir }));
    },
  };
}
