import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleToSingleHtml } from "@hyperframes/core/compiler";
import { parseAutomation } from "@hyperframes/core/audio-automation";
import { collectRenderMedia } from "@hyperframes/producer";
import { PREVIEW_BUNDLE_OPTIONS } from "@hyperframes/studio-server";
import { parseHTML } from "linkedom";
import { sourceTimeAt } from "@hyperframes/core/speed-ramp";
import { sampleGridAudio } from "../src/server/hyperframes/audioClock";
import { previewDocument } from "../src/server/hyperframes/previewBridge";
import { prepareRampPreview } from "../src/server/hyperframes/rampPreview";
import { runSourceTime } from "../src/shared/timeline/rampRuns";
import type { RampRun } from "../src/shared/timeline/rampRuns";

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

/** The audio tracks export hands its mixer. */
async function exportAudios(dir: string, scenes: string[]) {
  const html = await bundleToSingleHtml(dir);
  const files = new Map(
    await Promise.all(
      scenes.map(
        async (name) =>
          [name, await readFile(join(dir, name), "utf8")] as [string, string],
      ),
    ),
  );
  return sampleGridAudio(collectRenderMedia(html).audios, html, files);
}

/** The run export hands its mixer for each ramp, and the samples of it the piece plays. */
async function exportRuns(dir: string, scenes: string[]) {
  return new Map(
    (await exportAudios(dir, scenes)).flatMap((audio) =>
      audio.rampRun
        ? [
            [
              audio.id,
              {
                run: audio.rampRun.run,
                from: audio.rampRun.from,
                to: audio.rampRun.to,
              },
            ] as const,
          ]
        : [],
    ),
  );
}

