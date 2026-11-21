import { access } from "node:fs/promises";

// Playwright installs the matching headless shell next to CI's full Chrome.
const chrome = process.env.HYPERFRAMES_BROWSER_PATH ?? "";
const shell = chrome.replace(
  /\/chromium-(\d+)\/chrome-linux64\/chrome$/,
  "/chromium_headless_shell-$1/chrome-headless-shell-linux64/chrome-headless-shell",
);
if (shell === chrome) throw new Error(`Unexpected CI Chrome path: ${chrome}`);
await access(shell);
process.env.HYPERFRAMES_BROWSER_PATH = shell;
process.env.PRODUCER_HEADLESS_SHELL_PATH = shell;
process.env.PRODUCER_FORCE_SCREENSHOT = "false";

await import("../../src/server/hyperframes/renderWorker.ts");
