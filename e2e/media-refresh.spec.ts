import { execFile } from "node:child_process";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { Page } from "@playwright/test";
import { startMediaDrag } from "./media-drag";
import { expect, test } from "./fixtures";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";

async function render(
  path: string,
  color: string,
  video: boolean,
  amplitude = 0.002,
  seconds = 4,
) {
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=320x180:r=30:d=${seconds}`,
    ...(video
      ? [
          "-f",
          "lavfi",
          "-i",
          `aevalsrc=${amplitude}*sin(2*PI*440*t):s=48000:d=${seconds}`,
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-threads",
          "1",
          "-c:a",
          "aac",
          "-shortest",
        ]
      : ["-frames:v", "1", "-threads", "1"]),
    "-y",
    path,
  ]);
}

/** Sample the pixels users see in both the Media row and the clip body. */
async function pictures(page: Page, name: string) {
  return page.evaluate((name) => {
    const canvas = document.querySelector<HTMLCanvasElement>(".tl-bodies")!;
    const clip = document
      .querySelector('[data-clip="picture"]')!
      .getBoundingClientRect();
    const box = canvas.getBoundingClientRect();
    const ratio = canvas.width / box.width;
    const strip = [
      ...canvas
        .getContext("2d")!
        .getImageData(
          (clip.left + 20 - box.left) * ratio,
          (clip.bottom - 20 - box.top) * ratio,
          1,
          1,
        ).data,
    ];
    const thumb = document.querySelector<HTMLImageElement | HTMLVideoElement>(
      `.media-row[title="${name}"] .media-thumb img, .media-row[title="${name}"] .media-thumb video`,
    );
    if (
      !thumb ||
      (thumb instanceof HTMLImageElement
        ? !thumb.complete || thumb.naturalWidth === 0
        : thumb.readyState < 2)
    )
      return { strip, thumb: [] };
    const sample = document.createElement("canvas");
    sample.width = sample.height = 1;
    const ctx = sample.getContext("2d")!;
    ctx.drawImage(thumb, 0, 0, 1, 1);
    return { strip, thumb: [...ctx.getImageData(0, 0, 1, 1).data] };
  }, name);
}
const isColor = (pixels: number[], color: "red" | "blue") =>
  color === "red"
    ? pixels[0]! > 200 && pixels[1]! < 60 && pixels[2]! < 60
    : pixels[2]! > 200 && pixels[0]! < 60 && pixels[1]! < 60;

async function waveHeight(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".tl-bodies")!;
    const clip = document
      .querySelector('[data-clip="sound"]')!
      .getBoundingClientRect();
    const box = canvas.getBoundingClientRect();
    const ratio = canvas.width / box.width;
    const pixels = canvas
      .getContext("2d")!
      .getImageData(
        (clip.left + 20 - box.left) * ratio,
        (clip.bottom - 27 - box.top) * ratio,
        1,
        26 * ratio,
      ).data;
    let rows = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i]! > 128) rows++;
    return rows / ratio;
  });
}

for (const video of [false, true]) {
  test(`replacing an open ${video ? "video refreshes filmstrip, thumbnail, peaks and probe" : "image refreshes filmstrip and thumbnail"} without reload`, async ({
    page,
    request,
  }) => {
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: { name: "Media replacement" },
        })
      ).json(),
    );
    const name = video ? "card.mp4" : "card.png";
    await render(join(project.path, name), "red", video);
    const base = `/api/cutroom/projects/${project.id}`;
    const view = TimelineViewSchema.parse(
      await (await request.get(`${base}/timeline`)).json(),
    );
    const inserted = await request.post(`${base}/commands`, {
      data: {
        expectedRevision: view.revision,
        commands: [
          {
            type: "insert",
            track: 5,
            at: 0,
            clip: {
              id: "picture",
              kind: video ? "video" : "image",
              src: name,
              duration: 120,
            },
            ...(video ? { linkedAudio: { id: "sound" } } : {}),
          },
        ],
      },
    });
    expect(inserted.ok(), await inserted.text()).toBe(true);
    await page.goto(`/#project/${project.id}`);
    await expect(page.locator('[data-clip="picture"]')).toBeVisible();
    await expect
      .poll(async () => {
        const drawn = await pictures(page, name);
        return isColor(drawn.strip, "red") && isColor(drawn.thumb, "red");
      })
      .toBe(true);
    if (video) await expect.poll(() => waveHeight(page)).toBeGreaterThan(0);
    const initialWave = video ? await waveHeight(page) : 0;
    const evidence = process.env.CUTROOM_REFRESH_EVIDENCE;
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({
        path: join(evidence, `${video ? "video" : "image"}-before.png`),
      });
    }
    let navigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations++;
    });
    // Publish a completed replacement at the same path, as an external renderer does.
    const replacement = join(project.path, `next.${video ? "mp4" : "png"}`);
    await render(replacement, "blue", video, 0.9, video ? 6 : 4);
    await rename(replacement, join(project.path, name));
    try {
      await expect
        .poll(async () => {
          const drawn = await pictures(page, name);
          return isColor(drawn.strip, "blue") && isColor(drawn.thumb, "blue");
        })
        .toBe(true);
      if (video)
        await expect(
          page.locator(`.media-row[title="${name}"] .media-duration`),
        ).toHaveText("00:00:06:00");
      if (video)
        await expect
          .poll(() => waveHeight(page))
          .toBeGreaterThan(initialWave + 5);
    } finally {
      if (evidence)
        await page.screenshot({
          path: join(
            evidence,
            `${video ? "video" : "image"}-${process.env.CUTROOM_REFRESH_LABEL ?? "after"}.png`,
          ),
        });
    }
    expect(navigations).toBe(0);
    if (video) {
      // Replacing sound with a silent render also updates the Media row's probe for the next drop.
      await promisify(execFile)("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=320x180:r=30:d=4",
        "-an",
        "-threads",
        "1",
        "-y",
        replacement,
      ]);
      await rename(replacement, join(project.path, name));
      await expect.poll(() => waveHeight(page)).toBe(0);
      const row = page.locator(`.media-row[title="${name}"]`);
      await expect(row.locator(".media-duration")).toHaveText("00:00:04:00");
      const droppedRequest = page.waitForRequest(
        (sent) =>
          sent.method() === "POST" &&
          new URL(sent.url()).pathname === `${base}/commands`,
      );
      await startMediaDrag(page, row);
      const lane = await page.locator(".tl-lane.video").first().boundingBox();
      if (!lane) throw new Error("The video track is missing.");
      await page.mouse.move(lane.x + 600, lane.y + 20, { steps: 4 });
      await page.mouse.up();
      const payload = z
        .object({
          commands: z.array(z.object({ linkedAudio: z.unknown().optional() })),
        })
        .parse((await droppedRequest).postDataJSON());
      expect(payload.commands[0]?.linkedAudio).toBeUndefined();
      await expect
        .poll(async () => {
          const { timeline } = TimelineViewSchema.parse(
            await (await request.get(`${base}/timeline`)).json(),
          );
          const dropped = timeline.clips.filter(
            (clip) =>
              clip.src === name && clip.id !== "picture" && clip.id !== "sound",
          );
          return dropped.map((clip) => ({
            kind: clip.kind,
            link: clip.link,
          }));
        })
        .toEqual([{ kind: "video", link: null }]);
    }
  });
}