/** The run the viewer asks the media service to prepare, and the samples each element plays, by id. */
async function viewerRuns(dir: string) {
  const prefix = "/api/isolated/key/";
  const html = (await bundleToSingleHtml(dir, PREVIEW_BUNDLE_OPTIONS)).replace(
    "<head>",
    `<head><base href="${prefix}preview/">`,
  );
  const requested = new Map<string, RampRun>();
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
      rampRun: async (_project, _path, run) => {
        const key = JSON.stringify(run);
        const known = [...requested.keys()].indexOf(key);
        requested.set(key, run);
        return {
          key: (known < 0 ? requested.size - 1 : known)
            .toString(16)
            .padStart(64, "0"),
          available: true,
          pending: undefined,
        };
      },
      rampPins: () => ({ hold() {}, release() {} }),
    },
  );
  const runs = [...requested.values()];
  const { document } = parseHTML(prepared?.html ?? html);
  return new Map(
    Array.from(document.querySelectorAll("audio[src*='ramp-audio/']"), (el) => {
      const [, key, from, to] =
        /ramp-audio\/([a-f0-9]{64})-(\d+)-(\d+)\.wav/.exec(
          el.getAttribute("src")!,
        )!;
      return [
        el.getAttribute("data-hf-render-id") ?? el.id,
        {
          run: runs[Number.parseInt(key!, 16)]!,
          from: Number(from),
          to: Number(to),
          element: {
            start: el.getAttribute("data-start"),
            duration: el.getAttribute("data-duration"),
            fadeIn: el.getAttribute("data-fade-in"),
            fadeOut: el.getAttribute("data-fade-out"),
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
    const viewer = await viewerRuns(dir);
    const exported = await exportRuns(dir, ["ended.html", "trimmed.html"]);
    // Closed forms: "after" follows the 1 s "prev"; "both" lasts its data-duration; the scene
    // ends at 5.5 s; the trimmed mount plays 5.5 s to 7.5 s.
    expect(
      Object.fromEntries(
        Array.from(viewer, ([id, { from, to }]) => [id, to - from]),
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
    expect(viewer.get("trimmed-sound")!.element).toMatchObject({
      start: "0.5",
      duration: "2.5",
    });
    // Its run still starts at curve zero, the scene clip's own start; the mount cuts 0.5 s off.
    expect(viewer.get("trimmed-sound")!.from).toBe(24_000);
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
      const exported = await exportRuns(dir, ["scene.html"]);
      const viewer = await viewerRuns(dir);
      const { element, ...slice } = viewer.get("nested")!;
      expect(slice).toEqual(exported.get("nested")!);
      expect(slice.to - slice.from).toBe(24_000);
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

test("a ramp off the sample grid plays from its first sample in export", async () => {
  // Frame 31 at 29.97 is sample 49,649.6, so the first sample is 49,650, 1/120000 s later. The
  // curve has run that long, about 4.2 µs of source near its 0.5x start. It ends at frame 61, sample 97,697.6.
  const dir = await project({
    "index.html": root(
      "30000/1001",
      ramp(
        "late",
        'data-start="1.034367" data-duration="1.001" data-media-start="2" data-track-index="0"',
      ),
    ),
  });
  try {
    const audio = (await exportAudios(dir, [])).find(
      ({ id }) => id === "late",
    )!;
    expect(audio.samples).toEqual({ start: 49_650, end: 97_698 });
    const { run, from, to } = audio.rampRun!;
    expect(to - from).toBe(97_698 - 49_650);
    // Curve zero is the clip's own start, 0.4 of a sample before sample 49,650.
    expect(run.phase).toEqual(["3", "5"]);
    const lane = {
      target: "rate",
      points: [
        { t: 0, v: 0.5 },
        { t: 4, v: 2 },
      ],
    };
    expect(runSourceTime(run, from)).toBeCloseTo(
      2 + sourceTimeAt(lane, 1 / 120_000),
      12,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("each mount of a scene, and a trimmed mount inside a trimmed mount, prepares the sound export plays", async () => {
  const inner = scene(
    "inner",
    "24",
    ramp(
      "snd",
      'data-start="0" data-duration="3" data-media-start="1" data-fade-in="0.25" data-fade-out="0.25" data-track-index="0"',
    ),
  );
  const dir = await project({
    "index.html": root(
      "30",
      '<div id="a" data-composition-id="inner" data-composition-src="inner.html" data-start="0" data-duration="2" data-media-start="0.5" data-track-index="0"></div>' +
        '<div id="b" data-composition-id="inner" data-composition-src="inner.html" data-start="2" data-duration="2" data-media-start="1" data-track-index="1"></div>' +
        '<div id="c" data-composition-id="outer" data-composition-src="outer.html" data-start="4" data-duration="3" data-media-start="0.5" data-track-index="2"></div>',
    ),
    "inner.html": inner,
    "outer.html": scene(
      "outer",
      "25",
      '<div id="in" data-composition-id="inner" data-composition-src="inner.html" data-start="0.5" data-duration="3" data-media-start="0.25" data-track-index="0"></div>',
    ),
  });
  try {
    const viewer = await viewerRuns(dir);
    const audios = await exportAudios(dir, ["inner.html", "outer.html"]);
    const exported = await exportRuns(dir, ["inner.html", "outer.html"]);
    for (const [id, { element: _, ...slice }] of viewer)
      expect({ id, ...slice }).toEqual({ id, ...exported.get(id)! });
    // a: origin -0.5 s, cut to [0, 2). b: origin 1 s, [2, 4). c: the outer scene's origin is
    // 3.5 s and the inner one's 3.75 s, both mounts open at 4 s, and the clip ends at 6.75 s.
    expect(
      Object.fromEntries(
        Array.from(viewer, ([id, { from, to, element }]) => [
          id,
          {
            samples: to - from,
            start: element.start,
            duration: element.duration,
          },
        ]),
      ),
    ).toEqual({
      snd: { samples: 96_000, start: "0.5", duration: "2.5" },
      snd__hf2: { samples: 96_000, start: "1", duration: "2" },
      snd__hf3: { samples: 132_000, start: "0.25", duration: "2.75" },
    });
    // The mount opens 1 s into the clip, after its 0.25 s fade-in has ended: neither side fades in
    // again there. Both keep the fade-out at the end.
    const b = audios.find(({ id }) => id === "snd__hf2")!;
    expect({
      start: b.start,
      end: b.end,
      fadeIn: b.fadeIn,
      fadeOut: b.fadeOut,
    }).toEqual({ start: 2, end: 4, fadeIn: 0, fadeOut: 0.25 });
    expect(viewer.get("snd__hf2")!.element).toMatchObject({
      fadeIn: "0",
      fadeOut: "0.25",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
