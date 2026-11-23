import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleToSingleHtml } from "@hyperframes/core/compiler";
import { parseAutomation } from "@hyperframes/core/audio-automation";
import { collectRenderMedia } from "@hyperframes/producer";
import { PREVIEW_BUNDLE_OPTIONS } from "@hyperframes/studio-server";
import { parseHTML } from "linkedom";
import { sampleGridAudio } from "../src/server/hyperframes/audioClock";
import { previewDocument } from "../src/server/hyperframes/previewBridge";
import { prepareRampPreview } from "../src/server/hyperframes/rampPreview";
import type { RampWindow } from "../src/server/media/protocol";

const RAMP = JSON.stringify({
  version: 1,
  lanes: [
    {
      target: "rate",
      points: [
        { t: 0, v: 0.5 },
        { t: 4, v: 2 },
      ],
    },
  ],
});
const ramp = (id: string, timing: string) =>
  `<audio id="${id}" class="clip" src="tone.wav" ${timing} data-automation='${RAMP}'></audio>`;
const root = (fps: string, body: string) =>
  `<!doctype html><html><head></head><body><main id="main" data-composition-id="main" data-fps="${fps}" data-width="320" data-height="180" data-duration="8">${body}</main></body></html>`;
const scene = (id: string, fps: string, body: string) =>
  `<template><main id="${id}" data-composition-id="${id}" data-fps="${fps}" data-width="320" data-height="180" data-duration="8">${body}</main></template>`;

async function project(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "one-document-"));
  for (const [name, text] of Object.entries(files))
    await writeFile(join(dir, name), text);
  // Ramps stretch whatever the file holds; a header is enough for both readers.
  await writeFile(join(dir, "tone.wav"), "");
  return dir;
}

/** The sound export hands its mixer for each ramp: source and curve time at the first sample, and its length. */
async function exportWindows(dir: string, scenes: string[]) {
  const html = await bundleToSingleHtml(dir);
  const files = new Map(
    await Promise.all(
      scenes.map(
        async (name) =>
          [name, await readFile(join(dir, name), "utf8")] as [string, string],
      ),
    ),
  );
  return new Map(
    sampleGridAudio(collectRenderMedia(html).audios, html, files).flatMap(
      (audio) =>
        typeof audio.playbackRate === "object" && audio.samples
          ? [
              [
                audio.id,
                {
                  start: audio.mediaStart,
                  samples: audio.samples.end - audio.samples.start,
                  lane: {
                    ...audio.playbackRate,
                    offset: audio.playbackRate.offset ?? 0,
                  },
                },
              ] as const,
            ]
          : [],
    ),
  );
}

/** The sound the viewer asks the media service to prepare, by element id. */
async function viewerWindows(dir: string) {
  const prefix = "/api/isolated/key/";
  const html = (await bundleToSingleHtml(dir, PREVIEW_BUNDLE_OPTIONS)).replace(
    "<head>",
    `<head><base href="${prefix}preview/">`,
  );
  const requested = new Map<string, RampWindow>();
  const prepared = await prepareRampPreview(
    html,
    new URL(`http://127.0.0.1${prefix}preview`),
    prefix,
    {
      id: "project",
      name: "Project",
      path: dir,
      createdAt: "",
      updatedAt: "",
    },
    {
      rampAudio: async (_project, _path, window) => {
        const key = `ramp-${requested.size}`;
        requested.set(key, window);
        return { key, available: true, pending: undefined };
      },
    },
  );
  const { document } = parseHTML(prepared?.html ?? html);
  return new Map(
    Array.from(document.querySelectorAll("audio[src*='ramp-audio/']"), (el) => {
      const key = /ramp-audio\/([^.]+)\.wav/.exec(el.getAttribute("src")!)![1]!;
      const window = requested.get(key)!;
      // The serialized lane leaves out a zero offset.
      const lane = parseAutomation(window.rate).lanes[0]!;
      return [
        el.getAttribute("data-hf-render-id") ?? el.id,
        {
          start: window.start,
          samples: Math.round(window.duration * 48_000),
          lane: { ...lane, offset: lane.offset ?? 0 },
          element: {
            start: el.getAttribute("data-start"),
            duration: el.getAttribute("data-duration"),
          },
        },
      ] as const;
    }),
  );
}

