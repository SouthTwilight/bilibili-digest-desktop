import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";

const SCHEMA_VERSION = 1;
const CACHE_TTL_DAYS = 30;
const MAX_ENTRIES = 200;

export function createDigestCache(dir) {
  mkdirSync(dir, { recursive: true });

  function fileFor(videoId) {
    return join(dir, `${String(videoId).replace(/[^\w@.-]/g, "_")}.json`);
  }

  function load(videoId) {
    try {
      const file = fileFor(videoId);
      if (!existsSync(file)) return null;
      const cached = JSON.parse(readFileSync(file, "utf8"));
      if (cached.schemaVersion !== SCHEMA_VERSION) {
        unlinkSync(file);
        return null;
      }
      const ageDays = (Date.now() - Number(cached.savedAt || 0)) / 86_400_000;
      if (ageDays > CACHE_TTL_DAYS) {
        unlinkSync(file);
        return null;
      }
      return cached;
    } catch {
      return null;
    }
  }

  function save(videoId, entry) {
    const file = fileFor(videoId);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        savedAt: Date.now(),
        videoId,
        ...entry,
      }),
      "utf8",
    );
    evictOldEntries();
  }

  // Cheap LRU-ish sweep: drop the oldest files beyond the entry cap.
  function evictOldEntries() {
    try {
      const files = readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
        .sort((a, b) => a.mtime - b.mtime);
      const excess = files.length - MAX_ENTRIES;
      for (let i = 0; i < excess; i += 1) {
        unlinkSync(join(dir, files[i].name));
      }
    } catch {
      // Cache housekeeping must never break saving.
    }
  }

  return { load, save };
}
