import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { ExportJobSchema } from "../src/shared/export";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";
import { seedLibrary } from "./library-fixture";

test.beforeAll(seedLibrary);

async function openProject(
  page: Page,
  request: APIRequestContext,
  name: string,
) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name, width: 640, height: 360, duration: 4 },
      })
    ).json(),
  );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".tl-lanes")).toBeVisible();
  const timeline = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    );
  return { project, timeline };
}

async function openLibraryItem(page: Page, title: string) {
  await page.keyboard.press("Control+6");
  const rows = page
    .getByRole("list", { name: "Library" })
    .locator(".media-row");
  await page.getByRole("searchbox", { name: "Search library" }).fill(title);
  await rows.filter({ hasText: title }).first().click();
  return rows.filter({ hasText: title }).first();
}

test("a library item plays live in the source viewer, and its marked part places with F9", async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { project, timeline } = await openProject(
    page,
    request,
    "Library preview",
  );
  const row = await openLibraryItem(page, "Lower Third, Fixture");

  const source = page.getByRole("group", { name: "Source" });
  await expect(source.locator(".edit-source-name")).toHaveText(
    "Lower Third, Fixture",
  );
  await expect(source.locator(".library-meta")).toHaveText(
    "A white card in the lower left",
  );
  await expect(row).toHaveAttribute("aria-current", "true");
  // The item plays in the preview sandbox, never in the editor's page.
  const frame = source.locator(".library-source iframe");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(
    page.frameLocator(".library-source iframe").locator(".lt-card"),
  ).toBeAttached();
  await page.screenshot({ path: testInfo.outputPath("source.png") });

  // Space plays it on the source's own playhead.
  await page.keyboard.press("Space");
  await expect
    .poll(async () =>
      page.evaluate(() =>
        Number(
          document
            .querySelector(".edit-transport")
            ?.textContent?.match(/00:00:00:(\d\d)/)?.[1] ?? 0,
        ),
      ),
    )
    .toBeGreaterThan(5);
  await page.keyboard.press("Space");
  await page.screenshot({ path: testInfo.outputPath("playing.png") });

  // Mark an Out on frame 30 and place the marked part, which includes that frame, with F9.
  await page.keyboard.press("Home");
  for (let step = 0; step < 30; step++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("o");
  await page.keyboard.press("F9");
  await expect
    .poll(
      async () =>
        (await timeline()).timeline.clips.find((clip) =>
          clip.src?.endsWith("lt-fixture.html"),
        )?.duration,
    )
    .toBe(31);
  // Placing returns the viewer to the timeline, with the clip there.
  await expect(source).toBeHidden();
  const placed = (await timeline()).timeline.clips.find((clip) =>
    clip.src?.endsWith("lt-fixture.html"),
  )!;
  await expect(
    page.locator(`.tl-lanes [data-clip="${placed.id}"]`),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("placed.png") });

  // Undo takes it back; redo brings it back for the export.
  await page.locator(".tl-lanes").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  await expect(
    page.locator(`.tl-lanes [data-clip="${placed.id}"]`),
  ).toHaveCount(0);
  await page.keyboard.press("Control+Shift+z");
  await expect(
    page.locator(`.tl-lanes [data-clip="${placed.id}"]`),
  ).toBeVisible();

  const agent = new Client({ name: "library-preview-proof", version: "1" });
  await agent.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { origin: new URL(baseURL!).origin } },
    }),
  );
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await agent.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      return z
        .object({ structuredContent: z.object({ result: z.unknown() }) })
        .parse(result).structuredContent.result;
    };
    const started = z
      .object({ jobId: z.string(), outputPath: z.string() })
      .parse(
        await call("export_start", {
          projectId: project.id,
          range: "timeline",
        }),
      );
    await expect
      .poll(
        async () =>
          ExportJobSchema.parse(
            await call("export_status", { jobId: started.jobId }),
          ).status,
        { timeout: 60_000, intervals: [500] },
      )
      .toBe("complete");
    const png = testInfo.outputPath("frame.png");
    await promisify(execFile)("ffmpeg", [
      "-v",
      "error",
      "-ss",
      "0.5",
      "-i",
      started.outputPath,
      "-frames:v",
      "1",
      "-y",
      png,
    ]);
    const { stdout } = await promisify(execFile)(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        png,
        "-vf",
        "crop=1:1:190:270",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
      ],
      { encoding: "buffer" },
    );
    expect(Math.min(...stdout)).toBeGreaterThan(230);
  } finally {
    await agent.close();
  }
  expect(errors).toEqual([]);
});

