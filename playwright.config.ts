import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "@playwright/test";

const port = 4321;
const testRoot = process.env.CUTROOM_E2E_DIR ?? resolve(".cutroom-dev/e2e");
const executablePath =
  process.env.CUTROOM_BROWSER_PATH ||
  (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

export default defineConfig({
  testDir: "e2e",
  // Let shards split large specs at test boundaries without adding runner contention.
  fullyParallel: true,
  workers: 1,
  // CI retries a failed test once and reports a pass on retry as flaky; local runs never retry.
  retries: process.env.CI ? 1 : 0,
  ...(process.env.CUTROOM_E2E_DIR
    ? { outputDir: resolve(testRoot, "results") }
    : {}),
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1720, height: 1050 },
    actionTimeout: 12_000,
    launchOptions: {
      executablePath,
      args: [
        "--mute-audio",
        "--no-sandbox",
        // Headless Chromium on the machine's GPU instead of SwiftShader. A headed window on a
        // shared desktop also receives the desktop's real pointer, which breaks hover tests.
        ...(process.env.CUTROOM_E2E_GPU === "1"
          ? ["--use-angle=gl", "--ignore-gpu-blocklist"]
          : []),
      ],
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun src/server/index.ts",
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
    env: {
      CUTROOM_PORT: String(port),
      CUTROOM_DATA_DIR: resolve(testRoot, "data"),
      CUTROOM_PROJECTS_DIR: resolve(testRoot, "projects"),
      HYPERFRAMES_NO_TELEMETRY: "1",
      // Background removal runs on a stub model: no weights are needed or downloaded.
      CUTROOM_MATTE_SEGMENTER: pathToFileURL(
        resolve("tests/fixtures/stub-segmenter.ts"),
      ).href,
      STUB_SEGMENTER_DELAY_MS: "30",
    },
  },
});
