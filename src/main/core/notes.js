import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

// Keep CJK titles but drop characters that are illegal in Windows filenames.
// Fullwidth lookalikes (：？"＼ etc.) are technically legal but normalized away
// anyway to keep folder names predictable.
function sanitizeDirName(name) {
  return String(name || "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[＼／：＊？＂＜＞｜]/g, "")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 60);
}

export function videoFolderName(videoTitle, bvid) {
  return `${sanitizeDirName(videoTitle) || "未命名视频"}_${bvid}`;
}

// Notes live in the user's save directory, one folder per video:
//   {saveDir}/{合集名}/{视频名_BV号}/notes.json   (in a collection)
//   {saveDir}/{视频名_BV号}/notes.json            (standalone video)
// The same folder will later hold exported transcripts and summaries (M4).
export function createNotesStore({ saveDirResolver, legacyPath }) {
  function migratedLegacyNotes() {
    try {
      if (!legacyPath || !existsSync(legacyPath)) return [];
      const data = JSON.parse(readFileSync(legacyPath, "utf8"));
      return Array.isArray(data?.notes) ? data.notes : [];
    } catch {
      return [];
    }
  }

  function storeFile({ collectionTitle, videoTitle, bvid }) {
    const videoDir = videoFolderName(videoTitle, bvid);
    const base = saveDirResolver() || ".";
    return collectionTitle
      ? join(base, sanitizeDirName(collectionTitle) || "合集", videoDir, "notes.json")
      : join(base, videoDir, "notes.json");
  }

  function readFile(file) {
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      return Array.isArray(data?.notes) ? data.notes : [];
    } catch {
      return [];
    }
  }

  function writeFile(file, notes) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ notes }, null, 2), "utf8");
  }

  // Import old userData notes once so nothing is lost when switching to the
  // directory layout. Collection membership is not resolved here; the next
  // save from that video rewrites the file in the right place.
  let legacyPending = migratedLegacyNotes();

  return {
    add({ bvid, timestamp, text, videoTitle, channelName, collectionTitle }) {
      const file = storeFile({ collectionTitle, videoTitle, bvid });
      const notes = readFile(file);
      notes.push({
        id: randomUUID(),
        videoId: `${bvid}@p1`,
        bvid,
        timestamp: Math.max(0, Math.floor(Number(timestamp) || 0)),
        text: String(text || "").trim(),
        videoTitle: String(videoTitle || ""),
        channelName: String(channelName || ""),
        collectionTitle: String(collectionTitle || ""),
        createdAt: Date.now(),
      });
      writeFile(file, notes);
      return notes[notes.length - 1];
    },

    listFor({ bvid, videoTitle, collectionTitle }) {
      const file = storeFile({ collectionTitle, videoTitle, bvid });
      const legacy = legacyPending.filter((note) => note.videoId?.startsWith(bvid));
      if (legacy.length) {
        const merged = [...readFile(file), ...legacy];
        legacyPending = legacyPending.filter((note) => !note.videoId?.startsWith(bvid));
        if (merged.length) writeFile(file, merged);
        return merged.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      }
      return readFile(file).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    },

    // Walk the save directory: standalone videos match */notes.json, videos in
    // collections match */*/notes.json. The parent folder name identifies the
    // collection, grandparent identifies the video folder.
    listAll() {
      const base = saveDirResolver() || ".";
      const notes = [];
      try {
        for (const entry of readdirSync(base, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const collectionName = entry.name;
          const collectionDir = join(base, collectionName);
          // Direct notes.json = standalone video folder.
          const direct = join(collectionDir, "notes.json");
          if (existsSync(direct)) {
            notes.push(...readFile(direct));
            continue;
          }
          for (const videoEntry of readdirSync(collectionDir, { withFileTypes: true })) {
            if (!videoEntry.isDirectory()) continue;
            const file = join(collectionDir, videoEntry.name, "notes.json");
            if (existsSync(file)) notes.push(...readFile(file));
          }
        }
      } catch {
        // Unreadable save directory behaves as empty.
      }
      return notes.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    },

    remove(id) {
      const base = saveDirResolver() || ".";
      const targets = [];
      try {
        for (const entry of readdirSync(base, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const dir = join(base, entry.name);
          const direct = join(dir, "notes.json");
          if (existsSync(direct)) targets.push(direct);
          else {
            for (const sub of readdirSync(dir, { withFileTypes: true })) {
              if (sub.isDirectory()) {
                const f = join(dir, sub.name, "notes.json");
                if (existsSync(f)) targets.push(f);
              }
            }
          }
        }
      } catch {
        return { success: false };
      }
      for (const file of targets) {
        const notes = readFile(file);
        if (notes.some((note) => note.id === id)) {
          writeFile(file, notes.filter((note) => note.id !== id));
          return { success: true };
        }
      }
      return { success: false };
    },
  };
}
