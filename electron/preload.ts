import { contextBridge, shell } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  openExternal: (url: string) => shell.openExternal(url),
  isElectron: true,
});
