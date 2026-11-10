import { expect, test } from "bun:test";
import { join } from "node:path";
import { browserExecutable } from "../src/server/hyperframes/render";
import { captureFixture } from "./capture-fixture";

const supported = process.platform === "linux" && Boolean(browserExecutable());
const root = join(import.meta.dir, "..");

for (const { signal, paused } of [
  { signal: "SIGTERM", paused: false },
  { signal: "SIGINT", paused: false },
  { signal: "SIGKILL", paused: false },
  { signal: "SIGTERM", paused: true },
] as const) {
  test.skipIf(!supported)(
    `${signal} of a server after a real capture leaves no ${paused ? "unresponsive " : ""}Chromium or profile`,
    async () => {
      const fixture = await captureFixture();
      const server = Bun.spawn([process.execPath, "src/server/index.ts"], {
        cwd: root,
        env: fixture.env,
        timeout: 20_000,
        killSignal: "SIGKILL",
        stdout: "ignore",
        stderr: "inherit",
      });
      try {
        await fixture.capture();
        if (paused) await fixture.pauseBrowser();
        server.kill(signal);
        await server.exited;
        await fixture.expectStopped();
      } finally {
        server.kill("SIGKILL");
        await server.exited;
        await fixture.close();
      }
    },
    30_000,
  );
}

for (const exit of ["process.exit(0)", 'process.emit("beforeExit", 0)']) {
  test.skipIf(!supported)(
    `${exit} closes the capture browser and removes its profile`,
    async () => {
      const fixture = await captureFixture();
      const server = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { launchCaptureBrowser } from './src/server/hyperframes/captureBrowser';
         const {browser} = await launchCaptureBrowser();
         const page = await browser.newPage();
         await page.goto('data:text/html,<h1>Capture</h1>');
         await page.screenshot();
         ${exit};`,
        ],
        {
          cwd: root,
          env: fixture.env,
          timeout: 20_000,
          killSignal: "SIGKILL",
          stdout: "ignore",
          stderr: "inherit",
        },
      );
      try {
        expect(await server.exited).toBe(0);
        await fixture.expectStopped();
      } finally {
        server.kill("SIGKILL");
        await server.exited;
        await fixture.close();
      }
    },
    30_000,
  );
}

test.skipIf(!supported)(
  "a failed browser launch reports the cause and removes its profile",
  async () => {
    const fixture = await captureFixture();
    const executable = join(fixture.root, "missing-chromium");
    const server = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { launchCaptureBrowser } from './src/server/hyperframes/captureBrowser';
     await launchCaptureBrowser();`,
      ],
      {
        cwd: root,
        env: {
          ...fixture.env,
          PRODUCER_HEADLESS_SHELL_PATH: executable,
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const diagnostics = new Response(server.stderr).text();
    try {
      expect(await server.exited).not.toBe(0);
      expect(await diagnostics).toContain(executable);
      await fixture.expectStopped();
    } finally {
      server.kill("SIGKILL");
      await server.exited;
      await fixture.close();
    }
  },
);
