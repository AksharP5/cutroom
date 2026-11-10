import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectLocalServer } from "../src/desktop/runtime";
import { browserExecutable } from "../src/server/hyperframes/render";
import { captureFixture } from "./capture-fixture";

async function waitForPid(path: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await readFile(path, "utf8").catch(() => "");
    if (value) return Number(value);
    await Bun.sleep(20);
  }
  throw new Error("The test backend did not start.");
}

async function startupFixture() {
  const root = await mkdtemp(join(tmpdir(), "cutroom-desktop-start-"));
  await mkdir(join(root, "src/server"), { recursive: true });
  const pidFile = join(root, "backend.pid");
  await writeFile(
    join(root, "src/server/index.ts"),
    `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.sleep(60000);`,
  );
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const baseUrl = probe.url.origin;
  await probe.stop(true);
  return { root, pidFile, baseUrl };
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("cancelling desktop startup stops its owned backend before returning", async () => {
  const fixture = await startupFixture();
  const controller = new AbortController();
  const connection = connectLocalServer({
    root: fixture.root,
    baseUrl: fixture.baseUrl,
    signal: controller.signal,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      CUTROOM_BUN_PATH: process.execPath,
    },
  });
  try {
    const pid = await waitForPid(fixture.pidFile);
    controller.abort();
    await expect(connection).rejects.toMatchObject({ name: "AbortError" });
    expect(processExists(pid)).toBe(false);
  } finally {
    controller.abort();
    await connection.catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test.skipIf(process.env.CUTROOM_TEST_DESKTOP !== "1")(
  "quitting the native app during startup leaves no backend process",
  async () => {
    const fixture = await startupFixture();
    const { _electron } = await import("@playwright/test");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const application = await _electron.launch({
      executablePath: join(
        import.meta.dir,
        "../node_modules/electron/dist/electron",
      ),
      args: [join(import.meta.dir, "../dist-desktop/main.cjs")],
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: "",
        CUTROOM_ROOT: fixture.root,
        CUTROOM_BUN_PATH: process.execPath,
        CUTROOM_PORT: new URL(fixture.baseUrl).port,
        CUTROOM_DATA_DIR: join(fixture.root, "data"),
      },
    });
    try {
      const pid = await waitForPid(fixture.pidFile);
      const closed = application.waitForEvent("close");
      await application.evaluate(({ app }) => app.quit());
      await closed;
      expect(processExists(pid)).toBe(false);
    } finally {
      await application.close().catch(() => {});
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
  30_000,
);

for (const quit of ["normal", "SIGKILL"] as const) {
  test.skipIf(
    process.env.CUTROOM_TEST_DESKTOP !== "1" ||
      process.platform !== "linux" ||
      !browserExecutable(),
  )(
    `${quit} quit of the native app after a capture leaves no backend, Chromium, or profile`,
    async () => {
      const fixture = await captureFixture();
      const { _electron } = await import("@playwright/test");
      const application = await _electron.launch({
        executablePath: join(
          import.meta.dir,
          "../node_modules/electron/dist/electron",
        ),
        args: [join(import.meta.dir, "../dist-desktop/main.cjs")],
        env: {
          ...Object.fromEntries(
            Object.entries(fixture.env).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          ),
          ELECTRON_RUN_AS_NODE: "",
          CUTROOM_ROOT: join(import.meta.dir, ".."),
          CUTROOM_MUTE_AUDIO: "1",
        },
      });
      const child = application.process();
      let backend: number | undefined;
      try {
        await fixture.capture();
        const children = await readFile(
          `/proc/${child.pid}/task/${child.pid}/children`,
          "utf8",
        );
        for (const pid of children.trim().split(/\s+/)) {
          const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(
            () => "",
          );
          if (command.includes("src/server/index.ts")) backend = Number(pid);
        }
        if (!backend)
          throw new Error("The desktop did not own a backend process.");
        const closed = application.waitForEvent("close");
        if (quit === "normal")
          await application.evaluate(({ app }) => app.quit());
        else child.kill("SIGKILL");
        await closed;
        await fixture.expectStopped();
        expect(processExists(backend)).toBe(false);
      } finally {
        await application.close().catch(() => {});
        if (backend && processExists(backend)) process.kill(backend, "SIGKILL");
        await fixture.close();
      }
    },
    30_000,
  );
}
