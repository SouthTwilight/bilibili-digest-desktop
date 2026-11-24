import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname, basename, dirname } from "node:path";
import { parseDocName, parseVideoDirName, summaryBase } from "./naming.js";
import { fitUnder, assertFits } from "./paths.js";

// Scans the save directory into the sidebar's library tree:
//   collection folder  → contains video folders
//   video folder       → named 视频名_BV号, holds exported files + notes.json
function scanLibrary(saveDir) {
  if (!saveDir || !existsSync(saveDir)) return [];

  // Numeric-aware order: P1, P2, … P10 instead of the filesystem's
  // alphabetical P1, P10, P2 — applies to P folders and 视频名_Pn files.
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });

  function fileEntry(file, parent) {
    const path = join(parent, file);
    const ext = extname(file).toLowerCase();
    const kind =
      ext === ".md" ? "md" :
      ext === ".html" ? "html" :
      file === "notes.json" ? "notes" : "other";
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {}
    return { name: file, path, type: "file", kind, size };
  }

  function videoFolder(name, parent) {
    const dir = join(parent, name);
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    // Documents (md/html/notes.json) show as files; the `picture/`
    // subfolder collapses to a single folder entry — users who want the
    // screenshots can open it in Explorer.
    const files = [];
    for (const entry of entries) {
      if (entry.isFile()) {
        files.push(fileEntry(entry.name, dir));
      } else if (entry.isDirectory() && entry.name === "picture") {
        const picDir = join(dir, "picture");
        try {
          const pics = readdirSync(picDir);
          if (pics.length) {
            files.push({
              name: `picture (${pics.length} 张截图)`,
              path: picDir,
              type: "file",
              kind: "picture-dir",
              size: 0,
            });
          }
        } catch {
          // Unreadable picture folder is non-fatal.
        }
      }
    }
    if (!files.length) return null;
    files.sort(byName);
    return { name, path: dir, type: "video", children: files };
  }

  try {
    const root = readdirSync(saveDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    const tree = [];
    for (const entry of root) {
      const dir = join(saveDir, entry.name);
      let sub = [];
      try {
        sub = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const videoDirs = sub.filter((e) => e.isDirectory());
      const directFiles = sub.filter((e) => e.isFile()).map((e) => fileEntry(e.name, dir));
      // Standalone video folder: files directly inside.
      if (directFiles.length && !videoDirs.some((d) => existsSync(join(dir, d.name)))) {
        const video = { name: entry.name, path: dir, type: "video", children: directFiles.sort(byName) };
        tree.push(video);
        continue;
      }
      if (videoDirs.length) {
        const children = videoDirs
          .map((d) => videoFolder(d.name, dir))
          .filter(Boolean);
        if (children.length || directFiles.length) {
          const merged = [...children, ...directFiles].sort(byName);
          tree.push({ name: entry.name, path: dir, type: "collection", children: merged });
        }
      }
    }
    return tree.sort(byName);
  } catch {
    return [];
  }
}

// Read a library file for preview. The path must stay inside the save dir —
// the renderer only ever receives paths produced by scanLibrary, but a stale
// tree after a save-dir change could point elsewhere.
function readLibraryFile(saveDir, filePath) {
  const normalized = String(filePath || "");
  const base = String(saveDir || "");
  if (!base || !normalized.startsWith(base)) {
    return { success: false, error: "文件不在当前保存目录内。" };
  }
  try {
    const content = readFileSync(normalized, "utf8");
    const name = basename(normalized);
    const kind =
      name === "notes.json" ? "notes" :
      extname(name).toLowerCase() === ".html" ? "html" :
      extname(name).toLowerCase() === ".md" ? "md" : "other";
    return { success: true, kind, name, content };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Build one summarizable entry per candidate export file in a folder.
// Inputs are plain transcript exports (AI 总结 and 笔记 outputs are
// excluded); re-exports carry timestamps so only the newest file per base
// name is kept, and per-P files become separate entries. A summary is
// matched by identity — doc and summary share the part marker — so a head
// shortened by any rule still finds its file.
function summarizeFileEntries(dir, names, labelFor) {
  const summarizedParts = names
    .map((name) => parseDocName(name))
    .filter((parsed) => parsed.kind === "summary" && !parsed.derived)
    .map((parsed) => parsed.part);
  const byBase = new Map();
  for (const name of names) {
    const parsed = parseDocName(name);
    // Only Markdown exports are summary input; an HTML export is a document
    // (it counts as exported) but not something the text model is fed.
    if (parsed.kind !== "doc" || parsed.ext.toLowerCase() !== ".md") continue;
    const fileTitle = name
      .replace(/\.md$/i, "")
      .replace(/[_-]\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$/, "");
    const path = join(dir, name);
    let mtime = 0;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {}
    const prev = byBase.get(fileTitle);
    if (!prev || mtime > prev.mtime) byBase.set(fileTitle, { path, fileTitle, mtime, part: parsed.part });
  }
  const partOrder = (fileTitle) => Number(fileTitle.match(/_P(\d+)$/)?.[1] || 0);
  return Array.from(byBase.values())
    .sort((a, b) => partOrder(a.fileTitle) - partOrder(b.fileTitle))
    .map(({ path, fileTitle, part }) => ({
      name: labelFor(fileTitle),
      dir,
      file: path,
      hasSummary: summarizedParts.includes(part),
    }));
}

// Enumerate a library folder for batch AI summarization. Handles BOTH
// shapes: a collection folder (entries come from its video subfolders) and a
// standalone multi-P video folder (its per-P export files are entries in
// their own right — a multi-P video gets the same batch treatment a
// collection gets).
function scanFolderForSummary(saveDir, folderPath) {
  const base = String(saveDir || "");
  const target = String(folderPath || "");
  if (!base || !target.startsWith(base)) {
    return { success: false, error: "文件不在当前保存目录内。" };
  }
  let entries;
  try {
    entries = readdirSync(target, { withFileTypes: true });
  } catch (error) {
    return { success: false, error: error.message };
  }
  const videos = [];
  // Files directly inside the folder (standalone video exports / loose docs
  // in a collection folder) label by their file title.
  const directNames = entries.filter((e) => e.isFile()).map((e) => e.name);
  videos.push(...summarizeFileEntries(target, directNames, (fileTitle) => fileTitle));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "picture") continue;
    const dir = join(target, entry.name);
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    videos.push(
      ...summarizeFileEntries(dir, names, (fileTitle) => {
        const part = fileTitle.match(/_P(\d+)$/);
        return part ? `${entry.name}（${part[0].slice(1)}）` : entry.name;
      }),
    );
  }
  videos.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { success: true, videos };
}

// Whole-library scan for “AI总结全部”: one entry per summarizable document
// across every grouping shape — collections/uploaders (video folders
// inside), multi-P videos (P folders inside) and legacy standalone folders
// (files directly inside a top-level video folder).
function scanLibraryForSummary(saveDir) {
  const base = String(saveDir || "");
  if (!base || !existsSync(base)) return { success: false, error: "保存目录不存在。" };
  let tops;
  try {
    tops = readdirSync(base, { withFileTypes: true });
  } catch (error) {
    return { success: false, error: error.message };
  }
  const videos = [];
  for (const top of tops) {
    if (!top.isDirectory()) continue;
    const topDir = join(base, top.name);
    let subs;
    try {
      subs = readdirSync(topDir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Legacy standalone video folder (or loose docs): files directly inside.
    const directNames = subs.filter((e) => e.isFile()).map((e) => e.name);
    videos.push(...summarizeFileEntries(topDir, directNames, (fileTitle) => fileTitle));
    // Group folders (collection / uploader / multi-P video): one entry per
    // video or P folder inside, labeled group/folder. A video folder's per-P
    // FILES carry the (Pn) marker in the label; a P folder already has it.
    for (const sub of subs) {
      if (!sub.isDirectory() || sub.name === "picture") continue;
      const subDir = join(topDir, sub.name);
      const isPartFolder = /^P\d+$/.test(sub.name);
      let names = [];
      try {
        names = readdirSync(subDir);
      } catch {
        continue;
      }
      videos.push(
        ...summarizeFileEntries(subDir, names, (fileTitle) => {
          const base = `${top.name}/${sub.name}`;
          if (isPartFolder) return base;
          const part = fileTitle.match(/_P(\d+)$/);
          return part ? `${base}（${part[0].slice(1)}）` : base;
        }),
      );
    }
  }
  videos.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { success: true, videos };
}

export { scanLibrary, readLibraryFile, scanFolderForSummary, scanLibraryForSummary };

// ---- video folder identity -----------------------------------------------
// A video is found by its BV id, never by recomputing a folder name from a
// title: the name varies with the title's source, its length, the save dir's
// depth and whatever condensed it, but the _BV号 suffix is the same in every
// one of them. One BV → one folder in the library (the first writer picks
// it), so exports, notes and summaries of a video always share a directory —
// and a folder the user renamed or moved is still found.

const VIDEO_DIR_BV_RE = /BV[A-Za-z0-9]+$/i;

function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// BV (upper-cased) → candidate video folders, one or two levels under the
// save dir. Read fresh on every call — a few milliseconds for a library of
// hundreds of videos — so a folder the user renamed or moved is never looked
// up under a name cached before the change.
export function indexVideoDirs(saveDir) {
  const base = String(saveDir || "");
  const byBvid = new Map();
  if (!base) return byBvid;

  const add = (name, dir) => {
    const bvid = name.match(VIDEO_DIR_BV_RE)?.[0]?.toUpperCase();
    if (!bvid) return;
    if (!byBvid.has(bvid)) byBvid.set(bvid, []);
    byBvid.get(bvid).push(dir);
  };
  for (const top of listDir(base)) {
    if (!top.isDirectory() || top.name.startsWith(".") || top.name === "picture") continue;
    const topDir = join(base, top.name);
    add(top.name, topDir);
    for (const sub of listDir(topDir)) {
      if (sub.isDirectory() && sub.name !== "picture" && !sub.name.startsWith(".")) {
        add(sub.name, join(topDir, sub.name));
      }
    }
  }
  return byBvid;
}

// The head a video's files take from its folder name — the folder is where
// the name was decided, whatever rule produced it. (The P{n} subfolder of the
// multi-P layout does not carry it.) "" for a folder that is not a video's.
export function videoHeadOf(dir) {
  const folder = /^P\d+$/.test(basename(dir)) ? dirname(dir) : dir;
  return parseVideoDirName(basename(folder))?.head || "";
}

// Every folder carrying this BV, best first: the one holding the video's
// transcript exports before one that only ever received a stray file, then
// the fullest, then the shortest name. A library that never had duplicates
// sees a single entry.
export function videoDirCandidates(saveDir, bvid) {
  const key = String(bvid || "").toUpperCase();
  if (!key || !saveDir) return [];
  return (indexVideoDirs(saveDir).get(key) || [])
    .filter((dir) => existsSync(dir))
    .map((dir) => {
      const entries = listDir(dir);
      const docs = entries.filter((entry) => entry.isFile() && parseDocName(entry.name).kind === "doc").length;
      return { dir, docs, entries: entries.length };
    })
    .sort(
      (a, b) =>
        b.docs - a.docs ||
        b.entries - a.entries ||
        a.dir.length - b.dir.length ||
        a.dir.localeCompare(b.dir),
    )
    .map((candidate) => candidate.dir);
}

// The folder a video's files live in, or null when the library does not have
// the video yet.
export function findVideoDir(saveDir, bvid) {
  return videoDirCandidates(saveDir, bvid)[0] || null;
}

// The AI summary of a document is found by identity — the AI总结_ file in
// the same folder carrying the same part marker — never by recomputing a
// name from the title. Re-summaries overwrite that file in place, so a name
// the user may already link to stays put; a first summary is named after
// its document.
export function summaryTargetFor(filePath) {
  const dir = dirname(filePath);
  const doc = parseDocName(basename(filePath));
  const existing = listDir(dir)
    .filter((entry) => entry.isFile())
    .map((entry) => ({ name: entry.name, parsed: parseDocName(entry.name) }))
    .filter(({ parsed }) => parsed.kind === "summary" && !parsed.derived && parsed.part === doc.part);
  if (existing.length) {
    const canonical = `${summaryBase(doc)}.md`;
    const preferred = existing.find(({ name }) => name === canonical);
    const newest = existing.slice().sort((a, b) => mtimeOf(join(dir, b.name)) - mtimeOf(join(dir, a.name)))[0];
    return join(dir, (preferred || newest).name);
  }
  return assertFits(fitUnder(dir, `${summaryBase(doc)}.md`));
}

function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

// ---- collection incremental update ---------------------------------------
// "Already exported" is decided by folder names: every video folder is
// 视频名_BV号 (videoFolderName), and BV ids survive sanitize untouched.

const BV_SUFFIX_RE = /(BV[A-Za-z0-9]+)$/;

export function exportedBvids(saveDir, collectionTitle) {
  const set = new Set();
  try {
    const dir = join(String(saveDir || "."), String(collectionTitle || ""));
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const bv = entry.name.match(BV_SUFFIX_RE)?.[1];
      if (bv) set.add(bv);
    }
  } catch {}
  return set;
}

// Annotate collection videos with exported/newPages. The BV index (see
// "video folder identity" below) finds every folder of a video wherever it
// sits — in a collection, under an uploader, or top-level with P{n} folders —
// and all of them contribute their parts, so a legacy duplicate never hides
// an exported part from the diff. A `_全部P` file means fully covered.
// `collectionTitle` stays in the signature for call-site clarity; the lookup
// is deliberately collection-agnostic.
// Above this many missing parts an "incremental" update is really a
// bulk re-export in disguise (hundred-part videos whose P1 was exported
// long ago) — bail out and leave the video to manual whole-video re-export
// instead of queueing hundreds of single-P items.
const MAX_NEW_PAGES = 50;

export function markExported(saveDir, collectionTitle, videos) {
  const byBvid = indexVideoDirs(String(saveDir || "."));
  return (Array.isArray(videos) ? videos : []).map((video) => {
    const dirs = (byBvid.get(String(video.bvid || "").toUpperCase()) || []).filter((dir) => existsSync(dir));
    const pages = new Set();
    let fullCover = false;
    for (const dir of dirs) {
      pages.add(1); // a plain export file counts as P1
      for (const entry of listDir(dir)) {
        // The standalone multi-P layout keeps one P{n} folder per part.
        if (entry.isDirectory()) {
          if (/^P\d+$/.test(entry.name)) pages.add(Number(entry.name.slice(1)));
          continue;
        }
        // Markers are read where they live — at the end of an export's
        // name — never as a substring of a title.
        const parsed = parseDocName(entry.name);
        if (parsed.kind !== "doc") continue;
        if (parsed.part === "all") fullCover = true;
        else if (parsed.part !== "p1") pages.add(Number(parsed.part.slice(1)));
      }
    }
    const exported = dirs.length > 0;
    let newPages = [];
    // Remote P data missing (pageCount undefined) → skip P diff silently.
    if (exported && video.pageCount > 1 && !fullCover) {
      for (let p = 1; p <= video.pageCount; p += 1) {
        if (!pages.has(p)) newPages.push(p);
      }
      if (newPages.length > MAX_NEW_PAGES) newPages = [];
    }
    return { ...video, exported, newPages };
  });
}
