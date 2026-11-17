import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";
import {
  afterPaint,
  createPositionProject,
  positionField,
  seekFrame,
} from "./position-helpers";
import { waitForPreview } from "./preview-ready";

test("a positioned graphic keeps its saved offset through lift undo, toggling and split", async ({
  page,
  request,
}, info) => {
  const project = await createPositionProject(
    request,
    { name: "Position reinsertion", width: 640, height: 360, duration: 6 },
    `<!doctype html><html><head><style>html,body{margin:0;background:#142039}main{position:relative;width:640px;height:360px}.graphic{position:absolute;width:100px;height:50px}.subject{left:60px;top:100px;background:lime}.anchor{left:460px;top:230px;background:white}</style></head><body><main id="main" data-composition-id="main" data-no-timeline data-width="640" data-height="360" data-fps="30" data-duration="6"><div id="graphic" class="clip graphic subject" data-start="0" data-duration="4" data-track-index="0"></div><div id="anchor" class="clip graphic anchor" data-start="5" data-duration="1" data-track-index="0"></div></main></body></html>`,
  );
  const path = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${path}/timeline`)).json(),
    );
  const edit = async (commands: CommandInput[]) => {
    const response = await request.post(`${path}/commands`, {
      data: {
        composition: "index.html",
        expectedRevision: (await read()).revision,
        label: "Position reinsertion",
        commands,
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
  };
  // Establish the managed track sheet before loading. The anchor keeps it through lift.
  await edit([
    { type: "move", clipIds: ["graphic"], by: 1, mode: "overwrite" },
  ]);
  await edit([
    { type: "move", clipIds: ["graphic"], by: -1, mode: "overwrite" },
  ]);
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page, { timing: true });
  await page.locator('[data-clip="graphic"]').click();
  for (const [axis, value] of [
    ["X", "120"],
    ["Y", "-30"],
  ] as const) {
    const field = positionField(page, `Position ${axis}`);
    await field.fill(value);
    await afterPaint(page, () => field.press("Enter"));
  }
  await waitForPreview(page, { timing: true });
  // Start the structural edit from a freshly loaded, correctly positioned document.
  await page.reload();
  await waitForPreview(page, { timing: true });
  const document = () => page.locator("iframe[data-live]").getAttribute("src");
  const bounds = (tab: Page, clipId = "graphic") =>
    tab
      .frameLocator("iframe[data-live]")
      .locator(`[data-hf-cutroom-clip-id="${clipId}"]`)
      .evaluate((el) => {
        const { x, y, width, height } = el.getBoundingClientRect();
        return { x, y, width, height };
      });
  const saved = { x: 180, y: 70, width: 100, height: 50 };
  await expect.poll(() => bounds(page)).toEqual(saved);
  await seekFrame(page, 30);
  await page.locator('[data-clip="graphic"]').click();
  const positioned = await document();
  const source = await readFile(join(project.path, "index.html"), "utf8");
  const styles = (html: string) =>
    html.match(/<style\b[^>]*>[\s\S]*?<\/style>/g);

  const undo = () =>
    afterPaint(page, () =>
      page.getByRole("button", { name: "Undo", exact: true }).click(),
    );
  const matchesFresh = async (label: string, visible = true, frame = 30) => {
    const control = await page.context().newPage();
    try {
      await control.goto(`/#project/${project.id}`);
      await waitForPreview(control);
      await seekFrame(page, frame);
      await seekFrame(control, frame);
      const actual = await page.locator("iframe[data-live]").screenshot();
      const fresh = await control.locator("iframe[data-live]").screenshot();
      await info.attach(`${label} actual.png`, {
        body: actual,
        contentType: "image/png",
      });
      await info.attach(`${label} fresh.png`, {
        body: fresh,
        contentType: "image/png",
      });
      if (visible) {
        const clip = (await read()).timeline.clips.find(
          (clip) =>
            clip.x === 120 &&
            clip.start <= frame &&
            clip.start + clip.duration > frame,
        );
        if (!clip) throw new Error("Positioned graphic missing from timeline");
        expect(await bounds(control, clip.id)).toEqual(saved);
        expect(await bounds(page, clip.id)).toEqual(saved);
      }
      expect(actual.equals(fresh), label).toBe(true);
    } finally {
      await control.close();
    }
  };

  // Native Lift and Undo exercise the same command/history path as agent edits below.
  await page.getByRole("button", { name: /^Current time/ }).focus();
  await afterPaint(page, () => page.keyboard.press("Backspace"));
  await expect(
    page.frameLocator("iframe[data-live]").locator("#graphic"),
  ).toHaveCount(0);
  expect(await document()).toBe(positioned);
  expect(
    styles(await readFile(join(project.path, "index.html"), "utf8")),
  ).toEqual(styles(source));
  await undo();
  await matchesFresh("undo lift");
  expect(await document()).not.toBe(positioned);

  for (const enabled of [false, true]) {
    await afterPaint(page, () =>
      edit([{ type: "setClip", clipId: "graphic", enabled }]),
    );
    await matchesFresh(`enabled ${enabled}`, enabled);
  }
  await afterPaint(page, () =>
    edit([{ type: "split", clipIds: ["graphic"], at: 60 }]),
  );
  await matchesFresh("split", true, 90);
  await seekFrame(page, 30);
  await undo();
  await matchesFresh("undo split");
  // Ordinary timing edits still update in place, including their undo.
  await waitForPreview(page, { timing: true });
  const beforeMove = await document();
  await afterPaint(page, () =>
    edit([{ type: "move", clipIds: ["graphic"], by: 1, mode: "overwrite" }]),
  );
  expect(await document()).toBe(beforeMove);
  await matchesFresh("move");
  await undo();
  expect(await document()).toBe(beforeMove);
  await matchesFresh("undo move");
});
