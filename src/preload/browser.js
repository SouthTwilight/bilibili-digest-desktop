import { contextBridge, ipcRenderer } from "electron";

// Runs inside the embedded Bilibili browser view. Capabilities: report the
// "n" note shortcut with the player's current timestamp, plus a hover button
// over the player that does the same thing with the mouse.
contextBridge.exposeInMainWorld("digestBridge", {
  noteShortcut: (payload) => ipcRenderer.send("note:shortcut-n", payload),
});

function currentSeconds() {
  const video = document.querySelector("video");
  return video ? Math.max(0, Math.floor(video.currentTime) - 3) : null;
}

function sendNoteShortcut() {
  try {
    const video = document.querySelector("video");
    window.digestBridge.noteShortcut({
      seconds: currentSeconds(),
      url: location.href,
      paused: video ? video.paused : true,
    });
  } catch {
    // Bridge hiccup on a dying frame; the next keypress will retry.
  }
}

// Bilibili's own key handling can stop propagation in the bubble phase, so
// listen in the CAPTURE phase (earliest possible point) on both window and
// document; dedupe because the event reaches both targets.
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

// ---- player overlay button -------------------------------------------------
// Mirrors the extension's note button: floats over the player's TOP-LEFT
// (Bilibili stacks its own chrome top-right), visible while the cursor is
// over the player.
function mountNoteButton() {
  if (document.getElementById("digest-note-button")) return;
  const player =
    document.querySelector(".bpx-player-container") ||
    document.querySelector("#bilibili-player");
  if (!player) return;
  if (getComputedStyle(player).position === "static") {
    player.style.position = "relative";
  }

  const button = document.createElement("button");
  button.id = "digest-note-button";
  button.type = "button";
  button.textContent = "📝 记笔记";
  button.style.cssText = [
    "position:absolute",
    "top:70px",
    "left:16px",
    "z-index:99999",
    "border:none",
    "border-radius:999px",
    "padding:7px 16px",
    "font:600 13px system-ui,sans-serif",
    "background:#fb7299",
    "color:#fff",
    "cursor:pointer",
    "box-shadow:0 4px 14px rgba(0,0,0,.35)",
    "opacity:0",
    "pointer-events:none",
    "transition:opacity .25s",
  ].join(";");

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    sendNoteShortcut();
    button.textContent = "✓ 已记录";
    setTimeout(() => (button.textContent = "📝 记笔记"), 1600);
  });

  player.appendChild(button);
  player.addEventListener("mouseenter", () => {
    button.style.opacity = "1";
    button.style.pointerEvents = "auto";
  });
  player.addEventListener("mouseleave", () => {
    button.style.opacity = "0";
    button.style.pointerEvents = "none";
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountNoteButton);
} else {
  mountNoteButton();
}
// Bilibili is an SPA: rebuild the button when navigation swaps the player.
const observer = new MutationObserver(() => mountNoteButton());
const startObserving = () => observer.observe(document.body, { childList: true, subtree: true });
if (document.body) startObserving();
else document.addEventListener("DOMContentLoaded", startObserving);
