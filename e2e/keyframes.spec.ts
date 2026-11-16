import { expect, test } from "./fixtures";
import { createPositionProject, seekFrame } from "./position-helpers";

const box = `<!doctype html><html><head><style>html,body{margin:0;background:#000}#box{position:absolute;left:220px;top:130px;width:200px;height:100px;background:#00ff00}</style></head><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-fps="30" data-duration="2"><div id="box" class="clip" data-start="0" data-duration="2" data-track-index="0"></div></main></body></html>`;

test("an agent's keyframes play in the open viewer at the frames between them, and a later keyframe edit reloads it", async ({
  page,
  request,
}) => {
  const project = await createPositionProject(
    request,
    { name: "Keyframes", width: 640, height: 360, duration: 2 },
    box,
  );
  const base = `/api/cutroom/projects/${project.id}`;
  const revision = async () =>
    (
      (await (await request.get(`${base}/timeline`)).json()) as {
        revision: string;
      }
    ).revision;
  const send = async (commands: unknown[]) =>
    expect(
      (
        await request.post(`${base}/commands`, {
          data: { expectedRevision: await revision(), commands },
        })
      ).ok(),
    ).toBe(true);
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator('[data-clip="box"]')).toBeVisible();
  const shown = () =>
    page
      .frameLocator("iframe[data-live]")
      .locator("#box")
      .evaluate((element) => ({
        left: Math.round(element.getBoundingClientRect().left),
        opacity: Number(getComputedStyle(element).opacity),
      }));

  // The box fades up and slides 200 px right over its first second.
  await send([
    {
      type: "setKeyframe",
      clipId: "box",
      property: "opacity",
      frame: 0,
      value: 0,
    },
    {
      type: "setKeyframe",
      clipId: "box",
      property: "opacity",
      frame: 30,
      value: 1,
    },
    {
      type: "setKeyframe",
      clipId: "box",
      property: "position",
      frame: 0,
      value: { x: 0, y: 0 },
    },
    {
      type: "setKeyframe",
      clipId: "box",
      property: "position",
      frame: 30,
      value: { x: 200 },
    },
  ]);
  await seekFrame(page, 15);
  await expect.poll(shown).toEqual({ left: 320, opacity: 0.5 });
  await seekFrame(page, 45);
  await expect.poll(shown).toEqual({ left: 420, opacity: 1 });

  // Holding the slide's first keyframe keeps the box in place until the second.
  await send([
    {
      type: "setKeyframe",
      clipId: "box",
      property: "position",
      frame: 0,
      ease: "hold",
    },
    { type: "removeKeyframe", clipId: "box", property: "opacity", frame: 0 },
  ]);
  await seekFrame(page, 15);
  await expect.poll(shown).toEqual({ left: 220, opacity: 1 });
});
