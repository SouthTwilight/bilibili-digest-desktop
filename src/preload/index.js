import { contextBridge, ipcRenderer } from "electron";

// The renderer talks to the main process exclusively through this bridge.
contextBridge.exposeInMainWorld("desktop", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (input) => ipcRenderer.invoke("settings:set", input),
  pickSaveDir: () => ipcRenderer.invoke("settings:pick-save-dir"),

  getVideoDetails: (videoId) => ipcRenderer.invoke("video:details", videoId),
  getCollectionInfo: (videoId) => ipcRenderer.invoke("video:collection-info", videoId),
  getTranscript: (videoId, page, mode) =>
    ipcRenderer.invoke("transcript:get", { videoId, page, mode }),
  analyzeDigest: (videoId, page) => ipcRenderer.invoke("digest:analyze", { videoId, page }),
  seekVideo: (seconds) => ipcRenderer.invoke("video:seek", seconds),
  getCurrentTime: () => ipcRenderer.invoke("video:current-time"),
  revealInFolder: (filePath) => ipcRenderer.invoke("shell:reveal", filePath),
  navGo: (direction) => ipcRenderer.invoke("nav:go", direction),
  navReload: () => ipcRenderer.invoke("nav:reload"),
  navHome: () => ipcRenderer.invoke("nav:home"),

  translateBatch: (videoTitle, segments) =>
    ipcRenderer.invoke("transcript:translate", { videoTitle, segments }),
  explain: (payload) => ipcRenderer.invoke("explain", payload),
  listNotes: (scope) => ipcRenderer.invoke("notes:list", scope),
  listNotesFor: (video) => ipcRenderer.invoke("notes:list-for", video),
  addNote: (note) => ipcRenderer.invoke("notes:add", note),
  deleteNote: (id) => ipcRenderer.invoke("notes:delete", id),
  polishNote: (payload) => ipcRenderer.invoke("notes:polish", payload),
  saveTranslations: (videoId, page, translations, source) =>
    ipcRenderer.invoke("digest:save-translations", { videoId, page, translations, source }),

  onLayout: (callback) =>
    ipcRenderer.on("layout:update", (_event, layout) => callback(layout)),
  onVideoChanged: (callback) =>
    ipcRenderer.on("video:changed", (_event, video) => callback(video)),
  onDigestProgress: (callback) =>
    ipcRenderer.on("digest:progress", (_event, progress) => callback(progress)),
  onNavState: (callback) =>
    ipcRenderer.on("nav:state", (_event, state) => callback(state)),
  onNoteShortcut: (callback) =>
    ipcRenderer.on("note:shortcut", (_event, payload) => callback(payload)),
});
