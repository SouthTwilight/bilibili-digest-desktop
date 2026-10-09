// Long-document chunking for the library AI summary.
//
// Whole-video multi-P exports can far exceed the text model's context
// window; the old code silently truncated at 120k chars. These helpers split
// a document into model-sized chunks at H2 section boundaries (the merged
// exports carry one `## Pn` section per part, which is exactly the natural
// seam), hard-splitting any oversized section by lines.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { requestAiCompletion, loadPromptSection } from "./ai.js";
import { sanitizeName } from "./export-render.js";

export function splitDocIntoChunks(content, maxChars = 100_000) {
  const text = String(content || "");
  if (!text || text.length <= maxChars) return text ? [text] : [];

  // 1. Cut into sections at H2 headings; the heading leads its section and
  //    the preamble before the first heading leads the first section.
  const sections = [];
  let current = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("## ") && current.length) {
      sections.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length) sections.push(current);

  // 2. Hard-split any section that alone exceeds the budget by lines. A
  //    single line longer than the budget is still emitted (never dropped).
  const pieces = [];
  for (const section of sections) {
    let piece = [];
    let size = 0;
    for (const line of section) {
      if (size + line.length + 1 > maxChars && piece.length) {
        pieces.push(piece);
        piece = [];
        size = 0;
      }
      piece.push(line);
      size += line.length + 1;
    }
    if (piece.length) pieces.push(piece);
  }

  // 3. Greedily pack pieces back into chunks up to the budget.
  const chunks = [];
  let chunk = [];
  let size = 0;
  for (const piece of pieces) {
    const pieceLen = piece.reduce((total, line) => total + line.length + 1, 0);
    if (size + pieceLen > maxChars && chunk.length) {
      chunks.push(chunk.join("\n"));
      chunk = [];
      size = 0;
    }
    chunk.push(...piece);
    size += pieceLen;
  }
  if (chunk.length) chunks.push(chunk.join("\n"));
  return chunks;
}

// ---- User focus (AI summary direction) -----------------------------------

// The focus text rides into the prompt verbatim; only trim and cap it so a
// stray paste cannot blow up the request or the stored settings.
export function sanitizeFocus(value) {
  return String(value ?? "").trim().slice(0, 500);
}

// Extra instruction appended to the multi-chunk synthesis prompt so the
// per-chunk focus sections survive the final merge.
export function buildSynthesisFocusInstruction(focus) {
  const clean = sanitizeFocus(focus);
  if (!clean) return "";
  return (
    `用户重点关注方向：${clean}。` +
    "各分块总结中为该方向追加的专属章节，在合成时必须保留并合并去重。"
  );
}

// Notice payload for the library AI-summary completion (main-process router
// decides in-app toast vs OS notification; "打开" rides on `file`).
export function buildSummaryNotice({ success, videoName, file, error }) {
  return success
    ? { kind: "summary", ok: true, title: `AI 总结完成：${videoName}`, file: file || null }
    : { kind: "summary", ok: false, title: `AI 总结失败：${error || "未知错误"}`, file: null };
}

