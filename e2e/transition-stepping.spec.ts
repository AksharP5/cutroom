import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { titleAttributes, titleStyle } from "../src/server/timeline/titles";
import { defaultTitle } from "../src/shared/timeline/title";
import { seekFrame } from "./position-helpers";
import { expect, test } from "./fixtures";

// A trace snapshots every frame after each step, which slows stepping enough to hide the race.
test.use({ trace: "off" });

/**
 * The viewer's picture as a PNG once the preview rests on `frame`, and every element of the
 * preview that runs one animation more than once.
 */
async function resting(page: Page, frame: number) {
  const preview = async () =>
    (await page.locator("iframe[data-live]").elementHandle())!.contentFrame();
  await expect
    .poll(async () =>
      (await preview())!.evaluate(() => {
        const time = (
          window as { __player?: { getTime(): number } }
        ).__player!.getTime();
        // A video still seeking, or held while it seeks, shows an earlier picture.
        const waiting =
          document.querySelector("[data-hf-seek-video]") ||
          [...document.querySelectorAll("video")].some(
            (video) =>
              video.checkVisibility({ visibilityProperty: true }) &&
              (video.seeking || video.readyState < 2),
          );
        return waiting ? null : Math.round(time * 30);
      }),
    )
    .toBe(frame);
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  return {
    repeated: await (await preview())!.evaluate(() =>
      [...document.querySelectorAll("[id]")].flatMap((element) => {
        const names = element
          .getAnimations()
          .map((animation) => (animation as CSSAnimation).animationName);
        return new Set(names).size === names.length
          ? []
          : [`${element.id}: ${names.join(", ")}`];
      }),
    ),
    picture: (await page.locator(".edit-picture").screenshot()).toString(
      "base64",
    ),
  };
}

test("stepping through a HyperFrames dissolve and dip on a busy machine matches a fresh seek", async ({
  browser,
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Stepped", width: 640, height: 360, duration: 4 },
      })
    ).json(),
  );
  execFileSync("ffmpeg", [
    ...["-v", "error", "-nostdin", "-f", "lavfi", "-i"],
    "testsrc2=size=640x360:rate=30:duration=5",
    ...["-c:v", "libx264", "-preset", "veryfast", "-g", "15"],
    ...["-pix_fmt", "yuv420p", join(project.path, "a.mp4")],
  ]);
  const fps = { num: 30, den: 1 } as const;
  const title = titleAttributes(defaultTitle(fps), fps)
    .map(([name, value]) => (value === null ? "" : ` ${name}="${value}"`))
    .join("");
  const clip = (
    id: string,
    start: string,
    length: string,
    mediaStart: number,
  ) =>
    `<video id="${id}" src="a.mp4" muted data-start="${start}" data-duration="${length}" data-media-start="${mediaStart}" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%"></video>`;
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0;background:#111}</style>${titleStyle([])}</head><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-duration="3.666667" data-fps="30">
${clip("a", "0", "1.333333", 0)}
${clip("b", "1.333333", "1.333333", 2)}
${clip("c", "2.666667", "1", 3.5)}
<div id="name" class="clip" data-start="0.666667" data-duration="2.333333" data-track-index="1"${title}>Alex Rivera</div>
</main></body></html>`,
  );
  const view = TimelineViewSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${project.id}/timeline`)
    ).json(),
  );
  const response = await request.post(
    `/api/cutroom/projects/${project.id}/commands`,
    {
      data: {
        composition: "index.html",
        expectedRevision: view.revision,
        label: "Transitions",
        commands: [
          ["a", "b", "dissolve"],
          ["b", "c", "dip"],
        ].map(([from, to, kind]) => ({
          type: "setTransition",
          from,
          to,
          transition: { kind, duration: 12, alignment: "center" },
        })),
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
  // Every frame of the dissolve at 40 and the dip at 80, while the title fades in and out.
  const frames = [34, 74].flatMap((first) =>
    Array.from({ length: 13 }, (_, step) => first + step),
  );

  // With the CPU four times slower, a step often lands while a video is still seeking, and the
  // runtime holds that video. Count the holds of the clips with transitions.
  await page.addInitScript(() => {
    if (window === window.top) {
      localStorage.setItem("cutroom.footagePipeline", "false");
      return;
    }
    const count = window as { __holds?: number };
    count.__holds = 0;
    new MutationObserver((records) => {
      for (const { target } of records)
        if (
          target instanceof Element &&
          target.matches("[data-hf-seek-video][data-transition-in]")
        )
          count.__holds!++;
    }).observe(document, {
      attributes: true,
      attributeFilter: ["data-hf-seek-video"],
      subtree: true,
    });
  });
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  // Past the dip as fast as the key repeats, twice, then through both transitions looking at
  // each frame.
  const stepped = new Map<number, string>();
  for (const look of [false, false, true]) {
    await page.keyboard.press("Home");
    for (let frame = 1; frame < (look ? 87 : 96); frame++) {
      await page.keyboard.press("ArrowRight");
      if (!look || !frames.includes(frame)) continue;
      const { repeated, picture } = await resting(page, frame);
      expect(repeated, `frame ${frame}`).toEqual([]);
      stepped.set(frame, picture);
    }
  }
  const holds = await (await page.locator("iframe[data-live]").elementHandle())!
    .contentFrame()
    .then((frame) =>
      frame!.evaluate(() => (window as { __holds?: number }).__holds),
    );
  // Without a hold this test would not reach the bug.
  expect(holds).toBeGreaterThan(0);

  // The reference: a fresh page, sought once to each frame. A fade drawn twice is p² of the way
  // through instead of p.
  const fresh = await browser.newContext({
    viewport: page.viewportSize()!,
  });
  try {
    const reference = await fresh.newPage();
    await reference.addInitScript(() => {
      if (window === window.top)
        localStorage.setItem("cutroom.footagePipeline", "false");
    });
    await reference.goto(`/#project/${project.id}`);
    await expect(
      reference.locator(".edit-stage[data-preview-ready]"),
    ).toBeVisible();
    for (const frame of frames) {
      await seekFrame(reference, frame);
      const { repeated, picture } = await resting(reference, frame);
      expect(repeated, `reference frame ${frame}`).toEqual([]);
      const difference = await reference.evaluate(
        async (pngs) => {
          const [a, b] = await Promise.all(
            pngs.map(async (png) => {
              const image = await createImageBitmap(
                new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))]),
              );
              const canvas = new OffscreenCanvas(image.width, image.height);
              const context = canvas.getContext("2d")!;
              context.drawImage(image, 0, 0);
              return context.getImageData(0, 0, image.width, image.height).data;
            }),
          );
          let sum = 0;
          for (let index = 0; index < a!.length; index++)
            if (index % 4 !== 3) sum += Math.abs(a![index]! - b![index]!);
          return sum / ((a!.length / 4) * 3);
        },
        [picture, stepped.get(frame)!],
      );
      expect(difference, `frame ${frame}`).toBeLessThan(1);
    }
  } finally {
    await fresh.close();
  }
});
