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
