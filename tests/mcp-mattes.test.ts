import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createApp } from "../src/server/app";
import { createMcpHttpHandler } from "../src/server/mcp/server";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { createMatteRoutes } from "../src/server/matte/routes";
import { createMatteService } from "../src/server/matte/service";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { projectFixture } from "./project-fixture";

const tools = !!Bun.which("ffmpeg") && !!Bun.which("ffprobe");

test.skipIf(!tools)(
  "an agent removes a clip's background, polls matte_status until it is ready, and reads it back",
  async () => {
    const fixture = await projectFixture();
    const timeline = createTimelineRoutes(fixture.store, fixture.review);
    const cache = join(fixture.store.dataDir, "cache");
    const runtime = join(cache, "node_modules", "onnxruntime-node");
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "package.json"), "{}");
    await writeFile(join(cache, "weights.onnx"), "stub");
    const mattes = createMatteService({
      model: { weights: join(cache, "weights.onnx"), runtime: cache },
      segmenter: new URL("./fixtures/stub-segmenter.ts", import.meta.url),
    });
    fixture.app.route("/api/cutroom", timeline);
    fixture.app.route(
      "/api/cutroom",
      createMatteRoutes(fixture.store, timeline.timelineSnapshot, mattes),
    );
    const project = await fixture.store.create({ name: "Mattes" });
    const ffmpeg = Bun.spawn(
      [
        ...["ffmpeg", "-v", "error", "-y", "-f", "lavfi"],
        ...["-i", "color=red:s=64x64:r=30:d=3"],
        ...["-c:v", "libx264", "-pix_fmt", "yuv420p"],
        join(project.path, "talk.mp4"),
      ],
      { stderr: "pipe" },
    );
    expect(await ffmpeg.exited).toBe(0);
    await writeFile(
      join(project.path, "index.html"),
      '<main data-composition-id="main" data-duration="2" data-fps="30"><video id="talk" muted src="talk.mp4" data-start="0" data-duration="1" data-media-start="1" data-track-index="0"></video></main>',
    );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: createMcpHttpHandler({
        fetch: (url, init) => fixture.app.request(url, init),
      }),
    });
    const client = new Client({ name: "matte-test", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${server.port}/mcp`),
        ),
      );
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const answer = await client.callTool({
          name,
          arguments: { projectId: project.id, ...args },
        });
        expect(answer.isError, JSON.stringify(answer.content)).not.toBe(true);
        return z
          .object({ structuredContent: z.object({ result: z.unknown() }) })
          .parse(answer).structuredContent.result;
      };
      const before = TimelineViewSchema.parse(await call("timeline_read"));
      expect(before.timeline.clips[0]!.background).toBeNull();

      const edited = await call("timeline_edit", {
        expectedRevision: before.revision,
        commands: [
          {
            type: "setClip",
            clipId: "talk",
            background: { mode: "remove" },
          },
        ],
      });
      // The edit lands at once; its reply says where the job is.
      expect(edited).toMatchObject({
        background: {
          talk: {
            mode: "remove",
            state: expect.stringMatching(/^(waiting|running|ready)$/),
          },
        },
      });

      const ready = async () =>
        z
          .object({ clips: z.record(z.string(), z.unknown()) })
          .parse(await call("matte_status")).clips.talk;
      // Polled as an agent polls export_status.
      let state = await ready();
      for (
        let tries = 0;
        tries < 150 &&
        !z.object({ state: z.literal("ready") }).safeParse(state).success;
        tries++
      ) {
        await Bun.sleep(100);
        state = await ready();
      }
      expect(state).toEqual({
        mode: "remove",
        state: "ready",
        shrink: 1,
        soften: 1,
      });
      const after = await call("timeline_read");
      expect(after).toMatchObject({
        timeline: {
          clips: [
            {
              id: "talk",
              background: {
                mode: "remove",
                state: "ready",
                shrink: 1,
                soften: 1,
              },
            },
          ],
        },
      });
    } finally {
      await client.close();
      server.stop(true);
      await mattes.close();
      await fixture.close();
    }
  },
);

test("in the whole app, an agent's matte writes reach the matte routes rather than the agents' guard", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutroom-matte-agent-"));
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
  const client = new Client({ name: "matte-agent-test", version: "1" });
  try {
    const project = await runtime.projects.create({ name: "Matte agent" });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
      ),
    );
    const answer = await client.callTool({
      name: "matte_cancel",
      arguments: { projectId: project.id, jobId: "missing" },
    });
    // The agent guard answers 409 for routes mounted after it; the matte route answers 404.
    expect(JSON.stringify(answer.content)).toContain(
      "That matte job is not running.",
    );
  } finally {
    await client.close();
    await server.stop(true);
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
