import AdmZip from "adm-zip";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { sanitizeName, exportFileTimestamp } from "./export-render.js";

// Pack the AI summaries of selected video folders into one zip that mirrors
// the library layout ({合集名}/{视频文件夹}/AI总结_*.md) plus a manifest.json
// — unpacking it into another machine's save dir completes the migration.
// Entry names are built with explicit "/" so the archive stays portable.
export function packSummaries({ saveDir, collectionTitle = "", videoDirs }) {
  const base = String(saveDir || "");
  const dirs = (Array.isArray(videoDirs) ? videoDirs : []).filter((dir) =>
    String(dir || "").startsWith(base),
  );
  if (!dirs.length) return { success: false, error: "没有可打包的视频目录。" };

  const rootName = sanitizeName(collectionTitle) || "";
  const zip = new AdmZip();
  const videos = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = readdirSync(dir).filter((name) => /^AI总结_.*\.md$/i.test(name)).sort();
    } catch {
      continue;
    }
    if (!names.length) continue;
    const folder = basename(dir);
    for (const name of names) {
      zip.addFile([rootName, folder, name].filter(Boolean).join("/"), readFileSync(join(dir, name)));
    }
    videos.push({ folder, files: names });
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
  const label = rootName || sanitizeName(basename(dirs[0])) || "视频";
  const outFile = join(base, `AI总结打包_${label}_${exportFileTimestamp()}.zip`);
  writeFileSync(outFile, zip.toBuffer());
  return { success: true, file: outFile, videos: videos.length, files: fileCount };
}
