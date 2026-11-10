import { expect, test } from "bun:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createMediaService } from "../src/server/media/service";
import { projectFixture } from "./project-fixture";

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  const deadline = Date.now() + 5000;
  while (true) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      throw new Error("Media lifecycle did not reach the expected result.");
    await Bun.sleep(5);
  }
}
async function controlledFixture(
  mode: "queue" | "crash" | "frames" | "no-stream" = "queue",
  failCleanup = false,
) {
  const fixture = await projectFixture();
  const workerPath = join(fixture.directory, "worker.ts");
  const log = join(fixture.directory, "events.jsonl");
  const marker = join(fixture.directory, "crashed");
  const release = join(fixture.directory, "release");
  await writeFile(
    workerPath,
    `
import {appendFile} from "node:fs/promises";
import {join} from "node:path";
const task = await Bun.stdin.json();
if(task.kind === "probe") {
 await Bun.write(join(task.directory,"probe.json"), JSON.stringify(${JSON.stringify(mode)} === "no-stream" ? {} : {channels:1,video:{width:160,height:90,pixelAspect:1,fps:30,duration:12}}));
} else {
 await appendFile(${JSON.stringify(log)}, JSON.stringify({kind:task.kind,source:task.source,time:task.time})+"\\n");
 if(${JSON.stringify(mode)} === "crash" && !await Bun.file(${JSON.stringify(marker)}).exists()) {
  const child=Bun.spawn(["ffmpeg","-v","error","-re","-f","lavfi","-i","color=black:size=32x32:rate=1","-f","null","-"],{stdin:"ignore",stdout:"ignore",stderr:"ignore"});
  await Bun.write(${JSON.stringify(marker)},String(child.pid));
  process.exit(42);
 }
 if(${JSON.stringify(mode)} === "frames") {
  let cancelled=false;
  process.on("SIGTERM",()=>cancelled=true);
  while(!cancelled && !await Bun.file(${JSON.stringify(release)}).exists()) await Bun.sleep(5);
  if(cancelled) {console.log(JSON.stringify({type:"error",error:"cancelled"}));process.exit(0);}
 }
 if(task.kind === "filmstrip") {
  let cancelled=false;
  process.on("SIGTERM",()=>cancelled=true);
  await Bun.write(join(task.directory,"partial"),"partial");
  while(!cancelled) await Bun.sleep(5);
  console.log(JSON.stringify({type:"error",error:"cancelled"}));
  process.exit(0);
 }
 await Bun.write(join(task.directory,task.kind === "frame" ? "frame.jpg" : "peaks.bin"),"fixture");
}
console.log(JSON.stringify({type:"done"}));
`,
  );
  const media = createMediaService({
    workerUrl: new URL(`file://${workerPath}`),
    failureTtlMs: 100,
    removeDirectory: failCleanup
      ? async () => {
          throw new Error("Disk refused cleanup");
        }
      : undefined,
  });
  const project = await fixture.store.create({ name: "Media lifecycle" });
  for (const name of ["one.mp4", "two.mp4", "audio.wav", "frame.mp4"]) {
    await writeFile(join(project.path, name), "source");
    await until(
      () => media.request(project, name, "probe"),
      (result) => !!result.artifact,
    );
  }
  return {
    ...fixture,
    media,
    project,
    marker,
    release,
    workerPath,
    log,
    async close() {
      await media.dispose().catch((error: unknown) => {
        if (!failCleanup) throw error;
      });
      await fixture.close();
    },
  };
}

