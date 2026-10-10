import { contextBridge, ipcRenderer } from "electron";

// Subscribe-and-return-unsubscribe: ipcRenderer.on() returns the emitter
// itself, so returning it directly made every view's off() cleanup throw
// (fn is not a function) and leak duplicate listeners across tab switches.
function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// The renderer talks to the main process exclusively through this bridge.
contextBridge.exposeInMainWorld("desktop", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (input) => ipcRenderer.invoke("settings:set", input),
  pickSaveDir: () => ipcRenderer.invoke("settings:pick-save-dir"),

  getVideoDetails: (videoId) => ipcRenderer.invoke("video:details", videoId),
  getCollectionInfo: (videoId) => ipcRenderer.invoke("video:collection-info", videoId),
  getTranscript: (videoId, page, mode, track) =>
    ipcRenderer.invoke("transcript:get", { videoId, page, mode, track }),
  analyzeDigest: (videoId, page) => ipcRenderer.invoke("digest:analyze", { videoId, page }),
  seekVideo: (seconds) => ipcRenderer.invoke("video:seek", seconds),
  getCurrentTime: () => ipcRenderer.invoke("video:current-time"),
  captureFrame: () => ipcRenderer.invoke("video:capture-frame"),
  exportNotes: (video) => ipcRenderer.invoke("notes:export", video),
  openWithDefaultApp: (filePath) => ipcRenderer.invoke("library:open", { filePath }),
  summaryBatchPreview: (folderPath, deep = false) =>
    ipcRenderer.invoke("summary:batch-preview", { folderPath, deep }),
  summaryEnqueue: (collectionTitle, items, focus = "") =>
    ipcRenderer.invoke("summary:enqueue", { collectionTitle, items, focus }),
  summaryRetry: (taskId, itemIndexes) =>
    ipcRenderer.invoke("summary:retry", { taskId, itemIndexes }),
  summaryPack: (collectionTitle, videoDirs) =>
    ipcRenderer.invoke("summary:pack", { collectionTitle, videoDirs }),
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

  exportSingle: (bvid, page, format, sourceMode, track, allPages) =>
    ipcRenderer.invoke("export:single", { bvid, page, format, sourceMode, track, allPages }),
  exportCollectionPreview: (videoId) =>
    ipcRenderer.invoke("export:collection-preview", videoId),
  exportCollectionConfirm: (collectionTitle, format, items) =>
    ipcRenderer.invoke("export:collection-confirm", { collectionTitle, format, items }),
  exportTasks: () => ipcRenderer.invoke("export:tasks"),
  exportCancel: (id) => ipcRenderer.invoke("export:cancel", id),
  retryAsr: (taskId, itemIndexes) =>
    ipcRenderer.invoke("export:retry-asr", { taskId, itemIndexes }),
  libraryList: () => ipcRenderer.invoke("library:list"),
  libraryRead: (filePath) => ipcRenderer.invoke("library:read", filePath),
  libraryReveal: (filePath) => ipcRenderer.invoke("library:reveal", filePath),
  setViewVisible: (visible) => ipcRenderer.invoke("view:set-visible", visible),
  resizeSidebar: (width) => ipcRenderer.invoke("layout:resize-sidebar", width),

  onExportTaskUpdate: (callback) => subscribe("export:task-update", callback),
  onExportFinished: (callback) => subscribe("export:finished", callback),
  onNavigateTasks: (callback) => subscribe("export:navigate-tasks", callback),
  onSummaryFinished: (callback) => subscribe("summary:finished", callback),
  onAnalysisFinished: (callback) => subscribe("analysis:finished", callback),

  onLayout: (callback) => subscribe("layout:update", callback),
  onVideoChanged: (callback) => subscribe("video:changed", callback),
  onDigestProgress: (callback) => subscribe("digest:progress", callback),
  onNavState: (callback) => subscribe("nav:state", callback),
});
