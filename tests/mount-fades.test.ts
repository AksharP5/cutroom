import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAutomation,
  sampleAutomationLane,
  VOLUME_TARGET,
} from "@hyperframes/core/audio-automation";
import { fadeGain } from "@hyperframes/core/audio-fade";
import { bundleToSingleHtml } from "@hyperframes/core/compiler";
import { collectRenderMedia } from "@hyperframes/producer";
import { PREVIEW_BUNDLE_OPTIONS } from "@hyperframes/studio-server";
import { parseHTML } from "linkedom";
import { sampleGridAudio } from "../src/server/hyperframes/audioClock";
import { previewDocument } from "../src/server/hyperframes/previewBridge";
import { prepareRampPreview } from "../src/server/hyperframes/rampPreview";

// A clip in a scene fades in over 1 s while its volume lane falls from 1 to 0.5 over 2 s. The
// scene is mounted at 2 s with an in-point of 0.4 s, so the clip starts at 1.6 s and the mount
// lets it through 0.4 s in. Clip-local, timeline second t plays at
// min(1, t - 1.6) * (1 - 0.25 * (t - 1.6)) until the lane holds 0.5 from 3.6 s.
const LANE = JSON.stringify({
  version: 1,
  lanes: [
    {
      target: "volume",
      points: [
        { t: 0, v: 1 },
        { t: 2, v: 0.5 },
      ],
    },
  ],
});
const RAMP_AND_LANE = JSON.stringify({
  version: 1,
  lanes: [
    {
      target: "rate",
      points: [
        { t: 0, v: 0.5 },
        { t: 4, v: 2 },
      ],
    },
    ...JSON.parse(LANE).lanes,
  ],
});
const expected = (t: number) => {
  const elapsed = t - 1.6;
  return Math.min(1, elapsed) * (elapsed < 2 ? 1 - 0.25 * elapsed : 0.5);
};
const times = [2, 2.3, 2.6, 3, 3.5, 4, 4.8];

const scene = (automation: string) =>
  `<template><main id="scene" data-composition-id="scene" data-fps="30" data-width="320" data-height="180" data-duration="8"><audio id="bed" class="clip" src="source.wav" data-start="0" data-duration="4" data-fade-in="1" data-track-index="0" data-automation='${automation}'></audio></main></template>`;
const index = `<!doctype html><html><head></head><body><main id="main" data-composition-id="main" data-fps="30" data-width="320" data-height="180" data-duration="6"><div id="mount" data-composition-id="scene" data-composition-src="scene.html" data-start="2" data-duration="3" data-media-start="0.4" data-track-index="0"></div></main></body></html>`;

async function project(automation: string) {
  const dir = await mkdtemp(join(tmpdir(), "mount-fades-"));
  await writeFile(join(dir, "index.html"), index);
  await writeFile(join(dir, "scene.html"), scene(automation));
  // Six seconds at a steady 16,000, so the mix's level is its sample over 16,000.
  const raw = Buffer.alloc(6 * 48_000 * 4);
  for (let i = 0; i < raw.length; i += 2) raw.writeInt16LE(16_000, i);
  await writeFile(join(dir, "source.raw"), raw);
  const ffmpeg = Bun.spawn(
    [
      "ffmpeg",
      "-v",
      "error",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-i",
      join(dir, "source.raw"),
      join(dir, "source.wav"),
    ],
    { stderr: "pipe" },
  );
  if ((await ffmpeg.exited) !== 0)
    throw new Error(await new Response(ffmpeg.stderr).text());
  return dir;
}

/** The level HyperFrames applies at timeline second `t` to a clip that starts at `start`. */
function level(
  t: number,
  clip: {
    start: number;
    end: number;
    fadeIn: number;
    fadeOut: number;
    automation: string | null;
  },
) {
  const elapsed = t - clip.start;
  const lane = clip.automation
    ? parseAutomation(clip.automation).lanes.find(
        ({ target }) => target === VOLUME_TARGET,
      )
    : undefined;
  return (
    fadeGain(elapsed, clip.end - clip.start, clip) *
    (lane ? sampleAutomationLane(lane, elapsed) : 1)
  );
}

