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

test("the inspector keys Position at the playhead, shows the value between keyframes, and a diamond drags to retime", async ({
  page,
  request,
}) => {
  const project = await createPositionProject(
    request,
    { name: "Keyframes inspector", width: 640, height: 360, duration: 2 },
    box,
  );
  const timeline = async () =>
    (
      (await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json()) as {
        timeline: { clips: { keyframes: unknown }[] };
      }
    ).timeline.clips[0]!.keyframes;
  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="box"]').click();
  const x = page.getByRole("textbox", { name: "Position X", exact: true });
  const diamond = page.getByRole("button", {
    name: "Position keyframe",
    exact: true,
  });
  const left = () =>
    page
      .frameLocator("iframe[data-live]")
      .locator("#box")
      .evaluate((element) => Math.round(element.getBoundingClientRect().left));

  // The diamond keys the value shown; typing a value at another frame keys it there.
  await seekFrame(page, 0);
  await diamond.click();
  await expect(diamond).toHaveAttribute("aria-pressed", "true");
  await seekFrame(page, 30);
  await expect(diamond).toHaveAttribute("aria-pressed", "false");
  await x.fill("200");
  await x.press("Enter");
  await expect(diamond).toHaveAttribute("aria-pressed", "true");
  await expect.poll(timeline).toEqual({
    position: [
      { frame: 0, value: { x: 0, y: 0 }, ease: "linear" },
      { frame: 30, value: { x: 200, y: 0 }, ease: "linear" },
    ],
  });

  // Between keyframes the field and the picture show the interpolated value.
  await seekFrame(page, 10);
  await expect(x).toHaveValue("66.67 px");
  await expect.poll(left).toBe(287);

  // Dragging the second diamond along the clip retimes it, as one undo step.
  const second = page.locator('[data-keyframe="box:30"]');
  const first = page.locator('[data-keyframe="box:0"]');
  const [from, origin] = [
    (await second.boundingBox())!,
    (await first.boundingBox())!,
  ];
  const perFrame = (from.x - origin.x) / 30;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    from.x + from.width / 2 + perFrame * 15,
    from.y + from.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(page.locator('[data-keyframe="box:45"]')).toBeVisible();
  await expect
    .poll(async () => JSON.stringify(await timeline()))
    .toContain('"frame":45');
  await page.keyboard.press("Control+z");
  await expect(page.locator('[data-keyframe="box:30"]')).toBeVisible();
});

test("Resolve's keyframe keys add, hold, step between and delete keyframes, and a diamond's menu sets its ease", async ({
  page,
  request,
}) => {
  const project = await createPositionProject(
    request,
    { name: "Keyframe keys", width: 640, height: 360, duration: 2 },
    box,
  );
  const keyframes = async () =>
    (
      (await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json()) as {
        timeline: {
          clips: {
            keyframes: Record<string, { frame: number; ease: string }[]> | null;
          }[];
        };
      }
    ).timeline.clips[0]!.keyframes;
  const playhead = page.getByRole("button", {
    name: "Current time. Click to type a time.",
    exact: true,
  });
  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="box"]').click();

  // Ctrl+[ keys every transform property on a clip with none; its opacity stays the page's.
  await seekFrame(page, 10);
  await page.keyboard.press("Control+BracketLeft");
  await expect
    .poll(async () => Object.keys((await keyframes()) ?? {}))
    .toEqual(["position", "scale", "rotation", "crop"]);
  // Ctrl+] adds a held keyframe on the same properties, drawn square.
  await seekFrame(page, 40);
  await page.keyboard.press("Control+BracketRight");
  await expect(page.locator('[data-keyframe="box:40"]')).toHaveAttribute(
    "data-ease",
    "hold",
  );
  expect((await keyframes())!.position!.map(({ ease }) => ease)).toEqual([
    "linear",
    "hold",
  ]);

  // [ and ] step between them.
  await seekFrame(page, 0);
  await page.keyboard.press("BracketRight");
  await expect(playhead).toContainText("00:00:00:10");
  await page.keyboard.press("BracketRight");
  await expect(playhead).toContainText("00:00:01:10");
  await page.keyboard.press("BracketLeft");
  await expect(playhead).toContainText("00:00:00:10");

  // The diamond's menu sets the ease of every keyframe on its frame.
  await page.locator('[data-keyframe="box:10"]').click({ button: "right" });
  await page.getByRole("menuitemradio", { name: "Ease out" }).click();
  await expect
    .poll(async () => (await keyframes())!.scale!.map(({ ease }) => ease))
    .toEqual(["ease-out", "hold"]);

  // Alt+] deletes the keyframes under the playhead.
  await page.keyboard.press("Alt+BracketRight");
  await expect(page.locator('[data-keyframe="box:10"]')).toHaveCount(0);
  expect((await keyframes())!.position!.map(({ frame }) => frame)).toEqual([
    40,
  ]);
});
