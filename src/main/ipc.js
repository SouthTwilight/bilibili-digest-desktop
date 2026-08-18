import { ipcMain, dialog } from "electron";

export function registerIpcHandlers({ settingsStore }) {
  ipcMain.handle("settings:get", () => settingsStore.load());

  ipcMain.handle("settings:set", (_event, input) => settingsStore.save(input || {}));

  ipcMain.handle("settings:pick-save-dir", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "选择导出文件默认保存位置",
    });
    return result.canceled ? null : result.filePaths[0];
  });
}
