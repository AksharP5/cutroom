import { Worker } from "node:worker_threads";
import type { lintHyperframeHtml, lintProject } from "@hyperframes/core/lint";
import type { LintTask } from "./lintWorker";

type Settle = { resolve(value: unknown): void; reject(error: Error): void };

/**
 * HyperFrames lint on its own thread. At 1,000 clips it parses for about 400 ms, and the editor
 * asks for it after every save, an agent's included, just when the owner may press Undo.
 */
export function createLinter() {
  let worker: Worker | undefined;
  const pending = new Map<number, Settle>();
  let next = 0;
  const fail = (error: Error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
    worker = undefined;
  };
  const start = () => {
    const started = new Worker(new URL("./lintWorker.ts", import.meta.url));
    started.unref();
    started.on(
      "message",
      ({
        id,
        result,
        error,
      }: {
        id: number;
        result?: unknown;
        error?: string;
      }) => {
        const request = pending.get(id);
        pending.delete(id);
        if (error === undefined) request?.resolve(result);
        else request?.reject(new Error(error));
      },
    );
    started.on("error", (error) => {
      if (worker === started) fail(error);
    });
    started.on("exit", () => {
      if (worker === started) fail(new Error("Lint stopped unexpectedly."));
    });
    return started;
  };
  const run = (request: LintTask) =>
    new Promise<unknown>((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      (worker ??= start()).postMessage({ ...request, id });
    });
  return {
    // The worker runs these same functions; structured cloning keeps their results' shape.
    project: (...args: Parameters<typeof lintProject>) =>
      run({ task: "project", args }) as ReturnType<typeof lintProject>,
    html: (...args: Parameters<typeof lintHyperframeHtml>) =>
      run({ task: "html", args }) as ReturnType<typeof lintHyperframeHtml>,
    async close() {
      const stopping = worker;
      worker = undefined;
      fail(new Error("The editor is shutting down."));
      await stopping?.terminate();
    },
  };
}
