import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { compactLint } from "../src/shared/lint";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";
import { seekFrame } from "./position-helpers";
import { waitForPreview } from "./preview-ready";

const composition = "compositions/slate.html";
const entry = `<!doctype html><html><head><style>html,body{margin:0}</style><script src="assets/vendor/gsap.min.js"></script></head><body>
<main id="main" data-composition-id="main" data-no-timeline data-width="640" data-height="360" data-fps="30" data-duration="4">
  <div id="slate" class="clip" data-composition-id="slate" data-composition-src="${composition}" data-start="0" data-duration="4" data-track-index="0" data-width="640" data-height="360"></div>
</main></body></html>`;
const authored = `<template id="slate-template"><style>
#slate-root{position:relative;width:640px;height:360px;background:#171a24;color:#faf5e6;font-family:system-ui,sans-serif}
#graphic{position:absolute;top:90px;left:64px;width:512px;border-top:2px solid #e8bd85;padding-top:15px}
#heading{font-size:22px;margin:0;color:#e8bd85}#subtitle{font-size:52px;font-weight:700;margin:6px 0}#footer{font-size:19px;margin:0;color:#d0c6bb}
#flat{position:absolute;bottom:12px;right:20px;color:#a09b96}
</style><div id="slate-root" data-composition-id="slate" data-no-timeline data-width="640" data-height="360" data-fps="30" data-duration="4">
<div id="flat" class="clip" data-start="0" data-duration="4" data-track-index="0">April 2026</div>
<div id="graphic" class="clip" data-timeline-label="Launch slate" data-start="0.5" data-duration="3" data-track-index="1">
  <h2 id="heading">Field notes</h2>
  <p id="subtitle">Spring release</p>
  <div><p id="footer">Design team</p></div>
</div>
</div></template>`;

test("Inspector edits one nested text layer in the live viewer and one Undo restores it", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Launch slate", width: 640, height: 360, duration: 4 },
      })
    ).json(),
  );
  const index = join(project.path, "index.html");
  const file = join(project.path, composition);
  await mkdir(join(project.path, "compositions"), { recursive: true });
  await Promise.all([writeFile(index, entry), writeFile(file, authored)]);
  const lint = compactLint(
    await (await request.get(`/api/projects/${project.id}/lint`)).json(),
  );
  expect(lint.findings.filter(({ severity }) => severity === "error")).toEqual(
    [],
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const timelinePlacement = async () => {
    const { timeline } = TimelineViewSchema.parse(
      await (
        await request.get(
          `${api}/timeline?${new URLSearchParams({ composition })}`,
        )
      ).json(),
    );
    return timeline.clips.map(({ id, track, start, duration }) => ({
      id,
      track,
      start,
      duration,
    }));
  };
  const historySteps = async () =>
    z
      .object({
        entries: z.array(z.object({ label: z.string(), undone: z.boolean() })),
      })
      .parse(await (await request.get(`${api}/history`)).json())
      .entries.filter(
        ({ label, undone }) => label === "Edit layer text" && !undone,
      ).length;
  const placement = await timelinePlacement();

  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page);
  await page.locator('.tl-lanes [data-clip="slate"]').dblclick();
  await expect(
    page.getByRole("navigation", { name: "Composition" }),
  ).toHaveText(/Launch slate.*slate/);
  await expect(page.locator("iframe[data-live]")).toHaveAttribute(
    "src",
    /composition=compositions%2Fslate\.html/,
  );
  await seekFrame(page, 30);
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const picker = inspector.getByRole("combobox", { name: "Text layer" });
  const field = inspector.getByRole("textbox", {
    name: "Layer text",
    exact: true,
  });
  await page.locator('.tl-lanes [data-clip="flat"]').click();
  await expect(
    inspector.getByRole("textbox", { name: "Text", exact: true }),
  ).toHaveValue("April 2026");
  await expect(picker).toHaveCount(0);
  await page.locator('.tl-lanes [data-clip="graphic"]').click();
  await picker.click();
  await page.getByRole("option", { name: "subtitle", exact: true }).click();
  await expect(picker).toHaveAttribute("aria-expanded", "false");
  await expect(field).toHaveValue("Spring release");

  const viewer = page.frameLocator("iframe[data-live]");
  const subtitle = viewer.locator("#subtitle");
  await expect(subtitle).toBeVisible();
  await expect(subtitle).toHaveText("Spring release");
  const evidence =
    process.env.CUTROOM_LAYER_TEXT_EVIDENCE ?? info.outputPath("evidence");
  await mkdir(evidence, { recursive: true });
  const screenshot = (name: string) =>
    page.screenshot({
      path: join(evidence, `${name}.png`),
      animations: "disabled",
    });
  await screenshot("before");
  await field.fill("Autumn release");
  await field.press("Enter");
  await expect(subtitle).toBeVisible();
  await expect(subtitle).toHaveText("Autumn release");
  await expect(field).toHaveValue("Autumn release");
  await expect(viewer.locator("#heading")).toHaveText("Field notes");
  await expect(viewer.locator("#footer")).toHaveText("Design team");
  await expect.poll(historySteps).toBe(1);
  expect(await readFile(file, "utf8")).toBe(
    authored.replace("Spring release", "Autumn release"),
  );
  expect(await readFile(index, "utf8")).toBe(entry);
  expect(await timelinePlacement()).toEqual(placement);
  await screenshot("after");

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(subtitle).toBeVisible();
  await expect(subtitle).toHaveText("Spring release");
  await expect(field).toHaveValue("Spring release");
  await expect.poll(historySteps).toBe(0);
  expect(await readFile(file, "utf8")).toBe(authored);
  expect(await timelinePlacement()).toEqual(placement);
  await screenshot("undo");
});
