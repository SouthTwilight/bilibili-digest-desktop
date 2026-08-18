import { contextBridge, ipcRenderer } from "electron";

// Runs inside the embedded Bilibili browser view. Invisible by design: the
// page must stay indistinguishable from a plain browser, so this preload
// only listens for the "n" note shortcut (capture phase — Bilibili's own
// key handling can stop propagation in the bubble phase).
contextBridge.exposeInMainWorld("digestBridge", {
  noteShortcut: (payload) => ipcRenderer.send("note:shortcut-n", payload),
});

function sendNoteShortcut() {
  try {
    const video = document.querySelector("video");
    const seconds = video ? Math.max(0, Math.floor(video.currentTime) - 3) : null;
    window.digestBridge.noteShortcut({
      seconds,
      url: location.href,
      paused: video ? video.paused : true,
    });
  } catch {
    // Bridge hiccup on a dying frame; the next keypress will retry.
  }
}

let lastHandledAt = 0;
function handleKeydown(event) {
  if (event.key !== "n" && event.key !== "N") return;
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  const active = document.activeElement;
  if (
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.isContentEditable)
  ) {
    return;
  }
  if (Date.now() - lastHandledAt < 100) return;
  lastHandledAt = Date.now();
  event.preventDefault();
  event.stopPropagation();
  sendNoteShortcut();
}

window.addEventListener("keydown", handleKeydown, { capture: true });
document.addEventListener("keydown", handleKeydown, { capture: true });
