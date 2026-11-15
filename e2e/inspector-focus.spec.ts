import type { APIRequestContext, Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { seekFrame } from "./position-helpers";
import { expect, test } from "./fixtures";

/** A project with one title selected and the playhead inside it, its inspector open. */
async function openTitle(page: Page, request: APIRequestContext) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Inspector focus", duration: 12 },
      })
    ).json(),
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const view = TimelineViewSchema.parse(
    await (await request.get(`${api}/timeline`)).json(),
  );
  const response = await request.post(`${api}/commands`, {
    data: {
      expectedRevision: view.revision,
      commands: [
        { type: "setTrack", index: 3, kind: "video" },
        {
          type: "insert",
          track: 3,
          at: 0,
          clip: { kind: "title", id: "lower", text: "Ada", duration: 300 },
        },
      ],
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  const title = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${api}/timeline`)).json(),
    ).timeline.clips.find((clip) => clip.id === "lower")?.title;
  await page.goto(`/#project/${project.id}`);
  await page.locator('.tl-lanes [data-clip="lower"]').click();
  await seekFrame(page, 60);
  const clock = page.getByRole("button", {
    name: "Current time. Click to type a time.",
    exact: true,
  });
  return {
    inspector: page.getByRole("complementary", { name: "Inspector" }),
    title,
    clock,
  };
}

test("a pointer click on Plate or Align gives Space and the arrows back to the transport", async ({
  page,
  request,
}, info) => {
  const { inspector, title, clock } = await openTitle(page, request);
  const plate = inspector.getByRole("checkbox", { name: "Plate" });

  await plate.click();
  await expect.poll(async () => (await title())?.plate).not.toBeNull();
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("button", { name: "Play forward", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("k");
  await expect(plate).toBeChecked();
  expect((await title())?.plate).not.toBeNull();

  const left = inspector.getByRole("radio", { name: "Align left" });
  await left.click();
  await expect.poll(async () => (await title())?.align).toBe("left");
  const before = await clock.textContent();
  await page.keyboard.press("ArrowRight");
  await expect(clock).not.toHaveText(before!);
  await expect(left).toHaveAttribute("aria-checked", "true");
  expect((await title())?.align).toBe("left");
  await page.screenshot({ path: info.outputPath("after-align.png") });
});

test("a colour picked with the pointer gives the keys back to the transport", async ({
  page,
  request,
}) => {
  const { inspector, title } = await openTitle(page, request);
  const swatch = inspector.getByLabel("Colour", { exact: true });
  // A pointer press opens the system picker, which closes on its colour with a change event.
  // Headless Chromium's picker would keep the keys, so the press focuses the swatch without it.
  await swatch.dispatchEvent("pointerdown");
  await swatch.evaluate((input: HTMLInputElement) => {
    input.focus();
    input.value = "#00ff88";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect.poll(async () => (await title())?.color).toBe("#00ff88");
  await page.keyboard.press("l");
  await expect(
    page.getByRole("button", { name: "Play forward", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("k");
});

test("a keyboard user on Plate keeps focus and Space toggles it", async ({
  page,
  request,
}) => {
  const { inspector, title, clock } = await openTitle(page, request);
  const plate = inspector.getByRole("checkbox", { name: "Plate" });
  for (let tab = 0; tab < 80; tab++) {
    if (await plate.evaluate((element) => element === document.activeElement))
      break;
    await page.keyboard.press("Tab");
  }
  await expect(plate).toBeFocused();
  const before = await clock.textContent();
  await page.keyboard.press("Space");
  await expect(plate).toBeChecked();
  await expect(plate).toBeFocused();
  await expect.poll(async () => (await title())?.plate).not.toBeNull();
  await page.keyboard.press("Space");
  await expect(plate).not.toBeChecked();
  await expect.poll(async () => (await title())?.plate).toBeNull();
  await expect(plate).toBeFocused();
  await expect(clock).toHaveText(before!);
});
