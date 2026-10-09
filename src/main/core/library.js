import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname, basename } from "node:path";

// Scans the save directory into the sidebar's library tree:
//   collection folder  → contains video folders
//   video folder       → named 视频名_BV号, holds exported files + notes.json
function scanLibrary(saveDir) {
  if (!saveDir || !existsSync(saveDir)) return [];

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
        const video = { name: entry.name, path: dir, type: "video", children: directFiles };
        tree.push(video);
        continue;
      }
      if (videoDirs.length) {
        const children = videoDirs
          .map((d) => videoFolder(d.name, dir))
          .filter(Boolean);
        if (children.length || directFiles.length) {
          tree.push({ name: entry.name, path: dir, type: "collection", children: [...children, ...directFiles] });
        }
      }
    }
    return tree;
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

// Enumerate a collection's video folders for batch AI summarization. Inputs
// are plain transcript exports (AI 总结 and 笔记 outputs are excluded); every
// file is its own entry — per-P exports are separate documents sharing one
// video folder, and each P summarizes independently (AI总结_视频名_Pn.md).
// Re-exports carry timestamps, so only the newest file per base name is kept.
function scanCollectionForSummary(saveDir, collectionPath) {
  const base = String(saveDir || "");
  const target = String(collectionPath || "");
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
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "picture") continue;
    const dir = join(target, entry.name);
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const nameSet = new Set(names);
    const byBase = new Map();
    for (const name of names) {
      if (!name.toLowerCase().endsWith(".md") || /^AI总结_/i.test(name) || /^笔记_/.test(name)) {
        continue;
      }
      const fileTitle = name
        .replace(/\.md$/i, "")
        .replace(/[_-]\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$/, "");
      const path = join(dir, name);
      let mtime = 0;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {}
      const prev = byBase.get(fileTitle);
      if (!prev || mtime > prev.mtime) byBase.set(fileTitle, { path, fileTitle, mtime });
    }
    const partOrder = (fileTitle) => Number(fileTitle.match(/_P(\d+)$/)?.[1] || 0);
    const bases = Array.from(byBase.values()).sort((a, b) => partOrder(a.fileTitle) - partOrder(b.fileTitle));
    for (const { path, fileTitle } of bases) {
      const part = fileTitle.match(/_P(\d+)$/);
      videos.push({
        name: part ? `${entry.name}（${part[0].slice(1)}）` : entry.name,
        dir,
        file: path,
        hasSummary: nameSet.has(`AI总结_${fileTitle}.md`),
      });
    }
  }
  videos.sort((a, b) => a.name.localeCompare(b.name));
  return { success: true, videos };
}

export { scanLibrary, readLibraryFile, scanCollectionForSummary };