test("E12: the viewer prepares the same ramp sound as export for references, both ends, scene ends and trimmed mounts", async () => {
  const dir = await project({
    "index.html": root(
      "30",
      ramp("prev", 'data-start="0" data-duration="1" data-track-index="0"') +
        ramp(
          "after",
          'data-start="prev" data-duration="1.5" data-media-start="0.25" data-track-index="1"',
        ) +
        ramp(
          "both",
          'data-start="2.5" data-duration="1" data-end="4.5" data-media-start="0.5" data-track-index="2"',
        ) +
        '<div id="cut" data-composition-id="ended" data-composition-src="ended.html" data-start="4" data-duration="1.5" data-track-index="3"></div>' +
        '<div id="trim" data-composition-id="trimmed" data-composition-src="trimmed.html" data-start="5.5" data-duration="2" data-media-start="0.5" data-track-index="4"></div>',
    ),
    "ended.html": scene(
      "ended",
      "24",
      ramp(
        "ended-sound",
        'data-start="0" data-duration="3" data-track-index="0"',
      ),
    ),
    "trimmed.html": scene(
      "trimmed",
      "24",
      ramp(
        "trimmed-sound",
        'data-start="0" data-duration="3" data-media-start="1" data-track-index="0"',
      ),
    ),
  });
  try {
    const viewer = await viewerWindows(dir);
    const exported = await exportWindows(dir, ["ended.html", "trimmed.html"]);
    // Closed forms: "after" follows the 1 s "prev"; "both" lasts its data-duration; the scene
    // ends at 5.5 s; the trimmed mount plays 5.5 s to 7.5 s.
    expect(
      Object.fromEntries(
        Array.from(viewer, ([id, { samples }]) => [id, samples]),
      ),
    ).toEqual({
      prev: 48_000,
      after: 72_000,
      both: 48_000,
      "ended-sound": 72_000,
      "trimmed-sound": 96_000,
    });
    for (const [id, { element: _, ...window }] of viewer)
      expect({ id, ...window }).toEqual({ id, ...exported.get(id)! });
    // The prepared sound begins where the mount lets it through, half a second in.
    expect(viewer.get("trimmed-sound")!.element).toEqual({
      start: "0.5",
      duration: "2.5",
    });
    expect(viewer.get("trimmed-sound")!.lane.offset).toBe(0.5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a 24 fps scene in a 25 fps root at an off-grid host start plays from the same sample in the viewer and export", async () => {
  // Frame 1 of the scene is 1/24 s after an origin of 10,427 or 10,448 µs: 156281/3000000 s or
  // 19543/375000 s. That is sample 2,500 or 2,502, where whole microseconds would give 2,501.
  for (const [hostStart, first] of [
    ["0.010427", 2500],
    ["0.010448", 2502],
  ] as const) {
    const dir = await project({
      "index.html": root(
        "25",
        `<div id="mount" data-composition-id="scene" data-composition-src="scene.html" data-start="${hostStart}" data-duration="1" data-track-index="0"></div>`,
      ),
      "scene.html": scene(
        "scene",
        "24",
        ramp(
          "nested",
          'data-start="0.041667" data-duration="0.5" data-track-index="0"',
        ),
      ),
    });
    try {
      const exported = await exportWindows(dir, ["scene.html"]);
      const viewer = await viewerWindows(dir);
      const { element, ...window } = viewer.get("nested")!;
      expect(window).toEqual(exported.get("nested")!);
      expect(window.samples).toBe(24_000);
      // Sample 2,500 is just before the in-point of 0; the media worker refuses a negative start.
      expect(window.start).toBeGreaterThanOrEqual(0);
      const html = await bundleToSingleHtml(dir);
      const audio = sampleGridAudio(
        collectRenderMedia(html).audios,
        html,
        new Map([
          ["scene.html", await readFile(join(dir, "scene.html"), "utf8")],
        ]),
      ).find(({ id }) => id === "nested")!;
      expect(audio.samples?.start).toBe(first);
      // The runtime is handed the scene's own frame 1, not a microsecond near it.
      const served = previewDocument(
        await bundleToSingleHtml(dir, PREVIEW_BUNDLE_OPTIONS),
      ).html;
      expect(
        parseHTML(served)
          .document.querySelector("#nested")
          ?.getAttribute("data-start"),
      ).toBe(String(1 / 24));
      expect(element.start).toBe("0.041667");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("the viewer starts a loop where a trimmed mount lets it through, as export does", async () => {
  const dir = await project({
    "index.html": root(
      "30",
      '<div id="mount" data-composition-id="bed-scene" data-composition-src="bed.html" data-start="2" data-duration="5" data-media-start="1.5" data-track-index="0"></div>',
    ),
    "bed.html": scene(
      "bed-scene",
      "30",
      '<audio id="bed" class="clip" src="tone.wav" loop data-start="0" data-duration="10" data-media-start="1" data-track-index="0"></audio>',
    ),
  });
  try {
    const served = previewDocument(
      await bundleToSingleHtml(dir, PREVIEW_BUNDLE_OPTIONS),
    ).html;
    const bed = parseHTML(served).document.querySelector("#bed")!;
    // The scene's origin is 0.5 s and the mount opens at 2 s, so the loop restarts
    // 1.5 s into the scene with its own in-point, and still ends at 10 s.
    expect({
      start: bed.getAttribute("data-start"),
      duration: bed.getAttribute("data-duration"),
      mediaStart: bed.getAttribute("data-media-start"),
    }).toEqual({ start: "1.5", duration: "8.5", mediaStart: "1" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
