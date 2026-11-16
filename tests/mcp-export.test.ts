import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ExportJobSchema } from "../src/shared/export";
import { AGENT_HEADER } from "../src/shared/review";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { createMcpServer } from "../src/server/mcp/server";
import { projectFixture } from "./project-fixture";

async function fixture() {
  const project = await projectFixture();
  const editor = createHyperframesApi(project.store, project.review);
  project.app.route("/api", editor);
  const server = createMcpServer({
    fetch: (url, init) => project.app.request(url, init),
  });
  const client = new Client({ name: "export-test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  await client.connect(local);
  return {
    ...project,
    editor,
    client,
    async close() {
      await client.close();
      await server.close();
      await editor.dispose();
      await project.close();
    },
  };
}
const result = <T>(schema: z.ZodType<T>, value: unknown) => {
  const response = z.object({ isError: z.boolean().optional() }).parse(value);
  expect(response.isError, JSON.stringify(value)).not.toBe(true);
  return z
    .object({ structuredContent: z.object({ result: schema }) })
    .parse(value).structuredContent.result;
};
const Started = z.object({ jobId: z.string(), outputPath: z.string() });

// Start the real job, inspect the admitted request, then cancel before expensive capture.
test("MCP exports share dialog defaults, frame ranges, naming and cancel cleanup", async () => {
  const f = await fixture();
  try {
    const p = await f.store.create({
      name: "MCP cut",
      duration: 2,
      width: 320,
      height: 240,
    });
    const directory = join(p.path, ".cutroom/renders");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "MCP cut.mp4"), "existing export");
    const cases = [
      {
        marks: { in: 10, out: 31 },
        range: undefined,
        expected: { start: 10, end: 31 },
      },
      { marks: { in: 10, out: null }, range: undefined, expected: null },
      { marks: { in: null, out: 31 }, range: undefined, expected: null },
      { marks: { in: 10, out: 31 }, range: "timeline", expected: null },
      {
        marks: { in: 10, out: 31 },
        range: "marks",
        expected: { start: 10, end: 31 },
      },
      {
        marks: { in: null, out: null },
        range: { start: 3, end: 8 },
        expected: { start: 3, end: 8 },
      },
    ];
    for (const c of cases) {
      const document = await f.store.document(p);
      await f.store.writeDocument(
        p,
        Object.assign(document, {
          timelines: {
            "index.html": {
              tracks: [],
              markers: [],
              range: {
                in: c.marks.in === null ? null : c.marks.in / 30,
                out: c.marks.out === null ? null : c.marks.out / 30,
              },
            },
          },
        }),
      );
      const started = result(
        Started,
        await f.client.callTool({
          name: "export_start",
          arguments: { projectId: p.id, range: c.range },
        }),
      );
      expect(started.outputPath).toBe(join(directory, "MCP cut 2.mp4"));
      const status = result(
        ExportJobSchema,
        await f.client.callTool({
          name: "export_status",
          arguments: { jobId: started.jobId },
        }),
      );
      expect(status.range).toEqual(c.expected);
      expect(status.quality).toBe("standard");
      expect(status.fps).toEqual({ num: 30, den: 1 });
      expect(status.estimate).toBeNull();
      const active: unknown = await (
        await f.app.request("/api/export-jobs")
      ).json();
      expect(
        z
          .object({ jobs: z.array(ExportJobSchema) })
          .parse(active)
          .jobs.map((j) => j.jobId),
      ).toContain(started.jobId);
      const cancelled = result(
        z.object({ status: z.literal("cancelled") }),
        await f.client.callTool({
          name: "export_cancel",
          arguments: { jobId: started.jobId },
        }),
      );
      expect(cancelled.status).toBe("cancelled");
      const final = result(
        ExportJobSchema,
        await f.client.callTool({
          name: "export_status",
          arguments: { jobId: started.jobId },
        }),
      );
      expect(final.status).toBe("cancelled");
      expect(final.finishedAt).toBeNumber();
      expect(await readdir(directory)).toEqual(["MCP cut.mp4"]);
    }
  } finally {
    await f.close();
  }
});

