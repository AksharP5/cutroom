import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/server/app";
import { Hono } from "hono";
import { createProjectRoutes } from "../src/server/projects/routes";
import { createReviewService } from "../src/server/projects/review";
import { createTranscriptService } from "../src/server/transcript/service";
import {
  ProjectSchema,
  SourceSchema,
  TranscriptJobSchema,
} from "../src/shared/project";
import { createMcpHttpHandler, localApiBase } from "../src/server/mcp/server";
import { projectFixture } from "./project-fixture";
import { z } from "zod";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { editSummary } from "../src/shared/toolRow";
import { createTimelineRoutes } from "../src/server/timeline/routes";

test("marker names and colours round-trip through MCP, disk, and undo history", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Marker review beats" });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createMcpHttpHandler({
      fetch: (url, init) => fixture.app.request(url, init),
    }),
  });
  const client = new Client({ name: "marker-test", version: "1" });
  const resultSchema = z.object({
    structuredContent: z.object({ result: TimelineViewSchema }),
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
      ),
    );
    const read = async () =>
      resultSchema.parse(
        await client.callTool({
          name: "timeline_read",
          arguments: { projectId: project.id },
        }),
      ).structuredContent.result;
    const before = await read();
    const edited = resultSchema.parse(
      await client.callTool({
        name: "timeline_edit",
        arguments: {
          fullTimeline: true,
          projectId: project.id,
          expectedRevision: before.revision,
          commands: [
            {
              type: "setMarker",
              id: "downbeat",
              frame: 45,
              duration: 12,
              name: "Downbeat",
              note: "Keep this cue",
              color: "purple",
            },
          ],
        },
      }),
    ).structuredContent.result;
    const expected = [
      {
        id: "downbeat",
        frame: 45,
        duration: 12,
        name: "Downbeat",
        note: "Keep this cue",
        color: "purple" as const,
      },
    ];
    expect(edited.timeline.markers).toEqual(expected);
    expect((await read()).timeline.markers).toEqual(expected);
    expect(
      TimelineViewSchema.parse(
        await (
          await fixture.request(`/projects/${project.id}/timeline`)
        ).json(),
      ).timeline.markers,
    ).toEqual(expected);
    expect(
      (
        await client.callTool({
          name: "history_undo",
          arguments: { projectId: project.id },
        })
      ).isError,
    ).not.toBe(true);
    expect((await read()).timeline.markers).toEqual([]);
    expect(
      (
        await client.callTool({
          name: "history_redo",
          arguments: { projectId: project.id },
        })
      ).isError,
    ).not.toBe(true);
    expect((await read()).timeline.markers).toEqual(expected);
    const current = await read();
    expect(
      (
        await client.callTool({
          name: "timeline_edit",
          arguments: {
            fullTimeline: true,
            projectId: project.id,
            expectedRevision: current.revision,
            commands: [{ type: "removeMarker", id: "downbeat" }],
          },
        })
      ).isError,
    ).not.toBe(true);
    expect((await read()).timeline.markers).toEqual([]);
  } finally {
    await client.close();
    await server.stop(true);
    await fixture.close();
  }
});

