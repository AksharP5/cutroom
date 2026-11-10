import { expect, test } from "bun:test";
import {
  readFile,
  readdir,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createMediaRoutes } from "../src/server/media/routes";
import { createMediaService } from "../src/server/media/service";
import { encodePeaks } from "../src/server/media/peaks";
import { FilmstripSchema } from "../src/server/media/protocol";
import { JobStateSchema } from "../src/shared/jobs";
import { projectFixture } from "./project-fixture";

async function ffmpeg(args: string[]) {
  const child = Bun.spawn(["ffmpeg", "-v", "error", "-nostdin", ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const errors = await new Response(child.stderr).text();
  if ((await child.exited) !== 0) throw new Error(errors);
}

async function ready(request: () => Promise<Response> | Response) {
  const deadline = performance.now() + 10000;
  while (true) {
    const response = await request();
    if (response.status !== 202) return response;
    if (performance.now() > deadline)
      throw new Error("The media job did not finish.");
    await Bun.sleep(10);
  }
}

const PendingSchema = z.object({ key: z.string(), job: JobStateSchema });

test("PCM extrema survive chunk boundaries, partial buckets, and every mip", async () => {
  const pcm = Buffer.alloc(81 * 2);
  pcm.writeInt16LE(-32768, 0);
  pcm.writeInt16LE(32767, 158);
  pcm.writeInt16LE(-123, 160);
  const bytes = await encodePeaks(
    new ReadableStream({
      start(controller) {
        controller.enqueue(pcm.subarray(0, 3));
        controller.enqueue(pcm.subarray(3, 159));
        controller.enqueue(pcm.subarray(159));
        controller.close();
      },
    }),
  );
  expect(bytes.toString("ascii", 0, 4)).toBe("CRPK");
  expect(bytes.readUInt32LE(4)).toBe(1);
  expect(bytes.readDoubleLE(16)).toBe(81);
  expect(bytes.readUInt32LE(36)).toBe(2);
  expect(bytes.readInt16LE(96)).toBe(-32768);
  expect(bytes.readInt16LE(98)).toBe(32767);
  expect(bytes.readInt16LE(100)).toBe(-123);
  expect(bytes.readInt16LE(102)).toBe(-123);
  for (let level = 1; level < 4; level++) {
    const entry = 32 + 16 * level;
    expect(bytes.readUInt32LE(entry)).toBe(80 * 4 ** level);
    expect(bytes.readUInt32LE(entry + 4)).toBe(1);
    const offset = bytes.readUInt32LE(entry + 8);
    expect(bytes.readInt16LE(offset)).toBe(-32768);
    expect(bytes.readInt16LE(offset + 2)).toBe(32767);
  }
});

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "media routes generate real peaks and filmstrips, revalidate edits, and reuse disk cache after restart",
  async () => {
    const fixture = await projectFixture();
    const routes = createMediaRoutes(fixture.store);
    fixture.app.route("/api/cutroom", routes);
    let restarted: ReturnType<typeof createMediaService> | undefined;
    try {
      const project = await fixture.store.create({ name: "Media cache" });
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=10:duration=4.1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=8000:duration=4.1",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-threads",
        "1",
        "-c:a",
        "pcm_s16le",
        join(project.path, "sample.mkv"),
      ]);
      const base = `/projects/${project.id}/media`;
      const peaksUrl = `${base}/peaks?path=sample.mkv`;
      const first = await fixture.request(peaksUrl);
      expect(first.status).toBe(202);
      expect(first.headers.get("cache-control")).toBe("no-store");
      const pending = PendingSchema.parse(await first.json());
      const duplicate = await fixture.request(peaksUrl);
      expect(PendingSchema.parse(await duplicate.json()).key).toBe(pending.key);
      const peaks = await ready(() => fixture.request(peaksUrl));
      expect(peaks.status).toBe(200);
      expect(peaks.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(peaks.headers.get("cache-control")).toBe(
        "private, max-age=0, must-revalidate",
      );
      const bytes = Buffer.from(await peaks.arrayBuffer());
      expect(bytes.toString("ascii", 0, 4)).toBe("CRPK");
      expect(bytes.readUInt32LE(36)).toBe(410);
      expect(bytes.length).toBeLessThan(2500);
      const etag = peaks.headers.get("etag")!;
      expect(
        (
          await fixture.app.request(`/api/cutroom${peaksUrl}`, {
            headers: { "if-none-match": etag },
          })
        ).status,
      ).toBe(304);
      const filmstrip = await ready(() =>
        fixture.request(`${base}/filmstrip?path=sample.mkv`),
      );
      expect(filmstrip.status).toBe(200);
      const metadata = FilmstripSchema.extend({
        key: z.string(),
        spriteUrl: z.string(),
      }).parse(await filmstrip.json());
      expect(metadata.count).toBe(3);
      expect(metadata.columns).toBe(3);
      expect(metadata.rows).toBe(1);
      const sprite = await fixture.app.request(metadata.spriteUrl);
      expect(sprite.status).toBe(200);
      expect(sprite.headers.get("cache-control")).toContain("immutable");
      const image = Buffer.from(await sprite.arrayBuffer());
      expect([...image.subarray(0, 2)]).toEqual([255, 216]);
      await routes.dispose();
      restarted = createMediaService({
        workerUrl: new URL("file:///missing-worker.ts"),
      });
      const warm = await restarted.request(project, "sample.mkv", "peaks");
      expect(warm.state.status).toBe("done");
      expect(warm.artifact && (await readFile(warm.artifact))).toEqual(bytes);
      const warmStrip = await restarted.request(
        project,
        "sample.mkv",
        "filmstrip",
      );
      expect(warmStrip.metadata?.count).toBe(3);
      await utimes(
        join(project.path, "sample.mkv"),
        new Date(),
        new Date(Date.now() + 1000),
      );
      const changed = await restarted.request(project, "sample.mkv", "peaks");
      expect(changed.key).not.toBe(pending.key);
      expect(changed.state.status).toBe("running");
    } finally {
      await restarted?.dispose();
      await routes.dispose();
      await fixture.close();
    }
  },
  15000,
);

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "outside paths, linked caches, and playlist indirection cannot escape the project",
  async () => {
    const fixture = await projectFixture();
    const media = createMediaService();
    try {
      const project = await fixture.store.create({ name: "Media boundaries" });
      await writeFile(join(fixture.directory, "outside.wav"), "private");
      await symlink(
        join(fixture.directory, "outside.wav"),
        join(project.path, "link.wav"),
      );
      await expect(
        media.request(project, "../../outside.wav", "peaks"),
      ).rejects.toThrow("outside the project");
      await expect(media.request(project, "link.wav", "peaks")).rejects.toThrow(
        "Links outside",
      );
      await expect(
        media.request(project, "/etc/passwd", "peaks"),
      ).rejects.toThrow("project-relative");
      await writeFile(
        join(project.path, "list.m3u8"),
        "#EXTM3U\n#EXTINF:1,\n" + join(fixture.directory, "outside.wav"),
      );
      await media.request(project, "list.m3u8", "peaks");
      let result = await media.request(project, "list.m3u8", "peaks");
      while (result.state.status === "running") {
        await Bun.sleep(10);
        result = await media.request(project, "list.m3u8", "peaks");
      }
      expect(result.state.status).toBe("failed");
      expect(
        (await readdir(join(project.path, ".cutroom/cache"))).filter((name) =>
          name.startsWith(".media-"),
        ),
      ).toEqual([]);
      const other = await fixture.store.create({ name: "Linked cache" });
      await writeFile(join(other.path, "sample.wav"), "invalid media");
      await symlink(fixture.directory, join(other.path, ".cutroom"));
      await expect(media.request(other, "sample.wav", "peaks")).rejects.toThrow(
        "Links outside",
      );
    } finally {
      await media.dispose();
      await fixture.close();
    }
  },
);

