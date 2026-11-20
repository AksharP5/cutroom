import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createPositionProject, seekFrame } from "./position-helpers";

// A 640x360 frame: a dark screen with a green button right of centre.
const screen = `<!doctype html><html><head><style>html,body{margin:0;background:#000}#screen{position:absolute;inset:0;background:#202020}#screen i{position:absolute;left:400px;top:90px;width:80px;height:30px;background:#00ff00}</style></head><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-fps="30" data-duration="3"><div id="screen" class="clip" data-start="0" data-duration="3" data-track-index="0"><i></i></div></main></body></html>`;

type Region = {
  effect: string;
  box: { x: number; y: number; width: number; height: number };
  ease: string;
};
type Clip = { id: string; adjustment: boolean; region: Region | null };

async function open(
  page: Page,
  request: Parameters<typeof createPositionProject>[0],
) {
  const project = await createPositionProject(
    request,
    { name: "Regions", width: 640, height: 360, duration: 3 },
    screen,
  );
  const clips = async () =>
    (
      (await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json()) as { timeline: { clips: Clip[] } }
    ).timeline.clips;
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator('[data-clip="screen"]')).toBeVisible();
  await seekFrame(page, 15);
  return {
    clips,
    layer: async () => (await clips()).find((clip) => clip.adjustment),
  };
}

/** A point of the picture, in fractions of the frame. */
async function at(page: Page, x: number, y: number) {
  const box = (await page.locator(".edit-picture").boundingBox())!;
  return { x: box.x + x * box.width, y: box.y + y * box.height };
}
async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step++)
    await page.mouse.move(
      from.x + ((to.x - from.x) * step) / 8,
      from.y + ((to.y - from.y) * step) / 8,
    );
  await page.mouse.up();
}

test("a zoom drawn on the picture lands on an adjustment layer, aims by dragging and undoes one gesture at a time", async ({
  page,
  request,
}) => {
  const { layer } = await open(page, request);
  await page.keyboard.press("h");
  await expect(
    page.getByRole("button", { name: "Zoom and highlight H" }),
  ).toHaveAttribute("aria-pressed", "true");

  // A drag over the button's corner of the frame: a box of the frame's shape, a quarter wide.
  await drag(page, await at(page, 0.55, 0.2), await at(page, 0.8, 0.45));
  await expect
    .poll(async () => (await layer())?.region?.box)
    .toEqual({
      x: 0.55,
      y: 0.2,
      width: 0.25,
      height: 0.25,
    });
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(
    inspector.getByRole("textbox", { name: "Zoom", exact: true }),
  ).toHaveValue("400%");

  // Dragging the box's middle moves it; the move is one undo step.
  await drag(page, await at(page, 0.675, 0.325), await at(page, 0.575, 0.375));
  await expect
    .poll(async () => (await layer())?.region?.box.x)
    .toBeCloseTo(0.45, 2);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await layer())?.region?.box.x).toBe(0.55);
  // And one more removes the layer the drawing added.
  await page.keyboard.press("Control+z");
  await expect.poll(layer).toBeUndefined();
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(async () => (await layer())?.region?.box.x).toBe(0.55);
});

test("aiming shows the whole frame, and the result shows the zoom the export draws", async ({
  page,
  request,
}) => {
  const { layer } = await open(page, request);
  await page.keyboard.press("h");
  await drag(page, await at(page, 0.55, 0.2), await at(page, 0.8, 0.45));
  await expect.poll(async () => (await layer())?.region?.effect).toBe("zoom");
  // Past the layer's half-second ramp in.
  await seekFrame(page, 40);
  const depth = () =>
    page
      .frameLocator("iframe[data-live]")
      .locator("#screen")
      .evaluate((element) =>
        Number.parseFloat(
          getComputedStyle(element).translate.split(" ")[2] ?? "0",
        ),
      );
  // While aiming every zoom is set aside; the result brings it back at the playhead's frame,
  // past the ramp in: 1000 px of perspective times (1 - 1/4).
  await expect.poll(depth).toBe(0);
  await page.getByRole("radio", { name: "Result" }).click();
  await expect.poll(depth).toBeCloseTo(750, 0);
  await page.getByRole("radio", { name: "Aim" }).click();
  await expect.poll(depth).toBe(0);
  await page.keyboard.press("Escape");
  await expect.poll(depth).toBeCloseTo(750, 0);
});

test("the inspector edits a layer's effect, ramps and ease, and a blur follows its box on the picture", async ({
  page,
  request,
}) => {
  const { layer } = await open(page, request);
  await page.keyboard.press("h");
  await page.getByRole("radio", { name: "Blur" }).click();
  await drag(page, await at(page, 0.6, 0.2), await at(page, 0.8, 0.4));
  await expect.poll(async () => (await layer())?.region?.effect).toBe("blur");
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    "**/api/cutroom/projects/*/commands",
    async (route) => {
      const response = await route.fetch();
      await held;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  try {
    await inspector.getByRole("radio", { name: "Exponential out" }).click();
    await expect
      .poll(async () => (await layer())?.region?.ease)
      .toBe("expo-out");
    // Change the effect while the editor is still waiting for the ease edit's answer.
    await inspector.getByRole("radio", { name: "Highlight" }).click();
  } finally {
    release();
  }
  await expect
    .poll(async () => (await layer())?.region?.effect)
    .toBe("highlight");
  // The highlight keeps the box the blur had.
  expect((await layer())?.region?.box).toEqual({
    x: 0.6,
    y: 0.2,
    width: 0.2,
    height: 0.2,
  });
  const look = () =>
    page
      .frameLocator("iframe[data-live]")
      .locator("[data-cutroom-adjustment]")
      .evaluate((element) => getComputedStyle(element).backdropFilter);
  await expect.poll(look).toContain("brightness");
});
