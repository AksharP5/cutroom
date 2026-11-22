import { Hono } from "hono";
import { z } from "zod";
import type { ProjectStore } from "../projects/store";
import { canonicalProjectPath } from "../projects/path";
import type { createTimelineRoutes } from "../timeline/routes";
import { matteNeeds } from "../../shared/matte";
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
  timelineSnapshot: ReturnType<typeof createTimelineRoutes>["timelineSnapshot"],
  mattes: MatteService = createMatteService(),
) {
  const api = new Hono();
  api.get("/projects/:id/mattes", async (c) => {
    const project = await projects.get(c.req.param("id"));
    return c.json(await mattes.status(project));
  });
  /**
   * Queues what the composition's Remove clips lack: after an edit, a trim past the handles, a
   * new version, or before an export. Already-made frames cost nothing.
   */
  api.post("/projects/:id/mattes/sync", async (c) => {
    const project = await projects.get(c.req.param("id"));
    return c.json(
      await syncMattes(project, c.req.query("composition") ?? "index.html"),
    );
  });
  const syncMattes = async (
    project: Awaited<ReturnType<ProjectStore["get"]>>,
    path: string,
  ) => {
    const composition = canonicalProjectPath(path);
    const view = await timelineSnapshot(project, composition);
    if (!view.timeline) return mattes.status(project);
    const needs = matteNeeds(view.timeline, composition);
    await mattes.release(project, composition, needs);
    for (const { clip: _clip, ...need } of needs)
      // A source that is offline or unreadable shows its original picture.
      await mattes.request(project, { ...need, composition }).catch(() => {});
    return mattes.status(project);
  };
  api.post("/projects/:id/mattes", async (c) => {
    const project = await projects.get(c.req.param("id"));
    const request = RequestSchema.parse(await c.req.json());
    return c.json(await mattes.request(project, request));
  });
  api.delete("/projects/:id/mattes/:job", async (c) => {
    const project = await projects.get(c.req.param("id"));
    mattes.stop(project.id, c.req.param("job"));
    return c.json(await mattes.status(project));
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
  return Object.assign(api, { mattes, syncMattes });
}
