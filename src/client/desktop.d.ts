interface Window {
  cutroomDesktop?: {
    exportFile(path: string, action: "open" | "reveal"): Promise<void>;
    /** Shows a file or folder in the system's file manager. */
    reveal(path: string): Promise<void>;
  };
}
