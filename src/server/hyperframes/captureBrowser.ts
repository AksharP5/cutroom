import { join } from "node:path";
import { z } from "zod";

/** IPC ties the owner to this server; its DevTools pipe ties Chromium to the owner. */
export async function launchCaptureBrowser() {
  const ready = Promise.withResolvers<string>();
  const worker = Bun.spawn(
    [process.execPath, join(import.meta.dir, "captureBrowserWorker.ts")],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
      ipc(message: unknown) {
        const result = z
          .union([z.url({ protocol: /^ws$/ }), z.object({ error: z.string() })])
          .safeParse(message);
        if (!result.success) ready.reject(result.error);
        else if (typeof result.data === "string") ready.resolve(result.data);
        else ready.reject(new Error(result.data.error));
      },
    },
  );
  const stop = () => worker.disconnect();
  const closed = worker.exited.then((code) => {
    ready.reject(
      new Error(`The capture browser owner exited with code ${code}.`),
    );
    if (code !== 0)
      throw new Error(`The capture browser owner exited with code ${code}.`);
  });
  // Startup can fail before anyone awaits close().
  void closed.catch(() => {});
  try {
    const endpoint = await ready.promise;
    const { default: puppeteer } = await import("puppeteer-core");
    const browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
    return {
      browser,
      closed,
      async close() {
        stop();
        try {
          await closed;
        } finally {
          browser.disconnect();
        }
      },
    };
  } catch (error) {
    stop();
    await closed.catch(() => {});
    throw error;
  }
}
