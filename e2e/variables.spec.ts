import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";
import { waitForPreview } from "./preview-ready";

const HistorySchema = z.object({
  entries: z.array(z.object({ undone: z.boolean() })),
});
const DECLARATIONS = [
  { id: "title", type: "string", label: "Title", default: "Quarterly" },
  { id: "accent", type: "color", label: "Accent", default: "#3a6df0" },
  {
    id: "size",
    type: "number",
    label: "Size",
    default: 240,
    min: 40,
    max: 600,
  },
];

const shown = (page: Page, id: string) =>
  page.locator("iframe[data-live]").contentFrame().locator(`#${id}`);

/** The middle pixel of a rendered file's first frame, as RGB. */
async function pixel(path: string, x: number, y: number) {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      path,
      "-frames:v",
      "1",
      "-vf",
      `crop=w=2:h=2:x=${x}:y=${y},scale=1:1`,
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { encoding: "buffer" },
  );
  expect(result.status, result.stderr.toString()).toBe(0);
  return [...result.stdout];
}

test("the Inspector edits a live variable and leaves inert template declarations alone", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Live variables", width: 320, height: 240, duration: 1 },
      })
    ).json(),
  );
  const file = join(project.path, "index.html");
  const inert = `<template id="sample"><div data-composition-variables='[{"id":"ghost","type":"string","label":"Inert label","default":"Sample"}]'></div></template>`;
  const source = `<!doctype html><html><head>${inert}</head><body style="margin:0;color:white;background:#161616"><main data-composition-id="main" data-width="320" data-height="240" data-duration="1" data-no-timeline data-composition-variables='[{"id":"edition","type":"string","label":"Edition","default":"Live edition"}]'><section data-composition-variables='[{"id":"headline","type":"string","label":"Headline","default":"Release preview"}]'><h1 id="headline" class="clip" data-start="0" data-duration="1" data-track-index="0" data-var-text="headline">Fallback</h1><p id="edition" data-var-text="edition">Fallback</p></section></main></body></html>`;
  await writeFile(file, source);
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page);
  await expect(shown(page, "headline")).toHaveText("Release preview");
  await expect(shown(page, "edition")).toHaveText("Live edition");
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const field = inspector.getByRole("textbox", {
    name: "Headline",
    exact: true,
  });
  await expect(field).toHaveValue("Release preview");
  await expect(
    inspector.getByRole("textbox", { name: "Edition", exact: true }),
  ).toHaveValue("Live edition");
  await expect(
    inspector.getByRole("textbox", { name: "Inert label" }),
  ).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("variable-before.png") });
  await field.fill("Ready to publish");
  await field.press("Enter");
  await expect(shown(page, "headline")).toHaveText("Ready to publish");
  await inspector.getByRole("button", { name: "Set default" }).click();
  await expect.poll(() => readFile(file, "utf8")).toContain("Ready to publish");
  expect(await readFile(file, "utf8")).toContain(inert);
  await page.reload();
  await waitForPreview(page);
  await expect(shown(page, "headline")).toHaveText("Ready to publish");
  await expect(shown(page, "edition")).toHaveText("Live edition");
  await page.screenshot({ path: info.outputPath("variable-after.png") });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => readFile(file, "utf8")).toBe(source);
  await expect(shown(page, "headline")).toHaveText("Release preview");
});

