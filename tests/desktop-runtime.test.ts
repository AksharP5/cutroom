import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  connectLocalServer,
  isApplicationUrl,
  localServerUrl,
} from "../src/desktop/runtime";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

test("desktop reuses only a Cutroom server and leaves its lifetime with its owner", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ app: "cutroom", ok: true }),
  });
  servers.push(server);
  const baseUrl = server.url.origin;
  const connection = await connectLocalServer({ root: "/unused", baseUrl });
  expect(connection.owned).toBe(false);
  await connection.stop();
  expect((await fetch(`${baseUrl}/health`)).ok).toBe(true);

  const unrelated = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ app: "another-app", ok: true }),
  });
  servers.push(unrelated);
  await expect(
    connectLocalServer({ root: "/unused", baseUrl: unrelated.url.origin }),
  ).rejects.toThrow("Another application");
});

test("desktop validates the local origin and reports a missing Bun runtime without hanging", async () => {
  expect(localServerUrl("4317")).toBe("http://127.0.0.1:4317");
  expect(() => localServerUrl("4317/path")).toThrow("valid TCP port");
  expect(
    isApplicationUrl("http://127.0.0.1:4317/#project/test", localServerUrl()),
  ).toBe(true);
  expect(isApplicationUrl("https://example.com", localServerUrl())).toBe(false);
  expect(isApplicationUrl("file:///etc/passwd", localServerUrl())).toBe(false);
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const baseUrl = probe.url.origin;
  await probe.stop(true);
  await expect(
    connectLocalServer({
      root: process.cwd(),
      baseUrl,
      env: { ...process.env, CUTROOM_BUN_PATH: "/cutroom-test-no-such-bun" },
    }),
  ).rejects.toThrow("could not start Bun");
});

