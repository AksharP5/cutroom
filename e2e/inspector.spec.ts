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
  await inspector.locator(".inspector-history > summary").click();
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
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(agentRow).toHaveCount(0);
    await expect(
      inspector.getByRole("textbox", { name: "Opacity", exact: true }),
    ).toHaveValue("50%");
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(
      agentRow.getByRole("button", { name: "Accept", exact: true }),
    ).toBeVisible();
    await expect(agentRow).not.toContainText("Accepted");
    await expect(page.locator('[data-agent-change="picture"]')).toHaveCount(1);
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
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/render"),
  );
  const dialog = page.getByRole("dialog", { name: "Export", exact: true });
  await dialog.getByRole("button", { name: "Export MP4" }).click();
  const { jobId } = z
    .object({ jobId: z.string() })
    .parse(await (await started).json());
  await expect(dialog).toContainText("Export complete.", { timeout: 45_000 });
  const file = info.outputPath("inspector.mp4");
  const exported = await request.get(`/api/render/${jobId}/download`);
  expect(exported.ok()).toBeTruthy();
  await writeFile(file, await exported.body());
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

test("Changes stays bounded and fields, sections, selection and the drawer behave like the inspector", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: "Inspector finish",
          width: 640,
          height: 360,
          duration: 10,
        },
      })
    ).json(),
  );
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-fps="30" data-duration="10"><h1 id="opening-title" class="clip" data-start="0" data-duration="5" data-track-index="2">Opening</h1><div id="caption" class="clip" data-label="Caption" data-start="0" data-duration="5" data-track-index="1">Caption</div><div id="background" class="clip" data-label="Background" data-start="0" data-duration="10" data-track-index="0"></div></main></body></html>`,
  );
  const path = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${path}/timeline`)).json(),
    );
  for (let index = 1; index <= 15; index++) {
    const result = await request.post(`${path}/commands`, {
      headers: { "x-cutroom-agent": "external" },
      data: {
        expectedRevision: (await read()).revision,
        label: `Set opacity to ${index}%`,
        commands: [
          { type: "setClip", clipId: "opening-title", opacity: index / 100 },
        ],
      },
    });
    expect(result.ok()).toBe(true);
  }
  const edits = (await read()).clipEdits!;
  for (const edit of edits.slice(1))
    expect(
      (
        await request.post(`${path}/review/changes/accept`, {
          data: { editId: edit.id },
        })
      ).ok(),
    ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="opening-title"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.locator(".inspector-history")).not.toHaveAttribute(
    "open",
    "",
  );
  await inspector.locator(".inspector-history > summary").click();
  const rows = inspector.getByRole("listitem");
  await expect(inspector.locator(".inspector-clip strong")).toHaveText(
    "Opening title",
  );
  await expect(inspector.locator(".inspector-clip")).toContainText(
    "Text on V3",
  );
  await expect(
    inspector.getByRole("textbox", { name: "Speed", exact: true }),
  ).toHaveCount(0);
  await expect(
    inspector.getByRole("textbox", { name: "Source in", exact: true }),
  ).toHaveCount(0);
  await expect(inspector.locator(".inspector-timing")).toHaveAttribute(
    "open",
    "",
  );
  await expect(rows).toHaveCount(5);
  const pending = rows.filter({ hasText: "Set opacity to 1%" });
  await expect(
    pending.getByRole("button", { name: "Accept", exact: true }),
  ).toBeVisible();
  const title = await pending.locator(":scope > span").getAttribute("title");
  expect(title).toContain("Set opacity to 1%");
  expect(title).not.toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  expect(title).toMatch(/\d{1,2}:\d{2}/);
  await expect(pending.locator(".inspector-number")).toHaveText("1%");
  const fieldBounds = await inspector
    .getByRole("textbox", { name: "Duration", exact: true })
    .boundingBox();
  const panelBounds = await inspector.boundingBox();
  expect(fieldBounds!.y + fieldBounds!.height).toBeLessThan(
    panelBounds!.y + panelBounds!.height,
  );
  await page.screenshot({ path: info.outputPath("bounded-1440.png") });
  await inspector
    .getByRole("button", { name: "Show all (15)", exact: true })
    .click();
  await expect(rows).toHaveCount(15);
  await inspector
    .getByRole("button", { name: "Show less", exact: true })
    .click();
  await expect(rows).toHaveCount(5);
  const opacity = inspector.getByRole("textbox", {
    name: "Opacity",
    exact: true,
  });
  await opacity.focus();
  await opacity.press("ArrowUp");
  await expect(opacity).toHaveValue("16%");
  await opacity.press("Shift+ArrowDown");
  await expect(opacity).toHaveValue("6%");
  await opacity.press("Enter");
  await expect
    .poll(
      async () =>
        (await read()).timeline.clips.find(
          (clip) => clip.id === "opening-title",
        )?.opacity,
    )
    .toBe(0.06);
  await inspector
    .getByRole("button", { name: "Show all (16)", exact: true })
    .click();
  await expect(
    pending.getByRole("button", { name: "Accept", exact: true }),
  ).toBeVisible();
  await expect(pending).not.toContainText("Edited by you");
  await expect(pending).not.toContainText("Accepted");
  await inspector
    .getByRole("button", { name: "Show less", exact: true })
    .click();
  await opacity.fill("30%");
  await page.locator('[data-clip="caption"]').click();
  await expect
    .poll(
      async () =>
        (await read()).timeline.clips.find(
          (clip) => clip.id === "opening-title",
        )?.opacity,
    )
    .toBe(0.3);
  await page.locator('[data-clip="opening-title"]').click();
  await expect(opacity).toHaveValue("30%");
  await inspector
    .getByRole("button", { name: "Restore source opacity", exact: true })
    .click();
  await expect(opacity).toHaveValue("Auto");
  await expect(
    inspector.getByRole("button", { name: "Restore source opacity" }),
  ).toHaveCount(0);
  const autoRow = rows.filter({ hasText: "Set opacity to Auto" });
  await expect(autoRow).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(autoRow).toHaveCount(0);
  await expect(opacity).toHaveValue("30%");
  for (const name of ["Changes", "Composite", "Timing"])
    await inspector
      .locator("summary")
      .filter({ hasText: new RegExp(`^${name}(?:\\s*\\d+)?$`) })
      .click();
  await page.locator('[data-clip="caption"]').click();
  await expect(inspector.locator("details[open]")).toHaveCount(0);
  await page
    .locator('[data-clip="opening-title"]')
    .click({ modifiers: ["Control"] });
  await page
    .locator('[data-clip="background"]')
    .click({ modifiers: ["Control"] });
  await expect(inspector).toContainText("3 clips selected");
  await expect(opacity).toHaveCount(0);
  await page.locator('[data-clip="opening-title"]').click();
  for (const name of ["Changes", "Composite", "Timing"])
    await inspector
      .locator("summary")
      .filter({ hasText: new RegExp(`^${name}(?:\\s*\\d+)?$`) })
      .click();
  // A timeline drag and a typed Start both receive their labels from the same command path.
  await page.getByRole("button", { name: "Snapping", exact: true }).click();
  const clip = await page.locator('[data-clip="opening-title"]').boundingBox();
  const start = (await read()).timeline.clips.find(
    (clip) => clip.id === "opening-title",
  )!.start;
  await page.mouse.move(clip!.x + clip!.width / 2, clip!.y + clip!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    clip!.x + clip!.width / 2 + (clip!.width / 150) * 15,
    clip!.y + clip!.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        (await read()).timeline.clips.find(
          (clip) => clip.id === "opening-title",
        )!.start,
    )
    .toBe(start + 15);
  await expect(rows.filter({ hasText: "Moved 15 frames right" })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await inspector
    .locator("summary")
    .filter({ hasText: /^Changes/ })
    .focus();
  await page.keyboard.press("Escape");
  await expect(inspector).toHaveAttribute("data-open", "false");
  await expect(
    page.getByRole("button", { name: "Inspector", exact: true }),
  ).toBeFocused();
  const toggle = page.getByRole("button", { name: "Inspector", exact: true });
  // The usual drawer entry point leaves focus on its toolbar toggle.
  await toggle.click();
  await expect(inspector).toHaveAttribute("data-open", "true");
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(inspector).toHaveAttribute("data-open", "false");
  await expect(toggle).toBeFocused();
  await expect(inspector).toHaveCSS("opacity", "0");
  await expect(page.locator('[data-clip="opening-title"]')).toHaveClass(
    /selected/,
  );
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-clip="opening-title"]')).not.toHaveClass(
    /selected/,
  );
  await page.locator('[data-clip="opening-title"]').click();
  await toggle.click();
  await opacity.fill("70%");
  await opacity.press("Escape");
  await expect(opacity).toHaveValue("30%");
  await expect(inspector).toHaveAttribute("data-open", "true");
  await page.keyboard.press("Escape");
  await expect(inspector).toHaveAttribute("data-open", "false");
  await expect(toggle).toBeFocused();
});
