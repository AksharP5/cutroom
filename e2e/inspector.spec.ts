import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

const exec = promisify(execFile);

test("inspector commits, scrubs, cancels, accepts real MCP edits and exports the shown opacity", async ({
  page,
  request,
  baseURL,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Inspector proof", width: 320, height: 240, duration: 3 },
      })
    ).json(),
  );
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=red:s=100x100:r=30:d=4",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    join(project.path, "picture.mp4"),
  ]);
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0;background:blue}main{position:relative;width:320px;height:240px}video{position:absolute;left:30px;top:40px;width:100px;height:100px}</style></head><body><main id="main" data-composition-id="main" data-width="320" data-height="240" data-fps="30" data-duration="3"><video id="picture" class="clip" data-label="Picture" src="picture.mp4" muted data-start="0" data-duration="2" data-track-index="0"></video></main></body></html>`,
  );
  const path = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${path}/timeline`)).json(),
    );
  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="picture"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector).toContainText("Picture");
  await expect(inspector).toContainText("Video on V1");
  const set = async (label: string, value: string) => {
    await inspector
      .getByRole("textbox", { name: label, exact: true })
      .fill(value);
    await inspector
      .getByRole("textbox", { name: label, exact: true })
      .press("Enter");
  };
  await set("Start", "15f");
  await expect
    .poll(async () => (await read()).timeline.clips[0]?.start)
    .toBe(15);
  await set("Duration", "45f");
  await expect
    .poll(async () => (await read()).timeline.clips[0]?.duration)
    .toBe(45);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    inspector.getByRole("textbox", { name: "Duration", exact: true }),
  ).toHaveValue("00:00:02:00");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(
    inspector.getByRole("textbox", { name: "Duration", exact: true }),
  ).toHaveValue("00:00:01:15");
  await set("Source in", "1s");
  await set("Speed", "150%");
  await expect
    .poll(async () => (await read()).timeline.clips[0]?.playbackRate)
    .toBe(1.5);
  const beforeCancel = (await read()).revision;
  await inspector
    .getByRole("textbox", { name: "Start", exact: true })
    .fill("0");
  await inspector
    .getByRole("textbox", { name: "Start", exact: true })
    .press("Escape");
  await inspector
    .getByRole("textbox", { name: "Start", exact: true })
    .press("Tab");
  expect((await read()).revision).toBe(beforeCancel);
  await set("Source in", "4s");
  await expect(page.locator(".toast")).toContainText("end of its source");
  await expect
    .poll(async () => (await read()).timeline.clips[0]?.mediaStart)
    .toBe(1);
  await set("Opacity", "50%");
  await expect
    .poll(async () => (await read()).timeline.clips[0]?.opacity)
    .toBe(0.5);
  await expect(inspector.locator(".inspector-changes")).toContainText(
    "Set opacity to 50%",
  );
  await expect(inspector.locator(".inspector-changes")).toContainText(
    "Set speed to 150%",
  );
  // Enter hands the keyboard back to the editor.
  await expect(
    inspector.getByRole("textbox", { name: "Opacity", exact: true }),
  ).not.toBeFocused();
  await set("Opacity", "150%");
  await expect(page.locator(".toast")).toContainText(
    "Opacity must be between 0% and 100%.",
  );
  const startLabel = inspector.locator("label").filter({ hasText: /^Start$/ });
  const startBounds = await startLabel.boundingBox();
  if (!startBounds) throw new Error("Start label has no bounds");
  const beforeClick = (await read()).revision;
  await page.mouse.move(startBounds.x + 10, startBounds.y + 5);
  await page.mouse.down();
  await page.mouse.move(startBounds.x + 11, startBounds.y + 5);
  await page.mouse.up();
  await expect(
    inspector.getByRole("textbox", { name: "Start", exact: true }),
  ).toBeFocused();
  expect((await read()).revision).toBe(beforeClick);
  await page.keyboard.press("Escape");
  const opacityLabel = inspector
    .locator("label")
    .filter({ hasText: /^Opacity$/ });
  const bounds = await opacityLabel.boundingBox();
  if (!bounds) throw new Error("Opacity label has no bounds");
  await page.mouse.move(bounds.x + 10, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 20, bounds.y + bounds.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  await expect
    .poll(async () => (await read()).timeline.clips[0]?.opacity)
    .toBeCloseTo(0.6);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    inspector.getByRole("textbox", { name: "Opacity", exact: true }),
  ).toHaveValue("50%");
  await expect(inspector.locator('[data-by="human"]')).not.toHaveCount(0);

  const client = new Client({ name: "inspector-agent", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
        requestInit: { headers: { origin: baseURL! } },
      }),
    );
    const schema = z.object({
      structuredContent: z.object({ result: TimelineViewSchema }),
    });
    const view = schema.parse(
      await client.callTool({
        name: "timeline_read",
        arguments: { projectId: project.id },
      }),
    ).structuredContent.result;
    // Observe the frame that the timeline lands. Changes must already be in that same frame.
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        if (!document.querySelector('[data-agent-change="picture"]')) return;
        requestAnimationFrame(
          () =>
            (document.documentElement.dataset.ledgerInFrame = String(
              document
                .querySelector(".inspector-changes")
                ?.textContent?.includes("Agent opacity"),
            )),
        );
      });
      observer.observe(document.querySelector(".edit-page")!, {
        childList: true,
        subtree: true,
      });
    });
    const edited = schema.parse(
      await client.callTool({
        name: "timeline_edit",
        arguments: {
          projectId: project.id,
          expectedRevision: view.revision,
          label: "Agent opacity",
          commands: [{ type: "setClip", clipId: "picture", opacity: 0.4 }],
        },
      }),
    ).structuredContent.result;
    expect(edited.timeline.clips[0]?.opacity).toBe(0.4);
    await expect(
      inspector.getByRole("textbox", { name: "Opacity", exact: true }),
    ).toHaveValue("40%");
    await expect(page.locator("html")).toHaveAttribute(
      "data-ledger-in-frame",
      "true",
    );
    const agentRow = inspector
      .getByRole("listitem")
      .filter({ hasText: "Agent opacity" });
    await expect(
      agentRow.getByRole("button", { name: "Accept", exact: true }),
    ).toBeVisible();
    await agentRow.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(page.locator('[data-agent-change="picture"]')).toHaveCount(0);
    await expect(agentRow).toContainText("Accepted");
  } finally {
    await client.close();
  }

  // Editor shortcuts must stay inside the text field.
  await inspector
    .getByRole("textbox", { name: "Opacity", exact: true })
    .fill("");
  await inspector
    .getByRole("textbox", { name: "Opacity", exact: true })
    .pressSequentially("jkln");
  await inspector
    .getByRole("textbox", { name: "Opacity", exact: true })
    .press("Escape");
  await expect(
    page.getByRole("button", { name: "Play forward", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByRole("button", { name: "Select", exact: false }).first(),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Inspector", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await page.setViewportSize({ width: 1304, height: 900 });
  await expect
    .poll(() =>
      page
        .locator(".edit-tools")
        .evaluate((toolbar) => toolbar.scrollWidth <= toolbar.clientWidth),
    )
    .toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('[data-clip="picture"]').click();
  await expect(inspector).toBeVisible();
  const rect = await inspector.boundingBox();
  expect(rect?.width).toBe(300);
  await page.screenshot({ path: info.outputPath("drawer.png") });
  await page.keyboard.press("n");
  await expect(
    page.getByRole("button", { name: "Inspector", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", {
      name: "Current time. Click to type a time.",
      exact: true,
    })
    .click();
  await page
    .getByRole("textbox", { name: "Go to time", exact: true })
    .pressSequentially("00000100");
  await page
    .getByRole("textbox", { name: "Go to time", exact: true })
    .press("Enter");
  await expect(page.locator("iframe[data-live]")).toBeVisible();
  await expect(
    page.frameLocator("iframe[data-live]").locator("#picture"),
  ).toHaveCSS("opacity", "0.4");
  const previewBounds = await page.locator("iframe[data-live]").boundingBox();
  if (!previewBounds) throw new Error("The preview has no bounds");
  const previewPixel = info.outputPath("preview-pixel.png");
  await page.screenshot({
    path: previewPixel,
    clip: {
      x: previewBounds.x + (70 * previewBounds.width) / 320,
      y: previewBounds.y + (80 * previewBounds.height) / 240,
      width: 1,
      height: 1,
    },
  });
  await page.screenshot({ path: info.outputPath("preview.png") });
  const download = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const file = info.outputPath("inspector.mp4");
  await (await download).saveAs(file);
  const { stdout } = await exec(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      "1",
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      "crop=1:1:70:80,format=rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { encoding: "buffer" },
  );
  const preview = await exec(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      previewPixel,
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { encoding: "buffer" },
  );
  for (let channel = 0; channel < 3; channel++)
    expect(Math.abs(stdout[channel]! - preview.stdout[channel]!)).toBeLessThan(
      10,
    );
  // 40% red over blue, allowing H.264's colour conversion.
  expect(stdout[0]).toBeGreaterThan(85);
  expect(stdout[0]).toBeLessThan(120);
  expect(stdout[1]).toBeLessThan(15);
  expect(stdout[2]).toBeGreaterThan(135);
  expect(stdout[2]).toBeLessThan(170);
  expect(await readFile(file)).not.toHaveLength(0);
  expect(errors).toEqual([]);
});

test("the inspector starts closed where it would cover the stage", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Drawer default", width: 320, height: 240, duration: 3 },
      })
    ).json(),
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("#clip-inspector")).toHaveAttribute(
    "data-open",
    "false",
  );
});