test("an image variable changes the actual viewer and MP4 picture", async ({
  page,
  request,
}, info) => {
  test.setTimeout(90_000);
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Image variable", width: 320, height: 240, duration: 1 },
      })
    ).json(),
  );
  const index = join(project.path, "index.html");
  await mkdir(join(project.path, "assets"), { recursive: true });
  for (const [name, color] of [
    ["first.svg", "#ff0000"],
    ["second#2.svg", "#0000ff"],
  ]) {
    await writeFile(
      join(project.path, "assets", name!),
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"><path fill="${color}" d="M0 0h320v240H0z"/></svg>`,
    );
  }
  const source = `<!doctype html><html data-composition-variables='[{"id":"art","type":"image","label":"Artwork","default":{"url":"assets/first.svg","alt":"Artwork"}}]'><body style="margin:0"><main data-composition-id="main" data-width="320" data-height="240" data-duration="1"><img id="artwork" class="clip" src="assets/first.svg" data-var-src="art" data-start="0" data-duration="1" data-track-index="0" style="position:absolute;inset:0;width:320px;height:240px"></main></body></html>`;
  await writeFile(index, source);
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page);
  const image = shown(page, "artwork");
  await expect(image).toHaveJSProperty("naturalWidth", 320);
  const picture = page.locator(".edit-picture");
  const before = info.outputPath("authored-image.png");
  await picture.screenshot({ path: before });
  const field = page.getByRole("combobox", { name: "Artwork", exact: true });
  await expect(field).toHaveText("assets/first.svg");
  await field.click();
  await page.getByRole("option", { name: "assets/second#2.svg" }).click();
  await expect(image).toHaveAttribute("src", "assets/second%232.svg");
  await expect(image).toHaveJSProperty("naturalWidth", 320);
  const after = info.outputPath("preview-image.png");
  await picture.screenshot({ path: after });
  const dimensions = (await picture.boundingBox())!;
  const center = [
    Math.floor(dimensions.width / 2),
    Math.floor(dimensions.height / 2),
  ] as const;
  expect((await pixel(before, ...center))[0]).toBeGreaterThan(230);
  expect((await pixel(after, ...center))[2]).toBeGreaterThan(230);
  expect(await readFile(index, "utf8")).toBe(source);

  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export", exact: true });
  await expect(dialog.getByRole("combobox", { name: "Artwork" })).toHaveText(
    "assets/second#2.svg",
  );
  const answered = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/render"),
  );
  await dialog.getByRole("button", { name: "Export MP4", exact: true }).click();
  const { outputPath } = z
    .object({ outputPath: z.string() })
    .parse(await (await answered).json());
  await expect(dialog).toContainText("Export complete.", { timeout: 60_000 });
  const [red, green, blue] = await pixel(outputPath, 160, 120);
  expect(red).toBeLessThan(20);
  expect(green).toBeLessThan(20);
  expect(blue).toBeGreaterThan(230);
});

