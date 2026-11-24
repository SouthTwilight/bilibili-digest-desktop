import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fitDirUnder, assertFits } from "./paths.js";
import {
  videoDirName,
  collectionDirName,
  uploaderDirName,
  identityHead,
  parseDocName,
} from "./naming.js";
import { findVideoDir } from "./library.js";

export function videoFolderName(videoTitle, bvid) {
  return videoDirName(videoTitle, bvid);
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
    return [collectionDirName(collectionTitle), videoDir];
  }
  if (Number(pageCount) > 1) {
    return [videoDir, `P${Math.max(1, Number(page) || 1)}`];
  }
  return [uploaderDirName(channelName), videoDir];
}

// An existing folder decides its own layout: P{n} subfolders once it has
// any, otherwise flat. A top-level standalone folder (the multi-P layout)
// starts them as soon as a multi-P context writes into it and nothing has
// been laid out flat there yet.
function withPartLayout(dir, context, base) {
  const entries = listDir(dir);
  const flatDocs = entries.some((entry) => entry.isFile() && parseDocName(entry.name).kind === "doc");
  const topLevel = trimSeparators(dirname(dir)) === trimSeparators(join(base, "."));
  const usePartFolders =
    entries.some((entry) => entry.isDirectory() && /^P\d+$/.test(entry.name)) ||
    (topLevel && Number(context.pageCount) > 1 && !flatDocs);
  return usePartFolders ? join(dir, `P${Math.max(1, Number(context.page) || 1)}`) : dir;
}

function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function trimSeparators(path) {
  return path.replace(/[\\/]+$/, "");
}

// READ path (sync): the folder a video's files live in — found by BV when
// the library already has the video, computed from the context when not.
export function resolveVideoDir(context) {
  const base = String(context.base || ".");
  const existing = findVideoDir(base, context.bvid);
  if (existing) return withPartLayout(existing, context, base);
  return fitDirUnder(base, ...videoDirSegments(context));
}

// WRITE path (async): the same, except that a video new to the library gets
// its head from `decideVideoHead` first — the caller may condense a long
// title through the text model. Creating the folder is left to the writer
// that has something to put in it.
export async function ensureVideoDir(context, decideVideoHead = mechanicalVideoHead) {
  const base = String(context.base || ".");
  const existing = findVideoDir(base, context.bvid);
  if (existing) return withPartLayout(existing, context, base);
  const head = await decideVideoHead(context.videoTitle, context.bvid, base, context);
  return fitDirUnder(base, ...videoDirSegments({ ...context, videoTitle: head }));
}

// The head a new folder gets when no model condenses the title.
export function mechanicalVideoHead(title) {
  return identityHead(title);
}

// Notes live in the user's save directory in the same three-level layout as
// exports; the video folder also holds pictures and, later, summaries.
export function createNotesStore({ saveDirResolver, legacyPath, decideVideoHead = mechanicalVideoHead }) {
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

    async add({ bvid, timestamp, text, videoTitle, channelName, collectionTitle, pageCount, page, imageBase64 }) {
      const base = saveDirResolver() || ".";
      const dir = await ensureVideoDir(
        { collectionTitle, channelName, videoTitle, bvid, pageCount, page, base },
        decideVideoHead,
      );
      const file = assertFits(join(dir, "notes.json"));
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
          note.picture = savePicture(dir, imageBase64, note.id, note.timestamp);
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
