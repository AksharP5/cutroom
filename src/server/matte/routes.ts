import { Hono } from "hono";
import { z } from "zod";
import type { ProjectStore } from "../projects/store";
import { createMatteService } from "./service";
import type { MatteService } from "./service";

const RequestSchema = z.object({
  src: z.string().min(1).max(4096),
  from: z.number().finite().nonnegative(),
  to: z.number().finite().nonnegative(),
  retry: z.boolean().optional(),
});

/** Matte jobs and the model download, under `/api/cutroom`. */
export function createMatteRoutes(
  projects: ProjectStore,
  mattes: MatteService = createMatteService(),
) {
  const api = new Hono();
  api.get("/projects/:id/mattes", async (c) => {
    const project = await projects.get(c.req.param("id"));
    return c.json(await mattes.status(project.id));
  });
  api.post("/projects/:id/mattes", async (c) => {
    const project = await projects.get(c.req.param("id"));
    const request = RequestSchema.parse(await c.req.json());
    return c.json(await mattes.request(project, request));
  });
  api.delete("/projects/:id/mattes/:job", async (c) => {
    const project = await projects.get(c.req.param("id"));
    mattes.stop(project.id, c.req.param("job"));
    return c.json(await mattes.status(project.id));
  });
  // The weights are fetched only when someone presses Download.
  api.post("/mattes/model", (c) => {
    void mattes.downloadModel();
    return c.json({ ok: true }, 202);
  });
  api.delete("/mattes/model", (c) => {
    mattes.cancelDownload();
    return c.json({ ok: true });
  });
  return Object.assign(api, { mattes });
}
