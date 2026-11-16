import { fileURLToPath } from "node:url";
import { MediaEventSchema } from "./protocol";
import type { MediaTask } from "./protocol";
import type { z } from "zod";

export function startMediaWorker(
  task: MediaTask,
  workerUrl: URL,
  stopTimeoutMs: number,
  /** Progress, and each piece of an editing proxy as it is made. */
  onEvent: (
    event: Exclude<
      z.infer<typeof MediaEventSchema>,
      { type: "done" | "error" }
    >,
  ) => void = () => {},
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
  // One JSON event per line: progress while it works, then done or error.
  const output = (async () => {
    let raw = "";
    let outcome: z.infer<typeof MediaEventSchema> | undefined;
    let line = "";
    const read = (text: string) => {
      if (!text.trim()) return;
      const event = MediaEventSchema.parse(JSON.parse(text));
      if (event.type === "progress" || event.type === "piece") onEvent(event);
      else outcome = event;
    };
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      raw = (raw + text).slice(-8000);
      const lines = (line + text).split("\n");
      line = lines.pop()!;
      for (const complete of lines) read(complete);
    }
    read(line);
    return { raw, outcome };
  })();
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
        const [{ raw, outcome }, error] = await Promise.all([output, errors]);
        if (code !== 0)
          throw new Error(
            error.trim() ||
              raw.trim() ||
              `Media worker exited with code ${code}.`,
          );
        if (!outcome) throw new Error("The media worker reported no outcome.");
        if (outcome.type === "error") throw new Error(outcome.error);
      } finally {
        signal("SIGKILL");
        clearTimeout(stopTimeout);
        await exited;
      }
    })(),
  };
}
