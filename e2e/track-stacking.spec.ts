import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, TestInfo } from "@playwright/test";
import { z } from "zod";
import { ProjectSchema, SourceSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";

async function framePixels(frame: string) {
  const raw = `${frame}.rgb`;
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    frame,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    raw,
  ]);
  return readFile(raw);
}

async function captureFrame(
  request: APIRequestContext,
  projectId: string,
  name: string,
  testInfo: TestInfo,
) {
  const response = await request.get(
    `/api/projects/${projectId}/thumbnail/index.html?t=1&format=png&output=source`,
  );
  expect(response.ok(), response.statusText()).toBe(true);
  const frame = testInfo.outputPath(`${name}.png`);
  await writeFile(frame, await response.body());
  await testInfo.attach(name, { path: frame, contentType: "image/png" });
  return frame;
}

test("rendered video tracks stack upward after insert and track moves, while authored z-index wins", async ({
  request,
}, testInfo) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: "Title above footage",
          width: 640,
          height: 360,
          duration: 2,
        },
      })
    ).json(),
  );
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x265878:s=640x360:r=30:d=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    join(project.path, "footage.mp4"),
  ]);
  const path = `/api/cutroom/projects/${project.id}`;
  let view = TimelineViewSchema.parse(
    await (await request.get(`${path}/timeline`)).json(),
  );
  const edit = async (commands: CommandInput[]) => {
    const response = await request.post(`${path}/commands`, {
      data: { expectedRevision: view.revision, commands },
    });
    expect(response.ok(), await response.text()).toBe(true);
    view = TimelineViewSchema.parse(await response.json());
    expect(
      TimelineViewSchema.parse(
        await (await request.get(`${path}/timeline`)).json(),
      ),
    ).toEqual(view);
  };
  const whitePixels = async (name: string) => {
    const pixels = await framePixels(
      await captureFrame(request, project.id, name, testInfo),
    );
    let white = 0;
    for (let offset = 0; offset < pixels.length; offset += 3)
      if (
        pixels[offset]! > 200 &&
        pixels[offset + 1]! > 200 &&
        pixels[offset + 2]! > 200
      )
        white++;
    return white;
  };
  await edit([
    { type: "remove", clipIds: ["rule", "caption"] },
    { type: "setTrack", index: 0, name: "Footage" },
    { type: "setTrack", index: 2, name: "Titles" },
    {
      type: "insert",
      track: 0,
      at: 0,
      clip: {
        id: "footage",
        kind: "video",
        src: "footage.mp4",
        duration: 60,
        muted: true,
      },
    },
  ]);
  expect(await whitePixels("inserted-on-v1")).toBeGreaterThan(100);
  await edit([{ type: "move", clipIds: ["headline"], trackBy: 1 }]);
  expect(await whitePixels("title-on-v3")).toBeGreaterThan(100);

  const started = await request.post(`/api/projects/${project.id}/render`, {
    data: { format: "mp4", quality: "high" },
  });
  expect(started.ok()).toBe(true);
  const { jobId } = z.object({ jobId: z.string() }).parse(await started.json());
  const progress = await request.get(`/api/render/${jobId}/progress`, {
    timeout: 45_000,
  });
  const events = (await progress.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) =>
      z
        .object({ status: z.string(), error: z.string().optional() })
        .parse(JSON.parse(line.slice(5))),
    );
  expect(events.at(-1)?.status, events.at(-1)?.error).toBe("complete");
  const exported = await request.get(`/api/render/${jobId}/download`);
  expect(exported.ok()).toBe(true);
  const mp4 = testInfo.outputPath("stacking.mp4");
  await writeFile(mp4, await exported.body());
  const exportedFrame = testInfo.outputPath("exported-title-on-v3.png");
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-ss",
    "1",
    "-i",
    mp4,
    "-frames:v",
    "1",
    exportedFrame,
  ]);
  await testInfo.attach("exported-title-on-v3", {
    path: exportedFrame,
    contentType: "image/png",
  });
  const exportedPixels = await framePixels(exportedFrame);
  expect(
    exportedPixels.some(
      (value, index) =>
        index % 3 === 0 &&
        value > 200 &&
        exportedPixels[index + 1]! > 200 &&
        exportedPixels[index + 2]! > 200,
    ),
  ).toBe(true);

  await edit([{ type: "move", clipIds: ["footage"], trackBy: 3 }]);
  expect(await whitePixels("footage-above-title")).toBe(0);
  await edit([{ type: "move", clipIds: ["footage"], trackBy: -3 }]);
  expect(await whitePixels("footage-back-on-v1")).toBeGreaterThan(100);

  const source = SourceSchema.parse(
    await (await request.get(`${path}/source`)).json(),
  );
  const written = await request.put(`${path}/source`, {
    data: {
      path: "index.html",
      expectedVersion: source.version,
      content: source.content.replace(
        "</head>",
        "<style>.title{z-index:50}</style></head>",
      ),
    },
  });
  expect(written.ok()).toBe(true);
  view = TimelineViewSchema.parse(
    await (await request.get(`${path}/timeline`)).json(),
  );
  await edit([{ type: "move", clipIds: ["footage"], trackBy: 3 }]);
  expect(await whitePixels("authored-css-wins")).toBeGreaterThan(100);
});

