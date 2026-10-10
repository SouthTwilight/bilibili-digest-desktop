import AdmZip from "adm-zip";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { sanitizeName, exportFileTimestamp } from "./export-render.js";

// Windows Explorer's built-in zip handler reads entry names into a fixed
// 256-byte buffer and silently DROPS entries whose full path exceeds it
// (CJK is 3 bytes per char, so a ~90-char Chinese path already overflows) —
// the archive then opens as "invalid". Cap every path segment to a byte
// budget while keeping the _BV号 / _Pn suffixes that carry identity, so the
// whole entry stays well under the limit (and extraction paths stay short).
const BYTES_ROOT = 66;
const BYTES_FOLDER = 72;
const BYTES_FILE = 72;

function utf8Bytes(text) {
  return Buffer.byteLength(text, "utf8");
}

// Truncate a name to a UTF-8 byte budget, preserving an identity suffix
// (_BV号 / _Pn / .md) that must survive truncation.
function capByBytes(text, budget, keepSuffix = "") {
  if (utf8Bytes(text) <= budget) return text;
  const head = keepSuffix ? text.slice(0, text.length - keepSuffix.length) : text;
  let out = "";
  for (const ch of head) {
    if (utf8Bytes(out + ch) + utf8Bytes(keepSuffix) > budget) break;
    out += ch;
  }
  return out + keepSuffix;
}

// Collection / uploader root folder.
function capRoot(name) {
  return capByBytes(name, BYTES_ROOT);
}

// Video folder 视频名_BV号 — never lose the BV suffix (uniqueness).
function capFolder(name) {
  const m = name.match(/_(BV[\w]+)$/);
  return capByBytes(name, BYTES_FOLDER, m ? m[0] : "");
}

// Summary file AI总结_视频名(_Pn)?.md — keep the P marker and extension.
function capFile(name) {
  const m = name.match(/(_P\d+)?\.md$/);
  return capByBytes(name, BYTES_FILE, m ? m[0] : ".md");
}

function listSummaryFiles(dir) {
  try {
    return readdirSync(dir).filter((name) => /^AI总结_.*\.md$/i.test(name)).sort();
  } catch {
    return [];
  }
}

// Pack the AI summaries of selected video folders into one zip that mirrors
// the library layout ({合集名}/{视频文件夹}/AI总结_*.md, plus P*/ subfolders
// for multi-P videos) and a manifest.json — unpacking it into another
// machine's save dir completes the migration. Entry names are built with
// explicit "/" so the archive stays portable.
export function packSummaries({ saveDir, collectionTitle = "", videoDirs }) {
  const base = String(saveDir || "");
  const dirs = (Array.isArray(videoDirs) ? videoDirs : []).filter((dir) =>
    String(dir || "").startsWith(base),
  );
  if (!dirs.length) return { success: false, error: "没有可打包的视频目录。" };

  const rootName = capRoot(sanitizeName(collectionTitle) || "");
  const zip = new AdmZip();
  const videos = [];
  for (const dir of dirs) {
    // One group per storage location: the video folder itself plus each
    // per-P subfolder of the multi-P layout.
    const groups = [];
    const direct = listSummaryFiles(dir);
    if (direct.length) groups.push({ label: capFolder(basename(dir)), dir, names: direct });
    let subs = [];
    try {
      subs = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^P\d+$/.test(e.name))
        .map((e) => e.name)
        .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    } catch {}
    for (const sub of subs) {
      const names = listSummaryFiles(join(dir, sub));
      if (names.length) groups.push({ label: `${capFolder(basename(dir))}/${sub}`, dir: join(dir, sub), names });
    }
    for (const group of groups) {
      const files = [];
      for (const name of group.names) {
        const entryName = capFile(name);
        zip.addFile([rootName, group.label, entryName].filter(Boolean).join("/"), readFileSync(join(group.dir, name)));
        files.push(entryName);
      }
      videos.push({ folder: group.label, files });
    }
  }
  if (!videos.length) {
    return { success: false, error: "所选视频还没有生成 AI 总结。" };
  }

  const manifest = {
    app: "Bilibili Digest",
    kind: "ai-summaries",
    collectionTitle: collectionTitle || null,
    generatedAt: new Date().toISOString(),
    videos,
  };
  zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"));

  const fileCount = videos.reduce((total, video) => total + video.files.length, 0);
  // Keep the zip filename short too — Explorer's extract-all nests the
  // destination folder under the archive name.
  const label = (rootName || sanitizeName(basename(dirs[0])) || "视频").slice(0, 33);
  const outFile = join(base, `AI总结打包_${label}_${exportFileTimestamp()}.zip`);
  writeFileSync(outFile, zip.toBuffer());
  return { success: true, file: outFile, videos: videos.length, files: fileCount };
}
