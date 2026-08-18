import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { providerInfo } from "./settings-store.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(MODULE_DIR, "../prompts");

const AI_IDLE_TIMEOUT_MS = 50_000;
const AI_HARD_TIMEOUT_MS = 120_000;
const AI_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const promptFileCache = new Map();

export function loadPromptSection(fileName, heading, variables = {}) {
  let markdown = promptFileCache.get(fileName);
  if (!markdown) {
    // Normalize CRLF (files may carry Windows line endings) so the
    // section/fence matching below only deals with \n.
    markdown = readFileSync(join(PROMPTS_DIR, fileName), "utf8").replace(/\r\n/g, "\n");
    promptFileCache.set(fileName, markdown);
  }

  const marker = `## ${heading}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }
  const sectionStart = markerIndex + marker.length;
  const nextSection = markdown.indexOf("\n## ", sectionStart);
  const section = markdown.slice(
    sectionStart,
    nextSection === -1 ? markdown.length : nextSection,
  );
  const fenceMatch = section.match(/```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/);
  if (!fenceMatch) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }

  let prompt = fenceMatch[1];
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.split(`{${key}}`).join(String(value ?? ""));
  }
  return prompt;
}

// OpenAI-compatible chat/completions call with the same bounded-timeout and
// bounded-size guarantees as the extension's requestAiCompletion.
export async function requestAiCompletion({ settings, messages, maxTokens, temperature, responseFormat }) {
  const provider = providerInfo(settings.provider);
  const apiKey = settings.aiApiKeys[settings.provider] || "";
  if (!apiKey) {
    const error = new Error(`${provider.label} API key not configured. 请先在设置中填写。`);
    error.code = "NO_AI_KEY";
    throw error;
  }

  const body = { model: provider.model, max_tokens: maxTokens, messages };
  if (typeof temperature === "number") body.temperature = temperature;
  if (responseFormat) body.response_format = responseFormat;
  // Product features need bounded, predictable latency rather than reasoning.
  body.thinking = { type: "disabled" };

  const controller = new AbortController();
  let timeoutKind = "";
  const abortForTimeout = (kind) => {
    if (controller.signal.aborted) return;
    timeoutKind = kind;
    controller.abort();
  };
  const idle = setTimeout(() => abortForTimeout("idle"), AI_IDLE_TIMEOUT_MS);
  const hard = setTimeout(() => abortForTimeout("hard"), AI_HARD_TIMEOUT_MS);
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => abortForTimeout("idle"), AI_IDLE_TIMEOUT_MS);
  };

  try {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // Receiving headers proves the provider is still making progress.
    resetIdle();

    const responseText = await readBounded(response, resetIdle);
    if (!response.ok) {
      const errorData = safelyParse(responseText);
      const error = new Error(
        errorData?.error?.message || errorData?.message || `${provider.label} error: ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }
    const data = safelyParse(responseText);
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      const error = new Error(`${provider.label} returned an empty response.`);
      error.code = "EMPTY_AI_RESPONSE";
      throw error;
    }
    return text;
  } catch (error) {
    if (timeoutKind === "idle") {
      const timeoutError = new Error(`${provider.label} 请求 50 秒无响应，请重试。`);
      timeoutError.code = "AI_IDLE_TIMEOUT";
      throw timeoutError;
    }
    if (timeoutKind === "hard") {
      const timeoutError = new Error(`${provider.label} 请求超过 120 秒限制，请重试。`);
      timeoutError.code = "AI_HARD_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(idle);
    clearTimeout(hard);
  }
}

function safelyParse(text) {
  try {
    return JSON.parse(String(text).trimStart());
  } catch {
    return null;
  }
}

async function readBounded(response, onActivity) {
  const reader = response.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let responseText = "";
    let responseBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity();
      responseBytes += value?.byteLength ?? 0;
      if (responseBytes > AI_MAX_RESPONSE_BYTES) {
        await reader.cancel?.().catch(() => {});
        const error = new Error("AI response exceeded the 2 MiB limit.");
        error.code = "AI_RESPONSE_TOO_LARGE";
        throw error;
      }
      responseText += decoder.decode(value, { stream: true });
    }
    responseText += decoder.decode();
    return responseText;
  }
  const text = await response.text();
  onActivity();
  return text;
}

// ---- Analysis pipeline ----------------------------------------------------

export function parseLooseJson(text) {
  let cleaned = (text || "").trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    // Most common LLM slip: a trailing comma right before a } or ].
    return JSON.parse(cleaned.replace(/,(\s*[}\]])/g, "$1"));
  }
}

export function validateAndFixTimestamps(analysis, maxSeconds) {
  const safeMax =
    Number.isFinite(Number(maxSeconds)) && Number(maxSeconds) > 0
      ? Number(maxSeconds)
      : Number.MAX_SAFE_INTEGER;

  const formatTimestamp = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  };

  const safeString = (value, maxLength) =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  const safeSeconds = (value) => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > safeMax) return null;
    return Math.floor(seconds);
  };

  const chapters = (Array.isArray(analysis?.chapters) ? analysis.chapters : [])
    .slice(0, 100)
    .map((chapter) => {
      const seconds = safeSeconds(chapter?.timestampSeconds);
      const title = safeString(chapter?.title, 300);
      if (seconds === null || !title) return null;
      return {
        title,
        summary: safeString(chapter?.summary, 1500),
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyQuotes = (Array.isArray(analysis?.keyQuotes) ? analysis.keyQuotes : [])
    .slice(0, 50)
    .map((quote) => {
      const seconds = safeSeconds(quote?.timestampSeconds);
      const text = safeString(quote?.quote, 3000);
      if (seconds === null || !text) return null;
      return {
        quote: text,
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyMoments = (Array.isArray(analysis?.keyMoments) ? analysis.keyMoments : [])
    .map(safeSeconds)
    .filter((seconds) => seconds !== null)
    .slice(0, 100);

  return { chapters, keyQuotes, keyMoments };
}

export async function analyzeTranscript({ settings, videoDetails, transcript }) {
  if (!settings.aiApiKeys[settings.provider]) {
    return {
      success: false,
      error: "NO_AI_KEY",
      message: `${providerInfo(settings.provider).label} API key 未配置，请先在设置中填写。`,
    };
  }

  const transcriptText = transcript.transcriptTextTimestamped;

  // The transcript's LAST [M:SS] marker is the most reliable signal of where
  // the content actually ends — more trustworthy than duration metadata.
  let lastTranscriptSeconds = 0;
  const stampMatches = transcriptText.match(/\[(\d+):(\d{2})\]/g) || [];
  if (stampMatches.length) {
    const last = stampMatches[stampMatches.length - 1].match(/\[(\d+):(\d{2})\]/);
    lastTranscriptSeconds = parseInt(last[1]) * 60 + parseInt(last[2]);
  }
  const effectiveSeconds = Math.max(
    Math.floor(videoDetails.duration || 0),
    lastTranscriptSeconds,
  );
  const durationFormatted = `${Math.floor(effectiveSeconds / 60)}:${String(
    Math.floor(effectiveSeconds % 60),
  ).padStart(2, "0")}`;

  // The "last chapter must be after" threshold (75% in) forces whole-video
  // coverage instead of front-loaded chapters.
  const lateThresholdSeconds = Math.floor(effectiveSeconds * 0.75);
  const lateThreshold = `${Math.floor(lateThresholdSeconds / 60)}:${String(
    lateThresholdSeconds % 60,
  ).padStart(2, "0")}`;

  const promptVariables = {
    durationFormatted,
    lateThreshold,
    maxTimestampSeconds: effectiveSeconds,
    videoTitle: videoDetails.title || "Unknown",
    channelName: videoDetails.channelName || "Unknown",
    videoDescription: videoDetails.description || "No description available",
    transcriptText,
  };
  const systemPrompt = loadPromptSection("analysis.md", "System prompt", promptVariables);
  const userPrompt = loadPromptSection("analysis.md", "User prompt", promptVariables);

  const responseText = await requestAiCompletion({
    settings,
    maxTokens: 8192,
    responseFormat: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  return {
    success: true,
    analysis: validateAndFixTimestamps(parseLooseJson(responseText), effectiveSeconds),
  };
}
