import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { allowsLocalRequest } from "../src/server/localAccess";
import { createMediaRoutes } from "../src/server/media/routes";
import { createMediaService } from "../src/server/media/service";
import { createReviewService } from "../src/server/projects/review";
import { createProjectRoutes } from "../src/server/projects/routes";
import { createProjectStore } from "../src/server/projects/store";
import { MediaListSchema } from "../src/shared/project";
import { projectFixture } from "./project-fixture";

const tools = !!Bun.which("ffmpeg") && !!Bun.which("ffprobe");

/**
 * Two seconds of 1280x720 video whose frames carry their own number in eight blocks along the
 * top, white for 1, with a tone. ProRes in MOV is a codec no browser decodes; H.264 in MP4 is one
 * every browser does.
 */
async function numbered(path: string, codec: "prores" | "h264") {
  const encoder =
    codec === "prores"
      ? ["-c:v", "prores_ks", "-profile:v", "1", "-c:a", "pcm_s16le"]
      : ["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac"];
  const child = Bun.spawn(
    [
      ...["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i"],
      "testsrc2=size=1280x720:rate=30000/1001:duration=2",
      ...["-f", "lavfi", "-i", "nullsrc=size=8x1:rate=30000/1001:duration=2"],
      ...["-f", "lavfi", "-i", "sine=duration=2"],
      "-filter_complex",
      "[1:v]format=gray,geq=lum='255*mod(floor(N/pow(2\\,X))\\,2)',scale=1280:36:flags=neighbor[bar];[0:v][bar]overlay=0:0,format=yuv422p10le",
      ...["-map", "2:a", ...encoder, "-shortest", path],
    ],
    { stderr: "pipe" },
  );
  const errors = await new Response(child.stderr).text();
  if ((await child.exited) !== 0) throw new Error(errors);
}

