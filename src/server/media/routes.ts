import { realpath, stat } from "node:fs/promises";
import { extname, relative } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { projectPath } from "../projects/path";
import type { ProjectStore } from "../projects/store";
import type { Project } from "../../shared/project";
import { HttpError } from "../../shared/errors";
import { createMediaService } from "./service";
import type { MediaService } from "./service";
import { peakRange } from "./range";
import { piecePlaylist } from "./pieces";
import { frameGrid } from "./frames";

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
/** The containers the viewer's footage pipeline demuxes, by extension. */
const SOURCE_TYPES = new Map([
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".mov", "video/quicktime"],
]);
/** The type of a video the pipeline may read, or null for hidden files and anything else. */
const sourceType = (path: string) => {
  const parts = path.split(/[\\/]/);
  if (parts.some((part) => part.startsWith(".") && part !== ".")) return null;
  return SOURCE_TYPES.get(extname(path).toLowerCase()) ?? null;
};
function headers(etag: string, type: string) {
  return {
    "content-type": type,
    "cache-control": "private, max-age=0, must-revalidate",
    etag,
  };
}
export function createMediaRoutes(
  store: ProjectStore,
  media: MediaService = createMediaService(),
) {
  const api = new Hono();
  for (const kind of [
    "probe",
    "peaks",
    "filmstrip",
    "frame",
    "scrub",
    "proxy",
  ] as const)
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
          : kind === "scrub" || kind === "proxy"
            ? "video/mp4"
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
  // Where export puts the video's frames, which the footage pipeline shows the same way.
  api.get("/projects/:id/media/frames", async (c) => {
    c.header("cache-control", "no-store");
    return c.json(
      await framesOf(await store.get(c.req.param("id")), c.req.query("path")),
    );
  });
  // The footage pipeline's reads: a project video's own bytes, in ranges. Only video containers
  // outside hidden folders, checked on the path asked for and on the file a link resolves to.
  api.get("/projects/:id/media/source", async (c) => {
    const project = await store.get(c.req.param("id"));
    const path = PathSchema.parse(c.req.query("path"));
    const type = sourceType(path);
    const file = type && (await projectPath(project, path));
    if (
      !file ||
      sourceType(relative(await realpath(project.path), file)) !== type ||
      !(await stat(file)).isFile()
    )
      throw new HttpError(404, "Choose a video in the project.");
    return new Response(Bun.file(file), {
      headers: { "content-type": type, "cache-control": "no-store" },
    });
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
  return Object.assign(api, { media, dispose: () => media.dispose() });
}

/** A project video's frame grid; files that are not media answer 422. */
export async function framesOf(project: Project, path: string | undefined) {
  const file = await projectPath(project, PathSchema.parse(path));
  return frameGrid(file).catch(() => {
    throw new HttpError(422, "The file has no readable video.");
  });
}

/**
 * Scrub proxies for the sandboxed preview, below its capability: `scrub?path=` answers the
 * proxy's key once it exists, and `scrub/<key>` serves that MP4 with byte ranges.
 */
export async function scrubPreview(
  media: MediaService,
  project: Project,
  route: string,
  path: string | null,
): Promise<Response> {
  try {
    const key = /^scrub\/([a-f0-9]{64})$/.exec(route)?.[1];
    if (key)
      return new Response(Bun.file(await media.scrub(project, key)), {
        headers: {
          "content-type": "video/mp4",
          "cache-control": "private, max-age=31536000, immutable",
        },
      });
    if (route !== "scrub") throw new HttpError(404, "Not found.");
    const result = await media.request(
      project,
      PathSchema.parse(path),
      "scrub",
    );
    const headers = { "cache-control": "no-store" };
    if (result.artifact) return Response.json({ key: result.key }, { headers });
    return Response.json(
      { key: result.key, job: result.state },
      result.state.status === "failed"
        ? { status: 422, headers }
        : { status: 202, headers: { ...headers, "retry-after": "1" } },
    );
  } catch (error) {
    if (error instanceof HttpError)
      return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof z.ZodError)
      return Response.json({ error: "Choose a media path." }, { status: 400 });
    throw error;
  }
}

/** Response headers the sandboxed preview's runtime reads from an editing proxy request. */
export const proxyExposedHeaders = "retry-after, x-hf-proxy-progress";
/** The query naming one piece of an editing proxy, or `init` for their shared header. */
export const PROXY_PIECE_PARAM = "cutroom-piece";
const PieceSchema = z.union([
  z.literal("init"),
  z.coerce.number().int().nonnegative().safe(),
]);

/**
 * The editing proxy for HyperFrames' runtime, which asks `<asset>?hf-proxy=h264` for a video its
 * browser cannot decode. While the proxy is made, once its pieces are planned, the answer is an
 * HLS playlist of them, which the preview's `<video>` plays as it would the file: each piece is
 * fetched as the playhead needs it and made first. Then the MP4, with byte ranges. 202 with
 * progress until either exists. Null for a video Cutroom makes no proxy of, which HyperFrames' own
 * transcoder keeps. `name` is the asset's file name as the request spelled it, for the playlist.
 */
export async function proxyPreview(
  media: MediaService,
  project: Project,
  path: string,
  {
    name,
    piece,
    signal,
  }: { name: string; piece: string | null; signal: AbortSignal },
): Promise<Response | null> {
  const headers = { "cache-control": "no-store" };
  if (piece !== null) {
    const parsed = PieceSchema.safeParse(piece);
    if (!parsed.success)
      return new Response("Choose a piece.", { status: 400, headers });
    const body = await media
      .proxyPiece(project, path, parsed.data, signal)
      .catch((error: unknown) => {
        if (error instanceof HttpError)
          return new Response(error.message, { status: error.status, headers });
        // The preview stopped asking, for instance after moving on to another piece.
        if (signal.aborted) return new Response(null, { status: 204, headers });
        throw error;
      });
    if (!body || body instanceof Response) return body;
    return new Response(body, {
      headers: { ...headers, "content-type": "video/mp4" },
    });
  }
  const result = await media
    .proxyPoll(project, path)
    .catch((error: unknown) => {
      if (error instanceof HttpError && error.status === 422) return null;
      throw error;
    });
  if (!result) return null;
  if (result.artifact)
    return new Response(Bun.file(result.artifact), {
      headers: { ...headers, "content-type": "video/mp4" },
    });
  if (result.state.status === "failed")
    return new Response(result.state.error, { status: 502, headers });
  if (result.pieces?.cuts.length)
    return new Response(
      piecePlaylist(
        result.pieces,
        (piece) => `${name}?hf-proxy=h264&${PROXY_PIECE_PARAM}=${piece}`,
      ),
      {
        headers: {
          ...headers,
          "content-type": "application/vnd.apple.mpegurl",
        },
      },
    );
  return new Response(null, {
    status: 202,
    headers: {
      ...headers,
      // Planning the pieces reads the file's packets, well under a second.
      "retry-after": result.pieces ? "1" : "0.25",
      "x-hf-proxy-progress": result.state.progress.toFixed(3),
    },
  });
}
