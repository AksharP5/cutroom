import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  agentPermissionsSchema,
  agentProviderSchema,
  agentResponseSchema,
  agentTurnSchema,
  configureAgentSessionSchema,
  createAgentSessionSchema,
} from "../../shared/agent";
import { HttpError } from "../../shared/errors";
import type { AgentService } from "./service";

export function createAgentRoutes(service: AgentService) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof HttpError)
      return c.json({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return c.json(
        { error: error.issues.map((issue) => issue.message).join(" ") },
        400,
      );
    if (error instanceof SyntaxError)
      return c.json({ error: "The request body is not valid JSON." }, 400);
    console.error("Agent request failed:", error);
    return c.json({ error: error.message }, 500);
  });

  app.get("/projects/:id/agent-permissions", async (c) =>
    c.json(await service.permissions(c.req.param("id"))),
  );
  app.patch("/projects/:id/agent-permissions", async (c) => {
    const input = agentPermissionsSchema.parse(await c.req.json());
    return c.json(
      await service.setPermissions(
        c.req.param("id"),
        input.alwaysAllowCutroomEdits,
      ),
    );
  });
  app.get("/agents/capabilities", async (c) => {
    const provider = agentProviderSchema.parse(c.req.query("provider"));
    const projectId = z.string().min(1).parse(c.req.query("projectId"));
    return c.json(
      await service.capabilities(
        provider,
        projectId,
        c.req.query("refresh") === "true",
      ),
    );
  });
  app.get("/agents/sessions", (c) =>
    c.json({ sessions: service.list(c.req.query("projectId")) }),
  );
  app.post("/agents/sessions", async (c) =>
    c.json(
      await service.create(createAgentSessionSchema.parse(await c.req.json())),
      201,
    ),
  );
  app.get("/agents/sessions/:id", (c) =>
    c.json(service.get(c.req.param("id"))),
  );
  app.patch("/agents/sessions/:id", async (c) =>
    c.json(
      await service.configure(
        c.req.param("id"),
        configureAgentSessionSchema.parse(await c.req.json()),
      ),
    ),
  );
  app.post("/agents/sessions/:id/turns", async (c) =>
    c.json(
      await service.send(
        c.req.param("id"),
        agentTurnSchema.parse(await c.req.json()),
      ),
      202,
    ),
  );
  app.post("/agents/sessions/:id/interrupt", async (c) =>
    c.json(await service.interrupt(c.req.param("id"))),
  );
  app.post("/agents/sessions/:id/responses", async (c) =>
    c.json(
      await service.respond(
        c.req.param("id"),
        agentResponseSchema.parse(await c.req.json()),
      ),
    ),
  );
  app.get("/agents/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    service.get(id);
    return streamSSE(c, async (stream) => {
      let writing = Promise.resolve();
      let stop: (() => void) | undefined;
      const ended = new Promise<void>((resolve) => {
        stop = resolve;
      });
      const unsubscribe = service.subscribe(id, (envelope) => {
        const data = JSON.stringify(envelope);
        writing = writing
          .then(() => stream.writeSSE({ id: String(envelope.seq), data }))
          .catch(() => {
            stop?.();
          });
      });
      const ping = setInterval(() => {
        writing = writing
          .then(() => stream.writeSSE({ event: "ping", data: "" }))
          .catch(() => {
            stop?.();
          });
      }, 20_000);
      stream.onAbort(() => stop?.());
      await ended;
      clearInterval(ping);
      unsubscribe();
    });
  });
  return app;
}
