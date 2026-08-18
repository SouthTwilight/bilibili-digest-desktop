import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// Simple JSON-file note store. Notes are keyed by video and carry the
// timestamp they were taken at, so clicking one seeks the browser view.
export function createNotesStore(filePath) {
  function load() {
    try {
      if (existsSync(filePath)) {
        const data = JSON.parse(readFileSync(filePath, "utf8"));
        if (Array.isArray(data?.notes)) return data.notes;
      }
    } catch {
      // Corrupt store behaves as empty; saving will rewrite it.
    }
    return [];
  }

  function persist(notes) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ notes }, null, 2), "utf8");
  }

  return {
    list(videoId = null) {
      const notes = load();
      const filtered = videoId ? notes.filter((note) => note.videoId === videoId) : notes;
      return filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    },
    add({ videoId, timestamp, text, videoTitle, channelName }) {
      const notes = load();
      const note = {
        id: randomUUID(),
        videoId,
        timestamp: Math.max(0, Math.floor(Number(timestamp) || 0)),
        text: String(text || "").trim(),
        videoTitle: String(videoTitle || ""),
        channelName: String(channelName || ""),
        createdAt: Date.now(),
      };
      notes.push(note);
      persist(notes);
      return note;
    },
    remove(id) {
      const notes = load().filter((note) => note.id !== id);
      persist(notes);
      return { success: true };
    },
    removeForVideo(videoId) {
      const notes = load().filter((note) => note.videoId !== videoId);
      persist(notes);
      return { success: true };
    },
  };
}
