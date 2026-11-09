import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
  return (
    process.env.PRODUCER_HEADLESS_SHELL_PATH ||
    process.env.HYPERFRAMES_BROWSER_PATH ||
    Bun.which("chromium") ||
    Bun.which("google-chrome-stable") ||
    Bun.which("google-chrome") ||
    undefined
  );
}
