import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";
import config from "./playwright.config";

const root = process.env.CUTROOM_E2E_DIR ?? "/home/akshar/.cache/rfe-e2e";
const port = 4920;

export default defineConfig({
  ...config,
  testIgnore: process.env.RFE_VISUAL_DIR ? [] : ["**/rfe-*.local.spec.ts"],
  outputDir: resolve(root, "results"),
  use: { ...config.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    ...config.webServer,
    command: "bun src/server/index.ts",
    url: `http://127.0.0.1:${port}/health`,
    env: {
      CUTROOM_PORT: String(port),
      CUTROOM_DATA_DIR: resolve(root, "data"),
      CUTROOM_PROJECTS_DIR: resolve(root, "projects"),
      HYPERFRAMES_NO_TELEMETRY: "1",
    },
  },
});
