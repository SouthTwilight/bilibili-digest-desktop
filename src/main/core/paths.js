import { join } from "node:path";

// Windows caps FULL paths at 260 UTF-16 chars (unless LongPaths is enabled
// system-wide). Each library segment already caps its own length, but a deep
// saveDir plus long CJK titles can still push
// {saveDir}/{合集}/{视频名_BV}/P{n}/{文件名} past the limit — writes then
// fail with ENOENT. fitUnder lets normal-length paths through UNCHANGED and
// only when the total exceeds the budget shortens segments step by step:
// the filename first (keeping _Pn / timestamp / extension), then folder
// segments from the deepest up (keeping the _BV号 identity suffix); P{n}
// folders are never shortened. The base directory itself is untouchable.
//
// Every writer fits its path the same way: a video folder is created with
// MIN_FILE_RESERVE set aside for the smallest file that can land in it, so
// an export never meets a folder it cannot write into, and assertFits turns
// a hopeless path into a message instead of an ENOENT.
const SAFE_PATH_LIMIT = 245; // headroom under MAX_PATH 260

const FILE_SUFFIX = /(_(?:P\d+|全部P))?(_\d{4}-\d{2}-\d{2}_\d{2}-\d{2})?(\.[a-z0-9]+)$/i;
const DIR_SUFFIX = /(_BV\w+)$/;

// Separator + the 16-char head floor of a file name + _Pn + timestamp +
// ".html" — the least room a video folder needs for a file of its own.
export const MIN_FILE_RESERVE = 1 + 16 + 5 + 17 + 5;

function clampSegment(parts, index, suffixRegex, minTotal) {
  const segment = parts[index];
  const match = segment.match(suffixRegex);
  const suffix = match ? match[0] : "";
  const head = suffix ? segment.slice(0, segment.length - suffix.length) : segment;
  if (head.length <= minTotal) return false;
  // Take 8 units off the head, counted in what the path budget counts
  // (UTF-16 units) but cut on a code-point boundary — never through an emoji.
  const chars = Array.from(head);
  const budget = head.length - 8;
  let keep = 0;
  let units = 0;
  while (keep < chars.length && units + chars[keep].length <= budget) {
    units += chars[keep].length;
    keep += 1;
  }
  // …and never below minTotal, in the same unit: a floor counted in code
  // points would hand back 32 units of emoji where 16 were allowed.
  while (keep < chars.length && units < minTotal) {
    units += chars[keep].length;
    keep += 1;
  }
  // Never leave a trailing space or dot either: Windows drops both, so the
  // item on disk would not carry the name that was computed for it.
  parts[index] = chars.slice(0, keep).join("").replace(/[ .]+$/, "") + suffix;
  return true;
}

// Fit `segments` under `baseDir` within the path budget; returns the fitted
// segments (baseDir excluded — callers join it back themselves). `reserve`
// is path length set aside for children the caller appends itself, and
// `dirsOnly` treats every segment as a folder (the _BV号 rule throughout).
export function fitSegments(baseDir, segments, limit = SAFE_PATH_LIMIT, { reserve = 0, dirsOnly = false } = {}) {
  const parts = segments.map((segment) => String(segment));
  const over = () => join(baseDir, ...parts).length + reserve > limit;
  if (!over()) return parts;

  let guard = 64;
  while (over() && guard-- > 0) {
    // Filename first, then folders deepest → shallowest (P folders skipped).
    let changed = dirsOnly ? false : clampSegment(parts, parts.length - 1, FILE_SUFFIX, 16);
    if (!changed) {
      for (let i = (dirsOnly ? parts.length : parts.length - 1) - 1; i >= 0 && !changed; i -= 1) {
        if (/^P\d+$/.test(parts[i])) continue;
        changed = clampSegment(parts, i, DIR_SUFFIX, 12);
      }
    }
    if (!changed) break; // base dir alone is already at the limit — best effort
  }
  return parts;
}

// Convenience: baseDir + fitted segments, joined.
export function fitUnder(baseDir, ...segments) {
  return join(baseDir, ...fitSegments(baseDir, segments));
}

// A FOLDER path: every segment follows the folder rule and the smallest
// possible file is reserved below it.
export function fitDirUnder(baseDir, ...segments) {
  return join(
    baseDir,
    ...fitSegments(baseDir, segments, SAFE_PATH_LIMIT, { reserve: MIN_FILE_RESERVE, dirsOnly: true }),
  );
}

// Writers call this on a fitted path: when even the floors do not fit, say
// so instead of letting writeFileSync fail with a bare ENOENT.
export function assertFits(path) {
  if (path.length > SAFE_PATH_LIMIT) {
    const error = new Error(
      `保存路径超过 Windows 的 260 字符限制（当前 ${path.length} 字符），请把保存目录选得更浅一些。`,
    );
    error.code = "PATH_TOO_LONG";
    throw error;
  }
  return path;
}