test("an external MCP client edits the same project and undo history as the UI", async () => {
  const fixture = await projectFixture();
  const handler = createMcpHttpHandler({
    fetch: (url, init) => fixture.app.request(url, init),
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const client = new Client({
    name: "cutroom-integration-test",
    version: "1.0.0",
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
      ),
    );
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("transcript_edit");
    const created = await client.callTool({
      name: "project_create",
      arguments: { name: "External agent" },
    });
    const project = z
      .object({ structuredContent: z.object({ result: ProjectSchema }) })
      .parse(created).structuredContent.result;
    const read = await client.callTool({
      name: "source_read",
      arguments: { projectId: project.id },
    });
    const original = z
      .object({ structuredContent: z.object({ result: SourceSchema }) })
      .parse(read).structuredContent.result;
    const content = original.content.replace(
      "Drop media in, or ask your agent to start.",
      "Changed through MCP.",
    );
    const saved = await client.callTool({
      name: "source_write",
      arguments: {
        projectId: project.id,
        content,
        expectedVersion: original.version,
      },
    });
    expect(saved.isError).not.toBe(true);
    const visible = SourceSchema.parse(
      await (await fixture.request(`/projects/${project.id}/source`)).json(),
    );
    expect(visible.content).toContain("Changed through MCP.");
    expect(
      (await fixture.review.clipChanges(project, "index.html")).clipEdits,
    ).toContainEqual(
      expect.objectContaining({
        by: "agent",
        agentName: "cutroom-integration-test",
      }),
    );
    const stale = await client.callTool({
      name: "source_write",
      arguments: {
        projectId: project.id,
        content: "stale",
        expectedVersion: original.version,
      },
    });
    expect(stale.isError).toBe(true);
    const undo = await client.callTool({
      name: "history_undo",
      arguments: { projectId: project.id },
    });
    expect(undo.isError).not.toBe(true);
    expect(
      SourceSchema.parse(
        await (await fixture.request(`/projects/${project.id}/source`)).json(),
      ).content,
    ).toBe(original.content);
  } finally {
    await client.close();
    server.stop(true);
    await fixture.close();
  }
});

test("the stdio bridge refuses remote or credential-bearing API origins", () => {
  expect(localApiBase("http://localhost:4317")).toBe("http://localhost:4317");
  expect(() => localApiBase("http://example.com")).toThrow("local HTTP");
  expect(() => localApiBase("http://user:password@localhost:4317")).toThrow(
    "local HTTP",
  );
});

test("the published stdio entry point connects an outside agent to the running server", async () => {
  const fixture = await projectFixture();
  const project = await fixture.store.create({ name: "Stdio project" });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => fixture.app.fetch(request),
  });
  const client = new Client({ name: "cutroom-stdio-test", version: "1.0.0" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          fileURLToPath(new URL("../src/server/mcp/stdio.ts", import.meta.url)),
        ],
        env: {
          PATH: process.env.PATH ?? "",
          CUTROOM_URL: `http://127.0.0.1:${server.port}`,
        },
      }),
    );
    const result = await client.callTool({
      name: "projects_list",
      arguments: {},
    });
    const returned = z
      .object({
        structuredContent: z.object({
          result: z.object({ projects: z.array(ProjectSchema) }),
        }),
      })
      .parse(result);
    expect(returned.structuredContent.result.projects[0]?.id).toBe(project.id);
  } finally {
    await client.close();
    server.stop(true);
    await fixture.close();
  }
});

test("MCP transcription status retains the legacy job shape through successful and failed shared jobs", async () => {
  const fixture = await projectFixture();
  let fail = false;
  const service = createTranscriptService(fixture.store, {
    availability: async () => ({
      available: true,
      binary: "/installed/whisper",
      modelsDir: "/installed/models",
      models: ["ggml-small.en.bin"],
      model: "small.en",
    }),
    transcribe: async (options) => {
      if (fail) throw new Error("Engine failure");
      if (!options.dir) throw new Error("Expected scratch directory");
      const transcriptPath = join(options.dir, "words.json");
      await writeFile(
        transcriptPath,
        JSON.stringify([{ id: "hello", text: "Hello", start: 0, end: 1 }]),
      );
      return {
        kind: "transcribed",
        engine: "whisper",
        model: "small.en",
        detectedLanguage: "en",
        wordCount: 1,
        durationSeconds: 2,
        speechOnsetSeconds: 0,
        transcriptPath,
      };
    },
  });
  const api = new Hono().route(
    "/api/cutroom",
    createProjectRoutes(
      fixture.store,
      createReviewService(fixture.store),
      service,
    ),
  );
  const handler = createMcpHttpHandler({
    fetch: (url, init) => api.request(url, init),
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const client = new Client({ name: "job-status-test", version: "1" });
  try {
    const project = await fixture.store.create({ name: "Job status" });
    await writeFile(
      join(project.path, "index.html"),
      '<html><body><main data-composition-id="main" data-duration="2"><audio id="speech" class="clip" src="speech.wav" data-start="0" data-duration="2"></audio></main></body></html>',
    );
    await writeFile(join(project.path, "speech.wav"), "fixture audio");
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
      ),
    );
    for (const shouldFail of [false, true]) {
      fail = shouldFail;
      const job = await service.start(project, {
        sourceFile: "index.html",
        mediaPath: "speech.wav",
        elementId: "speech",
        language: "en",
      });
      const deadline = performance.now() + 3000;
      while (job.status === "running") {
        if (performance.now() > deadline)
          throw new Error("Transcription job did not settle.");
        await Bun.sleep(5);
      }
      const result = await client.callTool({
        name: "transcription_status",
        arguments: { jobId: job.id },
      });
      const received = z
        .object({
          structuredContent: z.object({ result: TranscriptJobSchema }),
        })
        .parse(result).structuredContent.result;
      expect(received.status).toBe(shouldFail ? "failed" : "complete");
      expect(received.progress).toBe(shouldFail ? 0 : 1);
      expect(received.message).toBe(
        shouldFail ? "Transcription failed" : "Transcribed 1 words",
      );
      if (shouldFail) expect(received.error).toBe("Engine failure");
      else expect(received.transcriptId).toBeString();
    }
  } finally {
    await client.close();
    await service.dispose();
    await server.stop(true);
    await fixture.close();
  }
});

