import { Hono } from "hono";
import { z } from "zod";
import type { ProjectStore } from "../projects/store";
import { createMediaService } from "./service";
import { peakRange } from "./range";

const PathSchema = z.string().min(1).max(4096);
const KeySchema = z.string().regex(/^[a-f0-9]{64}$/);
const TimeSchema = z.coerce.number().finite().nonnegative();
const RangeSchema = z
  .object({
    level: z.coerce.number().int().nonnegative().default(0),
    start: TimeSchema.default(0),
    end: TimeSchema.default(Number.MAX_VALUE),
  })
  .refine(
    (range) => range.end >= range.start,
    "Range end must follow its start.",
  );
function headers(etag: string, type: string) {
  return {
    "content-type": type,
    "cache-control": "private, max-age=0, must-revalidate",
    etag,
  };
}
export function createMediaRoutes(store: ProjectStore) {
  const api = new Hono();
  const media = createMediaService();
  for (const kind of ["peaks", "filmstrip", "frame"] as const)
    api.get(`/projects/:id/media/${kind}`, async (c) => {
      c.header("cache-control", "no-store");
      const project = await store.get(c.req.param("id"));
      const path = PathSchema.parse(c.req.query("path"));
      const query = c.req.query();
      const range =
        kind === "peaks" &&
        ["level", "start", "end"].some((field) => query[field] !== undefined)
          ? RangeSchema.parse(query)
          : undefined;
      const time =
        kind === "frame" ? TimeSchema.parse(c.req.query("time")) : undefined;
      const result = await media.request(project, path, kind, time);
      if (!result.artifact) {
        if (result.state.status === "failed")
          return c.json({ key: result.key, job: result.state }, 422);
        c.header("retry-after", "1");
        return c.json({ key: result.key, job: result.state }, 202);
      }
      if (range) {
        const slice = await peakRange(
          result.artifact,
          range.level,
          range.start,
          range.end,
        );
        const etag = `"${result.key}-${slice.variant}"`;
        const h = headers(etag, "application/octet-stream");
        if (c.req.header("if-none-match") === etag) {
          await slice.body.cancel();
          return new Response(null, { status: 304, headers: h });
        }
        return new Response(slice.body, {
          headers: { ...h, "content-length": String(slice.length) },
        });
      }
      const etag = `"${result.key}"`;
      const h = headers(
        etag,
        kind === "frame"
          ? "image/jpeg"
          : kind === "peaks"
            ? "application/octet-stream"
            : "application/json",
      );
      if (c.req.header("if-none-match") === etag)
        return new Response(null, { status: 304, headers: h });
      if (kind !== "filmstrip")
        return new Response(Bun.file(result.artifact), { headers: h });
      return new Response(
        JSON.stringify({
          ...result.metadata,
          key: result.key,
          sheets: result.metadata!.sheets.map((sheet) => ({
            ...sheet,
            spriteUrl: `/api/cutroom/projects/${encodeURIComponent(project.id)}/media/filmstrip/${result.key}/sprite?sheet=${sheet.index}`,
          })),
        }),
        { headers: h },
      );
    });
  api.get("/projects/:id/media/filmstrip/:key/sprite", async (c) => {
    const project = await store.get(c.req.param("id"));
    const key = KeySchema.parse(c.req.param("key"));
    const sheet = z.coerce
      .number()
      .int()
      .nonnegative()
      .safe()
      .default(0)
      .parse(c.req.query("sheet"));
    const h = {
      ...headers(`"${key}-${sheet}"`, "image/jpeg"),
      "cache-control": "private, max-age=31536000, immutable",
    };
    const file = await media.sprite(project, key, sheet);
    return new Response(
      c.req.header("if-none-match") === h.etag ? null : Bun.file(file),
      {
        status: c.req.header("if-none-match") === h.etag ? 304 : 200,
        headers: h,
      },
    );
  });
  return Object.assign(api, { dispose: () => media.dispose() });
}
