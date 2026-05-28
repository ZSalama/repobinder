import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("repobinderDesktop", {
  getDesktopContext: async (): Promise<{ platform: string; desktopAuthToken: string }> =>
    ipcRenderer.invoke("repobinder:get-desktop-context"),
  pickRepositoryFolder: async (): Promise<string | undefined> => ipcRenderer.invoke("repobinder:pick-folder"),
});
