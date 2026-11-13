import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "./fixtures";
import type { APIRequestContext, Download, Page } from "@playwright/test";
import { z } from "zod";
import { ProjectSchema, SourceSchema } from "../src/shared/project";
import { embeddedEditor } from "./embedded";

/** A one-second 320x240 composition with one picture clip, and the page's uncaught errors. */
async function exportable(page: Page, request: APIRequestContext) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/cutroom/agents/capabilities?**", (route) =>
    route.fulfill({
      json: {
        provider: "codex",
        available: true,
        skills: [],
        models: [],
        mcpServers: [],
      },
    }),
  );

  const created = await request.post("/api/cutroom/projects", {
    data: {
      name: "Export proof",
      width: 320,
      height: 240,
      duration: 1,
    },
  });
  expect(created.status()).toBe(201);
  const project = ProjectSchema.parse(await created.json());
  const source = SourceSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${project.id}/source`)
    ).json(),
  );
  const written = await request.put(
    `/api/cutroom/projects/${project.id}/source`,
    {
      data: {
        path: "index.html",
        expectedVersion: source.version,
        content:
          '<!doctype html><html><head><meta charset="UTF-8"><style>html,body{margin:0;background:#17222b}main{position:relative;width:320px;height:240px}.clip{position:absolute;inset:0;background:#ed9a72}</style></head><body><main id="main" data-composition-id="main" data-width="320" data-height="240" data-duration="1"><div id="picture" class="clip" data-start="0" data-duration="1" data-track-index="0"></div></main></body></html>',
      },
    },
  );
  expect(written.ok()).toBeTruthy();
  return { project, errors };
}

/** The download is an MP4 that plays: 320x240 and one second long. */
async function expectPlayable(download: Download, path: string, duration = 1) {
  expect(download.suggestedFilename()).toMatch(/\.mp4$/);
  await download.saveAs(path);
}

async function expectEncoded(path: string, duration = 1) {
  const bytes = await readFile(path);
  expect(bytes.subarray(4, 8).toString("ascii")).toBe("ftyp");

  const { stdout } = await promisify(execFile)("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,width,height:format=duration",
    "-of",
    "json",
    path,
  ]);
  const encoded = z
    .object({
      streams: z.array(
        z.object({
          codec_type: z.string(),
          width: z.number().optional(),
          height: z.number().optional(),
        }),
      ),
      format: z.object({ duration: z.string() }),
    })
    .parse(JSON.parse(stdout));
  expect(
    encoded.streams.find((stream) => stream.codec_type === "video"),
  ).toMatchObject({ width: 320, height: 240 });
  expect(Number(encoded.format.duration)).toBeCloseTo(duration, 1);
}

test("Export waits for edits, continues when hidden and opens the completed MP4", async ({
  page,
  request,
}, testInfo) => {
  const { project, errors } = await exportable(page, request);
  await page.goto(`/#project/${project.id}`);
  await expect(
    page
      .getByRole("region", { name: "Timeline" })
      .locator('[data-clip="picture"]'),
  ).toBeVisible();

  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/commands", async (route) => {
    await gate;
    await route.fulfill({ response: await route.fetch() });
  });
  // Hold a resize at the network boundary: the picture shows 1.5s, disk still holds 1s.
  const clip = page.locator('[data-clip="picture"]');
  const box = await clip.boundingBox();
  if (!box) throw new Error("The picture has no bounds.");
  const ppf = await page
    .locator(".tl-grid")
    .evaluate((grid) => Number(grid.style.getPropertyValue("--ppf")));
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width - 2 + 15 * ppf,
    box.y + box.height / 2,
    { steps: 10 },
  );
  await page.mouse.up();
  await expect
    .poll(() =>
      clip.evaluate((element) => element.style.getPropertyValue("--d")),
    )
    .toBe("45");
  let renders = 0;
  page.on("request", (sent) => {
    if (sent.method() === "POST" && sent.url().endsWith("/render")) renders++;
  });

  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/render"),
  );
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("button", { name: "Export MP4", exact: true }).click();
  await expect(
    page.getByRole("progressbar", { name: "Export progress" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cancel export" }),
  ).toBeDisabled();
  await expect(page.locator(".status-bar")).toContainText("Exporting");
  await page.waitForTimeout(250);
  expect(renders).toBe(0);
  release();

  const { jobId } = z
    .object({ jobId: z.string() })
    .parse(await (await started).json());
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Export complete", exact: true }),
  ).toBeVisible({ timeout: 45_000 });
  await page
    .getByRole("button", { name: "Export complete", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Export complete.");
  const popup = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Open", exact: true }).click();
  const video = await popup;
  await expect(video.locator("video")).toBeVisible();
  await video.close();
  const path = testInfo.outputPath("export.mp4");
  const exported = await request.get(`/api/render/${jobId}/download`);
  await writeFile(path, await exported.body());
  await expectEncoded(path, 1.5);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Export", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("two default exports choose distinct names, show size and keep the tool row still", async ({
  page,
  request,
}, testInfo) => {
  const { project, errors } = await exportable(page, request);
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator('[data-clip="picture"]')).toBeVisible();
  const tools = page.getByRole("toolbar", { name: "Tools", exact: true });
  const positions = () =>
    tools.locator(":scope > button").evaluateAll((buttons) =>
      buttons.map((button) => ({
        x: button.getBoundingClientRect().x,
        width: button.getBoundingClientRect().width,
      })),
    );
  const before = await positions();
  const paths: string[] = [];
  for (const filename of ["Export proof.mp4", "Export proof 2.mp4"]) {
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export", exact: true });
    await expect(dialog.getByLabel("File name", { exact: true })).toHaveValue(
      filename,
    );
    const started = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/render"),
    );
    await dialog
      .getByRole("button", { name: "Export MP4", exact: true })
      .click();
    const { jobId, outputPath } = z
      .object({ jobId: z.string(), outputPath: z.string() })
      .parse(await (await started).json());
    paths.push(outputPath);
    await expect(dialog).toContainText("Export complete.", { timeout: 45_000 });
    await expect(dialog).toContainText("Finished");
    await expect(dialog).not.toContainText(/Encoding frame/);
    const size = (await stat(outputPath)).size;
    expect(size).toBeGreaterThan(0);
    await expect(dialog).toContainText(
      new Intl.NumberFormat(undefined, {
        style: "unit",
        unit: "kilobyte",
        maximumFractionDigits: 1,
      }).format(size / 1000),
    );
    expect(await positions()).toEqual(before);
    const result = await request.get(`/api/render/${jobId}/download`);
    const saved = testInfo.outputPath(filename);
    await writeFile(saved, await result.body());
    await expectEncoded(saved);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Export", exact: true }),
    ).toBeFocused();
    expect(await positions()).toEqual(before);
  }
  expect(new Set(paths).size).toBe(2);
  expect(errors).toEqual([]);
});

