import { join } from "node:path";
import { z } from "zod";
import { HttpError } from "../../shared/errors";
import type { PositionCheck } from "../../shared/timeline/positionCheck";
import { createThumbnailRenderer } from "../hyperframes/thumbnails";

const WorkerResult = z.union([
  z.object({ id: z.string(), reason: z.string().nullable() }),
  z.object({ id: z.string(), error: z.string() }),
]);

/** The compiler and capture browser stay warm; each check owns two isolated documents. */
export function createPositionSupport(renderer = createThumbnailRenderer()) {
  const scopes = new Map<
    string,
    {
      revision: string;
      projectSignature?: string;
      requests: Set<string>;
      checks: Map<string, Promise<string | null>>;
      reasons: Record<string, string>;
    }
  >();
  const pending = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<string | null>>
  >();
  let worker: ReturnType<typeof startWorker> | undefined;
  let closing = false;
  let nextId = 0;
  const cancel = (requests: Iterable<string>) => {
    for (const id of requests) {
      pending
        .get(id)
        ?.reject(
          new HttpError(
            409,
            "The timeline changed during the Position check. Read it again.",
          ),
        );
      void worker
        ?.then(({ child }) =>
          child.stdin.write(JSON.stringify({ type: "cancel", id }) + "\n"),
        )
        .catch(() => {});
    }
  };
  const scopeFor = (scope: string, revision: string) => {
    let current = scopes.get(scope);
    if (current?.revision === revision) return current;
    if (current) cancel(current.requests);
    current = { revision, requests: new Set(), checks: new Map(), reasons: {} };
    scopes.set(scope, current);
    return current;
  };
  async function startWorker() {
    const node = Bun.which("node");
    if (!node) throw new Error("Node.js is required to check Position.");
    const { browser } = await renderer.getBrowser();
    const context = await browser.createBrowserContext();
    const child = Bun.spawn(
      [
        node,
        "--experimental-strip-types",
        join(import.meta.dir, "../hyperframes/positionCheckWorker.ts"),
        browser.wsEndpoint(),
        context.id!,
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
        env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1" },
      },
    );
    const finished = (async () => {
      const decoder = new TextDecoder();
      let remaining = "";
      for await (const bytes of child.stdout) {
        const lines = (
          remaining + decoder.decode(bytes, { stream: true })
        ).split("\n");
        remaining = lines.pop()!;
        for (const line of lines) {
          if (!line.startsWith("CUTROOM_POSITION:")) continue;
          const result = WorkerResult.parse(
            JSON.parse(line.slice("CUTROOM_POSITION:".length)),
          );
          const request = pending.get(result.id);
          if ("error" in result) request?.reject(new Error(result.error));
          else request?.resolve(result.reason);
        }
      }
      const code = await child.exited;
      if (code !== 0 && !closing)
        throw new Error(`The Position worker exited with code ${code}.`);
    })().finally(async () => {
      await context.close().catch(() => {});
      worker = undefined;
      for (const request of pending.values())
        request.reject(new Error("The Position worker stopped."));
    });
    void finished.catch((error: unknown) => console.error(error));
    return { child, finished };
  }
  return {
    reasons(scope: string, revision: string) {
      return scopeFor(scope, revision).reasons;
    },
    forget(scope: string) {
      const current = scopes.get(scope);
      if (current) cancel(current.requests);
      scopes.delete(scope);
    },
    invalidate(projectId: string) {
      for (const [key, current] of scopes)
        if (key.startsWith(projectId + "\0")) {
          cancel(current.requests);
          scopes.delete(key);
        }
    },
    check(
      scope: string,
      revision: string,
      input: PositionCheck,
      projectSignature?: string,
    ) {
      if (closing)
        return Promise.reject(
          new HttpError(503, "Position checks are closing."),
        );
      let current = scopeFor(scope, revision);
      if (current.projectSignature !== projectSignature) {
        cancel(current.requests);
        current = {
          revision,
          projectSignature,
          requests: new Set(),
          checks: new Map(),
          reasons: {},
        };
        scopes.set(scope, current);
      }
      const cached = current.checks.get(input.clipId);
      if (cached) return cached;
      const task = (async () => {
        const { child } = await (worker ??= startWorker().catch(
          (error: unknown) => {
            worker = undefined;
            throw error;
          },
        ));
        if (scopes.get(scope) !== current)
          throw new HttpError(
            409,
            "The timeline changed during the Position check. Read it again.",
          );
        const id = String(++nextId);
        const result = Promise.withResolvers<string | null>();
        pending.set(id, result);
        current.requests.add(id);
        let terminate: ReturnType<typeof setTimeout> | undefined;
        const timeout = setTimeout(() => {
          child.kill("SIGTERM");
          terminate = setTimeout(() => child.kill("SIGKILL"), 6000);
        }, 30_000);
        try {
          child.stdin.write(
            JSON.stringify({ type: "check", id, input }) + "\n",
          );
          const reason = await result.promise;
          if (scopes.get(scope) !== current)
            throw new HttpError(
              409,
              "The timeline changed during the Position check. Read it again.",
            );
          if (reason) current.reasons[input.clipId] = reason;
          return reason;
        } finally {
          clearTimeout(timeout);
          clearTimeout(terminate);
          pending.delete(id);
          current.requests.delete(id);
        }
      })().catch((error: unknown) => {
        current.checks.delete(input.clipId);
        if (closing || scopes.get(scope) !== current)
          throw new HttpError(
            409,
            "The timeline changed during the Position check. Read it again.",
          );
        throw error;
      });
      current.checks.set(input.clipId, task);
      return task;
    },
    async close() {
      closing = true;
      for (const current of scopes.values()) cancel(current.requests);
      scopes.clear();
      if (worker) {
        const { child, finished } = await worker;
        child.kill("SIGTERM");
        child.stdin.end();
        const timeout = setTimeout(() => child.kill("SIGKILL"), 6000);
        try {
          await finished;
        } finally {
          clearTimeout(timeout);
        }
      }
      await renderer.close();
    },
  };
}
export type PositionSupport = ReturnType<typeof createPositionSupport>;
