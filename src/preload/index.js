import { contextBridge, ipcRenderer } from "electron";

// The renderer talks to the main process exclusively through this bridge.
contextBridge.exposeInMainWorld("desktop", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (input) => ipcRenderer.invoke("settings:set", input),
  pickSaveDir: () => ipcRenderer.invoke("settings:pick-save-dir"),
  onLayout: (callback) =>
    ipcRenderer.on("layout:update", (_event, layout) => callback(layout)),
});