/** Every frame's number, read back from its blocks, and its presentation time. */
async function frames(path: string) {
  const decode = Bun.spawn(
    [
      ...["ffmpeg", "-v", "error", "-i", path, "-map", "0:v:0"],
      ...["-fps_mode", "passthrough", "-vf"],
      "crop=iw:ih/80:0:ih/80,scale=8:1:flags=area,format=gray",
      ...["-f", "rawvideo", "-"],
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const bytes = new Uint8Array(await new Response(decode.stdout).arrayBuffer());
  const times = Bun.spawnSync([
    ...["ffprobe", "-v", "error", "-select_streams", "v:0"],
    ...["-show_entries", "frame=pts_time", "-of", "csv=p=0", path],
  ]);
  return {
    numbers: Array.from({ length: bytes.length / 8 }, (_, frame) =>
      Array.from(bytes.subarray(frame * 8, frame * 8 + 8)).reduce(
        (value, level, bit) => value | (level > 128 ? 1 << bit : 0),
        0,
      ),
    ),
    times: times.stdout
      .toString()
      .trim()
      .split("\n")
      .map((line) => Number(line.split(",")[0])),
  };
}

async function ready(request: () => Promise<Response> | Response) {
  const deadline = performance.now() + 30_000;
  for (;;) {
    const response = await request();
    if (response.status !== 202) return response;
    if (performance.now() > deadline)
      throw new Error("The editing proxy was not made in time.");
    await Bun.sleep(50);
  }
}

test.skipIf(!tools)(
  "a video the browser cannot decode gets an H.264 editing proxy with every frame at its source time, tagged as Chrome draws the source; one it decodes gets none",
  async () => {
    const fixture = await projectFixture();
    // CI has no GPU; the same recipe encodes with libx264.
    const routes = createMediaRoutes(
      fixture.store,
      createMediaService({ nvenc: async () => false }),
    );
    fixture.app.route("/api/cutroom", routes);
    try {
      const project = await fixture.store.create({ name: "Editing proxies" });
      const source = join(project.path, "camera.mov");
      await numbered(source, "prores");
      await numbered(join(project.path, "screen.mp4"), "h264");
      const proxyOf = (path: string) => () =>
        fixture.request(`/projects/${project.id}/media/proxy?path=${path}`);

      const response = await ready(proxyOf("camera.mov"));
      expect(response.headers.get("content-type")).toBe("video/mp4");
      const proxy = join(fixture.directory, "proxy.mp4");
      await writeFile(proxy, Buffer.from(await response.arrayBuffer()));
      const streams = z
        .object({
          streams: z.array(
            z.object({
              codec_name: z.string(),
              width: z.number().optional(),
              height: z.number().optional(),
              color_space: z.string().optional(),
              color_primaries: z.string().optional(),
              color_transfer: z.string().optional(),
            }),
          ),
        })
        .parse(
          JSON.parse(
            Bun.spawnSync([
              ...["ffprobe", "-v", "error", "-show_entries"],
              "stream=codec_name,width,height,color_space,color_primaries,color_transfer",
              ...["-of", "json", proxy],
            ]).stdout.toString(),
          ),
        ).streams;
      // Chrome guesses BT.709 for an untagged 720-line source and draws the proxy's tags.
      expect(streams).toEqual([
        {
          codec_name: "h264",
          width: 1280,
          height: 720,
          color_space: "bt709",
          color_primaries: "bt709",
          color_transfer: "bt709",
        },
        { codec_name: "aac" },
      ]);
      // The preview's frame N must be the source's frame N, which export reads, at its time.
      const original = await frames(source);
      expect(original.numbers).toHaveLength(59);
      expect(original.numbers).toEqual(original.numbers.map((_, at) => at));
      expect(await frames(proxy)).toEqual(original);

      // HyperFrames plays H.264 itself, so nothing is made for it.
      expect((await ready(proxyOf("screen.mp4"))).status).toBe(422);
    } finally {
      await routes.dispose();
      await fixture.close();
    }
  },
  60_000,
);

test.skipIf(!tools)(
  "the sandboxed preview gets the editing proxy HyperFrames' runtime asks for, through its preflight, with progress, and agents read its state",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cutroom-proxy-preview-"));
    const projects = await createProjectStore({
      dataDir: root,
      projectsDir: join(root, "projects"),
    });
    const review = createReviewService(projects);
    const media = createMediaService({ nvenc: async () => false });
    const app = new Hono();
    let baseUrl = "";
    app.use("*", async (c, next) => {
      if (!allowsLocalRequest(c.req.raw, baseUrl)) return c.body(null, 403);
      await next();
    });
    app.route(
      "/api/cutroom",
      createProjectRoutes(projects, review, undefined, media.proxyState),
    );
    app.route("/api", createHyperframesApi(projects, review, media));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: app.fetch,
    });
    baseUrl = server.url.origin;
    try {
      const project = await projects.create({ name: "Proxy preview" });
      await numbered(join(project.path, "camera.mov"), "prores");
      await writeFile(
        join(project.path, "index.html"),
        `<!doctype html><html><body><main data-composition-id="main" data-width="1280" data-height="720" data-duration="2"><video id="camera" src="camera.mov" muted data-start="0" data-duration="2" data-track-index="0"></video></main></body></html>`,
      );
      const redirect = await fetch(
        `${baseUrl}/api/projects/${project.id}/isolated-preview`,
        { redirect: "manual" },
      );
      const capability = /^(\/api\/isolated\/[^/]+\/)preview/.exec(
        new URL(redirect.headers.get("location")!).pathname,
      )![1];
      const asset = `${baseUrl}${capability}preview/camera.mov?hf-proxy=h264`;

      // The runtime marks its request with a priority header, so the opaque preview preflights.
      const preflight = await fetch(asset, {
        method: "OPTIONS",
        headers: {
          origin: "null",
          "access-control-request-method": "GET",
          "access-control-request-headers": "range,x-hf-proxy-priority",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("null");
      expect(
        preflight.headers.get("access-control-allow-headers")?.split(", "),
      ).toEqual(["range", "x-hf-proxy-priority"]);

      const ask = () =>
        fetch(asset, {
          headers: {
            origin: "null",
            range: "bytes=0-0",
            "x-hf-proxy-priority": "1",
          },
        });
      const first = await ask();
      expect(first.status).toBe(202);
      expect(Number(first.headers.get("x-hf-proxy-progress"))).toBeWithin(0, 1);
      // A cross-origin reader sees only the headers the response exposes.
      expect(
        first.headers.get("access-control-expose-headers")?.split(", "),
      ).toEqual(["retry-after", "x-hf-proxy-progress"]);

      const listed = MediaListSchema.parse(
        await (
          await fetch(`${baseUrl}/api/cutroom/projects/${project.id}/media`)
        ).json(),
      ).media;
      expect(
        listed.map(({ mediaPath, proxy }) => [mediaPath, proxy?.status]),
      ).toEqual([
        ["camera.mov", expect.stringMatching(/^(queued|running|done)$/)],
      ]);

      const served = await ready(ask);
      expect(served.status).toBe(206);
      expect(served.headers.get("content-type")).toBe("video/mp4");
      expect(served.headers.get("access-control-allow-origin")).toBe("null");
      expect(
        MediaListSchema.parse(
          await (
            await fetch(`${baseUrl}/api/cutroom/projects/${project.id}/media`)
          ).json(),
        ).media[0]!.proxy,
      ).toEqual({ status: "done", progress: 1 });

      // Mutations stay closed to the opaque preview.
      expect(
        (await fetch(asset, { method: "POST", headers: { origin: "null" } }))
          .status,
      ).toBe(403);
    } finally {
      await server.stop(true);
      await media.dispose();
      await projects.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
