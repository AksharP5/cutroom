import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import type { Browser } from "puppeteer-core";
import { browserExecutable } from "./render";

const stopped = Promise.withResolvers<void>();
for (const event of ["disconnect", "SIGTERM", "SIGINT", "beforeExit"] as const)
  process.once(event, () => stopped.resolve());

let browser: Browser | undefined;
let profile: string | undefined;
try {
  const executablePath = browserExecutable();
  if (!executablePath)
    throw new Error(
      "Chromium is required for frame captures. Install Chromium or set HYPERFRAMES_BROWSER_PATH.",
    );
  profile = await mkdtemp(join(tmpdir(), "cutroom-capture-"));
  browser = await puppeteer.launch({
    headless: true,
    executablePath,
    userDataDir: profile,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--mute-audio",
      "--autoplay-policy=no-user-gesture-required",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  browser.once("disconnected", () => stopped.resolve());
  if (process.connected) process.send?.(browser.wsEndpoint());
  else stopped.resolve();
  await stopped.promise;
} catch (error) {
  console.error("The capture browser failed:", error);
  if (process.connected)
    process.send?.({
      error: error instanceof Error ? error.message : String(error),
    });
  process.exitCode = 1;
} finally {
  const child = browser?.process();
  const timeout = setTimeout(() => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
      return;
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ))
        throw error;
    }
  }, 5000);
  try {
    await browser?.close();
  } finally {
    clearTimeout(timeout);
    if (profile) await rm(profile, { recursive: true, force: true });
    if (process.connected) process.disconnect();
  }
}
