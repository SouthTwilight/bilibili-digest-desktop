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
import { fitUnder } from "./paths.js";

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

// Unified three-level library layout — the single source of truth shared by
// exports, notes and pictures:
//   collection video      → {合集名}/{视频名_BV号}/
//   standalone multi-P    → {视频名_BV号}/P{n}/
//   standalone single-P   → {UP主名}/{视频名_BV号}/
// The BV suffix keeps same-titled videos (and same-named UPs' folders) from
// colliding; the UP grouping merges all of one uploader's videos.
export function videoDirSegments({ collectionTitle, channelName, videoTitle, bvid, pageCount, page }) {
  const videoDir = videoFolderName(videoTitle, bvid);
  if (collectionTitle) {
    return [sanitizeDirName(collectionTitle) || "合集", videoDir];
  }
  if (Number(pageCount) > 1) {
    return [videoDir, `P${Math.max(1, Number(page) || 1)}`];
  }
  return [sanitizeDirName(channelName) || "其他UP主", videoDir];
}

export function resolveVideoDir(context) {
  return fitUnder(String(context.base || "."), ...videoDirSegments(context));
}

// Notes live in the user's save directory in the same three-level layout as
// exports; the video folder also holds pictures and, later, summaries.
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

  function storeFile(context) {
    return join(
      resolveVideoDir({ ...context, base: saveDirResolver() || "." }),
      "notes.json",
    );
  }

  // The video's own folder (for exports, pictures, summaries).
  function videoDir(context) {
    return resolveVideoDir({ ...context, base: saveDirResolver() || "." });
  }

  function savePicture(dir, imageBase64, noteId, timestamp) {
    const pictureDir = join(dir, "picture");
    mkdirSync(pictureDir, { recursive: true });
    const stamp = `${String(Math.floor(timestamp / 60)).padStart(2, "0")}-${String(timestamp % 60).padStart(2, "0")}`;
    const file = `${stamp}_${noteId.slice(0, 8)}.jpg`;
    writeFileSync(join(pictureDir, file), Buffer.from(imageBase64, "base64"));
    return `picture/${file}`;
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
    videoDir,

    add({ bvid, timestamp, text, videoTitle, channelName, collectionTitle, pageCount, page, imageBase64 }) {
      const context = { collectionTitle, channelName, videoTitle, bvid, pageCount, page };
      const file = storeFile(context);
      const notes = readFile(file);
      const note = {
        id: randomUUID(),
        videoId: `${bvid}@p${Math.max(1, Number(page) || 1)}`,
        bvid,
        timestamp: Math.max(0, Math.floor(Number(timestamp) || 0)),
        text: String(text || "").trim(),
        videoTitle: String(videoTitle || ""),
        channelName: String(channelName || ""),
        collectionTitle: String(collectionTitle || ""),
        picture: null,
        createdAt: Date.now(),
      };
      if (imageBase64) {
        try {
          note.picture = savePicture(videoDir(context), imageBase64, note.id, note.timestamp);
        } catch {
          // A failed screenshot must never block the note itself.
        }
      }
      notes.push(note);
      writeFile(file, notes);
      return note;
    },

    listFor(context) {
      const file = storeFile(context);
      const legacy = legacyPending.filter((note) => note.videoId?.startsWith(context.bvid));
      if (legacy.length) {
        const merged = [...readFile(file), ...legacy];
        legacyPending = legacyPending.filter((note) => !note.videoId?.startsWith(context.bvid));
        if (merged.length) writeFile(file, merged);
        return merged.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      }
      return readFile(file).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    },

    // Walk the save directory: notes.json at depth one (legacy standalone
    // video folder) or depth two (collection / UP / multi-P video grouping).
    // A multi-P video folder can hold BOTH a legacy direct notes.json and
    // new P*/notes.json — both are collected.
    listAll() {
      const base = saveDirResolver() || ".";
      const notes = [];
      try {
        for (const entry of readdirSync(base, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const groupDir = join(base, entry.name);
          const direct = join(groupDir, "notes.json");
          if (existsSync(direct)) notes.push(...readFile(direct));
          for (const videoEntry of readdirSync(groupDir, { withFileTypes: true })) {
            if (!videoEntry.isDirectory()) continue;
            const file = join(groupDir, videoEntry.name, "notes.json");
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
          for (const sub of readdirSync(dir, { withFileTypes: true })) {
            if (sub.isDirectory()) {
              const f = join(dir, sub.name, "notes.json");
              if (existsSync(f)) targets.push(f);
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
