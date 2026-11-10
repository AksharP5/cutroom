import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "./fixtures";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";

test("video inserts draw filmstrips and linked waveforms, and a silent video shows no sound", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Clip bodies" },
      })
    ).json(),
  );
  // A red picture with a tone, the same picture silent, and the tone alone.
  const picture = ["-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=4"];
  const tone = ["-f", "lavfi", "-i", "sine=frequency=440:duration=4"];
  for (const [name, inputs] of [
    ["sound.mp4", [...picture, ...tone]],
    ["silent.mp4", picture],
    ["bed.wav", tone],
  ] as const)
    await promisify(execFile)("ffmpeg", [
      "-loglevel",
      "error",
      ...inputs,
      "-shortest",
      "-y",
      join(project.path, name),
    ]);
  const { revision } = TimelineViewSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${project.id}/timeline`)
    ).json(),
  );
  const insert = (kind: string, src: string, track: number, at: number) => ({
    type: "insert",
    track,
    at,
    clip: { id: src.split(".")[0], kind, src, duration: 120 },
  });
  const inserted = await request.post(
    `/api/cutroom/projects/${project.id}/commands`,
    {
      data: {
        expectedRevision: revision,
        commands: [
          insert("audio", "bed.wav", 6, 0),
          {
            ...insert("video", "sound.mp4", 5, 0),
            linkedAudio: { id: "location" },
          },
          insert("video", "silent.mp4", 5, 120),
        ],
      },
    },
  );
  expect(inserted.ok(), await inserted.text()).toBe(true);
  await page.goto(`/#project/${project.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline.locator("[data-clip]")).toHaveCount(7);

  /** The colour drawn in a clip's body, 20px in from its left edge and `up` px above its bottom. */
  const drawn = (id: string, up: number) =>
    page.evaluate(
      ([id, up]) => {
        const canvas = document.querySelector<HTMLCanvasElement>(".tl-bodies");
        const clip = document.querySelector(`[data-clip="${id}"]`);
        if (!canvas || !clip) throw new Error("The timeline is not drawn.");
        const box = canvas.getBoundingClientRect();
        const at = clip.getBoundingClientRect();
        const scale = canvas.width / box.width;
        const [red = 0, green = 0, blue = 0, alpha = 0] = canvas
          .getContext("2d")!
          .getImageData(
            (at.left + 20 - box.left) * scale,
            (at.bottom - up - box.top) * scale,
            1,
            1,
          ).data;
        return { red, green, blue, alpha };
      },
      [id, up] as const,
    );
  const isRed = ({ red, green, blue }: Awaited<ReturnType<typeof drawn>>) =>
    red > 200 && green < 60 && blue < 60;

  // Both videos show their frames in the body, under the name strip.
  await expect.poll(async () => isRed(await drawn("sound", 30))).toBe(true);
  await expect.poll(async () => isRed(await drawn("silent", 30))).toBe(true);
  // Sound is on its linked audio clip, leaving the full video body for picture.
  await expect.poll(async () => isRed(await drawn("sound", 3))).toBe(true);
  expect(isRed(await drawn("silent", 3))).toBe(true);
  // The audio clip's waveform runs through the middle of its body, and nowhere near its edge.
  for (const id of ["bed", "location"]) {
    await expect.poll(async () => (await drawn(id, 14)).alpha).toBe(255);
    const wave = await drawn(id, 14);
    expect(wave.green).toBeGreaterThan(wave.red);
    expect((await drawn(id, 3)).alpha).toBe(0);
  }
});

test("exact filmstrip frames follow the view: on a cold cache, after a scroll, after an edit, and after a resize", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Exact frames" },
      })
    ).json(),
  );
  await promisify(execFile)("ffmpeg", [
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=30:d=10",
    "-g",
    "30",
    "-y",
    join(project.path, "long.mp4"),
  ]);
  const commands = `/api/cutroom/projects/${project.id}/commands`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    );
  const inserted = await request.post(commands, {
    data: {
      expectedRevision: (await read()).revision,
      commands: [
        {
          type: "insert",
          track: 5,
          at: 0,
          clip: { id: "long", kind: "video", src: "long.mp4", duration: 300 },
        },
      ],
    },
  });
  expect(inserted.ok()).toBe(true);

  /** Source times of the single frames the page has asked for, in order, without repeats. */
  const asked: number[] = [];
  let pending = 0;
  const isFrame = (url: string) =>
    new URL(url).pathname.endsWith("/media/frame");
  page.on("request", (sent) => {
    if (!isFrame(sent.url())) return;
    pending++;
    const time = Number(new URL(sent.url()).searchParams.get("time"));
    if (!asked.includes(time)) asked.push(time);
  });
  const arrived = (sent: { url(): string }) => {
    if (isFrame(sent.url())) pending--;
  };
  page.on("requestfinished", arrived);
  page.on("requestfailed", arrived);
  // Slow frames, so a queue has time to build.
  await page.route("**/media/frame?*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue().catch(() => {});
  });
  await page.goto(`/#project/${project.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline.locator('[data-clip="long"]')).toBeVisible();

  // Zoomed to the closest zoom before the filmstrip exists, then left alone: the clip's first
  // frame is still asked for once the media arrives.
  await timeline.getByRole("slider", { name: "Zoom" }).focus();
  await page.keyboard.press("End");
  await expect.poll(() => asked.includes(0)).toBe(true);
  await expect.poll(() => asked.length).toBeGreaterThan(8);

  // While the view scrolls, nothing new is asked for; the frames of where it stops are.
  const scroller = timeline.locator(".tl-scroll");
  await page.waitForTimeout(400);
  const before = asked.length;
  await scroller.evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        let steps = 0;
        const step = () => {
          element.scrollLeft += 40;
          if (++steps < 60) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      }),
  );
  expect(asked.length).toBe(before);
  await expect.poll(() => asked.length).toBeGreaterThan(before);

  // A trim made while the view rests on the clip's head asks for the new first frame.
  // Every frame of this view has arrived first, so only the edit can ask for another.
  await scroller.evaluate((element) => (element.scrollLeft = 0));
  let quiet = 0;
  await expect
    .poll(() => (quiet = pending === 0 ? quiet + 1 : 0), { intervals: [300] })
    .toBeGreaterThan(3);
  const trimmed = await request.post(commands, {
    data: {
      expectedRevision: (await read()).revision,
      commands: [{ type: "trim", clipId: "long", edge: "start", to: 7 }],
    },
  });
  expect(trimmed.ok()).toBe(true);
  const head = (await read()).timeline.clips.find((clip) => clip.id === "long");
  expect(head?.mediaStart).toBeCloseTo(7 / 30, 5);
  await expect.poll(() => asked.includes(head?.mediaStart ?? -1)).toBe(true);

  // Narrowing the window and scrolling leaves the bodies' canvas over everything in view.
  await page.setViewportSize({ width: 1100, height: 1050 });
  await scroller.evaluate(
    (element) => (element.scrollLeft += element.clientWidth * 0.6),
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const canvas = document
          .querySelector(".tl-bodies")!
          .getBoundingClientRect();
        const view = document
          .querySelector(".tl-scroll")!
          .getBoundingClientRect();
        const head = document
          .querySelector(".tl-heads")!
          .getBoundingClientRect();
        return canvas.left <= head.right && canvas.right >= view.right;
      }),
    )
    .toBe(true);
});