test("changing the export folder refreshes the suggested name and preserves a typed name", async ({
  page,
  request,
}) => {
  const { project } = await exportable(page, request);
  const chosen = join(project.path, "chosen");
  await mkdir(chosen);
  await writeFile(join(chosen, "Export proof.mp4"), "previous export");
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator('[data-clip="picture"]')).toBeVisible();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const filename = page.getByLabel("File name", { exact: true });
  await expect(page.getByRole("button", { name: "Export MP4" })).toBeEnabled();
  await page.getByLabel("Location", { exact: true }).fill(chosen);
  await expect(filename).toHaveValue("Export proof 2.mp4");
  await filename.fill("My name.mp4");
  await page.getByLabel("Location", { exact: true }).fill(project.path);
  await expect(page.getByRole("button", { name: "Export MP4" })).toBeEnabled();
  await expect(filename).toHaveValue("My name.mp4");
});

test("Export reports a refused pending edit instead of rendering the saved version", async ({
  page,
  request,
}) => {
  const { project } = await exportable(page, request);
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator('[data-clip="picture"]')).toBeVisible();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/commands", async (route) => {
    await gate;
    await route.fulfill({
      status: 422,
      json: { error: "The pending edit was refused." },
    });
  });
  // A range edit is optimistic too, and uses the same queue as a gesture.
  await page.getByRole("region", { name: "Viewer" }).click();
  await page.keyboard.press("i");
  await expect(page.getByText(/In\s*00:00:00:00/)).toBeVisible();
  let renders = 0;
  page.on("request", (sent) => {
    if (sent.method() === "POST" && sent.url().endsWith("/render")) renders++;
  });
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("button", { name: "Export MP4", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Cancel export" }),
  ).toBeDisabled();
  release();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "The pending edit was refused.",
  );
  await expect(
    page.getByRole("button", { name: "New export", exact: true }),
  ).toBeEnabled();
  expect(renders).toBe(0);
});

test("Location initializes before accepting edits and keeps the typed destination", async ({
  page,
  request,
}) => {
  const { project } = await exportable(page, request);
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator('[data-clip="picture"]')).toBeVisible();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `**/api/cutroom/projects/${project.id}/export-defaults?*`,
    async (route) => {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    },
  );
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const location = page
    .getByRole("dialog")
    .getByLabel("Location", { exact: true });
  await expect(location).toBeDisabled();
  release();
  await expect(location).toBeEnabled();
  await location.fill(project.path);
  await page
    .getByRole("dialog")
    .getByLabel("File name", { exact: true })
    .fill("My cut.mp4");
  await expect(location).toHaveValue(project.path);
});

