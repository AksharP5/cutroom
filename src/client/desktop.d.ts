interface Window {
  cutroomDesktop?: {
    exportFile(path: string, action: "open" | "reveal"): Promise<void>;
  };
}
