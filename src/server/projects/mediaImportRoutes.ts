import { Hono } from "hono";
import { stream } from "hono/streaming";
import { z } from "zod";
import { ImportSourcesSchema } from "../../local/mediaImport";
import type { MediaImportEvent } from "../../local/mediaImport";
import { HttpError } from "../../shared/errors";
import { AGENT_HEADER } from "../../shared/review";
import { projectMutationGuard } from "./authorization";
import { importMedia } from "./mediaImport";
import type { ReviewService } from "./review";
import { historyWho, parseInput } from "./routes";
import type { ProjectStore } from "./store";

/** Only mounted on the owner-only socket. The browser API accepts uploads instead. */
export function createMediaImportRoutes(
  store: ProjectStore,
  reviews: ReviewService,
) {
  const api = new Hono();
  const lifetime = new AbortController();
  const active = new Map<
    string,
    {
      projectId: string;
      cancel: AbortController;
      done: Promise<void>;
    }
  >();
  api.onError((error, c) =>
    c.json(
      { type: "error", error: error.message },
      error instanceof HttpError
        ? error.status
        : error instanceof SyntaxError
          ? 400
          : 500,
    ),
  );
  api.use("/projects/:id/*", projectMutationGuard(reviews));
  api.post("/projects/:id/media/import/:job", async (c) => {
    if (lifetime.signal.aborted)
      throw new HttpError(503, "Cutroom is closing.");
    const project = await store.get(c.req.param("id"));
    const input = parseInput(ImportSourcesSchema, await c.req.json());
    const id = parseInput(z.uuid(), c.req.param("job"));
    if (lifetime.signal.aborted)
      throw new HttpError(503, "Cutroom is closing.");
    if (active.has(id))
      throw new HttpError(409, "This import is already running.");
    const who = historyWho(reviews, c, project);
    const agentToken = c.req.header(AGENT_HEADER);
    const cancel = new AbortController();
    const completion = Promise.withResolvers<void>();
    c.header("Content-Type", "application/x-ndjson");
    c.header("Cache-Control", "no-store");
    active.set(id, { projectId: project.id, cancel, done: completion.promise });
    return stream(c, async (output) => {
      const disconnected = new AbortController();
      output.onAbort(() => disconnected.abort());
      const signal = AbortSignal.any([
        lifetime.signal,
        c.req.raw.signal,
        disconnected.signal,
        cancel.signal,
      ]);
      const send = (event: MediaImportEvent) =>
        output.writeln(JSON.stringify(event));
      try {
        const result = await importMedia(store, reviews, project, input, {
          signal,
          progress: send,
          agentToken,
          who,
        });
        await send({ type: "result", ...result });
      } catch (error) {
        if (disconnected.signal.aborted) return;
        if (cancel.signal.aborted) await send({ type: "cancelled" });
        else
          await send({
            type: "error",
            error: error instanceof Error ? error.message : String(error),
          });
      } finally {
        active.delete(id);
        completion.resolve();
      }
    });
  });
  api.post("/projects/:id/media/import/:job/cancel", (c) => {
    const operation = active.get(c.req.param("job"));
    if (operation?.projectId === c.req.param("id")) operation.cancel.abort();
    return c.body(null, 204);
  });
  return {
    fetch: api.fetch,
    async dispose() {
      lifetime.abort();
      await Promise.all([...active.values()].map(({ done }) => done));
    },
  };
}
