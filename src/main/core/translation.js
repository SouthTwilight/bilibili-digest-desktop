import { loadPromptSection, requestAiCompletion, parseLooseJson } from "./ai.js";

// Batch translation pipeline ported from the extension: segments carry stable
// IDs, the model returns JSON keyed by those IDs, and output is aligned back
// by ID with per-row validation so untrusted model text can never misalign.

function validateTranscriptBatchRequest(content) {
  const segments = content?.segments;
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 4) {
    throw new Error("Transcript translation requires 1 to 4 segments");
  }
  const seenIds = new Set();
  let totalCharacters = 0;
  const normalized = segments.map((segment) => {
    const id = typeof segment?.id === "string" ? segment.id.trim() : "";
    const text = typeof segment?.text === "string" ? segment.text.trim() : "";
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id) || seenIds.has(id)) {
      throw new Error("Transcript translation segment IDs must be unique and stable");
    }
    if (!text || text.length > 4000) {
      throw new Error("Transcript translation segment text is invalid or too long");
    }
    seenIds.add(id);
    totalCharacters += text.length;
    return { id, text };
  });
  if (totalCharacters > 12000) {
    throw new Error("Transcript translation batch is too large");
  }
  return normalized;
}

function looksLikeChineseTranslation(text, sourceText) {
  const latinLetters = (sourceText.match(/[A-Za-z]/g) || []).length;
  if (latinLetters < 20) return true;
  return /[\u3400-\u9fff]/.test(text);
}

export function normalizeTranslatedSegmentBatch(parsed, sourceSegments) {
  const candidates = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const sourceById = new Map(sourceSegments.map((segment) => [segment.id, segment]));
  const translatedById = new Map();

  candidates.forEach((candidate) => {
    if (
      typeof candidate?.id !== "string" ||
      typeof candidate?.text !== "string" ||
      !sourceById.has(candidate.id) ||
      translatedById.has(candidate.id)
    ) {
      return;
    }
    const text = candidate.text.trim();
    const source = sourceById.get(candidate.id);
    if (text && looksLikeChineseTranslation(text, source.text)) {
      translatedById.set(candidate.id, text);
    }
  });

  return {
    segments: sourceSegments.map((source) => ({
      id: source.id,
      text: translatedById.get(source.id) || "",
      error: translatedById.has(source.id) ? "" : "Missing or invalid Chinese translation",
    })),
  };
}

export function getTranslationBaseRules() {
  const langName = "Simplified Chinese";
  const langSpecific = loadPromptSection("translation.md", "Chinese rules");
  return loadPromptSection("translation.md", "Shared base rules", {
    langName,
    langSpecific,
  });
}

export async function translateTranscriptBatch({ settings, videoTitle, segments }) {
  try {
    if (!settings.aiApiKeys[settings.provider]) {
      return { success: false, error: "AI API key 未配置" };
    }
    const sourceSegments = validateTranscriptBatchRequest({ segments });
    const langName = "Simplified Chinese";
    const baseRules = getTranslationBaseRules();
    const systemPrompt = loadPromptSection("translation.md", "Transcript batch translation", {
      langName,
      videoTitle: videoTitle || "Unknown",
      baseRules,
    });
    const userContent = JSON.stringify({ segments: sourceSegments });
    const call = (responseFormat) =>
      requestAiCompletion({
        settings,
        temperature: 0.2,
        maxTokens: 1536,
        responseFormat,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      });
    let text = await call({ type: "json_object" });
    // JSON mode can rarely return an empty content string; retry once without
    // response_format (the prompt already demands JSON).
    if (text.code === "EMPTY_AI_RESPONSE") text = await call(undefined);

    const aligned = normalizeTranslatedSegmentBatch(parseLooseJson(text), sourceSegments);
    if (!aligned.segments.some((segment) => segment.text)) {
      return { success: false, error: "Translation returned no valid Chinese segments" };
    }
    return { success: true, translatedContent: aligned };
  } catch (error) {
    return { success: false, error: error.message || "Translation failed" };
  }
}