test("a transition dropped on a cut plays over both clips, centred on the track above", async ({
  page,
  request,
}) => {
  const { project, timeline } = await openProject(page, request, "Library cut");
  // Cut the background in two at 2 seconds.
  const view = await timeline();
  const cut = await request.post(
    `/api/cutroom/projects/${project.id}/commands`,
    {
      data: {
        expectedRevision: view.revision,
        commands: [{ type: "split", at: 60, clipIds: ["rule"] }],
      },
    },
  );
  expect(cut.ok(), await cut.text()).toBe(true);
  const lanes = page.locator(".tl-lanes");
  // The later piece starts at the cut.
  const second = (await timeline()).timeline.clips.find(
    (clip) => clip.track === 0 && clip.start === 60,
  )!;
  const later = page.locator(`.tl-lanes [data-clip="${second.id}"]`);
  await expect(later).toBeVisible();
  const edge = (await later.boundingBox())!;

  await page.keyboard.press("Control+6");
  await page
    .getByRole("searchbox", { name: "Search library" })
    .fill("Fixture Wipe");
  const row = page
    .getByRole("list", { name: "Library" })
    .locator(".media-row")
    .filter({ hasText: "Fixture Wipe" });
  const box = (await lanes.boundingBox())!;
  // 5px right of the cut, on the background's track.
  await row.dragTo(lanes, {
    targetPosition: {
      x: edge.x - box.x + 5,
      y: edge.y + edge.height / 2 - box.y,
    },
  });
  await expect
    .poll(async () =>
      (await timeline()).timeline.clips.find((clip) =>
        clip.src?.endsWith("tr-fixture.html"),
      ),
    )
    .toMatchObject({ start: 45, duration: 30, track: 1 });
});

test("a preview that cannot be built says so and closes the source", async ({
  page,
  request,
}) => {
  await page.route("**/api/cutroom/library/*/preview*", (route) =>
    route.fulfill({
      status: 502,
      json: { error: "Can't reach the HyperFrames library." },
    }),
  );
  await openProject(page, request, "Library preview failure");
  await openLibraryItem(page, "Lower Third, Fixture");
  await expect(page.locator(".toast")).toContainText(
    "Lower Third, Fixture could not be opened. Can't reach the HyperFrames library.",
  );
  await expect(page.getByRole("group", { name: "Source" })).toHaveCount(0);
});

test("@performance a library row's first frame shows within 500 ms from the cache", async ({
  page,
  request,
}, testInfo) => {
  await openProject(page, request, "Library preview timing");
  await page.keyboard.press("Control+6");
  await page
    .getByRole("searchbox", { name: "Search library" })
    .fill("Lower Third, Fixture");
  const row = page
    .getByRole("list", { name: "Library" })
    .locator(".media-row")
    .first();
  await expect(row).toBeVisible();
  const elapsed = await row.evaluate(
    (element) =>
      new Promise<number>((resolve) => {
        const start = performance.now();
        const done = () => {
          const frame = document.querySelector<HTMLIFrameElement>(
            ".library-source iframe",
          );
          if (!frame) return requestAnimationFrame(done);
          frame.addEventListener(
            "load",
            () =>
              requestAnimationFrame(() => resolve(performance.now() - start)),
            { once: true },
          );
        };
        (element as HTMLElement).click();
        done();
      }),
  );
  await testInfo.attach("row click to first frame", {
    body: `${Math.round(elapsed)} ms`,
    contentType: "text/plain",
  });
  console.log(`row click to first frame: ${Math.round(elapsed)} ms`);
  expect(elapsed).toBeLessThan(500);
});
