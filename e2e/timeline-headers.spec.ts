import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import type { TimelineViewSettings } from "../src/shared/timeline/view";
import { startMediaDrag } from "./media-drag";
import { expect, test } from "./fixtures";

test.use({
  launchOptions: {
    executablePath: process.env.CUTROOM_BROWSER_PATH ?? "/usr/bin/chromium",
    args: [
      "--mute-audio",
      "--no-sandbox",
      "--use-fake-device-for-media-stream",
    ],
  },
});

async function createProject(
  request: APIRequestContext,
  settings: TimelineViewSettings,
) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Timeline headers", duration: 20 },
      })
    ).json(),
  );
  await writeFile(
    join(project.path, "index.html"),
    `<main data-composition-id="main" data-duration="20" data-fps="30">${[
      0, 2, 4, 6,
    ]
      .map(
        (index) =>
          `<div class="clip" data-start="0" data-duration="20" data-track-index="${index}">Title</div><audio src="missing.wav" data-start="0" data-duration="20" data-track-index="${index + 1}"></audio>`,
      )
      .join("")}</main>`,
  );
  await writeFile(
    join(project.path, "Picture.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="red"/></svg>',
  );
  expect(
    (
      await request.put(`/api/cutroom/projects/${project.id}/timeline-view`, {
        data: settings,
      })
    ).ok(),
  ).toBe(true);
  return project;
}

