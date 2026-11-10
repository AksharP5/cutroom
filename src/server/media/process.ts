import { fileURLToPath } from "node:url";
import { MediaEventSchema } from "./protocol";
import type { MediaTask } from "./protocol";

export function startMediaWorker(
  task: MediaTask,
  workerUrl: URL,
  stopTimeoutMs: number,
) {
  const child = Bun.spawn([process.execPath, fileURLToPath(workerUrl)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });
  let stopTimeout: ReturnType<typeof setTimeout> | undefined;
  const signal = (signal: NodeJS.Signals) => {
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ))
        throw error;
    }
  };
  // The group remains addressable after the worker dies, including an FFmpeg child it orphaned.
  const exited = child.exited.finally(() => signal("SIGKILL"));
  const output = new Response(child.stdout).text();
  const errors = (async () => {
    let tail = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr)
      tail = (tail + decoder.decode(chunk, { stream: true })).slice(-8000);
    return tail;
  })();
  child.stdin.write(JSON.stringify(task));
  child.stdin.end();
  return {
    cancel() {
      signal("SIGTERM");
      stopTimeout ??= setTimeout(() => signal("SIGKILL"), stopTimeoutMs);
    },
    done: (async () => {
      try {
        const code = await exited;
        const [raw, error] = await Promise.all([output, errors]);
        if (code !== 0)
          throw new Error(
            error.trim() ||
              raw.trim() ||
              `Media worker exited with code ${code}.`,
          );
        const event = MediaEventSchema.parse(JSON.parse(raw));
        if (event.type === "error") throw new Error(event.error);
      } finally {
        signal("SIGKILL");
        clearTimeout(stopTimeout);
        await exited;
      }
    })(),
  };
}