// An agent chooses the same format, size and rate the dialog offers; marks follow the export's rate.
test("MCP exports choose a format, a supersampled size and a frame rate", async () => {
  const f = await fixture();
  try {
    const p = await f.store.create({
      name: "Overlay",
      duration: 2,
      width: 640,
      height: 360,
    });
    const document = await f.store.document(p);
    await f.store.writeDocument(
      p,
      Object.assign(document, {
        timelines: {
          "index.html": {
            tracks: [],
            markers: [],
            range: { in: 10 / 30, out: 31 / 30 },
          },
        },
      }),
    );
    const directory = join(p.path, ".cutroom/renders");
    for (const c of [
      {
        input: { format: "mov", size: "4k", fps: 24 },
        filename: "Overlay.mov",
        size: { width: 3840, height: 2160 },
        fps: { num: 24, den: 1 },
        // 10 to 31 at 30 fps covers 0.333 s to 1.033 s: frames 8 to 24 at 24 fps.
        range: { start: 8, end: 25 },
      },
      {
        input: { format: "gif", fps: 60 },
        filename: "Overlay.gif",
        size: { width: 640, height: 360 },
        fps: { num: 30, den: 1 },
        range: { start: 10, end: 31 },
      },
      {
        input: { format: "webm", size: "1080p" },
        filename: "Overlay.webm",
        size: { width: 1920, height: 1080 },
        fps: { num: 30, den: 1 },
        range: { start: 10, end: 31 },
      },
    ] as const) {
      const started = result(
        Started,
        await f.client.callTool({
          name: "export_start",
          arguments: { projectId: p.id, ...c.input },
        }),
      );
      expect(started.outputPath).toBe(join(directory, c.filename));
      const status = result(
        ExportJobSchema,
        await f.client.callTool({
          name: "export_status",
          arguments: { jobId: started.jobId },
        }),
      );
      expect(status.format).toBe(c.input.format);
      expect(status.size).toEqual(c.size);
      expect(status.fps).toEqual(c.fps);
      expect(status.range).toEqual(c.range);
      await f.client.callTool({
        name: "export_cancel",
        arguments: { jobId: started.jobId },
      });
    }
    for (const [input, message] of [
      [
        { format: "mov", filename: "Overlay.mp4" },
        "Name a MOV export with .mov",
      ],
      [{ format: "mkv" }, "format"],
      [{ fps: 48 }, "fps"],
      // 0.467 s to 0.5 s holds no frame at 24 fps.
      [{ range: { start: 14, end: 15 }, fps: 24 }, "shorter than one frame"],
    ] as const) {
      const refused = await f.client.callTool({
        name: "export_start",
        arguments: { projectId: p.id, ...input },
      });
      expect(refused.isError, JSON.stringify(input)).toBe(true);
      expect(JSON.stringify(refused.content)).toContain(message);
    }
    // 4K is not a whole multiple of 1280 x 960, nor its shape.
    const square = await f.store.create({
      name: "Four three",
      duration: 1,
      width: 1280,
      height: 960,
    });
    const refused = await f.client.callTool({
      name: "export_start",
      arguments: { projectId: square.id, size: "4k" },
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain(
      "4K needs a 16:9, 9:16 or square composition",
    );
    expect(
      await (await f.app.request("/api/export-jobs")).json(),
    ).toMatchObject({ jobs: [] });
  } finally {
    await f.close();
  }
});

test("exports accept chosen presets and folders, refuse invalid destinations/ranges and expose errors", async () => {
  const f = await fixture();
  try {
    const p = await f.store.create({
      name: "Chosen",
      duration: 1,
      width: 320,
      height: 240,
    });
    const directory = join(f.directory, "chosen");
    await mkdir(directory);
    for (const quality of ["draft", "high"] as const) {
      const started = result(
        Started,
        await f.client.callTool({
          name: "export_start",
          arguments: {
            projectId: p.id,
            directory,
            filename: "chosen.mp4",
            quality,
          },
        }),
      );
      const status = result(
        ExportJobSchema,
        await f.client.callTool({
          name: "export_status",
          arguments: { jobId: started.jobId },
        }),
      );
      expect(status.outputPath).toBe(join(directory, "chosen.mp4"));
      expect(status.quality).toBe(quality);
      await f.client.callTool({
        name: "export_cancel",
        arguments: { jobId: started.jobId },
      });
    }
    const destination = join(directory, "taken.mp4");
    await writeFile(destination, "previous export");
    // An agent learns the name is taken before any job starts.
    const refused = await f.client.callTool({
      name: "export_start",
      arguments: { projectId: p.id, directory, filename: "taken.mp4" },
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain(
      `${destination} already exists`,
    );
    expect(JSON.stringify(refused.content)).toContain("taken 2.mp4");
    expect(
      await (await f.app.request("/api/export-jobs")).json(),
    ).toMatchObject({ jobs: [] });
    // A name taken after that check still never overwrites the file.
    const taken = Started.parse(
      await (
        await f.app.request(`/api/projects/${p.id}/export`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory, filename: "taken.mp4" }),
        })
      ).json(),
    );
    let failed = result(
      ExportJobSchema,
      await f.client.callTool({
        name: "export_status",
        arguments: { jobId: taken.jobId },
      }),
    );
    const deadline = Date.now() + 3000;
    while (failed.status === "rendering") {
      if (Date.now() > deadline)
        throw new Error("A taken output did not fail.");
      await Bun.sleep(10);
      failed = result(
        ExportJobSchema,
        await f.client.callTool({
          name: "export_status",
          arguments: { jobId: taken.jobId },
        }),
      );
    }
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("already there");
    expect(failed.sizeBytes).toBeNull();
    expect(await readFile(destination, "utf8")).toBe("previous export");
    for (const input of [
      { directory: "relative" },
      { filename: "../oops.mp4" },
      { quality: "unknown" },
      { range: "marks" },
      { range: { start: 20, end: 10 } },
      { range: { start: 0, end: 1000 } },
    ])
      expect(
        (
          await f.client.callTool({
            name: "export_start",
            arguments: { projectId: p.id, ...input },
          })
        ).isError,
      ).toBe(true);
    await mkdir(join(p.path, ".cutroom"), { recursive: true });
    const linked = await f.store.create({ name: "Linked" });
    await mkdir(join(linked.path, ".cutroom"), { recursive: true });
    await symlink(directory, join(linked.path, ".cutroom/renders"));
    expect(
      (
        await f.client.callTool({
          name: "export_start",
          arguments: { projectId: linked.id },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await f.client.callTool({
          name: "export_status",
          arguments: { jobId: "missing" },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await f.client.callTool({
          name: "export_cancel",
          arguments: { jobId: "missing" },
        })
      ).isError,
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test("native cancellation authorizes the job's project and owner-started jobs are visible over MCP", async () => {
  const f = await fixture();
  const own = await f.store.create({ name: "Own" });
  const other = await f.store.create({ name: "Other" });
  const turn = await f.review.beginTurn(own, {
    kind: "message",
    id: "turn",
    token: "native",
  });
  try {
    const response = await f.app.request(`/api/projects/${other.id}/render`, {
      method: "POST",
      body: JSON.stringify({ format: "mp4" }),
    });
    const { jobId } = z
      .object({ jobId: z.string() })
      .parse(await response.json());
    const status = result(
      ExportJobSchema,
      await f.client.callTool({ name: "export_status", arguments: { jobId } }),
    );
    expect(status.projectId).toBe(other.id);
    const refused = await f.app.request(`/api/render/${jobId}/cancel`, {
      method: "POST",
      headers: { [AGENT_HEADER]: "native" },
    });
    expect(refused.status).toBe(409);
    expect(
      result(
        ExportJobSchema,
        await f.client.callTool({
          name: "export_status",
          arguments: { jobId },
        }),
      ).status,
    ).toBe("rendering");
    const cancelled = await f.client.callTool({
      name: "export_cancel",
      arguments: { jobId },
    });
    expect(result(z.object({ status: z.string() }), cancelled).status).toBe(
      "cancelled",
    );
    const ownStart = await f.app.request(`/api/projects/${own.id}/export`, {
      method: "POST",
      headers: { [AGENT_HEADER]: "native" },
      body: "{}",
    });
    const ownJob = z.object({ jobId: z.string() }).parse(await ownStart.json());
    expect(
      (
        await f.app.request(`/api/render/${ownJob.jobId}/cancel`, {
          method: "POST",
          headers: { [AGENT_HEADER]: "native" },
        })
      ).status,
    ).toBe(200);
  } finally {
    await turn.end();
    await f.close();
  }
});

test("one active export refuses overlapping MCP and editor starts across projects", async () => {
  const f = await fixture();
  try {
    const alpha = await f.store.create({
      name: "Alpha",
      duration: 600,
      width: 320,
      height: 240,
    });
    const beta = await f.store.create({
      name: "Beta",
      width: 320,
      height: 240,
    });
    const running = result(
      Started,
      await f.client.callTool({
        name: "export_start",
        arguments: { projectId: alpha.id, filename: "Long.mp4" },
      }),
    );
    const [mcp, editor] = await Promise.all([
      f.client.callTool({
        name: "export_start",
        arguments: {
          projectId: beta.id,
          filename: "Short.mp4",
          range: { start: 0, end: 1 },
        },
      }),
      f.app.request(`/api/projects/${beta.id}/render`, {
        method: "POST",
        body: JSON.stringify({ format: "mp4" }),
      }),
    ]);
    expect(mcp.isError).toBe(true);
    expect(editor.status).toBe(409);
    const error = z
      .object({ error: z.string() })
      .parse(await editor.json()).error;
    for (const message of [JSON.stringify(mcp), error]) {
      expect(message).toContain("Alpha");
      expect(message).toContain("Long.mp4");
      expect(message).toContain(running.jobId);
      expect(message).toContain("wait");
      expect(message).toContain("export_cancel");
    }
    result(
      z.object({ status: z.literal("cancelled") }),
      await f.client.callTool({
        name: "export_cancel",
        arguments: { jobId: running.jobId },
      }),
    );
    result(
      Started,
      await f.client.callTool({
        name: "export_start",
        arguments: { projectId: beta.id },
      }),
    );
  } finally {
    await f.close();
  }
});

test.skipIf(!Bun.which("ffmpeg"))(
  "export_start renders one sub-composition at its own length, marks and name",
  async () => {
    const f = await fixture();
    try {
      const p = await f.store.create({
        name: "Scenes",
        duration: 2,
        width: 320,
        height: 240,
      });
      await mkdir(join(p.path, "compositions"));
      await writeFile(
        join(p.path, "compositions", "red.html"),
        `<template>
  <div id="red-root" data-composition-id="red" data-width="320" data-height="240" data-duration="1" style="position:absolute;inset:0;background:#ff0000">
    <div id="red-card" class="clip" data-start="0" data-duration="1" data-track-index="0"></div>
  </div>
</template>
`,
      );
      const index = join(p.path, "index.html");
      await writeFile(
        index,
        (await readFile(index, "utf8")).replace(
          /(<main[^>]*>)[\s\S]*<\/main>/,
          `$1<div id="red" class="clip" data-composition-id="red" data-composition-src="compositions/red.html" data-start="1" data-duration="1" data-track-index="0" data-width="320" data-height="240"></div></main>`,
        ),
      );
      const document = await f.store.document(p);
      await f.store.writeDocument(
        p,
        Object.assign(document, {
          timelines: {
            "compositions/red.html": {
              tracks: [],
              markers: [],
              range: { in: 3 / 30, out: 12 / 30 },
            },
          },
        }),
      );
      const start = (args: Record<string, unknown>) =>
        f.client.callTool({
          name: "export_start",
          arguments: {
            projectId: p.id,
            composition: "compositions/red.html",
            ...args,
          },
        });
      const status = async (jobId: string) =>
        result(
          ExportJobSchema,
          await f.client.callTool({
            name: "export_status",
            arguments: { jobId },
          }),
        );

      // The scene's own marks set the range, not the root's.
      const marked = result(Started, await start({}));
      expect((await status(marked.jobId)).range).toEqual({
        start: 3,
        end: 12,
      });
      await f.client.callTool({
        name: "export_cancel",
        arguments: { jobId: marked.jobId },
      });

      const whole = result(Started, await start({ range: "timeline" }));
      expect(whole.outputPath).toBe(
        join(p.path, ".cutroom/renders", "Scenes red.mp4"),
      );
      let job = await status(whole.jobId);
      expect(job.name).toBe("Scenes red");
      for (const deadline = Date.now() + 120_000; job.status === "rendering";) {
        if (Date.now() > deadline) throw new Error("The export timed out.");
        await Bun.sleep(250);
        job = await status(whole.jobId);
      }
      expect(job.status, job.error ?? "").toBe("complete");
      const probe = Bun.spawnSync([
        "ffprobe",
        "-v",
        "error",
        "-count_frames",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=nb_read_frames",
        "-of",
        "csv=p=0",
        whole.outputPath,
      ]);
      // One second of the scene, not the root's two.
      expect(probe.stdout.toString().trim()).toBe("30");
      const pixel = Bun.spawnSync([
        "ffmpeg",
        "-v",
        "error",
        "-i",
        whole.outputPath,
        "-vf",
        "crop=2:2:160:120",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
      ]).stdout;
      // The scene's red fills its first frame, where the root shows nothing yet.
      expect(pixel[0]).toBeGreaterThan(200);
      expect(pixel[1]).toBeLessThan(60);
      expect(pixel[2]).toBeLessThan(60);
    } finally {
      await f.close();
    }
  },
  180_000,
);
