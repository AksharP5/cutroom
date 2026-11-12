import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

const port = Number(process.env.CUTROOM_E2E_PORT ?? 4321);
const testRoot = process.env.CUTROOM_E2E_DIR ?? resolve(".cutroom-dev/e2e");
const executablePath =
  process.env.CUTROOM_BROWSER_PATH ||
  (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  ...(process.env.CUTROOM_E2E_DIR
    ? { outputDir: resolve(testRoot, "results") }
    : {}),
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1720, height: 1050 },
    actionTimeout: 12_000,
    launchOptions: { executablePath, args: ["--mute-audio", "--no-sandbox"] },
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
    },
  },
});