test.skipIf(process.env.CUTROOM_TEST_DESKTOP !== "1")(
  "native Electron window opens the real workspace with renderer isolation, muted media, and owned-server cleanup",
  async () => {
    const root = resolve(import.meta.dir, "..");
    const data = await mkdtemp(join(tmpdir(), "cutroom-desktop-"));
    const probe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const port = probe.port;
    await probe.stop(true);
    const { _electron } = await import("@playwright/test");
    const packaged = process.env.CUTROOM_TEST_PACKAGE;
    const launchEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    Object.assign(launchEnv, {
      ELECTRON_RUN_AS_NODE: "",
      CUTROOM_MUTE_AUDIO: "1",
      CUTROOM_PORT: String(port),
      CUTROOM_DATA_DIR: join(data, "data"),
      CUTROOM_PROJECTS_DIR: join(data, "projects"),
    });
    delete launchEnv.CUTROOM_ROOT;
    delete launchEnv.CUTROOM_BUN_PATH;
    if (!packaged) {
      launchEnv.CUTROOM_ROOT = root;
      launchEnv.CUTROOM_BUN_PATH = process.execPath;
    }
    const application = await _electron.launch({
      executablePath: packaged
        ? join(packaged, "cutroom")
        : join(root, "node_modules/electron/dist/electron"),
      args: [
        "--ozone-platform=headless",
        "--use-fake-device-for-media-stream",
        ...(process.env.CUTROOM_TEST_NO_SANDBOX === "1"
          ? ["--no-sandbox"]
          : []),
        ...(packaged ? [] : [join(root, "dist-desktop/main.cjs")]),
      ],
      env: launchEnv,
      timeout: 30_000,
    });
    try {
      const page = await application.firstWindow();
      await page
        .getByRole("button", { name: "New project", exact: true })
        .waitFor();
      expect(await page.title()).toBe("Cutroom");
      expect(
        await page.evaluate(() => typeof window.cutroomDesktop?.exportFile),
      ).toBe("function");
      expect(
        await application.evaluate(
          ({ Menu }) => Menu.getApplicationMenu() === null,
        ),
      ).toBe(true);
      expect(
        await page.getByRole("heading", { name: "Make the next cut." }).count(),
      ).toBe(1);
      const state = z
        .object({
          preferences: z.object({
            nodeIntegration: z.boolean(),
            contextIsolation: z.boolean(),
            sandbox: z.boolean(),
          }),
          muted: z.boolean(),
        })
        .parse(
          await application.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0];
            if (!window) throw new Error("The desktop window is missing.");
            const readPreferences: unknown = Reflect.get(
              window.webContents,
              "getLastWebPreferences",
            );
            if (typeof readPreferences !== "function")
              throw new Error(
                "Electron's preferences inspector is unavailable.",
              );
            const preferences: unknown = readPreferences.call(
              window.webContents,
            );
            return { preferences, muted: window.webContents.isAudioMuted() };
          }),
        );
      expect(state).toEqual({
        preferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
        muted: true,
      });
      expect(
        await page.evaluate(() => typeof Reflect.get(globalThis, "require")),
      ).toBe("undefined");
      expect(
        await page.evaluate(
          'navigator.permissions.query({name:"clipboard-write"}).then(permission => permission.state)',
        ),
      ).toBe("granted");
      expect(
        await page.evaluate(
          'navigator.permissions.query({name:"camera"}).then(permission => permission.state)',
        ),
      ).toBe("denied");
      expect(
        await page.evaluate(async () => {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
          const live = stream
            .getAudioTracks()
            .some((track) => track.readyState === "live");
          stream.getTracks().forEach((track) => track.stop());
          return live;
        }),
      ).toBe(true);
      expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
      const origin = `http://127.0.0.1:${port}`;
      const isolatedProject = z
        .object({ id: z.string(), path: z.string() })
        .parse(
          await (
            await fetch(`${origin}/api/cutroom/projects`, {
              method: "POST",
              headers: { origin, "content-type": "application/json" },
              body: JSON.stringify({
                name: "Desktop isolation",
                width: 320,
                height: 240,
                duration: 1,
              }),
            })
          ).json(),
        );
      const sourcePath = join(isolatedProject.path, "index.html");
      const source = await readFile(sourcePath, "utf8");
      await writeFile(
        sourcePath,
        source.replace(
          "</body>",
          `<script>
        fetch("/api/cutroom/projects/${isolatedProject.id}/annotations", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"comment",body:"desktop attack",time:0})})
          .then(()=>document.querySelector("main").dataset.attack="allowed")
          .catch(()=>document.querySelector("main").dataset.attack="blocked");
      </script></body>`,
        ),
      );
      await page.evaluate(() =>
        localStorage.setItem("cutroom.newEditor", "true"),
      );
      await page.goto(`${origin}/#project/${isolatedProject.id}`);
      await page.reload();
      const preview = page.frameLocator("iframe[data-live]");
      await preview.locator('main[data-attack="blocked"]').waitFor();
      expect(
        await page.locator("iframe[data-live]").getAttribute("sandbox"),
      ).toBe("allow-scripts");
      expect(
        await page.evaluate(
          'document.querySelector("iframe[data-live]").contentDocument',
        ),
      ).toBeNull();
      await page.getByRole("region", { name: "Viewer" }).click();
      await page.keyboard.press("ArrowRight");
      expect(
        (
          await page
            .getByRole("button", { name: /^Current time/ })
            .textContent()
        )?.replace(/\s/g, ""),
      ).toBe("00:00:00:01");
      const document = z
        .object({ annotations: z.array(z.unknown()) })
        .parse(
          await (
            await fetch(
              `${origin}/api/cutroom/projects/${isolatedProject.id}/document`,
            )
          ).json(),
        );
      expect(document.annotations).toEqual([]);
      const voiceoverProject = z.object({ id: z.string() }).parse(
        await (
          await fetch(`${origin}/api/cutroom/projects`, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: JSON.stringify({
              name: "Keep the native take",
              duration: 30,
            }),
          })
        ).json(),
      );
      await page.goto(`${origin}/#project/${voiceoverProject.id}`);
      await page.getByRole("button", { name: "Arm A1", exact: true }).click();
      await page.getByRole("button", { name: "Record voiceover" }).click();
      await page.getByRole("button", { name: "Stop voiceover" }).waitFor();
      const notice = await application.evaluate(
        ({ app, dialog }) =>
          new Promise<string>((resolve) => {
            const original = dialog.showMessageBox;
            Object.defineProperty(dialog, "showMessageBox", {
              value: (_window: unknown, options: { message: string }) => {
                Object.defineProperty(dialog, "showMessageBox", {
                  value: original,
                });
                resolve(options.message);
                return Promise.resolve({ response: 0, checkboxChecked: false });
              },
            });
            app.quit();
          }),
      );
      expect(notice).toBe(
        "Save or discard the voiceover take before closing Cutroom.",
      );
      expect((await fetch(`${origin}/health`)).ok).toBe(true);
      expect(
        await page.getByRole("button", { name: "Stop voiceover" }).count(),
      ).toBe(1);
      await page.keyboard.press("Space");
      await page
        .getByRole("button", { name: "Record voiceover" })
        .waitFor({ state: "visible" });
      // A visible but disabled record control still means the delayed tail or upload is saving.
      await page.waitForFunction(
        () =>
          !window.document.querySelector<HTMLButtonElement>(
            '[aria-label="Record voiceover"]',
          )?.disabled,
      );
      if (packaged) {
        const status = z
          .object({ mcpCommand: z.string() })
          .parse(
            await (
              await fetch(`http://127.0.0.1:${port}/api/cutroom/status`)
            ).json(),
          );
        expect(status.mcpCommand).toContain(
          join(packaged, "resources/app/src/server/mcp/stdio.ts"),
        );
        const project = z.object({ id: z.string() }).parse(
          await (
            await fetch(`http://127.0.0.1:${port}/api/cutroom/projects`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                origin: `http://127.0.0.1:${port}`,
              },
              body: JSON.stringify({
                name: "Portable render",
                width: 320,
                height: 240,
                duration: 1,
              }),
            })
          ).json(),
        );
        const rendered = await fetch(
          `http://127.0.0.1:${port}/api/projects/${project.id}/render`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: `http://127.0.0.1:${port}`,
            },
            body: JSON.stringify({
              fps: 2,
              quality: "draft",
              format: "mp4",
              telemetryOptOut: true,
            }),
          },
        );
        expect(rendered.status).toBe(200);
        const job = z
          .object({ jobId: z.string() })
          .parse(await rendered.json());
        const progress = await (
          await fetch(
            `http://127.0.0.1:${port}/api/render/${job.jobId}/progress`,
          )
        ).text();
        expect(progress).toContain('"status":"complete"');
        const video = await fetch(
          `http://127.0.0.1:${port}/api/render/${job.jobId}/download`,
        );
        expect(video.status).toBe(200);
        expect((await video.arrayBuffer()).byteLength).toBeGreaterThan(1000);
      }
    } finally {
      await application.close();
      await rm(data, { recursive: true, force: true });
    }
    expect(
      await fetch(`http://127.0.0.1:${port}/health`).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  },
  90_000,
);