test("review_list gives an agent every stroke, the pin, and the range of a note made on the picture", async () => {
  const fixture = await projectFixture();
  const project = await fixture.store.create({ name: "Picture notes" });
  const handler = createMcpHttpHandler({
    fetch: (url, init) => fixture.app.request(url, init),
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const client = new Client({ name: "cutroom-review-test", version: "1.0.0" });
  const strokes = [
    {
      points: [
        { x: 0.2, y: 0.5 },
        { x: 0.4, y: 0.3 },
      ],
      color: "#f2c94c",
    },
    { points: [{ x: 0.7, y: 0.7 }], color: "#f2c94c" },
  ];
  try {
    // What the editor sends for a drawing with no words.
    const saved = await fixture.request(
      `/projects/${project.id}/annotations`,
      "POST",
      {
        kind: "drawing",
        body: "",
        time: 1,
        endTime: 2.5,
        compositionPath: "index.html",
        point: { x: 0.4, y: 0.3 },
        strokes,
      },
    );
    expect(saved.ok).toBe(true);
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
      ),
    );
    const listed = await client.callTool({
      name: "review_list",
      arguments: { projectId: project.id },
    });
    const { items } = z
      .object({
        structuredContent: z.object({
          result: z.object({ items: z.array(z.unknown()) }),
        }),
      })
      .parse(listed).structuredContent.result;
    expect(items).toEqual([
      expect.objectContaining({
        kind: "drawing",
        time: 1,
        endTime: 2.5,
        point: { x: 0.4, y: 0.3 },
        strokes,
        review: expect.objectContaining({ status: "open" }),
      }),
    ]);
  } finally {
    await client.close();
    await server.stop(true);
    await fixture.close();
  }
});

