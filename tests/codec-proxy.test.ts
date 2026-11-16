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
 * Video whose frames carry their own number in sixteen blocks along the top, white for 1, with a
 * tone: by default two seconds of 1280x720. ProRes in MOV is a codec no browser decodes; H.264 in
 * MP4 is one every browser does. A Matroska file keeps millisecond times, and `start` moves its
 * clock, as a recording cut from a longer one starts later.
 */
async function numbered(
  path: string,
  codec: "prores" | "h264",
  { seconds = 2, size = "1280x720", start = 0 } = {},
) {
  const encoder =
    codec === "prores"
      ? ["-c:v", "prores_ks", "-profile:v", "1"]
      : ["-c:v", "libx264", "-preset", "ultrafast"];
  const sound =
    path.endsWith(".mkv") || codec === "h264"
      ? ["-c:a", "aac"]
      : ["-c:a", "pcm_s16le"];
  const [width] = size.split("x");
  const child = Bun.spawn(
    [
      ...["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i"],
      `testsrc2=size=${size}:rate=30000/1001:duration=${seconds}`,
      ...["-f", "lavfi", "-i"],
      `nullsrc=size=16x1:rate=30000/1001:duration=${seconds}`,
      ...["-f", "lavfi", "-i", `sine=duration=${seconds}`],
      "-filter_complex",
      `[1:v]format=gray,geq=lum='255*mod(floor(N/pow(2\\,X))\\,2)',scale=${width}:36:flags=neighbor[bar];[0:v][bar]overlay=0:0,format=yuv422p10le`,
      ...["-map", "2:a", ...encoder, ...sound, "-shortest"],
      ...(start ? ["-output_ts_offset", String(start)] : []),
      path,
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
      "crop=iw:ih/80:0:ih/80,scale=16:1:flags=area,format=gray",
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
    numbers: Array.from({ length: bytes.length / 16 }, (_, frame) =>
      Array.from(bytes.subarray(frame * 16, frame * 16 + 16)).reduce(
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

test.skipIf(!tools)(
  "a long recording plays piece by piece while its proxy is made, each piece the source's own frames at their times, asked-for pieces first, and still after the proxy is finished",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cutroom-proxy-pieces-"));
    const projects = await createProjectStore({
      dataDir: root,
      projectsDir: join(root, "projects"),
    });
    const review = createReviewService(projects);
    const media = createMediaService({ nvenc: async () => false });
    const app = new Hono();
    app.route(
      "/api/cutroom",
      createProjectRoutes(projects, review, undefined, media.proxyState),
    );
    app.route("/api", createHyperframesApi(projects, review, media));
    app.route("/api/cutroom", createMediaRoutes(projects, media));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: app.fetch,
    });
    try {
      const project = await projects.create({ name: "Long recording" });
      // NTSC on Matroska's millisecond clock, starting 1.5 s in: no cut falls on a round time.
      const source = join(project.path, "recording.mkv");
      await numbered(source, "prores", {
        seconds: 13,
        size: "640x360",
        start: 1.5,
      });
      await writeFile(
        join(project.path, "index.html"),
        `<!doctype html><html><body><main data-composition-id="main" data-width="640" data-height="360" data-duration="13"><video id="recording" src="recording.mkv" muted data-start="0" data-duration="13" data-track-index="0"></video></main></body></html>`,
      );
      const redirect = await fetch(
        `${server.url.origin}/api/projects/${project.id}/isolated-preview`,
        { redirect: "manual" },
      );
      const capability = /^(\/api\/isolated\/[^/]+\/)preview/.exec(
        new URL(redirect.headers.get("location")!).pathname,
      )![1];
      const asset = `${server.url.origin}${capability}preview/recording.mkv`;

      // The playhead's piece, asked for before any other is made, so it is made first: from a
      // seek into the source, without its neighbours' frames.
      const asked = await ready(async () => {
        const response = await fetch(`${asset}?hf-proxy=h264&cutroom-piece=2`);
        // 409 until the pieces are planned.
        return response.status === 409
          ? new Response(null, { status: 202 })
          : response;
      });
      expect(asked.status).toBe(200);
      const playhead = new Uint8Array(await asked.arrayBuffer());

      // The runtime's request gets a playlist of every piece as soon as they are planned.
      const playlist = await ready(() =>
        fetch(`${asset}?hf-proxy=h264`, { headers: { range: "bytes=0-0" } }),
      );
      expect(playlist.headers.get("content-type")).toBe(
        "application/vnd.apple.mpegurl",
      );
      const lines = (await playlist.text()).split("\n");
      const lengths = lines
        .filter((line) => line.startsWith("#EXTINF:"))
        .map((line) => Number(line.slice(8, -1)));
      const uris = lines.filter((line) => line && !line.startsWith("#"));
      expect(lengths).toHaveLength(4);
      expect(uris).toEqual(
        lengths.map(
          (_, piece) => `recording.mkv?hf-proxy=h264&cutroom-piece=${piece}`,
        ),
      );
      expect(lines).toContain(
        '#EXT-X-MAP:URI="recording.mkv?hf-proxy=h264&cutroom-piece=init"',
      );
      const cuts = lengths.map((_, piece) =>
        lengths.slice(0, piece).reduce((sum, length) => sum + length, 0),
      );

      // Export reads the recording from its first timestamp, as FFmpeg reports it; so do the
      // pieces and the proxy. That is 1.5 s, or 23 ms earlier where FFmpeg 7 counts the AAC
      // encoder's lead-in.
      const start = Number(
        Bun.spawnSync([
          ...["ffprobe", "-v", "error", "-show_entries", "format=start_time"],
          ...["-of", "csv=p=0", source],
        ]).stdout.toString(),
      );
      expect(start).toBeWithin(1.45, 1.51);
      const original = await frames(source);
      const expected = {
        numbers: original.numbers,
        times: original.times.map((time) => Number((time - start).toFixed(6))),
      };
      const get = async (name: number | "init") => {
        const response = await fetch(
          `${asset}?hf-proxy=h264&cutroom-piece=${name}`,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBe(
          "null",
        );
        return new Uint8Array(await response.arrayBuffer());
      };
      const piece = async (index: number, body?: Uint8Array) => {
        body ??= await get(index);
        const init = await get("init");
        const file = join(root, `piece-${index}.mp4`);
        await writeFile(file, Buffer.concat([init, body]));
        const shown = await frames(file);
        const inside = expected.times.flatMap((time, at) =>
          time >= cuts[index]! && time < (cuts[index + 1] ?? Infinity)
            ? [at]
            : [],
        );
        expect(inside.length).toBeGreaterThan(0);
        expect(shown).toEqual({
          numbers: inside.map((at) => expected.numbers[at]),
          times: inside.map((at) => expected.times[at]),
        });
      };
      await piece(2, playhead);
      await piece(0);

      const finished = await ready(() =>
        fetch(
          `${server.url.origin}/api/cutroom/projects/${project.id}/media/proxy?path=recording.mkv`,
        ),
      );
      expect(finished.status).toBe(200);
      const proxy = join(root, "proxy.mp4");
      await writeFile(proxy, Buffer.from(await finished.arrayBuffer()));
      expect(await frames(proxy)).toEqual(expected);

      // A preview that started on the pieces still gets them from the finished file.
      await piece(3);
      await piece(1);
    } finally {
      await server.stop(true);
      await media.dispose();
      await projects.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

test.skipIf(!tools)(
  "a clip the preview asks for gets its proxy while a long recording nobody watches is still being made",
  async () => {
    const fixture = await projectFixture();
    const media = createMediaService({ nvenc: async () => false });
    try {
      const project = await fixture.store.create({ name: "Two recordings" });
      // MPEG-4 Part 2 is a codec no browser decodes, and quick to make.
      const make = (name: string, size: string, seconds: number) => {
        const made = Bun.spawnSync([
          ...["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i"],
          `testsrc2=size=${size}:rate=30:duration=${seconds}`,
          ...["-c:v", "mpeg4", "-q:v", "5", join(project.path, name)],
        ]);
        if (made.exitCode !== 0) throw new Error(made.stderr.toString());
      };
      make("long.mkv", "1920x1080", 60);
      make("short.mkv", "640x360", 2);
      // The long recording's proxy starts first, as listing the media does, and nobody waits.
      const long = () => media.request(project, "long.mkv", "proxy");
      const deadline = performance.now() + 30_000;
      for (;;) {
        // Planned, and its pieces being made.
        const started = await long();
        if (started.pieces && started.state.status === "running") break;
        if (performance.now() > deadline) throw new Error("It never started.");
        await Bun.sleep(20);
      }
      for (;;) {
        const short = await media.proxyPoll(project, "short.mkv");
        if (short.artifact) break;
        expect(short.state.status).not.toBe("failed");
        if (performance.now() > deadline)
          throw new Error("The clip the preview asked for was not made.");
        await Bun.sleep(100);
      }
      expect((await long()).state.status).toBe("running");
    } finally {
      await media.dispose();
      await fixture.close();
    }
  },
  60_000,
);