for (const [width, height] of [
  [1280, 800],
  [1720, 1050],
] as const) {
  for (const dpr of [1, 2]) {
    test.describe(`compact headers at ${width}x${height}, DPR ${dpr}`, () => {
      test.use({
        viewport: { width, height },
        deviceScaleFactor: dpr,
        permissions: ["microphone"],
      });
      test("names, icons and armed audio controls fit on one row", async ({
        page,
        request,
      }) => {
        const project = await createProject(request, {
          density: "compact",
          heights: {
            "0": 28,
            "1": 28,
            "2": 32,
            "3": 32,
            "4": 36,
            "5": 36,
            "6": 39,
            "7": 39,
          },
        });
        await page.goto(`/#project/${project.id}`);
        await expect(page.locator(".tl-head")).toHaveCount(8);
        for (const armed of [false, true]) {
          if (armed) {
            await page
              .getByRole("button", { name: "Arm A1", exact: true })
              .click();
            await expect(
              page.getByRole("button", { name: "Arm A1", exact: true }),
            ).toHaveAttribute("aria-pressed", "true");
            await expect(
              page.locator(".tl-head-title > .tl-meters-compact"),
            ).toHaveCount(1);
          }
          const controls = await page.locator(".tl-head").evaluateAll((rows) =>
            rows.flatMap((row) => {
              const bounds = row.getBoundingClientRect();
              const name = row
                .querySelector(".tl-head-name")!
                .getBoundingClientRect();
              return [
                ...row.querySelectorAll(
                  ".tl-track-button, .vo-input, .tl-head-name, .tl-head-title > .tl-meters-compact, .tl-track-button > svg, .vo-input > svg",
                ),
              ].map((element) => {
                const box = element.getBoundingClientRect();
                return {
                  label:
                    element.getAttribute("aria-label") ??
                    element.closest("button")?.getAttribute("aria-label") ??
                    element.tagName,
                  insetTop: box.top - bounds.top,
                  insetBottom: bounds.bottom - box.bottom,
                  insetLeft: box.left - bounds.left,
                  insetRight: bounds.right - box.right,
                  height: box.height,
                  width: box.width,
                  centerOffset: Math.abs(
                    box.top + box.height / 2 - name.top - name.height / 2,
                  ),
                  button: element.matches("button"),
                };
              });
            }),
          );
          for (const control of controls) {
            expect(control.insetTop, control.label).toBeGreaterThanOrEqual(2);
            expect(control.insetBottom, control.label).toBeGreaterThanOrEqual(
              2,
            );
            expect(control.insetLeft, control.label).toBeGreaterThanOrEqual(0);
            expect(control.insetRight, control.label).toBeGreaterThanOrEqual(0);
            expect(control.centerOffset, control.label).toBeLessThanOrEqual(
              0.5,
            );
            expect(control.width, control.label).toBeGreaterThan(10);
            if (control.button)
              expect(control.height, control.label).toBeGreaterThanOrEqual(20);
          }
          await page.screenshot({
            path: test
              .info()
              .outputPath(`compact-${armed ? "armed" : "idle"}.png`),
          });
        }
      });
    });
  }

  for (const trackHeight of [28, 200]) {
    test.describe(`media drag at ${width}x${height}, ${trackHeight}px tracks`, () => {
      test.use({ viewport: { width, height } });
      test("keeps lanes still and previews the track created above them", async ({
        page,
        request,
      }) => {
        const project = await createProject(request, {
          density: trackHeight === 28 ? "compact" : "tall",
          heights: { "0": trackHeight, "6": trackHeight },
        });
        await page.goto(`/#project/${project.id}`);
        await expect(page.locator(".tl-grid")).toHaveAttribute(
          "data-refit",
          "settled",
        );
        const positions = () =>
          page.locator(".tl-lane").evaluateAll((rows) =>
            rows.map((row) => ({
              index: row.getAttribute("data-row"),
              y: row.getBoundingClientRect().y,
            })),
          );
        const before = await positions();
        await startMediaDrag(
          page,
          page
            .getByRole("region", { name: "Media", exact: true })
            .getByRole("listitem")
            .filter({ hasText: "Picture.svg" }),
        );
        expect(await positions()).toEqual(before);
        const band = (await page.locator(".tl-drop-above").boundingBox())!;
        await page.mouse.move(band.x + 50, band.y + band.height / 2, {
          steps: 12,
        });
        const ghost = page.locator(".tl-ghost");
        await expect(ghost).toContainText("New video track");
        const preview = (await ghost.boundingBox())!;
        expect(await positions()).toEqual(before);
        expect(preview.y).toBe(before[0]!.y + 1);
        expect(preview.height).toBe((trackHeight === 28 ? 32 : 96) - 2);
        await page.mouse.up();
        await expect
          .poll(async () =>
            TimelineViewSchema.parse(
              await (
                await request.get(
                  `/api/cutroom/projects/${project.id}/timeline`,
                )
              ).json(),
            ).timeline.clips.some((clip) => clip.src === "Picture.svg"),
          )
          .toBe(true);
        const created = page.locator(".tl-clip.image");
        await expect(created).toBeVisible();
        const actual = (await created.boundingBox())!;
        expect(actual.y).toBe(preview.y);
        expect(actual.height).toBe(preview.height);
      });
    });
  }
}

test("track density uses the shared menu keyboard controls", async ({
  page,
  request,
}) => {
  const project = await createProject(request, {
    density: "normal",
    heights: {},
  });
  await page.goto(`/#project/${project.id}`);
  const trigger = page.getByRole("combobox", {
    name: "Track density",
    exact: true,
  });
  const list = page.getByRole("listbox", {
    name: "Track density options",
    exact: true,
  });
  await trigger.focus();
  for (const key of ["Enter", "Space", "ArrowDown", "ArrowUp"]) {
    await trigger.press(key);
    await expect(
      list.getByRole("option", { name: "Normal", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    await expect(trigger).toBeFocused();
  }
  await trigger.press("Enter");
  await page.keyboard.press("Home");
  await expect(
    list.getByRole("option", { name: "Compact", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    list.getByRole("option", { name: "Tall", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveText("Compact");
  await expect(trigger).toBeFocused();
  await expect(
    page.getByRole("separator", { name: "Height V1", exact: true }),
  ).toHaveAttribute("aria-valuenow", "32");
  await trigger.press("Space");
  await page.keyboard.press("n");
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveText("Normal");
  await expect(trigger).toBeFocused();
  await expect(
    page.getByRole("separator", { name: "Height V1", exact: true }),
  ).toHaveAttribute("aria-valuenow", "56");
});
