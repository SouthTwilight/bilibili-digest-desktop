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
const SAFE_PATH_LIMIT = 245; // headroom under MAX_PATH 260

const FILE_SUFFIX = /(_P\d+)?(_\d{4}-\d{2}-\d{2}_\d{2}-\d{2})?(\.[a-z0-9]+)$/i;
const DIR_SUFFIX = /(_BV\w+)$/;

function clampSegment(parts, index, suffixRegex, minTotal) {
  const segment = parts[index];
  const match = segment.match(suffixRegex);
  const suffix = match ? match[0] : "";
  const head = suffix ? segment.slice(0, segment.length - suffix.length) : segment;
  if (head.length <= minTotal) return false;
  parts[index] = head.slice(0, Math.max(minTotal, head.length - 8)) + suffix;
  return true;
}

// Fit `segments` under `baseDir` within the path budget; returns the fitted
// segments (baseDir excluded — callers join it back themselves).
export function fitSegments(baseDir, segments, limit = SAFE_PATH_LIMIT) {
  const parts = segments.map((segment) => String(segment));
  const over = () => join(baseDir, ...parts).length > limit;
  if (!over()) return parts;

  let guard = 64;
  while (over() && guard-- > 0) {
    // Filename first, then folders deepest → shallowest (P folders skipped).
    let changed = clampSegment(parts, parts.length - 1, FILE_SUFFIX, 16);
    if (!changed) {
      for (let i = parts.length - 2; i >= 0 && !changed; i -= 1) {
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
