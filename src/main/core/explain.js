import { loadPromptSection, requestAiCompletion, parseLooseJson } from "./ai.js";

// Selection explanation — ported from the extension's explain flow.
export async function explainSelection({ settings, videoTitle, selectedText, transcriptContext }) {
  if (!settings.aiApiKeys[settings.provider]) {
    return { success: false, error: "AI API key 未配置，请先在设置中填写。" };
  }
  try {
    const systemPrompt = loadPromptSection("explain.md", "System prompt", {
      videoTitle: videoTitle || "Unknown",
      selectedText,
      transcriptContext: transcriptContext || "None",
    });
    const text = await requestAiCompletion({
      settings,
      maxTokens: 2048,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: selectedText },
      ],
    });
    return { success: true, explanation: text.trim() };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Note polish — turns raw transcript lines around a timestamp into a clean
// readable sentence (extension's note-cleanup flow, single small call).
export async function cleanupNoteText({ settings, videoTitle, targetText, beforeText, afterText }) {
  try {
    const variables = {
      videoTitle: videoTitle || "Unknown",
      beforeText: beforeText || "(none)",
      targetText,
      afterText: afterText || "(none)",
    };
    const systemPrompt = loadPromptSection("note-cleanup.md", "System prompt", variables);
    const userPrompt = loadPromptSection("note-cleanup.md", "User prompt", variables);
    const text = await requestAiCompletion({
      settings,
      maxTokens: 1024,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    const parsed = parseLooseJson(text);
    const cleaned = typeof parsed?.quote === "string" ? parsed.quote.trim() : "";
    return { success: true, text: cleaned || targetText };
  } catch (error) {
    // Polishing is best-effort; fall back to the raw line.
    return { success: false, text: targetText };
  }
}