test.skipIf(!Bun.which("ffmpeg"))(
  "long filmstrips cannot occupy the peaks and visible-frame slot",
  async () => {
    const f = await controlledFixture();
    try {
      await f.media.request(f.project, "one.mp4", "filmstrip");
      const queued = await f.media.request(f.project, "two.mp4", "filmstrip");
      expect(queued.state.status).toBe("queued");
      const peaks = await until(
        () => f.media.request(f.project, "audio.wav", "peaks"),
        (result) => !!result.artifact,
      );
      const frame = await until(
        () => f.media.request(f.project, "frame.mp4", "frame", 1),
        (result) => !!result.artifact,
      );
      expect(peaks.state.status).toBe("done");
      expect(frame.state.status).toBe("done");
      const events = z
        .array(z.object({ kind: z.string(), source: z.string() }))
        .parse(
          (await readFile(f.log, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        );
      expect(events.filter((event) => event.kind === "filmstrip")).toHaveLength(
        1,
      );
      expect(events.some((event) => event.source.endsWith("two.mp4"))).toBe(
        false,
      );
    } finally {
      await f.close();
    }
  },
);

test.skipIf(!Bun.which("ffmpeg") || process.platform !== "linux")(
  "a crashed media worker loses its FFmpeg child, and a failed request can retry",
  async () => {
    const f = await controlledFixture("crash");
    try {
      const failed = await until(
        () => f.media.request(f.project, "audio.wav", "peaks"),
        (result) => result.state.status === "failed",
      );
      expect(failed.state.status).toBe("failed");
      const pid = Number(await readFile(f.marker, "utf8"));
      await until(
        async () => readFile(`/proc/${pid}/stat`, "utf8").catch(() => ""),
        (state) => !state || state.split(") ")[1]?.startsWith("Z ") === true,
      );
      await Bun.sleep(110);
      const recovered = await until(
        () => f.media.request(f.project, "audio.wav", "peaks"),
        (result) => !!result.artifact,
      );
      expect(recovered.state.status).toBe("done");
      expect((await readFile(f.log, "utf8")).trim().split("\n")).toHaveLength(
        2,
      );
    } finally {
      await f.close();
    }
  },
);

test.skipIf(!Bun.which("ffmpeg"))(
  "media shutdown rejects when cancelled partial files cannot be cleaned",
  async () => {
    const f = await controlledFixture("queue", true);
    try {
      await f.media.request(f.project, "one.mp4", "filmstrip");
      await until(
        async () => readFile(f.log, "utf8").catch(() => ""),
        (log) => log.includes("filmstrip"),
      );
      await expect(f.media.dispose()).rejects.toThrow("cleanup failed");
      const cache = join(f.project.path, ".cutroom/cache");
      expect(
        (await readdir(cache)).some((name) => name.startsWith(".media-")),
      ).toBe(true);
    } finally {
      await f.close();
    }
  },
);

test.skipIf(!Bun.which("ffmpeg"))(
  "the newest visible frame bypasses 60 stale queued frames",
  async () => {
    const f = await controlledFixture("frames");
    try {
      await f.media.request(f.project, "frame.mp4", "frame", 1);
      await f.media.request(f.project, "frame.mp4", "frame", 2);
      await until(
        async () => readFile(f.log, "utf8").catch(() => ""),
        (log) => log.trim().split("\n").length === 2,
      );
      for (let index = 90; index < 150; index++)
        expect(
          (await f.media.request(f.project, "frame.mp4", "frame", index / 30))
            .state.status,
        ).toBe("queued");
      expect(
        (await f.media.request(f.project, "frame.mp4", "frame", 10)).state
          .status,
      ).toBe("queued");
      const revisited = await f.media.request(
        f.project,
        "frame.mp4",
        "frame",
        3,
      );
      expect(revisited.state.status).toBe("queued");
      await writeFile(f.release, "release workers");
      await until(
        () => f.media.request(f.project, "frame.mp4", "frame", 10),
        (result) => !!result.artifact,
      );
      const events = z.array(z.object({ time: z.number() })).parse(
        (await readFile(f.log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      );
      expect(events.slice(2, 4).map((event) => event.time)).toContain(10);
      expect(events.slice(2, 4).map((event) => event.time)).toContain(3);
    } finally {
      await f.close();
    }
  },
);

test.skipIf(!Bun.which("ffmpeg"))(
  "missing streams are rejected from cached probe info without asset workers",
  async () => {
    const f = await controlledFixture("no-stream");
    try {
      await expect(
        f.media.request(f.project, "audio.wav", "peaks"),
      ).rejects.toThrow("no audio stream");
      await expect(
        f.media.request(f.project, "one.mp4", "filmstrip"),
      ).rejects.toThrow("no video stream");
      await expect(
        f.media.request(f.project, "one.mp4", "frame", 0),
      ).rejects.toThrow("no video stream");
      expect(await Bun.file(f.log).exists()).toBe(false);
    } finally {
      await f.close();
    }
  },
);

test.skipIf(!Bun.which("ffmpeg"))(
  "default failures outlive a second but edited sources retry immediately",
  async () => {
    const f = await controlledFixture("crash");
    const media = createMediaService({
      workerUrl: new URL(`file://${f.workerPath}`),
    });
    try {
      const failed = await until(
        () => media.request(f.project, "audio.wav", "peaks"),
        (result) => result.state.status === "failed",
      );
      await Bun.sleep(1100);
      expect(
        (await media.request(f.project, "audio.wav", "peaks")).state.status,
      ).toBe("failed");
      await writeFile(join(f.project.path, "audio.wav"), "edited source");
      const recovered = await until(
        () => media.request(f.project, "audio.wav", "peaks"),
        (result) => !!result.artifact,
      );
      expect(recovered.key).not.toBe(failed.key);
      expect((await readFile(f.log, "utf8")).trim().split("\n")).toHaveLength(
        2,
      );
    } finally {
      await media.dispose();
      await f.close();
    }
  },
);
