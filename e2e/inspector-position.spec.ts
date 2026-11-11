import { execFile } from "node:child_process";
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

const exec = promisify(execFile);

/** Find the actual coloured subject in a decoded frame, including its full pixel extent. */
function subjects(pixels: Buffer) {
  return ["red", "green"].map((color) => {
    let left = 320,
      top = 240,
      right = -1,
      bottom = -1;
    for (let y = 0; y < 240; y++)
      for (let x = 0; x < 320; x++) {
        const i = (y * 320 + x) * 3;
        const [r, g, b] = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
        const match =
          color === "red"
            ? r > 180 && g < 60 && b < 60
            : g > 180 && r < 70 && b < 70;
        if (!match) continue;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    if (right < 0) throw new Error(`No ${color} subject found`);
    return { left, top, right, bottom };
  });
}

test("position fields and MCP preserve animated offsets through playback, repeated seeks and export", async ({
  page,
  request,
  baseURL,
}, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Position proof", width: 320, height: 240, duration: 2 },
      })
    ).json(),
  );
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=red:s=64x48:r=30:d=2",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    join(project.path, "picture.mp4"),
  ]);
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    join(project.path, "sound.wav"),
  ]);
  await copyFile(
    join(process.cwd(), "node_modules/gsap/dist/gsap.min.js"),
    join(project.path, "gsap.min.js"),
  );
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0;background:#142039}main{position:relative;width:100%;height:100%}video{position:absolute;left:20px;top:30px;width:64px;height:48px;transform:translate(8px,4px)}#title{position:absolute;left:140px;top:145px;width:90px;height:32px;margin:0;background:lime;color:white;font:20px sans-serif}</style><script src="gsap.min.js"></script></head><body><main id="main" data-composition-id="main" data-width="320" data-height="240" data-fps="30" data-duration="2"><video id="picture" class="clip" data-label="Picture" src="picture.mp4" muted data-link="pair" data-x="12.25" data-y="-7.5" data-start="0" data-duration="2" data-track-index="0"></video><audio id="sound" src="sound.wav" data-link="pair" data-start="0" data-duration="2" data-track-index="2"></audio><p id="title" class="clip" data-label="Title" data-start="0" data-duration="2" data-track-index="1">Position</p></main><script>window.__timelines.main = gsap.timeline({paused:true}).fromTo('#title',{color:'#00ff00'},{color:'#ffffff',duration:1,ease:'none'},0);</script></body></html>`,
  );
  const path = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${path}/timeline`)).json(),
    );
  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="picture"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const field = (name: string) =>
    inspector.getByRole("textbox", { name, exact: true });
  const painted = async <T>(action: () => Promise<T>): Promise<T> => {
    const stage = page.locator(".edit-stage[data-preview-ready]");
    await expect(stage).toBeVisible();
    const before = await stage.getAttribute("data-preview-ready");
    const result = await action();
    await expect(stage).not.toHaveAttribute("data-preview-ready", before!);
    await expect(stage).toBeVisible();
    return result;
  };
  const undo = () =>
    painted(() =>
      page.getByRole("button", { name: "Undo", exact: true }).click(),
    );
  const set = async (name: string, value: string) => {
    await field(name).fill(value);
    await painted(() => field(name).press("Enter"));
  };
  await expect(field("Position X")).toHaveValue("0 px");
  await set("Position X", "-12.5 px");
  await expect
    .poll(
      async () =>
        (await read()).timeline.clips.find((c) => c.id === "picture")?.x,
    )
    .toBe(-12.5);
  await field("Position X").focus();
  await page.keyboard.down("ArrowUp");
  await page.keyboard.down("Shift");
  await page.keyboard.down("ArrowUp");
  await page.keyboard.up("Shift");
  await painted(() => page.keyboard.up("ArrowUp"));
  await field("Position X").press("Enter");
  await expect(field("Position X")).toHaveValue("-1.5 px");
  await undo();
  await expect(field("Position X")).toHaveValue("-12.5 px");
  const revision = (await read()).revision;
  await field("Position X").fill("99");
  await field("Position X").press("Escape");
  expect((await read()).revision).toBe(revision);
  const label = inspector.locator("label").filter({ hasText: /^Position X$/ });
  const bounds = await label.boundingBox();
  if (!bounds) throw new Error("Position label missing");
  await page.mouse.move(bounds.x + 10, bounds.y + 5);
  await page.mouse.down();
  await page.keyboard.down("Shift");
  await page.mouse.move(bounds.x + 15, bounds.y + 5);
  await expect
    .poll(() =>
      page
        .frameLocator("iframe[data-live]")
        .locator("canvas[data-cutroom-video-hold]")
        .evaluate((el) => el.getBoundingClientRect().left),
    )
    .toBe(65.5);
  await page.screenshot({
    path: info.outputPath("live-video-scrub.png"),
    caret: "initial",
  });
  await page.keyboard.up("Shift");
  await painted(() => page.mouse.up());
  await expect(field("Position X")).toHaveValue("37.5 px");
  await undo();
  await expect(field("Position X")).toHaveValue("-12.5 px");
  await painted(() =>
    inspector.getByRole("button", { name: "Reset position" }).click(),
  );
  await expect(field("Position X")).toHaveValue("0 px");
  await expect
    .poll(
      async () =>
        (await read()).timeline.clips.find((c) => c.id === "picture")?.x,
    )
    .toBeNull();

  const seek = async (frame: number, offset = 0) => {
    await page
      .getByRole("button", {
        name: "Current time. Click to type a time.",
        exact: true,
      })
      .click();
    await page
      .getByRole("textbox", { name: "Go to time", exact: true })
      .pressSequentially(
        String(Math.floor(frame / 30) * 100 + (frame % 30)).padStart(8, "0"),
      );
    await page
      .getByRole("textbox", { name: "Go to time", exact: true })
      .press("Enter");
    await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
    await expect(page.locator("iframe[data-live]")).toBeVisible();
    await expect
      .poll(async () =>
        page
          .frameLocator("iframe[data-live]")
          .locator("#title")
          .evaluate((el) => el.getBoundingClientRect().left),
      )
      .toBeCloseTo(140 + offset, 0);
  };
  // Capture authored CSS and colour animation before adding offsets.
  const baseline = new Map<number, ReturnType<typeof subjects>>();
  const screenshot = async (name: string) => {
    await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
    const file = info.outputPath(name);
    await page.locator("iframe[data-live]").screenshot({ path: file });
    const { stdout } = await exec(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        file,
        "-vf",
        "scale=320:240",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { encoding: "buffer" },
    );
    return subjects(stdout);
  };
  for (const frame of [3, 15, 45]) {
    await seek(frame);
    baseline.set(frame, await screenshot(`baseline-${frame}.png`));
  }
  await page.screenshot({ path: info.outputPath("before-position.png") });

  const client = new Client({ name: "position-agent", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
        requestInit: { headers: { origin: baseURL! } },
      }),
    );
    const resultSchema = z.object({
      structuredContent: z.object({ result: TimelineViewSchema }),
    });
    const view = resultSchema.parse(
      await client.callTool({
        name: "timeline_read",
        arguments: { projectId: project.id },
      }),
    ).structuredContent.result;
    const moved = await painted(
      async () =>
        resultSchema.parse(
          await client.callTool({
            name: "timeline_edit",
            arguments: {
              projectId: project.id,
              expectedRevision: view.revision,
              commands: [
                { type: "setClip", clipId: "picture", x: 40, y: -10 },
                { type: "setClip", clipId: "title", x: 40, y: -10 },
              ],
            },
          }),
        ).structuredContent.result,
    );
    expect(moved.timeline.clips.find((c) => c.id === "sound")).toMatchObject({
      x: null,
      y: null,
    });
    const row = inspector
      .getByRole("listitem")
      .filter({ hasText: "Moved 40 px right; Moved 10 px up" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(row).toContainText("Accepted");
    await expect(field("Position X")).toHaveValue("40 px");
    // Clearing only X must retain Y without turning either authored baseline into an offset.
    await set("Position X", "0");
    await expect
      .poll(() =>
        page
          .frameLocator("iframe[data-live]")
          .locator("#picture")
          .evaluate((el) => el.getBoundingClientRect().left)
          .catch(() => NaN),
      )
      .toBe(28);
    await expect
      .poll(() =>
        page
          .frameLocator("iframe[data-live]")
          .locator("#picture")
          .evaluate((el) => el.getBoundingClientRect().top)
          .catch(() => NaN),
      )
      .toBe(24);
    await undo();
    await expect(field("Position X")).toHaveValue("40 px");
    await page.locator('[data-clip="sound"]').click({ modifiers: ["Alt"] });
    await expect(inspector.getByText("Transform", { exact: true })).toHaveCount(
      0,
    );
    await page.locator('[data-clip="title"]').click();
    await expect(field("Position X")).toHaveValue("40 px");
    await expect(inspector.getByText("Scale", { exact: true })).toHaveCount(0);
    await expect(inspector.getByText("Rotation", { exact: true })).toHaveCount(
      0,
    );
    // Play from within the colour animation while retaining the offset.
    await seek(3, 40);
    await page
      .getByRole("button", { name: "Play forward", exact: true })
      .click();
    await expect
      .poll(() =>
        page
          .frameLocator("iframe[data-live]")
          .locator("#title")
          .evaluate((el) => el.getBoundingClientRect().left),
      )
      .toBeGreaterThan(165);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    const preview = new Map<number, ReturnType<typeof subjects>>();
    for (const frame of [45, 3, 15, 45, 3]) {
      await seek(frame, 40);
      const positions = await screenshot(`preview-${frame}.png`);
      preview.set(frame, positions);
      for (let i = 0; i < 2; i++) {
        expect(positions[i]!.left - baseline.get(frame)![i]!.left).toBeCloseTo(
          40,
          0,
        );
        expect(positions[i]!.top - baseline.get(frame)![i]!.top).toBeCloseTo(
          -10,
          0,
        );
      }
    }
    await page.screenshot({ path: info.outputPath("after-position.png") });
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const started = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/render"),
    );
    const dialog = page.getByRole("dialog", { name: "Export", exact: true });
    await dialog.getByRole("button", { name: "Export MP4" }).click();
    const { jobId } = z
      .object({ jobId: z.string() })
      .parse(await (await started).json());
    await expect(dialog).toContainText("Export complete.", { timeout: 90_000 });
    const file = info.outputPath("position.mp4");
    await writeFile(
      file,
      await (await request.get(`/api/render/${jobId}/download`)).body(),
    );
    const comparisons = [];
    for (const frame of [3, 15, 45]) {
      const { stdout } = await exec(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          file,
          "-vf",
          `select=eq(n\\,${frame})`,
          "-frames:v",
          "1",
          "-pix_fmt",
          "rgb24",
          "-f",
          "rawvideo",
          "pipe:1",
        ],
        { encoding: "buffer" },
      );
      const exported = subjects(stdout);
      for (let i = 0; i < 2; i++)
        for (const edge of ["left", "top", "right", "bottom"] as const)
          expect(
            Math.abs(exported[i]![edge] - preview.get(frame)![i]![edge]),
          ).toBeLessThanOrEqual(1);
      comparisons.push({ frame, preview: preview.get(frame), exported });
    }
    await writeFile(
      info.outputPath("positions.json"),
      JSON.stringify(comparisons, null, 2),
    );
    expect(errors).toEqual([]);
  } finally {
    await client.close();
  }
});
