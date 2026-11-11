import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { ExportJobSchema } from "../src/shared/export";
import { ProjectSchema, SourceSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

const result = <T>(schema: z.ZodType<T>, value: unknown) => {
  expect(
    z.object({ isError: z.boolean().optional() }).parse(value).isError,
    JSON.stringify(value),
  ).not.toBe(true);
  return z
    .object({ structuredContent: z.object({ result: schema }) })
    .parse(value).structuredContent.result;
};
const Started = z.object({ jobId: z.string(), outputPath: z.string() });
const source = (duration: number) =>
  `<!doctype html><html><head><style>html,body{margin:0;background:#17222b}main{position:relative;width:320px;height:240px}.clip{position:absolute;inset:0;background:#ed9a72}</style></head><body><main data-composition-id="main" data-width="320" data-height="240" data-fps="30" data-duration="${duration}"><div id="picture" class="clip" data-start="0" data-duration="${duration}" data-track-index="0">MCP export</div></main></body></html>`;

test("stdio and HTTP MCP export marked and whole timelines, share the indicator, and cancel mid-capture", async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: "MCP export proof",
          width: 320,
          height: 240,
          duration: 2,
        },
      })
    ).json(),
  );
  const writeSource = async (duration: number) => {
    const read = SourceSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/source`)
      ).json(),
    );
    expect(
      (
        await request.put(`/api/cutroom/projects/${project.id}/source`, {
          data: {
            path: "index.html",
            expectedVersion: read.version,
            content: source(duration),
          },
        })
      ).ok(),
    ).toBe(true);
  };
  await writeSource(2);
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator('[data-clip="picture"]')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("before.png") });
  const clients = [
    new Client({ name: "stdio-export-proof", version: "1" }),
    new Client({ name: "http-export-proof", version: "1" }),
  ];
  try {
    await clients[0].connect(
      new StdioClientTransport({
        command: "bun",
        args: [
          fileURLToPath(new URL("../src/server/mcp/stdio.ts", import.meta.url)),
        ],
        env: {
          PATH: process.env.PATH ?? "",
          CUTROOM_URL: baseURL!,
          TMPDIR: process.env.TMPDIR ?? "/tmp",
        },
      }),
    );
    await clients[1].connect(
      new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
        requestInit: { headers: { origin: new URL(baseURL!).origin } },
      }),
    );
    const status = async (client: Client, jobId: string) =>
      result(
        ExportJobSchema,
        await client.callTool({ name: "export_status", arguments: { jobId } }),
      );
    const view = result(
      TimelineViewSchema,
      await clients[0].callTool({
        name: "timeline_read",
        arguments: { projectId: project.id },
      }),
    );
    result(
      TimelineViewSchema,
      await clients[0].callTool({
        name: "timeline_edit",
        arguments: {
          projectId: project.id,
          expectedRevision: view.revision,
          commands: [{ type: "setRange", in: 15, out: 45 }],
        },
      }),
    );
    const probes = [];
    for (const [transport, client] of [
      ["stdio", clients[0]],
      ["http", clients[1]],
    ] as const) {
      for (const range of ["marks", "timeline"] as const) {
        const started = result(
          Started,
          await client.callTool({
            name: "export_start",
            arguments: {
              projectId: project.id,
              ...(range === "timeline" ? { range } : {}),
            },
          }),
        );
        await expect(
          page.getByRole("button", { name: /^Exporting/ }),
        ).toBeVisible();
        if (transport === "stdio" && range === "marks") {
          await page.getByRole("button", { name: /^Exporting/ }).click();
          await expect(page.getByRole("dialog")).toContainText(
            started.outputPath,
          );
          await page.screenshot({
            path: testInfo.outputPath("agent-export.png"),
          });
          await page.getByRole("button", { name: "Hide", exact: true }).click();
        }
        await expect
          .poll(async () => (await status(client, started.jobId)).status, {
            timeout: 40_000,
            intervals: [250, 500],
          })
          .toBe("complete");
        const done = await status(client, started.jobId);
        expect(done.error).toBeNull();
        expect(done.sizeBytes).toBe((await stat(done.outputPath)).size);
        const probe = JSON.parse(
          (
            await promisify(execFile)("ffprobe", [
              "-v",
              "error",
              "-select_streams",
              "v:0",
              "-show_entries",
              "stream=width,height,nb_frames,r_frame_rate,duration",
              "-of",
              "json",
              done.outputPath,
            ])
          ).stdout,
        );
        const video = z
          .object({
            streams: z.array(
              z.object({
                width: z.number(),
                height: z.number(),
                nb_frames: z.string(),
                r_frame_rate: z.string(),
                duration: z.string(),
              }),
            ),
          })
          .parse(probe).streams[0];
        expect(video).toMatchObject({
          width: 320,
          height: 240,
          nb_frames: range === "marks" ? "30" : "60",
          r_frame_rate: "30/1",
        });
        probes.push({ transport, range, ...video, sizeBytes: done.sizeBytes });
      }
    }
    // The owner's dialog starts a job that MCP can inspect and cancel after real capture begins.
    await writeSource(60);
    await page
      .getByRole("button", { name: "Export complete", exact: true })
      .click();
    await page.getByRole("button", { name: "New export", exact: true }).click();
    const startResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/render"),
    );
    await page
      .getByRole("radio", { name: "Whole timeline", exact: true })
      .check();
    await page.getByRole("button", { name: "Export MP4", exact: true }).click();
    const ownerJob = Started.parse(await (await startResponse).json());
    await expect
      .poll(
        async () => {
          const job = await status(clients[1], ownerJob.jobId);
          return (
            job.stageProgress?.code === "capture" &&
            (job.stageProgress.done ?? 0) >= 3
          );
        },
        { timeout: 40_000, intervals: [100] },
      )
      .toBe(true);
    expect(
      result(
        z.object({ status: z.string() }),
        await clients[1].callTool({
          name: "export_cancel",
          arguments: { jobId: ownerJob.jobId },
        }),
      ).status,
    ).toBe("cancelled");
    expect((await status(clients[0], ownerJob.jobId)).status).toBe("cancelled");
    await expect(page.getByRole("dialog")).toContainText(
      "Export cancelled. Partial output removed.",
    );
    expect(existsSync(ownerJob.outputPath)).toBe(false);
    expect(
      (await readdir(dirname(ownerJob.outputPath))).filter((name) =>
        name.startsWith(".cutroom-render-"),
      ),
    ).toEqual([]);
    await testInfo.attach("ffprobe results", {
      body: JSON.stringify(probes, null, 2),
      contentType: "application/json",
    });
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
});

test("switching projects keeps export cancellation live and allows the next editor export", async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const alpha = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Export Alpha", duration: 600, width: 320, height: 240 },
      })
    ).json(),
  );
  const beta = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Export Beta", duration: 2, width: 320, height: 240 },
      })
    ).json(),
  );
  const client = new Client({ name: "switch-export-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
        requestInit: { headers: { origin: new URL(baseURL!).origin } },
      }),
    );
    await page.goto(`/#project/${alpha.id}`);
    await expect(page.locator("iframe[data-live]")).toHaveCount(1);
    const started = result(
      Started,
      await client.callTool({
        name: "export_start",
        arguments: { projectId: alpha.id },
      }),
    );
    await page.getByRole("button", { name: /^Exporting/ }).click();
    await expect(page.getByRole("dialog")).toContainText(started.outputPath);
    await page.getByRole("button", { name: "Hide", exact: true }).click();
    await page.evaluate((id) => {
      location.hash = `project/${id}`;
    }, beta.id);
    await expect(page.locator(".project-switcher")).toHaveText(beta.name);
    await expect(page.locator("iframe[data-live]")).toHaveCount(1);
    result(
      z.object({ status: z.literal("cancelled") }),
      await client.callTool({
        name: "export_cancel",
        arguments: { jobId: started.jobId },
      }),
    );
    await expect(page.locator(".export-indicator")).toHaveText("Export");
    await page.locator(".export-indicator").click();
    await expect(page.getByRole("dialog")).toContainText(
      "Export cancelled. Partial output removed.",
    );
    await page.screenshot({
      path: testInfo.outputPath("switched-export-cancelled.png"),
    });
    await page.getByRole("button", { name: "New export", exact: true }).click();
    const response = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/projects/${beta.id}/render`),
    );
    await page.getByRole("button", { name: "Export MP4", exact: true }).click();
    const next = Started.parse(await (await response).json());
    await page
      .getByRole("button", { name: "Cancel export", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText(
      "Export cancelled. Partial output removed.",
    );
    expect(
      result(
        ExportJobSchema,
        await client.callTool({
          name: "export_status",
          arguments: { jobId: next.jobId },
        }),
      ).status,
    ).toBe("cancelled");
  } finally {
    await client.close();
  }
});

test("a reload in another project finds the running export and can cancel it", async ({
  page,
  request,
  baseURL,
}) => {
  const [alpha, beta] = await Promise.all(
    ["Reload Alpha", "Reload Beta"].map(async (name, index) =>
      ProjectSchema.parse(
        await (
          await request.post("/api/cutroom/projects", {
            data: { name, duration: index ? 2 : 600, width: 320, height: 240 },
          })
        ).json(),
      ),
    ),
  );
  const client = new Client({ name: "reload-export-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
        requestInit: { headers: { origin: new URL(baseURL!).origin } },
      }),
    );
    await page.goto(`/#project/${beta.id}`);
    await expect(page.locator("iframe[data-live]")).toHaveCount(1);
    const started = result(
      Started,
      await client.callTool({
        name: "export_start",
        arguments: { projectId: alpha.id },
      }),
    );
    await page.reload();
    await expect(page.locator(".project-switcher")).toHaveText(beta.name);
    await expect(page.locator(".export-indicator")).toHaveText(/^Exporting/);
    await page.locator(".export-indicator").click();
    await expect(page.getByRole("dialog")).toContainText(alpha.name);
    await expect(page.getByRole("dialog")).toContainText(started.outputPath);
    await page
      .getByRole("button", { name: "Cancel export", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText(
      "Export cancelled. Partial output removed.",
    );
    expect(
      result(
        ExportJobSchema,
        await client.callTool({
          name: "export_status",
          arguments: { jobId: started.jobId },
        }),
      ).status,
    ).toBe("cancelled");
  } finally {
    await client.close();
  }
});
