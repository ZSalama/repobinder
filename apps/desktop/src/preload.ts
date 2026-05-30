import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("repobinderDesktop", {
  getDesktopContext: async (): Promise<{ platform: string; desktopAuthToken: string }> =>
    ipcRenderer.invoke("repobinder:get-desktop-context"),
  pickRepositoryFolder: async (): Promise<string | undefined> => ipcRenderer.invoke("repobinder:pick-folder"),
  copyDevServerUrl: async (url: string): Promise<boolean> => ipcRenderer.invoke("repobinder:copy-dev-server-url", url),
  setRemoteMode: async (enabled: boolean): Promise<{ host: string; port: number; remoteEnabled: boolean }> =>
    ipcRenderer.invoke("repobinder:set-remote-mode", enabled),
});
