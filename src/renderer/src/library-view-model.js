// Pure view logic for the export library: the table rows a library scan
// turns into, paging and file labels. No Vue and no window here, so it is
// unit-tested directly (tests/library-view-model.test.mjs).

const SUMMARY_RE = /^AI总结_.*\.md$/i;
const NOTES_EXPORT_RE = /^笔记_/;
const isFile = (node) => node?.type === "file";

// A transcript export — the only kind of document AI summaries are made of.
export function isTranscript(file) {
  return file.kind === "md" && !SUMMARY_RE.test(file.name) && !NOTES_EXPORT_RE.test(file.name);
}

export function isSummary(file) {
  return SUMMARY_RE.test(file.name);
}

// Every file under a top-level library node, in display order.
export function flattenFiles(node) {
  const out = [];
  const take = (children) => {
    for (const file of children || []) if (isFile(file)) out.push({ file });
  };
  if (node.type === "collection") {
    for (const child of node.children || []) {
      if (child.type === "video") take(child.children);
      else if (isFile(child)) out.push({ file: child });
    }
  } else {
    take(node.children);
  }
  return out;
}

// One table row per top-level folder (a collection, an uploader group or a
// standalone video), with the counts the list shows.
export function buildLibraryRows(tree) {
  return (Array.isArray(tree) ? tree : [])
    .filter((node) => node?.type && node.path)
    .map((node) => {
      const files = flattenFiles(node);
      return {
        path: node.path,
        name: node.name,
        type: node.type,
        node,
        files,
        videos: node.type === "collection" ? (node.children || []).filter((child) => child.type === "video").length : 1,
        docs: files.filter((item) => isTranscript(item.file)).length,
        summaries: files.filter((item) => isSummary(item.file)).length,
      };
    });
}

// The slice of a list to show. The page is clamped after the list shrinks;
// an empty list has no pages and an empty slice.
export function paginate(total, page, pageSize) {
  const size = Math.max(1, Number(pageSize) || 20);
  const count = Math.max(0, Number(total) || 0);
  const pages = Math.ceil(count / size);
  const current = Math.min(Math.max(1, Number(page) || 1), Math.max(1, pages));
  const start = (current - 1) * size;
  return { page: current, pages, start, end: Math.min(start + size, count) };
}

export function fileTypeLabel(file) {
  if (file.kind === "picture-dir") return "截图";
  if (file.kind === "notes") return "笔记数据";
  if (file.kind === "html") return "网页";
  if (file.kind !== "md") return "文件";
  if (isSummary(file)) return "总结";
  if (NOTES_EXPORT_RE.test(file.name)) return "笔记";
  return "字幕";
}

const STAMP_RE = /_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})$/;
const PART_RE = /_P(\d+)$/;

// What tells one file of a folder apart from its siblings, in one short
// line: "字幕 · P75 · 2026-11-23 21:47". Every file of a multi-part video
// carries the same long title, and what differs — the _Pn marker, the export
// time — sits at the END of a name that a narrow column truncates.
// "" for files whose name already says everything (notes.json, the picture
// folder).
export function fileIdentity(file) {
  if (file.kind === "picture-dir" || file.kind === "notes") return "";
  const dot = file.name.lastIndexOf(".");
  const base = dot > 0 ? file.name.slice(0, dot) : file.name;
  const stamp = base.match(STAMP_RE);
  const stem = stamp ? base.slice(0, -stamp[0].length) : base;
  const part = stem.match(PART_RE)?.[1];
  let kind = "";
  if (file.kind === "html") kind = "网页";
  else if (file.kind === "md") kind = /^AI总结_/.test(stem) ? "AI总结" : NOTES_EXPORT_RE.test(stem) ? "笔记" : "字幕";
  else return "";
  const when = stamp ? `${stamp[1]}-${stamp[2]}-${stamp[3]} ${stamp[4]}:${stamp[5]}` : "";
  return [kind, part ? `P${part}` : "", when].filter(Boolean).join(" · ");
}

// Minimal Markdown rendering for the preview: headings, bold, quotes, list
// items and links. The result goes through v-html in the sidebar, which
// holds the window.desktop bridge, and transcript text is an uploader's — so
// everything is escaped first, and a link's address, the only text that ever
// lands in an attribute, may not contain a quote (or anything else that
// could end the attribute or the URL). `&` is fine: after escaping it only
// ever appears as an entity, which an attribute shows as literal text.
// Transcript links look like "?p=21&t=1s", so excluding it would leave every
// multi-part timestamp unrendered.
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s"'()`\\]+)\)/g;
const escapeHtml = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (text) =>
  escapeHtml(text)
    // A link shows its label only. Every transcript line carries one, and
    // printing "[0:01](https://…/?p=21&t=1s)" made the page unreadable.
    .replace(LINK_RE, '<span class="md-link" title="$2">$1</span>')
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

export function renderMarkdown(text) {
  return String(text || "")
    .split(/\n/)
    .map((line) => {
      if (/^### /.test(line)) return `<h4>${inline(line.slice(4))}</h4>`;
      if (/^## /.test(line)) return `<h3>${inline(line.slice(3))}</h3>`;
      if (/^# /.test(line)) return `<h2>${inline(line.slice(2))}</h2>`;
      if (/^> /.test(line)) return `<blockquote>${inline(line.slice(2))}</blockquote>`;
      if (/^- /.test(line)) return `<div class="md-li">${inline(line.slice(2))}</div>`;
      if (/^---+$/.test(line)) return "<hr>";
      if (!line.trim()) return "<div class='md-gap'></div>";
      return `<p>${inline(line)}</p>`;
    })
    .join("");
}

export function prettyNotes(content) {
  try {
    const data = JSON.parse(content);
    return (data.notes || [])
      .map(
        (note) =>
          `[${Math.floor(note.timestamp / 60)}:${String(note.timestamp % 60).padStart(2, "0")}] ${note.text}`,
      )
      .join("\n") || "（空）";
  } catch {
    return content;
  }
}
