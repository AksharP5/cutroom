import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import type { Browser } from "puppeteer-core";
import { z } from "zod";
import { createCaptureProfile } from "./captureProfiles";
import { browserExecutable } from "./render";

async function webSocketEndpoint(profile: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const content = await readFile(
      join(profile, "DevToolsActivePort"),
      "utf8",
    ).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return "";
      throw error;
    });
    const result = z
      .tuple([
        z.coerce.number().int().min(1).max(65535),
        z.string().regex(/^\/devtools\/browser\/[\w-]+$/),
      ])
      .safeParse(content.trim().split("\n"));
    if (result.success) {
      const [port, path] = result.data;
      return `ws://127.0.0.1:${port}${path}`;
    }
    await Bun.sleep(25);
  }
  throw new Error("Chromium did not publish its capture WebSocket endpoint.");
}

const stopped = Promise.withResolvers<void>();
for (const event of [
  "disconnect",
  "SIGTERM",
  "SIGINT",
  "SIGHUP",
  "beforeExit",
] as const)
  process.once(event, () => stopped.resolve());

let browser: Browser | undefined;
let profile: string | undefined;
try {
  const executablePath = browserExecutable();
  if (!executablePath)
    throw new Error(
      "Chromium is required for frame captures. Install Chromium or set HYPERFRAMES_BROWSER_PATH.",
    );
  profile = await createCaptureProfile();
  browser = await puppeteer.launch({
    headless: true,
    pipe: true,
    executablePath,
    userDataDir: profile,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: [
      // The pipe ties Chromium to this owner; the server connects over loopback WS.
      "--remote-debugging-pipe",
      "--remote-debugging-port=0",
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
  if (process.connected) process.send?.(await webSocketEndpoint(profile));
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
  // A stopped Chromium cannot process pipe closure or Browser.close.
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
