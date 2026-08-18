import { contextBridge, ipcRenderer } from "electron";

// Runs inside the embedded Bilibili browser view. Only capability: report
// the "n" note shortcut with the player's current timestamp.
contextBridge.exposeInMainWorld("digestBridge", {
  noteShortcut: (payload) => ipcRenderer.send("note:shortcut-n", payload),
});

window.addEventListener("keydown", (event) => {
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
  event.preventDefault();
  event.stopPropagation();
  const video = document.querySelector("video");
  const seconds = video ? Math.max(0, Math.floor(video.currentTime) - 3) : null;
  window.digestBridge.noteShortcut({
    seconds,
    url: location.href,
    paused: video ? video.paused : true,
  });
});
