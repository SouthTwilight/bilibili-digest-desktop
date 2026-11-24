import AdmZip from "adm-zip";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { cleanTitle, clip } from "./naming.js";
import { exportFileTimestamp } from "./export-render.js";
import { fitUnder, assertFits } from "./paths.js";

// Compressing a whole library folder into ONE zip, for backup and moving.
// Entries are the folder's contents under their real names, relative to the
// folder — the same shape Windows' own "compressed (zipped) folder" produces,
// so Explorer's "Extract All" puts them back in a folder named after the
// archive.
//
// One constraint is not negotiable: Windows Explorer's built-in zip handler
// reads each entry's full path into a 260-BYTE buffer, counted in UTF-8
// (three bytes per Chinese character). A single longer path and the handler
// lists NOTHING from the archive — the whole file "opens as invalid".
// Measured on the shell's own handler: paths of 260 bytes list, 261 do not.
// Names are never shortened to fit: a folder with a path past the limit
// fails outright and says so, on the tasks page. New exports cannot hit the
// limit — a condensed title is at most 30 characters, which keeps every path
// under about 220 bytes — it only catches folders exported under the old
// 60-character names.
export const MAX_ENTRY_BYTES = 260;

export function utf8Bytes(text) {
  return Buffer.byteLength(String(text), "utf8");
}

// `dirPath` must be a folder directly under the save dir.
export function isLibraryFolder(saveDir, dirPath) {
  if (!saveDir || !dirPath) return false;
  try {
    // resolve() on both sides: separators and trailing slashes differ between
    // a hand-typed save dir and a path joined by the scanner.
    return resolve(dirname(dirPath)) === resolve(saveDir) && statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

// {folder}_{timestamp}.zip, then " (2)", " (3)"… when the same folder is
// compressed again within the minute — never overwrite an earlier archive.
function archivePath(base, folderName) {
  const head = clip(cleanTitle(folderName)) || "导出库";
  const stamp = exportFileTimestamp();
  const name = (n) => `${head}_${stamp}${n > 1 ? ` (${n})` : ""}.zip`;
  let file = fitUnder(base, name(1));
  for (let n = 2; existsSync(file) && n < 1000; n += 1) file = fitUnder(base, name(n));
  return assertFits(file);
}

// Every file below `dir`, as the path it will have inside the archive.
// Symlinks and anything else are left alone: no cycles, no surprises.
function listEntries(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) out.push(...listEntries(join(dir, entry.name), `${relative}/`));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

// Zip one library folder into {folder}_{timestamp}.zip next to it. Fails,
// without writing anything, when a path inside would be unreadable in
// Explorer — `error` leads with how many paths overstay the limit, because
// the tasks page only has room for the first dozen characters or so.
//
// Nothing here blocks the main thread for long: files are read one at a
// time and deflated one at a time on a worker thread, so the rest of the
// app stays usable while a big folder zips. `onProgress(done, total)` fires
// as each file is compressed — that count is the progress on the tasks page.
export async function compressFolder({ saveDir, dirPath, onProgress }) {
  const base = String(saveDir || "");
  const target = String(dirPath || "");
  if (!isLibraryFolder(base, target)) {
    return { success: false, error: "只能压缩导出库根目录下的文件夹。" };
  }

  const entries = listEntries(target);
  if (!entries.length) return { success: false, error: "这个文件夹是空的。" };
  const tooLong = entries.filter((entry) => utf8Bytes(entry) > MAX_ENTRY_BYTES);
  if (tooLong.length) {
    return {
      success: false,
      error:
        `${tooLong.length} 个文件的路径超过 ${MAX_ENTRY_BYTES} 字节，资源管理器打不开这样的压缩包，已取消压缩。` +
        `例如（${utf8Bytes(tooLong[0])} 字节）：${tooLong[0]}`,
    };
  }

  const zip = new AdmZip();
  for (const entry of entries) zip.addFile(entry, await readFile(join(target, entry)));
  let done = 0;
  // Callback form: one file deflated per tick, `done` counted as each lands.
  const buffer = await new Promise((resolve, reject) =>
    zip.toBuffer(resolve, reject, null, () => {
      done += 1;
      onProgress?.(done, entries.length);
    }),
  );
  const outFile = archivePath(base, basename(target));
  await writeFile(outFile, buffer);
  return { success: true, file: outFile, files: entries.length };
}
