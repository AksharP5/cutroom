import { expect } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

async function waitForCaptureState(
  check: () => Promise<boolean>,
  timeout = 10_000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error("The capture process did not reach the expected state.");
}

/** Linux process tests match only the profile inside their own temporary directory. */
export async function captureFixture() {
  const root = await mkdtemp(join(tmpdir(), "cap-"));
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const baseUrl = probe.url.origin;
  await probe.stop(true);
  const profiles = async () =>
    (await readdir(root)).filter((name) =>
      /^(cutroom-capture-|puppeteer_dev_chrome_profile-)/.test(name),
    );
  const processes = async () => {
    const pids: number[] = [];
    for (const pid of await readdir("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(
        () => "",
      );
      if (command.includes(`--user-data-dir=${root}/`)) pids.push(Number(pid));
    }
    return pids;
  };
  return {
    root,
    baseUrl,
    profiles,
    env: {
      ...process.env,
      TMPDIR: root,
      CUTROOM_BUN_PATH: process.execPath,
      CUTROOM_PORT: new URL(baseUrl).port,
      CUTROOM_DATA_DIR: join(root, "data"),
      CUTROOM_PROJECTS_DIR: join(root, "projects"),
      HYPERFRAMES_NO_TELEMETRY: "1",
    },
    async capture() {
      // Starting a real Bun server imports the renderer before health becomes available.
      await waitForCaptureState(
        async () =>
          fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(700) }).then(
            (response) => response.ok,
            () => false,
          ),
        30_000,
      );
      const response = await fetch(`${baseUrl}/api/cutroom/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: baseUrl },
        body: JSON.stringify({
          name: "Capture lifetime",
          width: 320,
          height: 240,
          duration: 1,
        }),
      });
      expect(response.status).toBe(201);
      const project = z.object({ id: z.string() }).parse(await response.json());
      const image = await fetch(
        `${baseUrl}/api/projects/${project.id}/thumbnail/index.html?t=0&format=png&output=source`,
      );
      expect(image.status).toBe(200);
      expect(Buffer.from(await image.arrayBuffer()).subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      expect(await profiles()).toHaveLength(1);
      expect((await processes()).length).toBeGreaterThan(0);
    },
    async expectStopped() {
      await waitForCaptureState(
        async () =>
          (await processes()).length === 0 && (await profiles()).length === 0,
      );
      expect(await processes()).toEqual([]);
      expect(await profiles()).toEqual([]);
    },
    async expectBrowserStopped() {
      await waitForCaptureState(
        async () => (await processes()).length === 0,
        3000,
      );
      expect(await processes()).toEqual([]);
    },
    async ownerPid() {
      const [profile] = await profiles();
      return z.coerce
        .number()
        .int()
        .positive()
        .parse(profile?.match(/^cutroom-capture-(\d+)-/)?.[1]);
    },
    async pauseBrowser() {
      for (const pid of await processes()) {
        const command = await readFile(`/proc/${pid}/cmdline`, "utf8");
        if (command.includes("--type=")) continue;
        process.kill(pid, "SIGSTOP");
        return;
      }
      throw new Error("No capture browser was running.");
    },
    async close() {
      for (const pid of await processes()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "ESRCH"
          ))
            throw error;
        }
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}
