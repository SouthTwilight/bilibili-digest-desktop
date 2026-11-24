// The one place that turns a title into a file or folder name. Every other
// module builds names through these helpers — eight filename incidents in
// three months were all the same two mistakes: a name derived again somewhere
// else, and a suffix cut off by a truncation it was never meant to meet.
//
//   identity lives in suffixes   a video is its _BV号, a document its _Pn
//                                marker (no marker means P1), a kind its
//                                AI总结_ / 笔记_ prefix
//   head + structural suffixes   truncation applies to the head only
//   a name is decided once       the video folder is the record; the files
//                                inside take their head from it
//   lookups match by identity    never by recomputing a name

export const HEAD_MAX = 60;

const STAMP_RE = /[_-]\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$/;
const PART_RE = /_(P\d+|全部P)$/;
// Tails that parseDocName / parseVideoDirName would read as a marker, a BV
// id or a timestamp. The marker forms also match when a clip has cut them
// short (_P, _BV), so no fragment of one is ever left on a head.
const LOOKALIKE_TAIL_RE = /(?:_P\d*|_全部P?|_BV[A-Za-z0-9]*|[_-]\d{4}-\d{2}-\d{2}_\d{2}-\d{2})$/;

// Windows-illegal characters, their fullwidth lookalikes (legal, but
// normalized away to keep names predictable) and control characters;
// whitespace collapsed.
export function cleanTitle(text) {
  return String(text || "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[＼／：＊？＂＜＞｜]/g, "")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Cut to at most `max` code points — never through a surrogate pair (emoji) —
// and never leave a trailing space or dot: Windows drops both from a name on
// disk, so the file would no longer be where the computed path says.
export function clip(text, max = HEAD_MAX) {
  const chars = Array.from(String(text || ""));
  const out = chars.length <= max ? chars.join("") : chars.slice(0, max).join("");
  return out.replace(/[ .]+$/, "").trimStart();
}

// Drop a tail a parser would mistake for a marker.
export function stripMarkerTails(text) {
  let out = String(text || "");
  let match;
  while ((match = out.match(LOOKALIKE_TAIL_RE))) {
    out = out.slice(0, out.length - match[0].length).replace(/[ _]+$/, "");
  }
  return out;
}

// The only way a name is assembled: the head is cleaned and cut, then the
// suffixes are appended whole.
export function composeName(headText, maxHead = HEAD_MAX, ...suffixes) {
  return clip(cleanTitle(headText), maxHead) + suffixes.join("");
}

// A head for a name that is parsed for identity later. Lookalike marker tails
// are dropped so title text can never be read back as a marker.
export function identityHead(text, maxHead = HEAD_MAX) {
  return stripMarkerTails(clip(cleanTitle(text), maxHead));
}

// P1 and single-P exports carry no marker (legacy name); parts beyond the
// first are told apart by it, and "all" labels a merged whole-video document.
export function partMarker(page) {
  if (page === "all") return "_全部P";
  const n = Number(page) || 1;
  return n > 1 ? `_P${n}` : "";
}

// "p1" | "p<n>" | "all" → the marker as it is spelled in a name.
export function partText(part) {
  return part === "all" ? "_全部P" : part && part !== "p1" ? `_${part.toUpperCase()}` : "";
}

// 视频名_BV号 — the folder IS the video's record; every lookup keys on the
// BV suffix, never on the title in front of it.
export function videoDirName(title, bvid) {
  return `${identityHead(title) || "未命名视频"}_${bvid}`;
}

export function collectionDirName(title) {
  return clip(cleanTitle(title), HEAD_MAX) || "合集";
}

export function uploaderDirName(name) {
  return clip(cleanTitle(name), HEAD_MAX) || "其他UP主";
}

// 视频名[_Pn]_时间戳 — a transcript export's base name (no extension).
export function exportDocBase(head, page, stamp) {
  const base = `${identityHead(head) || "bilibili-digest"}${partMarker(page)}`;
  // A title that would read back as another kind of file ("AI总结" or "笔记"
  // followed by _P2 or the timestamp) gets a lead-in, so the kind prefixes
  // stay unambiguous.
  const lead = /^(?:AI总结|笔记)(?:_|$)/i.test(base) ? "视频_" : "";
  return `${lead}${base}_${stamp}`;
}

// AI总结_视频名[_Pn].md — named after its DOCUMENT, so the file the writer
// produces and the file a lookup expects are the same string by construction.
export function summaryBase(doc) {
  return `AI总结_${composeName(doc.head || "未命名", HEAD_MAX, partText(doc.part))}`;
}

// What a file name says about itself. `part` is the document's identity
// inside its folder: "p1" for no marker and _P1 alike, "p<n>", or "all" for a
// merged _全部P document.
export function parseDocName(fileName) {
  const name = String(fileName || "");
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const summary = /^AI总结_/i.test(stem);
  const notes = /^笔记_/.test(stem);
  const kind = summary
    ? "summary"
    : notes
      ? "notes"
      : /^\.md$/i.test(ext) || /^\.html$/i.test(ext)
        ? "doc"
        : "other";
  const body = summary ? stem.slice("AI总结_".length) : notes ? stem.slice("笔记_".length) : stem;
  const bare = body.replace(STAMP_RE, "");
  const match = bare.match(PART_RE);
  return {
    kind,
    ext,
    head: match ? bare.slice(0, bare.length - match[0].length) : bare,
    stamp: bare === body ? "" : body.slice(bare.length),
    part: kind === "doc" || kind === "summary" ? partIdentity(match?.[1]) : null,
    // A summary OF a summary or notes export (AI总结_AI总结_…,
    // AI总结_…学习笔记) summarizes no document of this folder, so it never
    // matches by identity.
    derived: summary && (/^(AI总结_|笔记_)/.test(body) || / 学习笔记$/.test(body)),
  };
}

function partIdentity(marker) {
  if (!marker || marker === "P1") return "p1";
  return marker === "全部P" ? "all" : marker.toLowerCase();
}

// 视频名_BV号 → { head, bvid }; null for anything that is not a video folder.
export function parseVideoDirName(folderName) {
  const match = String(folderName || "").match(/^(.*?)_?(BV[A-Za-z0-9]+)$/i);
  return match ? { head: match[1], bvid: match[2] } : null;
}