async function stackingProject(request: APIRequestContext, content: string) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Scoped stacking", width: 640, height: 360, duration: 2 },
      })
    ).json(),
  );
  const path = `/api/cutroom/projects/${project.id}`;
  const source = SourceSchema.parse(
    await (await request.get(`${path}/source`)).json(),
  );
  const written = await request.put(`${path}/source`, {
    data: { path: "index.html", expectedVersion: source.version, content },
  });
  expect(written.ok()).toBe(true);
  return {
    project,
    edit: async (commands: CommandInput[], composition = "index.html") => {
      const view = TimelineViewSchema.parse(
        await (
          await request.get(
            `${path}/timeline?composition=${encodeURIComponent(composition)}`,
          )
        ).json(),
      );
      const response = await request.post(`${path}/commands`, {
        data: { composition, expectedRevision: view.revision, commands },
      });
      expect(response.ok(), await response.text()).toBe(true);
      const edited = TimelineViewSchema.parse(await response.json());
      expect(
        TimelineViewSchema.parse(
          await (
            await request.get(
              `${path}/timeline?composition=${encodeURIComponent(composition)}`,
            )
          ).json(),
        ),
      ).toEqual(edited);
    },
  };
}

test("authored utility layers and first-child styles survive a duration edit", async ({
  page,
  request,
}) => {
  const { project, edit } = await stackingProject(
    request,
    `<!doctype html><html><head><style>@layer utilities{.z-50{z-index:50}}html,body{margin:0}.box{position:absolute;inset:0;background:red}.box:first-child{background:blue}</style></head><body><main data-composition-id="main" data-width="640" data-height="360" data-duration="2"><div id="box" class="clip box z-50" data-start="0" data-duration="1" data-track-index="1"></div></main></body></html>`,
  );
  await edit([{ type: "trim", clipId: "box", edge: "end", to: 60 }]);
  await page.goto(`/api/projects/${project.id}/preview`);
  await expect(page.locator("#box")).toHaveCSS("z-index", "50");
  await expect(page.locator("#box")).toHaveCSS(
    "background-color",
    "rgb(0, 0, 255)",
  );
  await expect(page.locator("main > :first-child")).toHaveAttribute(
    "id",
    "box",
  );
  await expect(
    page.locator("head > style[data-cutroom-track-stacking]"),
  ).toHaveAttribute("data-cutroom-track-stacking", "main");
});

