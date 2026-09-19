// Long-document chunking for the library AI summary.
//
// Whole-video multi-P exports can far exceed the text model's context
// window; the old code silently truncated at 120k chars. These helpers split
// a document into model-sized chunks at H2 section boundaries (the merged
// exports carry one `## Pn` section per part, which is exactly the natural
// seam), hard-splitting any oversized section by lines.

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
