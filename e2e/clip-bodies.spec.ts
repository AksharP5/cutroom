import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";

test("clip bodies draw a filmstrip and a waveform, and a silent video shows no sound", async ({
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
          insert("video", "sound.mp4", 5, 0),
          insert("video", "silent.mp4", 5, 120),
          insert("audio", "bed.wav", 6, 0),
        ],
      },
    },
  );
  expect(inserted.ok()).toBe(true);
  await page.addInitScript(() =>
    localStorage.setItem("cutroom.newEditor", "true"),
  );
  await page.goto(`/#project/${project.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline.locator("[data-clip]")).toHaveCount(6);

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
  // The video with sound gets a strip of it along the bottom; the silent one stays picture.
  await expect.poll(async () => isRed(await drawn("sound", 3))).toBe(false);
  expect(isRed(await drawn("silent", 3))).toBe(true);
  // The audio clip's waveform runs through the middle of its body, and nowhere near its edge.
  await expect.poll(async () => (await drawn("bed", 14)).alpha).toBe(255);
  const wave = await drawn("bed", 14);
  expect(wave.green).toBeGreaterThan(wave.red);
  expect((await drawn("bed", 3)).alpha).toBe(0);
});
