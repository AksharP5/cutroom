import type { MediaImportProgress } from "../local/mediaImport";

declare global {
  interface Window {
    cutroomDesktop?: {
      importMedia(
        id: string,
        projectId: string,
        files: File[],
        progress: (event: MediaImportProgress) => void,
      ): Promise<{ files: string[] } | null>;
      cancelMediaImport(id: string): Promise<void>;
      exportFile(path: string, action: "open" | "reveal"): Promise<void>;
      /** Shows a file or folder in the system's file manager. */
      reveal(path: string): Promise<void>;
    };
  }
}
