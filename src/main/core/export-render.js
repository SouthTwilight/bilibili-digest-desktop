// Export document renderers, ported from the extension's parameterized
// buildMarkdownExport/buildHtmlExport. Every export lands inside the video's
// own folder in the save directory ({saveDir}/{合集}/{视频名_BV}/).

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeName(name) {
  return String(name || "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[＼／：＊？＂＜＞｜]/g, "")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 60);
}

export function exportFileTimestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
}

// Multi-P videos share one title across parts, and the timestamp only has
// minute precision — without the part number, exporting P2 within the same
// minute overwrites P1's file. Parts beyond the first are distinguished;
// P1/single-P videos keep the legacy name.
export function exportFileName(videoTitle, page = 1) {
  const stamp = exportFileTimestamp();
  const part = Number(page) > 1 ? `_P${Number(page)}` : "";
  return `${sanitizeName(videoTitle) || "bilibili-digest"}${part}_${stamp}`;
}

function timestampLabel(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = Math.floor(seconds % 60);
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function buildMarkdownExport(video) {
  const lines = [
    `# ${video.title || "B站视频学习笔记"}`,
    "",
    `- **UP主：** ${video.channelName || "未知"}`,
    `- **视频链接：** ${video.url}`,
    `- **字幕语言：** ${video.language || "未知"}`,
  ];
  if (video.description) lines.push("", "## 视频简介", "", video.description);
  if (video.analysis?.chapters?.length) {
    lines.push("", "## AI 章节", "");
    video.analysis.chapters.forEach((chapter) => {
      lines.push(`### [${chapter.timestamp}] ${chapter.title}`, "", chapter.summary || "", "");
    });
  }
  if (video.analysis?.keyQuotes?.length) {
    lines.push("## 关键观点", "");
    video.analysis.keyQuotes.forEach((quote) =>
      lines.push(`> **${quote.timestamp}** ${quote.quote}`, ""),
    );
  }
  lines.push("## 完整字幕", "");
  (video.transcript || []).forEach((entry) => {
    const stamp = timestampLabel(entry.start);
    lines.push(`- [${stamp}](${video.url}?t=${Math.floor(entry.start)}s) ${entry.text}`);
  });
  lines.push("", "---", "由 Bilibili Digest 桌面版导出");
  return lines.join("\n");
}

const HTML_STYLE = `
  :root{--pink:#fb7299;--ink:#18191c;--muted:#61666d;--line:#e3e5e7}
  *{box-sizing:border-box}
  body{margin:0;background:#f6f7f9;color:var(--ink);font:15px/1.75 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  .page{width:min(900px,calc(100% - 28px));margin:32px auto;background:#fff;border:1px solid var(--line);border-radius:16px;padding:clamp(22px,5vw,54px);box-shadow:0 12px 36px rgba(24,25,28,.07)}
  h1{line-height:1.3;margin:0 0 14px}h2{margin-top:38px;padding-bottom:10px;border-bottom:2px solid rgba(251,114,153,.18)}
  .meta{color:var(--muted)}a{color:var(--pink);text-decoration:none}
  .chapter{display:flex;gap:18px;padding:14px 0;border-bottom:1px solid var(--line)}.chapter a{flex:0 0 54px;font-weight:700}.chapter p{margin:4px 0;color:var(--muted)}
  blockquote{margin:12px 0;padding:14px 18px;border-left:4px solid var(--pink);background:rgba(251,114,153,.06);border-radius:0 10px 10px 0}blockquote b{margin-right:12px;color:var(--pink)}
  .line{display:grid;grid-template-columns:62px 1fr;gap:14px;padding:11px 0;border-bottom:1px solid var(--line)}.time{font-family:ui-monospace,monospace;font-weight:700}
  .footer{margin-top:38px;color:#9499a0;font-size:12px}
  @media(max-width:560px){.line{grid-template-columns:52px 1fr}.page{margin:12px auto}}
`;

export function buildHtmlExport(video) {
  const chapters = (video.analysis?.chapters || [])
    .map(
      (chapter) => `
    <article class="chapter"><a href="${escapeHtml(video.url)}?t=${Number(chapter.timestampSeconds) || 0}s">${escapeHtml(chapter.timestamp)}</a><div><strong>${escapeHtml(chapter.title)}</strong><p>${escapeHtml(chapter.summary || "")}</p></div></article>`,
    )
    .join("");
  const quotes = (video.analysis?.keyQuotes || [])
    .map(
      (quote) => `
    <blockquote><b>${escapeHtml(quote.timestamp)}</b>${escapeHtml(quote.quote)}</blockquote>`,
    )
    .join("");
  const entries = (video.transcript || [])
    .map(
      (entry) =>
        `<div class="line"><a class="time" href="${escapeHtml(video.url)}?t=${Math.floor(entry.start)}s">${escapeHtml(timestampLabel(entry.start))}</a><div>${escapeHtml(entry.text)}</div></div>`,
    )
    .join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(video.title || "B站视频学习笔记")}</title><style>${HTML_STYLE}
  </style></head><body><main class="page"><h1>${escapeHtml(video.title || "B站视频学习笔记")}</h1><div class="meta">UP主：${escapeHtml(video.channelName || "未知")} · <a href="${escapeHtml(video.url)}">打开原视频</a></div>${video.description ? `<h2>视频简介</h2><p>${escapeHtml(video.description)}</p>` : ""}${chapters ? `<h2>AI 章节</h2>${chapters}` : ""}${quotes ? `<h2>关键观点</h2>${quotes}` : ""}<h2>完整字幕</h2>${entries}<div class="footer">由 Bilibili Digest 桌面版导出</div></main></body></html>`;
}
