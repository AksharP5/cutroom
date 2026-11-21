import { expect, test } from "bun:test";
import { join } from "node:path";
import { launchCaptureBrowser } from "../src/server/hyperframes/captureBrowser";
import { captureBrowserArgs } from "../src/server/hyperframes/captureBrowserArgs";
import { browserExecutable } from "../src/server/hyperframes/render";
import { captureFixture } from "./capture-fixture";

const supported = process.platform === "linux" && Boolean(browserExecutable());
const root = join(import.meta.dir, "..");

test.skipIf(process.platform !== "linux")(
  "capture adds the screenshot feature to one Chromium feature list",
  () => {
    expect(
      captureBrowserArgs([
        "--enable-features=CanvasDrawElement,Vulkan",
        "--disable-extensions",
        "--enable-features=CDPScreenshotNewSurface",
      ]),
    ).toEqual([
      "--disable-extensions",
      "--enable-features=CanvasDrawElement,Vulkan,CDPScreenshotNewSurface",
    ]);
  },
);

test.skipIf(!supported)(
  "the shared still browser enables fresh screenshots and HTML-in-Canvas",
  async () => {
    const capture = await launchCaptureBrowser();
    try {
      const session = await capture.browser.target().createCDPSession();
      const { arguments: args } = await session.send(
        "Browser.getBrowserCommandLine",
      );
      const flags = args.filter((arg) => arg.startsWith("--enable-features="));
      expect(flags).toHaveLength(1);
      expect(flags[0]?.split("=")[1]?.split(",")).toContain(
        "CDPScreenshotNewSurface",
      );
      const page = await capture.browser.newPage();
      expect(
        await page.evaluate(
          () =>
            typeof Object.getOwnPropertyDescriptor(
              CanvasRenderingContext2D.prototype,
              "drawElementImage",
            )?.value,
        ),
      ).toBe("function");
    } finally {
      await capture.close();
    }
  },
  20_000,
);

for (const target of ["server process group", "owner"] as const) {
  test.skipIf(!supported)(
    `SIGKILL of the ${target} stops Chromium and the next capture reclaims its profile`,
    async () => {
      const fixture = await captureFixture();
      const start = () =>
        Bun.spawn([process.execPath, "src/server/index.ts"], {
          cwd: root,
          env: fixture.env,
          detached: true,
          stdout: "ignore",
          stderr: "inherit",
        });
      let server = start();
      try {
        await fixture.capture();
        const profiles = await fixture.profiles();
        if (target === "owner")
          process.kill(await fixture.ownerPid(), "SIGKILL");
        else {
          process.kill(-server.pid, "SIGKILL");
          await server.exited;
        }
        await fixture.expectBrowserStopped();
        expect(await fixture.profiles()).toEqual(profiles);
        if (target === "server process group") server = start();
        await fixture.capture();
        expect(await fixture.profiles()).not.toEqual(profiles);
        server.kill("SIGTERM");
        await server.exited;
        await fixture.expectStopped();
      } finally {
        server.kill("SIGKILL");
        await server.exited;
        await fixture.close();
      }
    },
    // Launches Chromium twice and recovers its owner and profile between captures.
    50_000,
  );
}

test.skipIf(!supported)(
  "starting another capture owner preserves a live owner's profile and browser",
  async () => {
    const fixture = await captureFixture();
    const server = Bun.spawn([process.execPath, "src/server/index.ts"], {
      cwd: root,
      env: fixture.env,
      stdout: "ignore",
      stderr: "inherit",
    });
    try {
      await fixture.capture();
      const profiles = await fixture.profiles();
      const other = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { launchCaptureBrowser } from './src/server/hyperframes/captureBrowser';
           const capture = await launchCaptureBrowser();
           await capture.close();`,
        ],
        {
          cwd: root,
          env: fixture.env,
          stdout: "ignore",
          stderr: "inherit",
          timeout: 20_000,
        },
      );
      expect(await other.exited).toBe(0);
      expect(await fixture.profiles()).toEqual(profiles);
      await fixture.capture();
      server.kill("SIGTERM");
      await server.exited;
      await fixture.expectStopped();
    } finally {
      server.kill("SIGKILL");
      await server.exited;
      await fixture.close();
    }
  },
  // Starts two real capture owners while preserving a live Chromium instance.
  30_000,
);

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
    // Starts real Chromium; an unresponsive browser needs the forced-cleanup grace period.
    30_000,
  );
}

test.skipIf(!supported)(
  "process.exit closes the capture browser and removes its profile",
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
         process.exit(0);`,
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
  // Launches Chromium, takes a screenshot, and checks real process-exit cleanup.
  30_000,
);

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