test("the embedded editor exports a local composition and downloads a playable MP4", async ({
  page,
  request,
}, testInfo) => {
  await embeddedEditor(page);
  const { project, errors } = await exportable(page, request);

  await page.goto(`/#project/${project.id}?v=1&rc=1&tv=1`);
  await expect(
    page.frameLocator("hyperframes-player iframe").locator("#picture"),
  ).toBeVisible();
  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/projects/${project.id}/render`),
  );
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const response = await started;
  expect(response.ok(), await response.text()).toBeTruthy();
  await expect(
    page.getByRole("tab", { name: /^Renders(?: \(\d+\))?$/ }),
  ).toBeVisible();

  const downloadButton = page.getByRole("button", {
    name: /^Download .+\.mp4$/,
  });
  await expect(downloadButton).toBeEnabled({ timeout: 45_000 });
  const pendingDownload = page.waitForEvent("download");
  await downloadButton.click();
  await expectPlayable(
    await pendingDownload,
    testInfo.outputPath("export.mp4"),
  );
  expect(errors).toEqual([]);
});

test("Shift+8 defaults to marked frames and exports their exact duration", async ({
  page,
  request,
}, testInfo) => {
  const { project } = await exportable(page, request);
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator('[data-clip="picture"]')).toBeVisible();
  await page.getByRole("region", { name: "Viewer" }).click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowRight");
  // Park on frames 5 and 14, marking an inclusive ten-frame selection.
  await page.keyboard.press("Home");
  for (let frame = 0; frame < 5; frame++)
    await page.keyboard.press("ArrowRight");
  await page.keyboard.press("i");
  for (let frame = 5; frame < 14; frame++)
    await page.keyboard.press("ArrowRight");
  await page.keyboard.press("o");
  await page.keyboard.press("Shift+8");
  const dialog = page.getByRole("dialog", { name: "Export", exact: true });
  await expect(
    dialog.getByRole("radio", { name: "In to Out", exact: true }),
  ).toBeChecked();
  await expect(dialog).toContainText("00:00:00:10");
  await dialog.getByLabel("File name", { exact: true }).fill("Marked cut.mp4");
  await dialog.getByLabel("Quality", { exact: true }).click();
  await dialog.getByRole("option", { name: "High", exact: true }).click();
  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/render"),
  );
  await dialog.getByRole("button", { name: "Export MP4" }).click();
  const { jobId } = z
    .object({ jobId: z.string() })
    .parse(await (await started).json());
  await expect(dialog).toContainText("Export complete.", { timeout: 45_000 });
  const result = await request.get(`/api/render/${jobId}/download`);
  const path = testInfo.outputPath("marked.mp4");
  await writeFile(path, await result.body());
  await expectEncoded(path, 10 / 30);
});

test("Cancel stops the real render and removes a named partial file", async ({
  page,
  request,
}) => {
  const { project } = await exportable(page, request);
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator('[data-clip="picture"]')).toBeVisible();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/render"),
  );
  await page.getByRole("button", { name: "Export MP4" }).click();
  const { jobId, outputPath } = z
    .object({ jobId: z.string(), outputPath: z.string() })
    .parse(await (await started).json());
  await page.getByRole("button", { name: "Cancel export" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Export cancelled. Partial output removed.",
  );
  expect(existsSync(outputPath)).toBe(false);
  expect((await request.get(`/api/render/${jobId}/download`)).status()).toBe(
    404,
  );
});

test("Export explains a range it can't render instead of blanking the editor", async ({
  page,
  request,
}) => {
  const { project, errors } = await exportable(page, request);
  const api = `/api/cutroom/projects/${project.id}`;
  const source = SourceSchema.parse(
    await (await request.get(`${api}/source`)).json(),
  );
  // Nothing on the timeline: there is no range to export.
  const emptied = await request.put(`${api}/source`, {
    data: {
      path: "index.html",
      expectedVersion: source.version,
      content:
        '<!doctype html><html><body><main id="main" data-composition-id="main" data-width="320" data-height="240" data-duration="0"></main></body></html>',
    },
  });
  expect(emptied.ok()).toBeTruthy();
  await page.goto(`/#project/${project.id}`);
  await page.getByRole("region", { name: "Viewer" }).click();
  await page.keyboard.press("Shift+8");
  const dialog = page.getByRole("dialog", { name: "Export", exact: true });
  await expect(dialog.getByRole("alert")).toContainText(
    "The timeline is empty.",
  );
  await expect(
    dialog.getByRole("button", { name: "Export MP4" }),
  ).toBeDisabled();
  await expect(page.getByRole("region", { name: "Viewer" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("Shift+8 then Enter starts Export instead of closing, including slow defaults", async ({
  page,
  request,
}, testInfo) => {
  const { project } = await exportable(page, request);
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator('[data-clip="picture"]')).toBeVisible();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/export-defaults?**", async (route) => {
    await gate;
    await route.fulfill({ response: await route.fetch() });
  });
  await page.keyboard.press("Shift+8");
  const dialog = page.getByRole("dialog", { name: "Export", exact: true });
  const button = dialog.getByRole("button", {
    name: "Export MP4",
    exact: true,
  });
  await dialog.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
  await page.screenshot({ path: testInfo.outputPath("export-focus.png") });
  await expect(button).toBeFocused();
  await expect(button).toBeDisabled();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  release();
  await expect(button).toBeEnabled();
  await page.keyboard.press("Enter");
  await expect(dialog).toContainText("Export complete", { timeout: 40_000 });
  await page.screenshot({ path: testInfo.outputPath("export-complete.png") });
  await dialog.getByRole("button", { name: "New export", exact: true }).click();
  await expect(button).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
