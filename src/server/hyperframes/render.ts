import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  STUDIO_MANUAL_EDITS_PATH,
  STUDIO_MOTION_PATH,
  createStudioManualEditsRenderBodyScript,
  createStudioMotionRenderBodyScript,
} from "@hyperframes/studio-server";

async function readManifest(projectDir: string, path: string) {
  return readFile(join(projectDir, path), "utf8").catch((error: unknown) => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return "";
    throw error;
  });
}

export async function studioRenderScripts(
  projectDir: string,
  composition?: string,
) {
  const [manual, motion] = await Promise.all([
    readManifest(projectDir, STUDIO_MANUAL_EDITS_PATH),
    readManifest(projectDir, STUDIO_MOTION_PATH),
  ]);
  const options = { activeCompositionPath: composition ?? null };
  return [
    createStudioManualEditsRenderBodyScript(manual, options),
    createStudioMotionRenderBodyScript(motion, options),
  ].filter((script): script is string => script !== null);
}

export function browserExecutable() {
  const configured =
    process.env.PRODUCER_HEADLESS_SHELL_PATH ||
    process.env.HYPERFRAMES_BROWSER_PATH;
  if (configured) return configured;

  const commands = ["chromium", "google-chrome-stable", "google-chrome"];
  if (process.platform !== "linux")
    return commands.map((name) => Bun.which(name)).find(Boolean) ?? undefined;

  // Linux launchers can prepend desktop options and personal extension flags.
  // Accept native binaries on PATH as well as the common distro locations.
  const candidates = [
    "/usr/lib/chromium/chromium",
    "/usr/lib64/chromium/chromium",
    "/usr/lib/chromium-browser/chromium-browser",
    "/opt/google/chrome/chrome",
    ...commands,
  ];
  const browserNames = new Set([...commands, "chrome", "chromium-browser"]);
  const magic = Buffer.alloc(4);
  for (const candidate of candidates) {
    const path = Bun.which(candidate);
    if (!path) continue;
    try {
      const binary = realpathSync(path);
      if (!browserNames.has(basename(binary))) continue;
      const fd = openSync(binary, "r");
      try {
        if (
          readSync(fd, magic, 0, magic.length, 0) === magic.length &&
          magic.toString("ascii") === "\x7fELF"
        )
          return binary;
      } finally {
        closeSync(fd);
      }
    } catch {
      // Continue looking if an executable disappeared or cannot be read.
    }
  }
}