test("a mounted scene resolves its image default and exports its own override", async ({
  page,
  request,
}, info) => {
  test.setTimeout(120_000);
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Scene artwork", width: 640, height: 240, duration: 1 },
      })
    ).json(),
  );
  await mkdir(join(project.path, "art"), { recursive: true });
  await mkdir(join(project.path, "compositions", "art"), { recursive: true });
  for (const [name, color] of [
    ["art/red.svg", "red"],
    ["art/blue#2.svg", "blue"],
    ["art/green.svg", "lime"],
    ["compositions/art/green.svg", "blue"],
  ] as const) {
    await writeFile(
      join(project.path, name),
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="${color}"/></svg>`,
    );
  }
  const composition = "compositions/scene.html";
  const scene = `<template><main id="scene" data-composition-id="scene" data-width="320" data-height="240" data-duration="1" data-composition-variables='[{"id":"art","type":"image","label":"Artwork","default":{"url":"../art/red.svg","alt":"Red artwork"}}]'><img id="artwork" class="clip" src="../art/red.svg" data-var-src="art" data-start="0" data-duration="1" data-track-index="0" width="320" height="240"></main></template>`;
  await writeFile(join(project.path, composition), scene);
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><body style="margin:0"><main data-composition-id="main" data-width="640" data-height="240" data-duration="1"><div id="host" class="clip" data-composition-id="scene" data-composition-src="${composition}" data-start="0" data-duration="1" data-track-index="0" data-width="320" data-height="240"></div><div id="other-host" class="clip" data-composition-id="scene" data-composition-src="${composition}" data-variable-values='{"art":"art/green.svg"}' data-start="0" data-duration="1" data-track-index="1" data-width="320" data-height="240" style="position:absolute;top:0;left:320px"></div></main></body></html>`,
  );
  const frame = page.frameLocator("iframe[data-live]");
  const artwork = frame.locator('[data-var-src="art"]').first();
  const viewer = page.locator(".edit-picture");
  const expectColor = (rgb: number[], channel: number) => {
    expect(rgb).toHaveLength(3);
    for (const [index, value] of rgb.entries())
      if (index === channel) expect(value).toBeGreaterThan(230);
      else expect(value).toBeLessThan(20);
  };
  const checkPicture = async (filename: string, ...channels: number[]) => {
    await expect(artwork).toHaveJSProperty("naturalWidth", 320);
    const path = info.outputPath(filename);
    await viewer.screenshot({ path });
    const { width, height } = (await viewer.boundingBox())!;
    for (const [column, channel] of channels.entries())
      expectColor(
        await pixel(
          path,
          Math.floor((width * (column + 0.5)) / channels.length),
          Math.floor(height / 2),
        ),
        channel,
      );
  };
  const exportPicture = async (channels: number[], expectedFile?: string) => {
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export", exact: true });
    if (expectedFile)
      await expect(
        dialog.getByRole("combobox", { name: "Artwork" }),
      ).toHaveText(expectedFile);
    const sent = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/render"),
    );
    await dialog
      .getByRole("button", { name: "Export MP4", exact: true })
      .click();
    const { outputPath } = z
      .object({ outputPath: z.string() })
      .parse(await (await sent).json());
    await expect(dialog).toContainText("Export complete.", { timeout: 45_000 });
    for (const [column, channel] of channels.entries())
      expectColor(await pixel(outputPath, 160 + column * 320, 120), channel);
    await dialog
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
  };
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page);
  const mounts = frame.locator(
    '[data-composition-id][data-composition-file="compositions/scene.html"]',
  );
  await expect(mounts).toHaveCount(2);
  const [first, second] = await mounts.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-composition-id")),
  );
  expect(first).not.toBe(second);
  const hostOverride = frame.locator('#other-host [data-var-src="art"]');
  await expect(hostOverride).toHaveAttribute("src", "art/green.svg");
  await expect(hostOverride).toHaveJSProperty("naturalWidth", 320);
  await checkPicture("parent-default-and-host-override.png", 0, 1);
  await exportPicture([0, 1]);

  await page.locator('[data-clip="host"]').dblclick();
  await expect(
    page.getByRole("navigation", { name: "Composition" }),
  ).toHaveText(/scene/);
  await waitForPreview(page);
  await checkPicture("scene-default.png", 0);
  const picker = page.getByRole("combobox", { name: "Artwork", exact: true });
  await expect(picker).toHaveText("art/red.svg");
  await picker.click();
  await page.getByRole("option", { name: "art/blue#2.svg" }).click();
  await expect(artwork).toHaveAttribute("src", /art\/blue%232\.svg$/);
  await checkPicture("scene-override.png", 2);
  await exportPicture([2], "art/blue#2.svg");
  expect(await readFile(join(project.path, composition), "utf8")).toBe(scene);
});

test("a scene opened on its own previews and exports its nested image default", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Nested artwork", width: 320, height: 240, duration: 1 },
      })
    ).json(),
  );
  const host = (id: string) =>
    `<div id="${id}-host" class="clip" data-composition-id="${id}" data-composition-src="compositions/${id}.html" data-start="0" data-duration="1" data-track-index="0" data-width="320" data-height="240"></div>`;
  const main = (id: string, contents: string) =>
    `<main data-composition-id="${id}" data-width="320" data-height="240" data-duration="1">${contents}</main>`;
  await mkdir(join(project.path, "art"), { recursive: true });
  await mkdir(join(project.path, "compositions/art"), { recursive: true });
  for (const [path, color] of [
    ["art/image.svg", "blue"],
    ["compositions/art/image.svg", "red"],
  ] as const) {
    await writeFile(
      join(project.path, path),
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="${color}"/></svg>`,
    );
  }
  const child = `<template><main data-composition-id="child" data-width="320" data-height="240" data-duration="1" data-composition-variables='[{"id":"art","type":"image","label":"Artwork","default":{"url":"art/image.svg","alt":"Red artwork"}}]'><img id="artwork" class="clip" src="art/image.svg" data-var-src="art" data-start="0" data-duration="1" data-track-index="0" width="320" height="240"></main></template>`;
  const childPath = join(project.path, "compositions/child.html");
  await writeFile(childPath, child);
  await writeFile(
    join(project.path, "compositions/parent.html"),
    `<template>${main("parent", host("child"))}</template>`,
  );
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><body style="margin:0">${main("main", host("parent"))}</body></html>`,
  );

  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page);
  await page.locator('[data-clip="parent-host"]').dblclick();
  await expect(
    page.getByRole("navigation", { name: "Composition" }),
  ).toHaveText(/parent/);
  await waitForPreview(page);
  const artwork = shown(page, "artwork");
  await expect(artwork).toHaveAttribute("src", "compositions/art/image.svg");
  await expect(artwork).toHaveJSProperty("naturalWidth", 320);
  const preview = info.outputPath("nested-scene-preview.png");
  const picture = page.locator(".edit-picture");
  await picture.screenshot({ path: preview });
  const { width, height } = (await picture.boundingBox())!;
  expect(
    await pixel(preview, Math.floor(width / 2), Math.floor(height / 2)),
  ).toEqual([255, 0, 0]);

  const exported = await request.post(`/api/projects/${project.id}/export`, {
    data: { composition: "compositions/parent.html", range: "timeline" },
  });
  expect(exported.ok(), await exported.text()).toBe(true);
  const { outputPath } = z
    .object({ outputPath: z.string() })
    .parse(await exported.json());
  await expect
    .poll(() => existsSync(outputPath), { timeout: 45_000 })
    .toBe(true);
  const [red, green, blue] = await pixel(outputPath, 160, 120);
  expect(red).toBeGreaterThan(230);
  expect(green).toBeLessThan(20);
  expect(blue).toBeLessThan(20);
  expect(await readFile(childPath, "utf8")).toBe(child);
});

