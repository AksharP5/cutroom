import { cp, copyFile } from "node:fs/promises";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { z } from "zod";
import { ReviewItemSchema } from "../src/shared/review";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";
import { afterPaint, seekFrame } from "./position-helpers";

async function open(page: Page, request: APIRequestContext, variant: string) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: `Animation ${variant}` },
      })
    ).json(),
  );
  await cp(
    join(import.meta.dirname, "fixtures/title-sync", variant),
    project.path,
    { recursive: true },
  );
  await copyFile(
    "node_modules/gsap/dist/gsap.min.js",
    join(project.path, "gsap.min.js"),
  );
  await page.addInitScript(() => {
    const reports: unknown[] = [];
    Object.assign(window, { animationReports: reports });
    addEventListener("message", (event) => {
      if (
        event.data?.source === "cutroom-preview" &&
        event.data?.type === "animation-windows"
      )
        reports.push(event.data.windows);
    });
  });
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  await expect(page.locator(".tl-grid")).toHaveAttribute(
    "data-refit",
    "settled",
  );
  const base = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${base}/timeline`)).json(),
    );
  return { base, read };
}

async function removeShot(page: Page) {
  await seekFrame(page, 36 * 30 + 8);
  await page.locator('[data-clip="shot-b"]').click();
  await afterPaint(page, () => page.keyboard.press("Shift+x"));
}

test("Shift+X warns when a helper-built title leaves its animation behind and Ask agent saves a Review note", async ({
  page,
  request,
}, info) => {
  const { base, read } = await open(page, request, "absolute-hard");
  await removeShot(page);
  await expect(
    page.locator(".toast").filter({ hasText: "Removed 18:00" }),
  ).toContainText("Undo");
  await expect
    .poll(
      async () =>
        (await read()).timeline.clips.find((clip) => clip.id === "cta")?.start,
    )
    .toBe(18 * 30);
  await page.locator('[data-clip="cta"]').click();
  await seekFrame(page, 18 * 30 + 8);
  await expect(
    page.locator(".toast").filter({ hasText: "Removed 18:00" }),
  ).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("after-edit.png") });
  const warning = page
    .locator(".toast")
    .filter({ hasText: "Call to action's animation stayed at 00:00:36:00." });
  await expect(warning).toBeVisible();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.locator(".inspector-timing")).toContainText(
    "Animation plays at 00:00:36:00, outside this clip.",
  );
  await expect(
    inspector.getByRole("button", { name: "Ask agent", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("animation-warning.png") });
  await warning.getByRole("button", { name: "Ask agent", exact: true }).click();
  const notes = async () =>
    z
      .object({ items: z.array(ReviewItemSchema) })
      .parse(await (await request.get(`${base}/review`)).json()).items;
  await expect.poll(async () => (await notes()).length).toBe(1);
  const note = (await notes())[0]!;
  expect(note.body).toBe(
    "Make this clip's animation follow the clip. Its tweens are at absolute timeline seconds (36.00 s) and the clip now starts at 18.00 s. Move the title into its own sub-composition file with a timeline in clip-local seconds. Keep the look and the timing relative to the clip's start. Check the first second of the clip with timeline_view.",
  );
  expect(note.time).toBe(18);
  expect(note.elementId).toBe("cta");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Review notes" }),
  ).toContainText(note.body);
  await page.reload();
  await expect.poll(async () => (await notes()).length).toBe(1);
});

test("Shift+X keeps a sub-composition title attached without an animation warning", async ({
  page,
  request,
}) => {
  await open(page, request, "sub-composition");
  await removeShot(page);
  await page.locator('[data-clip="cta"]').click();
  await seekFrame(page, 18 * 30 + 8);
  await expect
    .poll(() =>
      page
        .frameLocator("iframe[data-live]")
        .locator("#cta-text")
        .evaluate((element) => Number(getComputedStyle(element).opacity)),
    )
    .toBeGreaterThan(0.5);
  await expect(page.locator(".inspector-timing")).not.toContainText(
    "Animation plays at",
  );
  await expect(
    page
      .locator(".toast")
      .filter({ hasText: /animation stayed|animation behind/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Play forward", exact: true }).click();
  await page.waitForTimeout(1100);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.frameLocator("iframe[data-live]").locator("#cta-text"),
  ).toHaveCSS("opacity", "1");
  // Confirm the negative result came from the new report, rather than a missing bridge.
  // Playback must not publish more window reports.
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "animationReports")))
    .toEqual([
      { "shot-a": [], "shot-b": [], "shot-c": [], cta: [] },
      { "shot-a": [], "shot-c": [], cta: [] },
    ]);
});
