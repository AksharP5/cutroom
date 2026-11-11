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
        await f.app.request(`/api/projects/${p.id}/export-jobs`)
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
    const taken = result(
      Started,
      await f.client.callTool({
        name: "export_start",
        arguments: { projectId: p.id, directory, filename: "taken.mp4" },
      }),
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