test("variables preview live from the inspector and an agent, become defaults in one step, and export as previewed", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Template", width: 640, height: 360, duration: 1 },
      })
    ).json(),
  );
  const index = join(project.path, "index.html");
  await writeFile(
    index,
    (await readFile(index, "utf8"))
      .replace(
        '<html lang="en">',
        `<html lang="en" data-composition-variables='${JSON.stringify(DECLARATIONS)}'>`,
      )
      .replace(
        "</style>",
        ".badge { position: absolute; left: 0; top: 0; height: 100px; background: var(--accent); width: calc(var(--size) * 1px); }\n</style>",
      )
      .replace(
        'data-label="Project title">Template',
        'data-label="Project title" data-var-text="title">Quarterly',
      )
      .replace(
        "</main>",
        '<div id="badge" class="clip badge" data-start="0" data-duration="1" data-track-index="3"></div>\n</main>',
      ),
  );
  const authored = await readFile(index, "utf8");
  const steps = async () =>
    HistorySchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/history`)
      ).json(),
    ).entries.filter((entry) => !entry.undone).length;

  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page);
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const variables = inspector.locator(".inspector-variables");
  await expect(variables).toContainText("Variables");
  const headline = shown(page, "headline");
  const badge = shown(page, "badge");
  await expect(headline).toHaveText("Quarterly");
  await expect(badge).toHaveCSS("background-color", "rgb(58, 109, 240)");
  const type = async (field: string, value: string) => {
    const input = variables.getByRole("textbox", { name: field, exact: true });
    await input.fill(value);
    await input.press("Enter");
  };
  const url = page.url();

  await type("Title", "Q4 report");
  await expect(headline).toHaveText("Q4 report");
  await type("Accent hex", "ff3366");
  await expect(badge).toHaveCSS("background-color", "rgb(255, 51, 102)");
  await type("Size", "480");
  await expect(badge).toHaveCSS("width", "480px");
  // A value its declaration refuses never reaches the viewer, and the field shows the last one.
  await type("Size", "900");
  await expect(
    page.getByRole("status").or(page.getByRole("alert")),
  ).toContainText("600");
  await expect(
    variables.getByRole("textbox", { name: "Size", exact: true }),
  ).toHaveValue("480");
  await expect(badge).toHaveCSS("width", "480px");
  // Hostile words stay words: HyperFrames sets text, so no element is created from them.
  const hostile = `<img src=x onerror="document.title='owned'">`;
  await type("Title", hostile);
  await expect(headline).toHaveText(hostile);
  await expect(headline.locator("img")).toHaveCount(0);
  // Previews never write the source or history, and the editor itself never reloaded.
  expect(await readFile(index, "utf8")).toBe(authored);
  expect(page.url()).toBe(url);

  // An agent's override reaches the open editor and its viewer.
  const before = await steps();
  expect(
    (
      await request.put(
        `/api/cutroom/projects/${project.id}/variables/preview`,
        { data: { values: { title: "From the agent", accent: "#ff3366" } } },
      )
    ).ok(),
  ).toBe(true);
  await expect(headline).toHaveText("From the agent");
  await expect(badge).toHaveCSS("width", "240px");
  await expect(
    variables.getByRole("textbox", { name: "Title", exact: true }),
  ).toHaveValue("From the agent");

  // Set default writes the declaration as one undo step; undo puts the source back.
  await variables
    .locator(".inspector-field", { hasText: "Title" })
    .getByRole("button", { name: "Set default" })
    .click();
  await expect.poll(steps).toBe(before + 1);
  await expect
    .poll(async () => readFile(index, "utf8"))
    .toContain('"default":"From the agent"');
  await expect(headline).toHaveText("From the agent");
  await page.keyboard.press("Control+z");
  await expect.poll(async () => readFile(index, "utf8")).toBe(authored);
  // The override went into the default, so undoing that shows the old default again.
  await expect(headline).toHaveText("Quarterly");

  // The Export dialog starts from the viewer's overrides and the file shows them.
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export", exact: true });
  await expect(dialog.locator(".export-variables")).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: "Title", exact: true }),
  ).toHaveValue("Quarterly");
  await expect(dialog.getByLabel("Accent", { exact: true })).toHaveValue(
    "#ff3366",
  );
  await dialog.getByRole("textbox", { name: "Size", exact: true }).fill("320");
  const started = page.waitForRequest(
    (sent) => sent.method() === "POST" && sent.url().endsWith("/render"),
  );
  const answered = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/render"),
  );
  await dialog.getByRole("button", { name: "Export MP4", exact: true }).click();
  expect(
    z.object({ variables: z.unknown() }).parse((await started).postDataJSON())
      .variables,
  ).toEqual({ accent: "#ff3366", size: 320 });
  const { outputPath } = z
    .object({ outputPath: z.string() })
    .parse(await (await answered).json());
  await expect(dialog).toContainText("Export complete.", { timeout: 60_000 });
  // Inside the badge's 320 pixels, its override colour; past them, the page.
  const [red, green, blue] = await pixel(outputPath, 300, 50);
  expect(red).toBeGreaterThan(230);
  expect(green).toBeLessThan(80);
  expect(blue).toBeGreaterThan(80);
  const [, , outside] = await pixel(outputPath, 340, 50);
  expect(outside).toBeLessThan(40);
});

test("bind existing variables from the inspector and preview their words and colour", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: "Variable binding",
          width: 640,
          height: 360,
          duration: 2,
        },
      })
    ).json(),
  );
  const index = join(project.path, "index.html");
  const source = `<!doctype html><html data-composition-variables='${JSON.stringify(DECLARATIONS)}'><body><main data-composition-id="main" data-width="640" data-height="360" data-duration="2"><p id="caption" class="clip" data-start="0" data-duration="2" data-track-index="0" style="color:#00ff00;font-size:40px">Plain words</p></main></body></html>`;
  await writeFile(index, source);
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page);
  await page.locator('.tl-lanes [data-clip="caption"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await inspector.screenshot({ path: info.outputPath("variables-before.png") });
  await inspector
    .getByRole("combobox", { name: "Words variable", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Title (title)", exact: true })
    .click();
  await expect(shown(page, "caption")).toHaveText("Quarterly");
  await expect(
    inspector.getByRole("combobox", { name: "Words variable", exact: true }),
  ).toContainText("Title (title)");
  await inspector
    .getByRole("combobox", { name: "Colour variable", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Accent (accent)", exact: true })
    .click();
  await expect(shown(page, "caption")).toHaveCSS("color", "rgb(58, 109, 240)");
  await expect
    .poll(async () => readFile(index, "utf8"))
    .toContain("color: var(--accent)");
  await inspector.screenshot({ path: info.outputPath("variables-after.png") });
  await page.keyboard.press("Control+z");
  await expect(shown(page, "caption")).toHaveCSS("color", "rgb(0, 255, 0)");
  await page.keyboard.press("Control+z");
  await expect.poll(async () => readFile(index, "utf8")).toBe(source);
  await expect(shown(page, "caption")).toHaveText("Plain words");

  await inspector.getByRole("combobox", { name: "Words variable" }).click();
  await page.getByRole("option", { name: "New variable…" }).click();
  await expect(
    inspector.getByRole("combobox", { name: "Words variable" }),
  ).toContainText("caption-text");
  await expect(shown(page, "caption")).toHaveText("Plain words");
});
