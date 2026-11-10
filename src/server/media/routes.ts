import { Hono } from "hono";
import { z } from "zod";
import type { ProjectStore } from "../projects/store";
import { createMediaService } from "./service";

const PathSchema = z.string().min(1).max(4096);
const KeySchema = z.string().regex(/^[a-f0-9]{64}$/);

function fileResponse(
  path: string,
  etag: string,
  type: string,
  ifNoneMatch?: string,
) {
  const headers = {
    "content-type": type,
    "cache-control": "private, max-age=0, must-revalidate",
    etag,
  };
  if (ifNoneMatch === etag) return new Response(null, { status: 304, headers });
  return new Response(Bun.file(path), { headers });
}

export function createMediaRoutes(store: ProjectStore) {
  const api = new Hono();
  const media = createMediaService();
  for (const kind of ["peaks", "filmstrip"] as const) {
    api.get(`/projects/:id/media/${kind}`, async (c) => {
      c.header("cache-control", "no-store");
      const project = await store.get(c.req.param("id"));
      const path = PathSchema.parse(c.req.query("path"));
      const result = await media.request(project, path, kind);
      if (!result.artifact) {
        if (result.state.status === "failed")
          return c.json({ key: result.key, job: result.state }, 422);
        c.header("retry-after", "1");
        return c.json({ key: result.key, job: result.state }, 202);
      }
      const etag = `"${result.key}"`;
      if (kind === "peaks")
        return fileResponse(
          result.artifact,
          etag,
          "application/octet-stream",
          c.req.header("if-none-match"),
        );
      c.header("cache-control", "private, max-age=0, must-revalidate");
      c.header("etag", etag);
      if (c.req.header("if-none-match") === etag) return c.body(null, 304);
      return c.json({
        ...result.metadata,
        key: result.key,
        spriteUrl: `/api/cutroom/projects/${encodeURIComponent(project.id)}/media/filmstrip/${result.key}/sprite`,
      });
    });
  }
  api.get("/projects/:id/media/filmstrip/:key/sprite", async (c) => {
    const project = await store.get(c.req.param("id"));
    const key = KeySchema.parse(c.req.param("key"));
    const response = fileResponse(
      await media.sprite(project, key),
      `"${key}"`,
      "image/jpeg",
      c.req.header("if-none-match"),
    );
    response.headers.set(
      "cache-control",
      "private, max-age=31536000, immutable",
    );
    return response;
  });
  return Object.assign(api, { dispose: () => media.dispose() });
}
