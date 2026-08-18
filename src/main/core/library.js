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
    const files = entries.filter((e) => e.isFile()).map((e) => fileEntry(e.name, dir));
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

export { scanLibrary, readLibraryFile };
