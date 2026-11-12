import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("cutroomDesktop", {
  exportFile: (path: string, action: "open" | "reveal"): Promise<void> =>
    ipcRenderer.invoke("cutroom:export-file", { path, action }),
  reveal: (path: string): Promise<void> =>
    ipcRenderer.invoke("cutroom:reveal", path),
});
