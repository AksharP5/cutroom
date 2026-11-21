import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { IpcRendererEvent } from "electron";
import type { MediaImportProgress } from "../local/mediaImport";

contextBridge.exposeInMainWorld("cutroomDesktop", {
  async importMedia(
    id: string,
    projectId: string,
    files: File[],
    progress: (event: MediaImportProgress) => void,
  ): Promise<{ files: string[] } | null> {
    const paths = files.map((file) => webUtils.getPathForFile(file));
    if (paths.some((path) => !path))
      throw new Error("Choose files from this computer.");
    const onProgress = (
      _event: IpcRendererEvent,
      requestId: string,
      update: MediaImportProgress,
    ) => {
      if (requestId === id) progress(update);
    };
    ipcRenderer.on("cutroom:import-progress", onProgress);
    try {
      return await ipcRenderer.invoke("cutroom:import-media", {
        id,
        projectId,
        paths,
      });
    } finally {
      ipcRenderer.removeListener("cutroom:import-progress", onProgress);
    }
  },
  cancelMediaImport: (id: string): Promise<void> =>
    ipcRenderer.invoke("cutroom:cancel-import", id),
  exportFile: (path: string, action: "open" | "reveal"): Promise<void> =>
    ipcRenderer.invoke("cutroom:export-file", { path, action }),
  reveal: (path: string): Promise<void> =>
    ipcRenderer.invoke("cutroom:reveal", path),
});