test("title text edits through MCP write the source, undo in one step, and refuse nested markup", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Launch cut" });
  const file = join(project.path, "index.html");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createMcpHttpHandler({
      fetch: (url, init) => fixture.app.request(url, init),
    }),
  });
  const client = new Client({ name: "text-test", version: "1" });
  const resultSchema = z.object({
    structuredContent: z.object({ result: TimelineViewSchema }),
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
      ),
    );
    const read = async () =>
      resultSchema.parse(
        await client.callTool({
          name: "timeline_read",
          arguments: { projectId: project.id },
        }),
      ).structuredContent.result;
    const text = (view: Awaited<ReturnType<typeof read>>) =>
      view.timeline.clips.find((clip) => clip.id === "headline")?.text;
    const setText = async (words: string) =>
      client.callTool({
        name: "timeline_edit",
        arguments: {
          fullTimeline: true,
          projectId: project.id,
          expectedRevision: (await read()).revision,
          commands: [{ type: "setClip", clipId: "headline", text: words }],
        },
      });
    expect(text(await read())).toBe("Launch cut");
    const answer = await setText("Spring\nlaunch");
    const edited = resultSchema.parse(answer).structuredContent.result;
    expect(text(edited)).toBe("Spring\nlaunch");
    expect(await Bun.file(file).text()).toContain(">Spring<br>launch</div>");
    const { clipEdits } = resultSchema.parse(
      await client.callTool({
        name: "timeline_read",
        arguments: { projectId: project.id, clipEdits: true },
      }),
    ).structuredContent.result;
    expect(clipEdits?.[0]?.label).toBe("Set text to “Spring launch”");
    // The agent panel's row reads the sentence that ends the call's result.
    expect(
      editSummary("cutroom_studio: timeline_edit", JSON.stringify(answer)),
    ).toBe("Set text to “Spring launch” for Project title");
    await client.callTool({
      name: "history_undo",
      arguments: { projectId: project.id },
    });
    expect(text(await read())).toBe("Launch cut");
    expect(await Bun.file(file).text()).toContain(">Launch cut</div>");

    const source = await Bun.file(file).text();
    await writeFile(
      file,
      source.replace(">Launch cut</div>", "><em>Launch</em> cut</div>"),
    );
    const refused = await setText("Flattened");
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain(
      "This text has markup inside it. Edit it in the source.",
    );
    expect(await Bun.file(file).text()).toContain("<em>Launch</em> cut");
  } finally {
    await client.close();
    await server.stop(true);
    await fixture.close();
  }
});

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "media_files tells an agent each file's length, size, picture and sound without probing it",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cutroom-media-details-"));
    const probe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const port = probe.port;
    await probe.stop(true);
    const runtime = await createApp({
      dataDir: root,
      projectsDir: join(root, "projects"),
      port,
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: runtime.app.fetch,
    });
    const client = new Client({ name: "media-details-test", version: "1" });
    try {
      const project = await runtime.projects.create({ name: "Media details" });
      const assets = join(project.path, "assets");
      await mkdir(assets, { recursive: true });
      const ffmpeg = (...args: string[]) =>
        expect(Bun.spawnSync(["ffmpeg", "-v", "error", ...args]).exitCode).toBe(
          0,
        );
      ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=320x180:r=50:d=2",
        "-f",
        "lavfi",
        "-i",
        "sine=d=2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        join(assets, "talk.mp4"),
      );
      ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=640x360:r=24000/1001:d=1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        join(assets, "broll.mp4"),
      );
      ffmpeg("-f", "lavfi", "-i", "sine=d=3", join(assets, "music.wav"));
      ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "color=s=64x32",
        "-frames:v",
        "1",
        join(assets, "logo.png"),
      );
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${port}/mcp`),
        ),
      );
      const list = async () =>
        z
          .object({
            structuredContent: z.object({
              result: z.object({
                files: z.array(z.looseObject({ path: z.string() })),
              }),
            }),
          })
          .parse(
            await client.callTool({
              name: "media_files",
              arguments: { projectId: project.id, query: "assets/" },
            }),
          ).structuredContent.result.files;
      let files = await list();
      const file = (name: string) =>
        files.find(({ path }) => path === `assets/${name}`);
      const bytes = async (name: string) =>
        (await stat(join(assets, name))).size;
      expect(file("talk.mp4")).toEqual({
        path: "assets/talk.mp4",
        kind: "video",
        src: "assets/talk.mp4",
        bytes: await bytes("talk.mp4"),
        duration: expect.closeTo(2, 1),
        width: 320,
        height: 180,
        fps: 50,
        audio: true,
      });
      expect(file("broll.mp4")).toMatchObject({
        width: 640,
        height: 360,
        fps: 23.976,
        audio: false,
      });
      expect(file("music.wav")).toEqual({
        path: "assets/music.wav",
        kind: "audio",
        src: "assets/music.wav",
        bytes: await bytes("music.wav"),
        duration: 3,
        audio: true,
      });
      expect(file("logo.png")).toEqual({
        path: "assets/logo.png",
        kind: "image",
        src: "assets/logo.png",
        bytes: await bytes("logo.png"),
      });

      // A replacement of the same size that keeps the old modification time is probed again:
      // 2 s of mono and 1 s of stereo hold the same number of bytes.
      const music = join(assets, "music.wav");
      ffmpeg("-f", "lavfi", "-i", "sine=d=2", "-ac", "1", "-y", music);
      files = await list();
      const mono = await stat(music);
      expect(file("music.wav")).toMatchObject({ duration: 2 });
      const stereo = join(root, "stereo.wav");
      ffmpeg("-f", "lavfi", "-i", "sine=d=1", "-ac", "2", stereo);
      expect((await stat(stereo)).size).toBe(mono.size);
      await rename(stereo, music);
      await utimes(music, mono.atimeMs / 1000, mono.mtimeMs / 1000);
      expect((await stat(music)).mtimeMs).toBe(mono.mtimeMs);
      files = await list();
      expect(file("music.wav")).toMatchObject({
        bytes: mono.size,
        duration: 1,
      });

      // A file that went, or a path outside the project, is refused and never probed.
      await writeFile(join(root, "outside.wav"), "not inside the project");
      for (const path of [
        "assets/gone.wav",
        "../../outside.wav",
        join(root, "outside.wav"),
      ])
        expect(
          (
            await runtime.app.request(
              `http://127.0.0.1:${port}/api/cutroom/projects/${project.id}/media/details?path=${encodeURIComponent(path)}`,
            )
          ).status,
        ).toBe(404);
    } finally {
      await client.close();
      await runtime.dispose();
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(
  !Bun.which("ffmpeg") || !Bun.which("ffprobe") || !Bun.which("bash"),
)(
  "media_files probes eight files at a time, and a file ffprobe cannot read or stalls on keeps its size",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cutroom-media-probes-"));
    const probe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const port = probe.port;
    await probe.stop(true);
    const runtime = await createApp({
      dataDir: root,
      projectsDir: join(root, "projects"),
      port,
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: runtime.app.fetch,
    });
    const client = new Client({ name: "media-probes-test", version: "1" });
    const configured = process.env.HYPERFRAMES_FFPROBE_PATH;
    // Stand-ins for ffprobe: one notes how many probes are running before running the real one,
    // the other never answers.
    const running = join(root, "running");
    await mkdir(running);
    const counting = join(root, "ffprobe-counting");
    await writeFile(
      counting,
      `#!/usr/bin/env bash\ntouch "${running}/$$"\nls "${running}" | wc -l >> "${root}/counts"\nsleep 0.2\nrm "${running}/$$"\nexec "${Bun.which("ffprobe")}" "$@"\n`,
      { mode: 0o755 },
    );
    const stalling = join(root, "ffprobe-stalling");
    await writeFile(stalling, "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
    try {
      const project = await runtime.projects.create({ name: "Media probes" });
      const assets = join(project.path, "assets");
      await mkdir(assets, { recursive: true });
      const tone = join(root, "tone.wav");
      expect(
        Bun.spawnSync([
          "ffmpeg",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=d=1",
          tone,
        ]).exitCode,
      ).toBe(0);
      for (let index = 0; index < 20; index++)
        await copyFile(tone, join(assets, `take-${index}.wav`));
      await writeFile(join(assets, "broken.mp4"), "not a video at all");
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${port}/mcp`),
        ),
      );
      const list = async (query: string) =>
        z
          .object({
            structuredContent: z.object({
              result: z.object({
                files: z.array(z.looseObject({ path: z.string() })),
              }),
            }),
          })
          .parse(
            await client.callTool({
              name: "media_files",
              arguments: { projectId: project.id, query },
            }),
          ).structuredContent.result.files;
      const size = async (name: string) =>
        (await stat(join(assets, name))).size;

      process.env.HYPERFRAMES_FFPROBE_PATH = counting;
      const files = await list("assets/");
      expect(files.filter((file) => file.duration === 1)).toHaveLength(20);
      expect(files.find((file) => file.path === "assets/broken.mp4")).toEqual({
        path: "assets/broken.mp4",
        kind: "video",
        src: "assets/broken.mp4",
        bytes: await size("broken.mp4"),
      });
      const counts = (await readFile(join(root, "counts"), "utf8"))
        .trim()
        .split("\n")
        .map(Number);
      expect(counts).toHaveLength(21);
      expect(Math.max(...counts)).toBeGreaterThan(1);
      expect(Math.max(...counts)).toBeLessThanOrEqual(8);

      // ffprobe is stopped after 15 s and the file still lists with its size.
      process.env.HYPERFRAMES_FFPROBE_PATH = stalling;
      await copyFile(tone, join(assets, "stalled.wav"));
      expect(await list("stalled")).toEqual([
        {
          path: "assets/stalled.wav",
          kind: "audio",
          src: "assets/stalled.wav",
          bytes: await size("stalled.wav"),
        },
      ]);
    } finally {
      if (configured === undefined) delete process.env.HYPERFRAMES_FFPROBE_PATH;
      else process.env.HYPERFRAMES_FFPROBE_PATH = configured;
      await client.close();
      await runtime.dispose();
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  45_000,
);
