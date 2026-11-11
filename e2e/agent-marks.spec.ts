import { spawnSync } from "node:child_process";
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { seekFrame } from "./position-helpers";
import { expect, test } from "./fixtures";
import { ProjectSchema, SourceSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { ReviewItemSchema } from "../src/shared/review";

// 17 clips reproduce the reviewer's project without media or a real agent turn.
test("a rendered GSAP tween edit produces one composition row and no clip underlines", async ({
  page,
  request,
}, testInfo) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Title animation review" },
      })
    ).json(),
  );
  await copyFile(
    join(process.cwd(), "node_modules/gsap/dist/gsap.min.js"),
    join(project.path, "gsap.min.js"),
  );
  const base = `/api/cutroom/projects/${project.id}`;
  const clips = Array.from(
    { length: 17 },
    (_, i) =>
      `<div id="${i === 0 ? "title" : `clip-${i}`}" class="clip" data-start="${Math.floor(i / 4) * 2}" data-duration="2" data-track-index="${i % 4}" data-label="${i === 0 ? "Title" : `Clip ${i}`}" style="position:absolute;left:10%;top:${15 + (i % 4) * 17}%;font-size:${i % 4 === 0 ? 72 : 40}px;color:white">${i === 0 ? "Launch cut" : `Scene ${i}`}</div>`,
  ).join("\n");
  const readSource = async () =>
    SourceSchema.parse(await (await request.get(`${base}/source`)).json());
  const original = await readSource();
  const content = `<!doctype html><html><head><style>html,body{margin:0;background:#111;font-family:sans-serif}main{position:relative}</style><script src="gsap.min.js"></script></head><body><main id="main" data-composition-id="main" data-width="1920" data-height="1080" data-duration="10">${clips}</main><script>const tl=gsap.timeline({paused:true}); tl.fromTo("#title",{x:-120},{x:0,duration:0.6,ease:"none"},0); window.__timelines={main:tl};</script></body></html>`;
  expect(
    (
      await request.put(`${base}/source`, {
        data: {
          path: "index.html",
          expectedVersion: original.version,
          content,
        },
      })
    ).ok(),
  ).toBe(true);
  const note = ReviewItemSchema.parse(
    await (
      await request.post(`${base}/review`, {
        data: {
          body: "Make the title slide in faster",
          time: 0,
          elementId: "title",
          compositionPath: "index.html",
        },
      })
    ).json(),
  );
  expect(
    (
      await request.post(`${base}/review/${note.id}/agent`, {
        data: { type: "claim" },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  await seekFrame(page, 6);
  const titleX = () =>
    page
      .frameLocator("iframe[data-live]")
      .locator("#title")
      .evaluate(
        (element) => new DOMMatrix(getComputedStyle(element).transform).m41,
      );
  await expect.poll(titleX).toBeCloseTo(-80, 0);
  const current = await readSource();
  expect(
    (
      await request.put(`${base}/source`, {
        headers: { "x-cutroom-agent": "external" },
        data: {
          path: "index.html",
          expectedVersion: current.version,
          content: content.replace("duration:0.6", "duration:0.3"),
        },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await request.post(`${base}/review/${note.id}/agent`, {
        data: {
          type: "complete",
          note: "Shortened the title slide-in from 0.6s to 0.3s.",
        },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/#project/${project.id}`);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "To review notes", exact: true }),
  ).toContainText("Shortened the title slide-in");
  const shared = page.getByRole("list", { name: "Composition changes" });
  await expect(shared.getByRole("listitem")).toHaveCount(1);
  await expect(shared).toHaveText("Edited index.html composition");
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  await seekFrame(page, 6);
  await expect.poll(titleX).toBeCloseTo(-40, 0);
  await page.screenshot({ path: testInfo.outputPath("after.png") });
  await expect(page.locator("[data-agent-change]")).toHaveCount(0);
  const view = TimelineViewSchema.parse(
    await (await request.get(`${base}/timeline`)).json(),
  );
  expect(view.agentChanges).toEqual([]);
  expect(view.clipEdits?.filter((edit) => edit.by === "agent")).toHaveLength(1);
  await page
    .getByRole("region", { name: "To review notes", exact: true })
    .getByRole("button", { name: "Accept", exact: true })
    .click();
  await expect(page.locator("[data-agent-change]")).toHaveCount(0);
  const accepted = await readSource();
  expect(
    (
      await request.put(`${base}/source`, {
        headers: { "x-cutroom-agent": "external" },
        data: {
          path: "index.html",
          expectedVersion: accepted.version,
          content: accepted.content.replace(
            "window.__timelines={main:tl};",
            "window.__timelines={main:tl}; window.sharedSetting=1;",
          ),
        },
      })
    ).ok(),
  ).toBe(true);
  await expect(shared.getByRole("listitem")).toHaveCount(1);
  await expect(shared).toHaveText("Edited index.html composition");
  await expect(page.locator("[data-agent-change]")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("shared-agent-change.png"),
  });
  await page
    .getByRole("button", { name: "Accept agent changes", exact: true })
    .click();
  await expect(shared).toHaveCount(0);
});

for (const [name, before, after, expectedX] of [
  ["receiver", 'intro.to("#title"', 'outro.to("#title"', 0],
  ["delay", "delay:0", "delay:1", 0],
  ["defaults", "duration:1", "duration:2", 112.5],
] as const) {
  test(`a rendered timeline ${name} edit stays visible as a composition row`, async ({
    page,
    request,
  }, info) => {
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: { name: `Timeline ${name} review` },
        })
      ).json(),
    );
    await copyFile(
      join(process.cwd(), "node_modules/gsap/dist/gsap.min.js"),
      join(project.path, "gsap.min.js"),
    );
    const content = `<!doctype html><html><head><script src="gsap.min.js"></script><style>body{margin:0;background:#111;color:white}#title{font:60px sans-serif}</style></head><body><main data-composition-id="main" data-duration="5" data-width="800" data-height="450"><div id="title" data-start="0" data-duration="5">Title</div></main><script>const main=gsap.timeline({paused:true});const intro=gsap.timeline({delay:0,defaults:{duration:1,ease:"none"}});const outro=gsap.timeline({delay:3});intro.to("#title",{x:450},0);main.add(intro,0);main.add(outro,0);window.__timelines={main};</script></body></html>`;
    await writeFile(join(project.path, "index.html"), content);
    const base = `/api/cutroom/projects/${project.id}`;
    await page.goto(`/#project/${project.id}`);
    await seekFrame(page, 15);
    const titleX = () =>
      page
        .frameLocator("iframe[data-live]")
        .locator("#title")
        .evaluate(
          (element) => new DOMMatrix(getComputedStyle(element).transform).m41,
        );
    await expect.poll(titleX).toBeCloseTo(225, 0);
    const current = SourceSchema.parse(
      await (await request.get(`${base}/source`)).json(),
    );
    const saved = await request.put(`${base}/source`, {
      headers: { "x-cutroom-agent": "external" },
      data: {
        path: "index.html",
        expectedVersion: current.version,
        content: content.replace(before, after),
      },
    });
    expect(saved.ok()).toBe(true);
    await expect.poll(titleX).toBeCloseTo(expectedX, 0);
    await page.getByRole("button", { name: "Review", exact: true }).click();
    const rows = page.getByRole("list", { name: "Composition changes" });
    await expect(rows.getByRole("listitem")).toHaveCount(1);
    await expect(page.locator("[data-agent-change]")).toHaveCount(0);
    await info.attach("rendered-state", {
      body: JSON.stringify({
        beforeX: 225,
        afterX: await titleX(),
        rows: 1,
        clipMarks: 0,
      }),
      contentType: "application/json",
    });
    await page
      .getByRole("button", { name: "Accept agent changes", exact: true })
      .click();
    await expect(rows).toHaveCount(0);
  });
}

test("replacing rendered media reviews its clip and keeps owner replacements unmarked", async ({
  page,
  request,
}, testInfo) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: "Media replacement review",
          width: 400,
          height: 240,
          duration: 5,
        },
      })
    ).json(),
  );
  const base = `/api/cutroom/projects/${project.id}`;
  const media = `/api/projects/${project.id}`;
  const png = (color: string) => {
    const result = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=400x240`,
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-c:v",
      "png",
      "pipe:1",
    ]);
    expect(result.status, result.stderr.toString()).toBe(0);
    return result.stdout;
  };
  const red = png("red");
  const blue = png("blue");
  const upload = async (buffer: Buffer, agent = false) => {
    const response = await request.post(`${media}/upload`, {
      headers: agent ? { "x-cutroom-agent": "external" } : {},
      multipart: { files: { name: "card.png", mimeType: "image/png", buffer } },
    });
    expect(response.status(), await response.text()).toBe(201);
    expect((await response.json()).files).toEqual(["card.png"]);
  };
  await upload(red);
  const original = SourceSchema.parse(
    await (await request.get(`${base}/source`)).json(),
  );
  expect(
    (
      await request.put(`${base}/source`, {
        data: {
          path: "index.html",
          expectedVersion: original.version,
          content:
            '<html><body style="margin:0"><main data-composition-id="main" data-width="400" data-height="240" data-duration="5"><img id="title" crossorigin="anonymous" src="card.png" data-start="0" data-duration="5" style="width:400px;height:240px"></main></body></html>',
        },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  const pixel = () =>
    page
      .frameLocator("iframe[data-live]")
      .locator("#title")
      .evaluate((element) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d")!;
        context.drawImage(element as HTMLImageElement, 0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
      });
  await expect.poll(pixel).toEqual([253, 0, 0]);
  await page.screenshot({ path: testInfo.outputPath("asset-before.png") });
  expect(
    (
      await request.delete(`${media}/files/card.png`, {
        headers: { "x-cutroom-agent": "external" },
      })
    ).ok(),
  ).toBe(true);
  await upload(blue, true);
  await expect.poll(pixel).toEqual([0, 0, 254]);
  await expect(page.locator("[data-agent-change]")).toHaveCount(1);
  const view = TimelineViewSchema.parse(
    await (await request.get(`${base}/timeline`)).json(),
  );
  expect(view.agentChanges).toEqual(["title"]);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Accept agent changes", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("asset-after.png") });
  await page
    .getByRole("button", { name: "Accept agent changes", exact: true })
    .click();
  await expect(page.locator("[data-agent-change]")).toHaveCount(0);
  expect((await request.delete(`${media}/files/card.png`)).ok()).toBe(true);
  await upload(red);
  await expect.poll(pixel).toEqual([253, 0, 0]);
  expect(
    TimelineViewSchema.parse(
      await (await request.get(`${base}/timeline`)).json(),
    ).agentChanges,
  ).toEqual([]);
  await expect(page.locator("[data-agent-change]")).toHaveCount(0);
});
