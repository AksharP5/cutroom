import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { ExportJobSchema } from "../src/shared/export";
import { LibraryAddedSchema } from "../src/shared/library";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";
import { seedLibrary } from "./library-fixture";

const result = <T>(schema: z.ZodType<T>, value: unknown) => {
  expect(
    z.object({ isError: z.boolean().optional() }).parse(value).isError,
    JSON.stringify(value),
  ).not.toBe(true);
  return z
    .object({ structuredContent: z.object({ result: schema }) })
    .parse(value).structuredContent.result;
};

test("a library block lands as one clip, undoes and redoes in the editor, and exports; agents add components", async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000);
  await seedLibrary();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Library proof", width: 640, height: 360, duration: 4 },
      })
    ).json(),
  );
  const projectApi = `/api/cutroom/projects/${project.id}`;
  const timeline = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${projectApi}/timeline`)).json(),
    );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".tl-lanes")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("before.png") });

  const response = await request.post(`${projectApi}/library`, {
    data: { name: "lt-fixture", track: 1, at: 15 },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const added = LibraryAddedSchema.parse(await response.json());
  expect(added).toMatchObject({
    composition: "compositions/lt-fixture.html",
    added: ["compositions/lt-fixture.html"],
  });
  const clip = page.locator(`.tl-lanes [data-clip="${added.clipId}"]`);
  await expect(clip).toBeVisible();
  await expect(clip).toHaveAttribute("title", "Lower Third, Fixture");
  await expect(clip).not.toHaveClass(/\boffline\b/);
  // The Inspector's Changes words it as an addition, for the audit trail.
  await expect(
    page.getByText("Added Lower Third, Fixture from the HyperFrames library"),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("added.png") });

  await page.locator(".tl-lanes").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  await expect(clip).toHaveCount(0);
  expect(
    (await timeline()).timeline.clips.map((item) => item.id),
  ).not.toContain(added.clipId);
  expect(
    (
      await request.get(
        `${projectApi}/source?path=compositions/lt-fixture.html`,
      )
    ).status(),
  ).toBe(404);
  await page.keyboard.press("Control+Shift+z");
  await expect(clip).toBeVisible();

  const agent = new Client({ name: "library-proof", version: "1" });
  await agent.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { origin: new URL(baseURL!).origin } },
    }),
  );
  try {
    const found = result(
      z.object({
        items: z.array(z.object({ name: z.string(), inProject: z.boolean() })),
      }),
      await agent.callTool({
        name: "library_search",
        arguments: { projectId: project.id, query: "lower third" },
      }),
    );
    expect(found.items).toEqual([
      expect.objectContaining({ name: "lt-fixture", inProject: true }),
    ]);
    const component = result(
      LibraryAddedSchema,
      await agent.callTool({
        name: "library_add",
        arguments: {
          projectId: project.id,
          name: "fx-fixture",
          track: 2,
          at: 0,
        },
      }),
    );
    expect(component.composition).toBe("compositions/fx-fixture.html");
    const componentClip = page.locator(
      `.tl-lanes [data-clip="${component.clipId}"]`,
    );
    await expect(componentClip).toBeVisible();
    // The new scene file reaches the editor's file list, so the clip never reads as offline.
    await expect(componentClip).not.toHaveClass(/\boffline\b/);
    await page.screenshot({ path: testInfo.outputPath("agent-added.png") });

    const Started = z.object({ jobId: z.string(), outputPath: z.string() });
    const started = result(
      Started,
      await agent.callTool({
        name: "export_start",
        arguments: { projectId: project.id, range: "timeline" },
      }),
    );
    const status = async () =>
      result(
        ExportJobSchema,
        await agent.callTool({
          name: "export_status",
          arguments: { jobId: started.jobId },
        }),
      );
    await expect
      .poll(async () => (await status()).status, {
        timeout: 60_000,
        intervals: [500],
      })
      .toBe("complete");
    // One second in, both items play: the block's white card and the component's red word.
    const frame = testInfo.outputPath("frame.png");
    await promisify(execFile)("ffmpeg", [
      "-v",
      "error",
      "-ss",
      "1",
      "-i",
      started.outputPath,
      "-frames:v",
      "1",
      "-y",
      frame,
    ]);
    const pixel = async (x: number, y: number) => [
      ...(
        await promisify(execFile)(
          "ffmpeg",
          [
            "-v",
            "error",
            "-i",
            frame,
            "-vf",
            `crop=1:1:${x}:${y}`,
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
          ],
          { encoding: "buffer" },
        )
      ).stdout,
    ];
    const card = await pixel(190, 270);
    expect(Math.min(...card)).toBeGreaterThan(230);
    await testInfo.attach("export frame", {
      path: frame,
      contentType: "image/png",
    });
  } finally {
    await agent.close();
  }
  expect(errors).toEqual([]);
});