test.skipIf(!Bun.which("ffmpeg"))(
  "media work shares a key, runs two workers, and cancels queued and running jobs before shutdown returns",
  async () => {
    const fixture = await projectFixture();
    const workerPath = join(fixture.directory, "controlled-worker.ts");
    const eventsPath = join(fixture.directory, "events.jsonl");
    await writeFile(
      workerPath,
      `
import { appendFile } from "node:fs/promises";
let cancelled = false;
self.onmessage = async ({data}) => {
  if (data.type === "cancel") { cancelled = true; return; }
  await appendFile(${JSON.stringify(eventsPath)}, JSON.stringify({type:"start",source:data.source})+"\\n");
  while (!cancelled) await Bun.sleep(5);
  await appendFile(${JSON.stringify(eventsPath)}, JSON.stringify({type:"stop",source:data.source})+"\\n");
  self.postMessage({type:"error", error:"cancelled"});
};`,
    );
    const media = createMediaService({
      workerUrl: new URL(`file://${workerPath}`),
    });
    try {
      const project = await fixture.store.create({ name: "Media queue" });
      for (const name of ["one.wav", "two.wav", "three.wav"])
        await writeFile(join(project.path, name), "fixture");
      const [one, duplicate] = await Promise.all([
        media.request(project, "one.wav", "peaks"),
        media.request(project, "one.wav", "peaks"),
      ]);
      expect(one.key).toBe(duplicate.key);
      expect(one.state.status).toBe("running");
      await media.request(project, "two.wav", "peaks");
      const queued = await media.request(project, "three.wav", "peaks");
      expect(queued.state.status).toBe("queued");
      const deadline = performance.now() + 3000;
      while (true) {
        const events = await readFile(eventsPath, "utf8").catch(() => "");
        if (events.trim().split("\n").length === 2) break;
        if (performance.now() > deadline)
          throw new Error("Workers never started.");
        await Bun.sleep(5);
      }
      await media.dispose();
      const events = z
        .array(z.object({ type: z.string(), source: z.string() }))
        .parse(
          (await readFile(eventsPath, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        );
      expect(events.filter((event) => event.type === "start")).toHaveLength(2);
      expect(events.filter((event) => event.type === "stop")).toHaveLength(2);
      expect(events.some((event) => event.source.endsWith("three.wav"))).toBe(
        false,
      );
      expect(await readdir(join(project.path, ".cutroom/cache"))).toEqual([]);
      await expect(media.request(project, "one.wav", "peaks")).rejects.toThrow(
        "shutting down",
      );
    } finally {
      await media.dispose();
      await fixture.close();
    }
  },
  5000,
);

test.skipIf(!Bun.which("ffmpeg"))(
  "filmstrip count follows decoded video when audio is longer, and audio-only filmstrips fail without leaving cache files",
  async () => {
    const fixture = await projectFixture();
    const media = createMediaService();
    try {
      const project = await fixture.store.create({ name: "Unequal streams" });
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "color=red:size=160x90:rate=10:duration=0.1",
        "-f",
        "lavfi",
        "-i",
        "sine=duration=4.1",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-c:a",
        "pcm_s16le",
        join(project.path, "long-audio.mkv"),
      ]);
      let result = await media.request(project, "long-audio.mkv", "filmstrip");
      const deadline = performance.now() + 5000;
      while (!result.artifact && result.state.status !== "failed") {
        if (performance.now() > deadline)
          throw new Error("The filmstrip did not finish.");
        await Bun.sleep(10);
        result = await media.request(project, "long-audio.mkv", "filmstrip");
      }
      expect(result.state.status).toBe("done");
      expect(result.metadata?.count).toBe(1);
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "sine=duration=0.2",
        join(project.path, "audio.wav"),
      ]);
      let audio = await media.request(project, "audio.wav", "filmstrip");
      while (audio.state.status === "running") {
        if (performance.now() > deadline)
          throw new Error("The audio-only job did not fail.");
        await Bun.sleep(10);
        audio = await media.request(project, "audio.wav", "filmstrip");
      }
      expect(audio.state.status).toBe("failed");
      expect(
        (await readdir(join(project.path, ".cutroom/cache"))).filter((name) =>
          name.startsWith(".media-"),
        ),
      ).toEqual([]);
    } finally {
      await media.dispose();
      await fixture.close();
    }
  },
);