// Derive the video name a summary is "about": the document's H1 beats the
// file name, and export-timestamp suffixes are stripped either way. Per-P
// exports share one H1, so the source file's _Pn suffix is kept — each part
// gets its own AI总结_视频名_Pn.md instead of overwriting its siblings.
export function docVideoName(filePath, content) {
  const fileBase = basename(filePath, extname(filePath)).replace(
    /[_-]\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$/,
    "",
  );
  const titleMatch = String(content || "").match(/^#\s+(.+)$/m);
  const name = (titleMatch?.[1] || fileBase).slice(0, 60);
  const part = fileBase.match(/_P(\d+)$/);
  return part ? `${name}_P${part[1]}` : name;
}

// Summarize one exported markdown document and store the result next to it
// as AI总结_视频名.md. Shared by the single-file enqueue and the collection
// batch queue — `requestCompletion` is injectable for tests. Errors are
// thrown (callers map codes like NO_AI_KEY); progress rides onProgress as
// (title, subtitle) ticks.
export async function summarizeExportedDoc({
  settings,
  filePath,
  focus = "",
  onProgress,
  onUsage,
  requestCompletion = requestAiCompletion,
}) {
  const content = readFileSync(filePath, "utf8");
  const videoName = docVideoName(filePath, content);
  const userFocus = sanitizeFocus(focus);
  const userFocusBlock = userFocus
    ? loadPromptSection("summary.md", "User focus block", { userFocus })
    : "";
  const complete = (promptContent, title) =>
    requestCompletion({
      settings,
      maxTokens: 8192,
      messages: [{ role: "user", content: loadPromptSection("summary.md", "System prompt", { title, content: promptContent, userFocusBlock }) }],
      onUsage,
    });

  // Whole-video multi-P exports can exceed the model's context window. Split
  // at section boundaries, summarize each chunk with the same four-layer
  // prompt, then synthesize — no silent truncation.
  const chunks = splitDocIntoChunks(content, 100_000);
  let text;
  if (chunks.length <= 1) {
    onProgress?.("正在生成 AI 总结", "长文档需要一两分钟");
    text = await complete(content, videoName);
  } else {
    const partSummaries = [];
    for (let i = 0; i < chunks.length; i += 1) {
      onProgress?.("正在生成 AI 总结", `长文档已分 ${chunks.length} 块，正在总结第 ${i + 1}/${chunks.length} 块`);
      partSummaries.push(await complete(chunks[i], `${videoName}（第 ${i + 1}/${chunks.length} 块）`));
    }
    onProgress?.("正在汇总各块总结", "最后一步");
    const focusInstruction = buildSynthesisFocusInstruction(userFocus);
    text = await requestCompletion({
      settings,
      maxTokens: 8192,
      onUsage,
      messages: [
        {
          role: "user",
          content:
            `以下是一份长文档（约 ${content.length} 字符）按顺序分块总结的结果。请把它们综合成一份完整的总结文档，` +
            "遵循与分块总结相同的结构（快速概览 / 结构化深度总结 / 总结与行动项）：合并各块中重复的主题，" +
            "按内容自然脉络重新组织分节，保留所有时间戳链接和关键原话，不要遗漏任何一块的要点。" +
            focusInstruction +
            "\n\n" +
            partSummaries.map((s, i) => `--- 第 ${i + 1} 块总结 ---\n${s}`).join("\n\n"),
        },
      ],
    });
  }
  // Titles ride straight into the output filename; Windows-illegal
  // characters in them (e.g. "AI游戏开发速成课|AI生成...") used to make
  // writeFileSync fail with ENOENT. The prompt keeps the raw title.
  const outFile = join(dirname(filePath), `AI总结_${sanitizeName(videoName) || "未命名"}.md`);
  writeFileSync(outFile, text.trim() + "\n", "utf8");
  return { success: true, file: outFile, videoName };
}

// Marker titles strip angle brackets so a pathological title can neither
// forge nor break the <<<总结：标题>>> delimiters.
function markerTitle(name) {
  return String(name || "").replace(/[<>]/g, "").trim().slice(0, 80);
}

// Summarize SEVERAL short documents in ONE completion request. Collection
// batches of short videos otherwise re-bill the full prompt template per
// video (the fixed template sits around the provider's prefix-cache
// threshold, so it almost never hits). The model returns one
// <<<总结：标题>>>-delimited section per doc; any doc it skipped or
// mislabeled falls back to the solo path — correctness never depends on
// format compliance, only the savings do.
export async function summarizeDocsBatch({
  settings,
  docs,
  focus = "",
  onProgress,
  onUsage,
  requestCompletion = requestAiCompletion,
}) {
  const userFocus = sanitizeFocus(focus);
  const userFocusBlock = userFocus
    ? loadPromptSection("summary.md", "User focus block", { userFocus })
    : "";
  const entries = docs.map((doc) => {
    const content = readFileSync(doc.filePath, "utf8");
    return { ...doc, content, videoName: markerTitle(docVideoName(doc.filePath, content)) };
  });
  const docsBlock = entries
    .map((entry, i) => `<<<文档 ${i + 1}/${entries.length}：${entry.videoName}>>>\n\n${entry.content}`)
    .join("\n\n");
  onProgress?.(`正在批量总结 ${entries.length} 个视频`, "一组短文档共用一次请求");

  const response = await requestCompletion({
    settings,
    maxTokens: 8192,
    messages: [
      {
        role: "user",
        content: loadPromptSection("summary.md", "Batch system prompt", {
          count: entries.length,
          userFocusBlock,
          docs: docsBlock,
        }),
      },
    ],
    onUsage,
  });

  // Split the response back into per-video sections by marker line.
  const buckets = new Map();
  let current = null;
  for (const line of String(response).split("\n")) {
    const match = line.match(/^<<<总结：(.*)>>>\s*$/);
    if (match) {
      current = markerTitle(match[1]);
      if (!buckets.has(current)) buckets.set(current, []);
      continue;
    }
    if (current) buckets.get(current).push(line);
  }

  const results = [];
  let soloFallback = 0;
  for (const entry of entries) {
    const body = (buckets.get(entry.videoName) || []).join("\n").trim();
    if (body) {
      const file = join(dirname(entry.filePath), `AI总结_${sanitizeName(entry.videoName) || "未命名"}.md`);
      writeFileSync(file, body + "\n", "utf8");
      results.push({ filePath: entry.filePath, videoName: entry.videoName, file });
    } else {
      // The model skipped or mislabeled this doc — pay the solo cost for it
      // rather than losing its summary.
      soloFallback += 1;
      onProgress?.(`正在补总结 ${entry.videoName}`, "批量响应缺失该视频，单独重试");
      const solo = await summarizeExportedDoc({
        settings,
        filePath: entry.filePath,
        focus,
        onUsage,
        requestCompletion,
      });
      results.push({ filePath: entry.filePath, videoName: solo.videoName, file: solo.file });
    }
  }
  return { success: true, results, soloFallback };
}