for (const kind of ["inline", "external"] as const) {
  test(`parent stacking leaves ${kind} scene content alone`, async ({
    page,
    request,
  }, testInfo) => {
    const children = `<div id="red" class="clip" data-start="0" data-duration="2" data-track-index="1" style="position:absolute;inset:0;background:red"></div><div id="blue" class="clip" data-start="0" data-duration="2" data-track-index="02" style="position:absolute;inset:0;background:blue"></div>`;
    const scene = `<div id="scene" data-composition-id="scene" ${kind === "external" ? 'data-composition-src="scene.html"' : ""} data-start="0" data-duration="2" data-track-index="1" style="position:absolute;left:0;top:0;width:320px;height:360px">${kind === "inline" ? children : ""}</div>`;
    const second =
      kind === "external"
        ? `<div id="second" data-composition-id="scene" data-composition-src="scene.html" data-start="0" data-duration="2" data-track-index="0" style="position:absolute;left:320px;top:0;width:320px;height:360px"></div>`
        : "";
    const { project, edit } = await stackingProject(
      request,
      `<!doctype html><html><head><style>html,body{margin:0}</style></head><body><main data-composition-id="main" data-width="640" data-height="360" data-duration="2">${scene}${second}</main></body></html>`,
    );
    if (kind === "external")
      await writeFile(
        join(project.path, "scene.html"),
        `<template><div data-composition-id="scene" data-width="320" data-height="360" data-duration="2">${children}</div></template>`,
      );
    const bluePicture = async (name: string) => {
      const pixels = await framePixels(
        await captureFrame(request, project.id, name, testInfo),
      );
      for (const x of kind === "external" ? [50, 370] : [50]) {
        const offset = (50 * 640 + x) * 3;
        expect([...pixels.subarray(offset, offset + 3)]).toEqual([0, 0, 255]);
      }
    };
    await bluePicture(`${kind}-before`);
    await edit([{ type: "move", clipIds: ["scene"], by: 1 }]);
    await bluePicture(`${kind}-after-parent-move`);
    await page.goto(`/api/projects/${project.id}/preview`);
    expect(
      await page
        .locator('[id="red"]')
        .evaluateAll((elements) =>
          elements.map((element) => getComputedStyle(element).zIndex),
        ),
    ).toEqual(kind === "external" ? ["auto", "auto"] : ["auto"]);
    if (kind === "external") {
      await edit(
        [{ type: "trim", clipId: "blue", edge: "end", to: 45 }],
        "scene.html",
      );
      await bluePicture("external-after-scene-edit");
      await page.goto(`/api/projects/${project.id}/preview`);
      expect(
        await page
          .locator('[id="blue"]')
          .evaluateAll((elements) =>
            elements.map((element) => getComputedStyle(element).zIndex),
          ),
      ).toEqual(["2", "2"]);
      expect(
        await page
          .locator('[id="red"]')
          .evaluateAll((elements) =>
            elements.map((element) => getComputedStyle(element).zIndex),
          ),
      ).toEqual(["1", "1"]);
    }
  });
}

test("editing only an external scene keeps entry-page utility layers above its defaults", async ({
  page,
  request,
}) => {
  const { project, edit } = await stackingProject(
    request,
    `<!doctype html><html><head><style>@layer utilities{.z-50{z-index:50}}</style></head><body><main data-composition-id="main" data-width="640" data-height="360" data-duration="2"><div id="scene" data-composition-id="scene" data-composition-src="scene.html" data-start="0" data-duration="2" data-track-index="0"></div></main></body></html>`,
  );
  await writeFile(
    join(project.path, "scene.html"),
    `<template><div data-composition-id="scene" data-duration="2"><div id="box" class="clip z-50" data-start="0" data-duration="1" data-track-index="1" style="position:absolute;inset:0;background:blue"></div></div></template>`,
  );
  await edit(
    [{ type: "trim", clipId: "box", edge: "end", to: 60 }],
    "scene.html",
  );
  await page.goto(`/api/projects/${project.id}/preview`);
  await expect(page.locator("#box")).toHaveCSS("z-index", "50");
  await expect(
    page.locator("head > style[data-cutroom-track-layer]"),
  ).toHaveAttribute("data-cutroom-track-layer", "");
});