/** What export hands its mixer for the clip. */
async function exported(dir: string) {
  const html = await bundleToSingleHtml(dir);
  const scenes = new Map([
    ["scene.html", await readFile(join(dir, "scene.html"), "utf8")],
  ]);
  return sampleGridAudio(collectRenderMedia(html).audios, html, scenes).find(
    ({ id }) => id === "bed",
  )!;
}

/** The clip as the served preview hands it to the runtime, which counts from its own start. */
function served(html: string, selector: string) {
  const el = parseHTML(html).document.querySelector(selector)!;
  const read = (name: string) => el.getAttribute(name);
  // The scene's origin is 2 - 0.4 = 1.6 s.
  const start = 1.6 + Number(read("data-start"));
  return {
    start,
    end: start + Number(read("data-duration")),
    fadeIn: Number(read("data-fade-in") ?? 0),
    fadeOut: Number(read("data-fade-out") ?? 0),
    automation: read("data-automation"),
  };
}

test.skipIf(!Bun.which("node") || !Bun.which("ffmpeg"))(
  "a faded clip under a trimmed mount keeps its clip-local fade and lane in the viewer and in the mix",
  async () => {
    const dir = await project(LANE);
    try {
      const viewer = served(
        previewDocument(await bundleToSingleHtml(dir, PREVIEW_BUNDLE_OPTIONS))
          .html,
        "#bed",
      );
      const track = await exported(dir);
      for (const t of times) {
        expect(level(t, viewer)).toBeCloseTo(expected(t), 6);
        expect(
          level(t, {
            start: track.start,
            end: track.end,
            fadeIn: track.fadeIn ?? 0,
            fadeOut: track.fadeOut ?? 0,
            automation: track.automation ?? null,
          }),
        ).toBeCloseTo(expected(t), 3);
      }

      // The real mix, through Cutroom's mixer transform.
      await writeFile(join(dir, "mix.html"), await bundleToSingleHtml(dir));
      const child = Bun.spawn(
        [
          "node",
          "--experimental-strip-types",
          join(import.meta.dir, "fixtures", "sample-grid-mix.ts"),
          dir,
          "mix",
          "30",
          "1",
          "180",
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      if ((await child.exited) !== 0)
        throw new Error(await new Response(child.stderr).text());
      const pcm = await readFile(
        join(dir, "mix", "plan", "work", "audio-source.wav"),
      );
      const data = pcm.indexOf("data", 12) + 8;
      const mixed = (t: number) =>
        (pcm.readFloatLE(data + Math.round(t * 48_000) * 8) * 32_768) / 16_000;
      expect(mixed(1.99)).toBe(0);
      for (const t of times) expect(mixed(t)).toBeCloseTo(expected(t), 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);

test("a faded ramp under a trimmed mount keeps its clip-local fade and lane in the viewer and in the mix", async () => {
  const dir = await project(RAMP_AND_LANE);
  try {
    const prefix = "/api/isolated/key/";
    const html = (
      await bundleToSingleHtml(dir, PREVIEW_BUNDLE_OPTIONS)
    ).replace("<head>", `<head><base href="${prefix}preview/">`);
    const prepared = await prepareRampPreview(
      html,
      new URL(`http://127.0.0.1${prefix}preview`),
      prefix,
      { id: "p", name: "p", path: dir, createdAt: "", updatedAt: "" },
      {
        rampAudio: async () => ({
          key: "ramp",
          available: true,
          pending: undefined,
        }),
      },
    );
    // The prepared sound starts where the mount opens, so the viewer's element moves there.
    const viewer = served(previewDocument(prepared!.html).html, "audio#bed");
    expect(viewer.start).toBeCloseTo(2, 9);
    const track = await exported(dir);
    for (const t of times) {
      expect(level(t, viewer)).toBeCloseTo(expected(t), 3);
      expect(
        level(t, {
          start: track.start,
          end: track.end,
          fadeIn: track.fadeIn ?? 0,
          fadeOut: track.fadeOut ?? 0,
          automation: track.automation ?? null,
        }),
      ).toBeCloseTo(level(t, viewer), 9);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
