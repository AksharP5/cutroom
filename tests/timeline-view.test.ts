import { waveformPeak } from "../src/client/timeline/math";
import { expect, test } from "bun:test";
import { normalizeTimeline } from "../src/shared/timeline/apply";
import type { Clip, Timeline, Track } from "../src/shared/timeline/schema";
import {
  MAX_PPF,
  clipsByTrack,
  clipsInRange,
  cssEasing,
  cssMilliseconds,
  filmTiles,
  fitPpf,
  frameAt,
  frameStep,
  majorTicks,
  mountedRange,
  pageTarget,
  peakLevel,
  rowsBetween,
  scrollForAnchor,
  settledScroll,
  sliderToZoom,
  sourceSecondsPerPixel,
  tickStep,
  trackRows,
  zoomToSlider,
} from "../src/client/timeline/math";
import { localMediaPath } from "../src/shared/media";
import {
  clickSelection,
  emptySelection,
  marqueeSelection,
  pruneSelection,
  selectionAtPlayhead,
} from "../src/client/timeline/selection";

const fps30 = { num: 30, den: 1 };
const ntsc = { num: 30_000, den: 1001 };

const clip = (
  id: string,
  track: number,
  start: number,
  duration: number,
  extra: Partial<Clip> = {},
): Clip => ({
  id,
  track,
  kind: "video",
  start,
  duration,
  mediaStart: 0,
  playbackRate: 1,
  src: "talk.mp4",
  sourceDuration: null,
  hasAudio: false,
  link: null,
  label: null,
  volume: null,
  opacity: null,
  x: null,
  y: null,
  fadeIn: 0,
  fadeOut: 0,
  automation: null,
  enabled: true,
  startRef: null,
  ...extra,
});
const track = (index: number, extra: Partial<Track> = {}): Track => ({
  index,
  kind: "video",
  name: null,
  locked: false,
  autoSelect: true,
  enabled: true,
  muted: false,
  solo: false,
  ...extra,
});
const timeline = (clips: Clip[], tracks: Track[]): Timeline =>
  normalizeTimeline({
    fps: fps30,
    duration: 900,
    tracks,
    clips,
    markers: [],
    range: { in: null, out: null },
  });

test("the ruler picks the smallest step that keeps labels 96px apart", () => {
  // 32 px per frame: every third frame would be 96px, but 3f is not a step, so 5f.
  expect(tickStep(32, fps30)).toEqual({ major: 5, minor: 1 });
  expect(tickStep(96, fps30)).toEqual({ major: 1, minor: null });
  // One second is exactly 96px wide.
  expect(tickStep(3.2, fps30)).toEqual({ major: 30, minor: 5 });
  // Just under: one second no longer fits, so two seconds, in six parts.
  expect(tickStep(3.19, fps30)).toEqual({ major: 60, minor: 10 });
  expect(tickStep(0.5, fps30)).toEqual({ major: 300, minor: 60 });
  // Two frames only split in half.
  expect(tickStep(48, fps30)).toEqual({ major: 2, minor: 1 });
  expect(tickStep(0.01, fps30)).toEqual({ major: 18_000, minor: 1_800 });
  // A day-long timeline still gets a step: the largest one.
  expect(tickStep(0.000_01, fps30).major).toBe(108_000);
});

test("ruler steps count 30 frames per second at 29.97, as its timecode does", () => {
  expect(tickStep(3.2, ntsc)).toEqual({ major: 30, minor: 5 });
});

test("24 fps seconds divide into two-frame ticks, since five and ten do not fit", () => {
  expect(tickStep(4, { num: 24, den: 1 })).toEqual({ major: 24, minor: 2 });
});

test("labelled ticks cover the mounted range from the step before it", () => {
  expect(majorTicks({ from: 70, to: 200 }, 60)).toEqual([60, 120, 180]);
  expect(majorTicks({ from: 60, to: 120 }, 60)).toEqual([60]);
});

test("a pixel maps to the frame under it and zoom holds the anchor frame still", () => {
  expect(frameAt(100, 0, 4)).toBe(25);
  expect(frameAt(101, 0, 4)).toBe(25);
  expect(frameAt(102, 0, 4)).toBe(26);
  expect(frameAt(100, 300, 4)).toBe(100);
  expect(frameAt(-50, 0, 4)).toBe(0);
  // Frame 100 sits under x=100 at 4 px per frame with 300px scrolled. Zooming to 8 keeps it there.
  const scroll = scrollForAnchor(100, 100, 8);
  expect(scroll).toBe(700);
  expect(frameAt(100, scroll, 8)).toBe(100);
  // Near the start there is nothing to scroll back to.
  expect(scrollForAnchor(5, 400, 8)).toBe(0);
});

test("zooming in from a wide fit keeps the frame under the cursor, though the scroller keeps whole pixels", () => {
  // Ten minutes fitted in 976px is 0.054 px per frame: one pixel of scroll is 18 frames.
  const anchor = 613;
  let ppf = fitPpf(18_000, 1_008, fps30);
  let exact = 0;
  let native = 0;
  const frame = (exact + anchor) / ppf;
  while (ppf < MAX_PPF) {
    const from = settledScroll(exact, native);
    const under = (from + anchor) / ppf;
    ppf = Math.min(MAX_PPF, ppf * 1.05);
    exact = scrollForAnchor(under, anchor, ppf);
    native = Math.round(exact);
  }
  expect((settledScroll(exact, native) + anchor) / ppf).toBeCloseTo(frame, 6);
  // What is drawn is within the scroller's half pixel of it.
  expect(Math.abs((native + anchor) / ppf - frame)).toBeLessThan(0.02);
});

test("a scroll by the person, or the scroller's bounds, replaces the remembered offset", () => {
  expect(settledScroll(120.4, 120)).toBe(120.4);
  expect(settledScroll(120.4, 500)).toBe(500);
  expect(settledScroll(9_000.7, 8_640)).toBe(8_640);
});

test("looped playback pages once per wrap, and once each time the playhead nears the edge", () => {
  // 2 px per frame in a 1000px view, looping frames 100 to 900.
  const ppf = 2;
  const width = 1_000;
  let scroll = 0;
  const pages: number[] = [];
  const show = (frame: number) => {
    const target = pageTarget(frame * ppf - scroll, width, 1);
    if (target === null) return;
    scroll = Math.max(0, frame * ppf - target);
    pages.push(frame);
  };
  for (let frame = 100; frame < 900; frame++) show(frame);
  // 900px of the view is frame 450; the page puts it at 100px, so the next is 400 frames on.
  expect(pages).toEqual([450, 850]);
  for (let frame = 100; frame < 300; frame++) show(frame);
  // The wrap to the in point is one page back, not a page each way on consecutive frames.
  expect(pages).toEqual([450, 850, 100]);
  expect(scroll).toBe(100);
});

test("reverse playback pages at the left edge, and back to a playhead that is ahead of the view", () => {
  expect(pageTarget(101, 1_000, -1)).toBeNull();
  expect(pageTarget(100, 1_000, -1)).toBe(900);
  expect(pageTarget(1_200, 1_000, -1)).toBe(900);
  expect(pageTarget(-40, 1_000, -1)).toBe(900);
  // Forward: started past the threshold, or beyond the view, it still pages.
  expect(pageTarget(899, 1_000, 1)).toBeNull();
  expect(pageTarget(950, 1_000, 1)).toBe(100);
  expect(pageTarget(2_656, 1_000, 1)).toBe(100);
});

test("fit shows the whole timeline and the slider runs from fit to the closest zoom", () => {
  const fit = fitPpf(9_000, 1_232, fps30);
  expect(9_000 * fit).toBeCloseTo(1_200);
  // An empty timeline shows ten seconds; a few frames never zoom past the closest zoom.
  expect(fitPpf(0, 1_232, fps30)).toBe(4);
  expect(fitPpf(10, 1_232, fps30)).toBe(MAX_PPF);
  expect(zoomToSlider(fit, fit)).toBe(0);
  // A ripple holds the earlier scale until its gap closes, even when the new Fit is closer.
  expect(zoomToSlider(fit / 2, fit)).toBe(0);
  expect(zoomToSlider(MAX_PPF, fit)).toBe(1);
  expect(sliderToZoom(0.5, fit)).toBeCloseTo(Math.sqrt(fit * MAX_PPF));
  expect(zoomToSlider(sliderToZoom(0.3, fit), fit)).toBeCloseTo(0.3);
  expect(sliderToZoom(4, fit)).toBe(MAX_PPF);
});

test("video tracks stack upward from the divider and audio downward", () => {
  const sizes = { video: 56, audio: 44, seam: 1, divider: 2 };
  const layout = trackRows(
    [
      track(0),
      track(1, { kind: "audio" }),
      track(2),
      track(3, { kind: "audio" }),
    ],
    sizes,
  );
  expect(layout.rows.map((row) => [row.id, row.track.index, row.top])).toEqual([
    ["V2", 2, 0],
    ["V1", 0, 57],
    ["A1", 1, 116],
    ["A2", 3, 161],
  ]);
  expect(layout.dividerTop).toBe(114);
  expect(layout.height).toBe(206);
  expect(rowsBetween(layout.rows, 56, 117).map((row) => row.id)).toEqual([
    "V1",
    "A1",
  ]);
  // An empty timeline still shows one video and one audio track.
  expect(
    trackRows([], sizes).rows.map((row) => [
      row.id,
      row.track.index,
      row.track.kind,
    ]),
  ).toEqual([
    ["V1", 0, "video"],
    ["A1", 1, "audio"],
  ]);
  // A kind with no track yet gets an empty row on a free index, so it is never created over
  // an existing track or as the other kind.
  expect(
    trackRows([track(1, { kind: "audio", locked: true })], sizes).rows.map(
      (row) => [row.id, row.track.index, row.track.kind],
    ),
  ).toEqual([
    ["V1", 0, "video"],
    ["A1", 1, "audio"],
  ]);
  expect(
    trackRows([track(0), track(1)], sizes).rows.map((row) => [
      row.id,
      row.track.index,
    ]),
  ).toEqual([
    ["V2", 1],
    ["V1", 0],
    ["A1", 2],
  ]);
});

test("new-track bands use the same row geometry as the created tracks", () => {
  const tracks = [track(0), track(1, { kind: "audio" })];
  for (const height of [28, 200]) {
    const sizes = {
      video: 96,
      audio: 80,
      seam: 1,
      divider: 2,
      heights: { "0": height, "1": height },
    };
    const layout = trackRows(tracks, { ...sizes, dropZones: true });
    for (const kind of ["video", "audio"] as const) {
      const preview = layout.newRows[kind];
      const created = trackRows([...tracks, preview.track], sizes).rows.find(
        (row) => row.track.index === preview.track.index,
      )!;
      expect(preview.height).toBe(created.height);
      expect(preview.top + preview.height).toBeLessThan(layout.height);
      for (const row of layout.rows)
        expect(
          preview.top + preview.height <= row.top ||
            preview.top >= row.top + row.height,
        ).toBe(true);
    }
  }
});

test("the mounted range holds until the view leaves it or it grows too long", () => {
  const first = mountedRange(null, { from: 100, to: 200 });
  expect(first).toEqual({ from: 50, to: 250 });
  // Scrolling inside the overscan keeps the same range, so nothing renders.
  expect(mountedRange(first, { from: 140, to: 240 })).toBe(first);
  expect(mountedRange(first, { from: 160, to: 260 })).toEqual({
    from: 110,
    to: 310,
  });
  // Zooming in keeps it until the view is under a quarter of what is mounted.
  expect(mountedRange(first, { from: 100, to: 150 })).toBe(first);
  expect(mountedRange(first, { from: 100, to: 140 })).toEqual({
    from: 80,
    to: 160,
  });
  expect(mountedRange(null, { from: 0, to: 100 }).from).toBe(0);
});

test("only clips touching the range are mounted, including a long clip that starts before it", () => {
  const clips = [
    clip("long", 0, 0, 500),
    clip("a", 0, 10, 10),
    clip("b", 0, 100, 50),
    clip("c", 0, 150, 50),
    clip("d", 0, 600, 10),
  ];
  const track = clipsByTrack(clips).get(0)!;
  const ids = (from: number, to: number) =>
    clipsInRange(track, { from, to }).map((item) => item.id);
  expect(ids(120, 160)).toEqual(["long", "b", "c"]);
  // Ranges are half-open: a clip ending at 150 is not in [150, 200).
  expect(ids(150, 200)).toEqual(["long", "c"]);
  expect(ids(500, 600)).toEqual([]);
  expect(ids(500, 601)).toEqual(["d"]);
  expect(ids(700, 900)).toEqual([]);
});

const edit = timeline(
  [
    clip("v1", 0, 0, 100, { link: "a" }),
    clip("v2", 0, 100, 100),
    clip("v3", 0, 200, 100),
    clip("a1", 1, 0, 100, { kind: "audio", link: "a" }),
    clip("a2", 1, 150, 100, { kind: "audio" }),
    clip("t1", 2, 120, 30),
    clip("m1", 3, 0, 300, { kind: "audio" }),
  ],
  [
    track(0),
    track(1, { kind: "audio" }),
    track(2),
    track(3, { kind: "audio", locked: true }),
  ],
);
// Top to bottom as displayed: V2, V1, A1, A2.
const order = [2, 0, 1, 3];
const plain = { toggle: false, range: false, alone: false };
const ids = (selection: { ids: ReadonlySet<string> }) =>
  [...selection.ids].sort();

test("a click selects a clip with its linked partner; Alt leaves the partner out", () => {
  const picked = clickSelection(edit, order, emptySelection, "v1", plain);
  expect(ids(picked)).toEqual(["a1", "v1"]);
  expect(picked.anchor).toBe("v1");
  expect(ids(clickSelection(edit, order, picked, "v2", plain))).toEqual(["v2"]);
  expect(
    ids(
      clickSelection(edit, order, emptySelection, "v1", {
        ...plain,
        alone: true,
      }),
    ),
  ).toEqual(["v1"]);
});

test("Ctrl-click adds and removes a clip without touching the rest", () => {
  const toggle = { ...plain, toggle: true };
  const one = clickSelection(edit, order, emptySelection, "v2", plain);
  const two = clickSelection(edit, order, one, "t1", toggle);
  expect(ids(two)).toEqual(["t1", "v2"]);
  expect(ids(clickSelection(edit, order, two, "v2", toggle))).toEqual(["t1"]);
  // Removing a linked clip removes its partner too.
  const linked = clickSelection(edit, order, two, "v1", toggle);
  expect(ids(linked)).toEqual(["a1", "t1", "v1", "v2"]);
  expect(ids(clickSelection(edit, order, linked, "a1", toggle))).toEqual([
    "t1",
    "v2",
  ]);
});

test("Shift-click selects everything between the anchor and the clip, across the tracks between", () => {
  const range = { ...plain, range: true };
  const anchor = clickSelection(edit, order, emptySelection, "t1", plain);
  // From the title on V2 down to a2 on A1: V2, V1 and A1 between frames 120 and 250.
  const picked = clickSelection(edit, order, anchor, "a2", range);
  expect(ids(picked)).toEqual(["a2", "t1", "v2", "v3"]);
  // The anchor stays, so a second Shift-click re-ranges from the same clip.
  expect(picked.anchor).toBe("t1");
  expect(ids(clickSelection(edit, order, picked, "v2", range))).toEqual([
    "t1",
    "v2",
  ]);
  // With nothing to range from, Shift-click is a plain click.
  expect(ids(clickSelection(edit, order, emptySelection, "v3", range))).toEqual(
    ["v3"],
  );
});

test("clips on a locked track cannot be selected by click, marquee, or Shift+V", () => {
  expect(clickSelection(edit, order, emptySelection, "m1", plain)).toBe(
    emptySelection,
  );
  expect(
    ids(marqueeSelection(edit, [0, 1, 2, 3], { from: 0, to: 900 })),
  ).toEqual(["a1", "a2", "t1", "v1", "v2", "v3"]);
  expect(ids(selectionAtPlayhead(edit, 130))).toEqual(["t1", "v2"]);
});

test("a marquee selects what it touches, plus linked partners, and adds to a held selection", () => {
  // Frames 90 to 100 on V1 only: v1 ends at 100, v2 starts there and is not touched.
  expect(ids(marqueeSelection(edit, [0], { from: 90, to: 100 }))).toEqual([
    "a1",
    "v1",
  ]);
  const held = clickSelection(edit, order, emptySelection, "v3", plain);
  expect(
    ids(marqueeSelection(edit, [2], { from: 100.5, to: 125.2 }, held)),
  ).toEqual(["t1", "v3"]);
  expect(ids(marqueeSelection(edit, [2], { from: 0, to: 100 }))).toEqual([]);
});

test("Shift+V skips tracks with auto-select off", () => {
  const off = timeline(
    edit.clips.filter((item) => item.track !== 3),
    [track(0, { autoSelect: false }), track(1, { kind: "audio" }), track(2)],
  );
  expect(ids(selectionAtPlayhead(off, 50))).toEqual(["a1"]);
  // The frame a clip ends on belongs to the next clip.
  expect(ids(selectionAtPlayhead(edit, 100))).toEqual(["v2"]);
});

test("a selection drops clips that were removed or whose track was locked", () => {
  const picked = marqueeSelection(edit, [0, 2], { from: 0, to: 900 });
  expect(pruneSelection(edit, picked)).toBe(picked);
  const locked = timeline(
    edit.clips.filter((item) => item.id !== "v3"),
    [track(0), track(1, { kind: "audio" }), track(2, { locked: true })],
  );
  expect(ids(pruneSelection(locked, { ...picked, anchor: "t1" }))).toEqual([
    "a1",
    "v1",
    "v2",
  ]);
  expect(pruneSelection(locked, { ...picked, anchor: "t1" }).anchor).toBeNull();
});

test("motion durations read the same from dev and minified CSS", () => {
  expect(cssMilliseconds("220ms")).toBe(220);
  expect(cssMilliseconds(" .22s")).toBe(220);
  // Reduced motion collapses movement to zero, which the timeline takes as no animation.
  expect(cssMilliseconds("0s")).toBe(0);
});

test("the canvas eases a sliding clip on the same curve the browser eases its box", () => {
  // A symmetric curve is half the way at half the time.
  expect(cssEasing("cubic-bezier(0.42, 0, 0.58, 1)")(0.5)).toBeCloseTo(0.5, 4);
  // The edit slide's curve as minified CSS writes it: slow to start, and always moving forward.
  const ease = cssEasing("cubic-bezier(.77, 0, .175, 1)");
  expect([ease(0), ease(1)]).toEqual([0, 1]);
  expect(ease(0.25)).toBeLessThan(0.1);
  const samples = Array.from({ length: 11 }, (_, step) => ease(step / 10));
  expect(samples).toEqual(samples.toSorted((a, b) => a - b));
  expect(cssEasing("ease")(0.3)).toBe(0.3);
});

test("a waveform is drawn from the coarsest level that still gives every pixel its own bucket", () => {
  // Buckets are 2 ms at level 0 and four times longer at each level after it.
  // At the closest zoom a pixel is about a millisecond: nothing is finer than level 0.
  expect(peakLevel(sourceSecondsPerPixel(32, fps30, 1))).toBe(0);
  // One frame per pixel is 33 ms a pixel: the 32 ms level, and 128 ms at four times the speed.
  expect(peakLevel(sourceSecondsPerPixel(1, fps30, 1))).toBe(2);
  expect(peakLevel(sourceSecondsPerPixel(1, fps30, 4))).toBe(3);
  // Ten minutes fitted in the lanes is 0.38 s a pixel: 128 ms buckets, three to a pixel.
  const fit = fitPpf(18_000, 1_620, fps30);
  expect(peakLevel(sourceSecondsPerPixel(fit, fps30, 1))).toBe(3);
  // A pixel exactly one bucket long uses that level; a hair shorter drops to the finer one.
  expect(peakLevel(0.008)).toBe(1);
  expect(peakLevel(0.007_9)).toBe(0);
  // A day in view still has a level: the coarsest.
  expect(peakLevel(100)).toBe(6);
});

test("filmstrip tiles start on the clip's first frame and show the source from its media start", () => {
  const cut = { mediaStart: 3, playbackRate: 1 };
  // At 2 px per frame a 71px tile spans 1.18 s, so the frames shown are a second apart.
  const perPixel = sourceSecondsPerPixel(2, fps30, 1);
  const step = frameStep(71 * perPixel);
  expect(step).toBe(1);
  expect(filmTiles(cut, 71, perPixel, step, 0, 200)).toEqual([
    { x: 0, time: 3 },
    { x: 71, time: 4 },
    { x: 142, time: 5 },
  ]);
  // Scrolled 100px into the clip, the tiles are the same ones in the same places.
  expect(filmTiles(cut, 71, perPixel, step, 100, 300)).toEqual([
    { x: 71, time: 4 },
    { x: 142, time: 5 },
    { x: 213, time: 6 },
    { x: 284, time: 7 },
  ]);
  // At double speed each tile covers twice the source: frames two seconds apart, from the trim.
  const fast = { mediaStart: 3, playbackRate: 2 };
  const fastPixel = sourceSecondsPerPixel(2, fps30, 2);
  expect(frameStep(71 * fastPixel)).toBe(2);
  expect(
    filmTiles(fast, 71, fastPixel, 2, 0, 200).map((tile) => tile.time),
  ).toEqual([3, 5, 7]);
});

test("a trimmed clip's first tile is its first frame, never footage from before the trim", () => {
  // Trimmed to 1.3 s and 3.1 s, off every step. The first tile is the trim point itself and
  // the rest count whole steps on from it.
  const perPixel = sourceSecondsPerPixel(32, fps30, 1);
  const step = frameStep(71 * perPixel);
  for (const mediaStart of [1.3, 3.1]) {
    const times = filmTiles(
      { mediaStart, playbackRate: 1 },
      71,
      perPixel,
      step,
      0,
      200,
    ).map((tile) => tile.time);
    expect(times[0]).toBe(mediaStart);
    expect(times[1]).toBeCloseTo(mediaStart + 0.0625, 9);
    expect(times[2]).toBeCloseTo(mediaStart + 0.125, 9);
  }
});

test("filmstrip frames come from the sprite until a tile is shorter than its two seconds", () => {
  // Fitted, a tile spans far more than two seconds: one sprite frame each.
  expect(frameStep(71 * sourceSecondsPerPixel(0.09, fps30, 1))).toBe(2);
  // At the closest zoom a tile is 2.2 frames: frames a sixteenth of a second apart.
  expect(frameStep(71 * sourceSecondsPerPixel(32, fps30, 1))).toBe(0.0625);
});

test("a media source resolves to one project file for the server and the timeline", () => {
  expect(localMediaPath("index.html", "media/a%20b.mp4?v=2")).toBe(
    "media/a b.mp4",
  );
  expect(localMediaPath("index.html", "./footage.mp4#t=1")).toBe("footage.mp4");
  expect(localMediaPath("compositions/intro.html", "../media/a.mp4")).toBe(
    "media/a.mp4",
  );
  expect(localMediaPath("compositions/intro.html", "bed.wav")).toBe(
    "compositions/bed.wav",
  );
  // A leading slash still means the composition's own folder.
  expect(localMediaPath("compositions/intro.html", "/assets/a.mp4")).toBe(
    "compositions/assets/a.mp4",
  );
  // A path out of the project keeps its `..`, so the file lookup refuses it.
  expect(localMediaPath("compositions/intro.html", "../../secret.mp4")).toBe(
    "../secret.mp4",
  );
  expect(localMediaPath("index.html", "https://example.com/a.mp4")).toBeNull();
  expect(localMediaPath("index.html", "//example.com/a.mp4")).toBeNull();
  expect(localMediaPath("index.html", "bad%zz.mp4")).toBeNull();
});

test("waveform dB mapping hides the noise floor and gives speech room without hitting the edges", () => {
  const height = (db: number) => waveformPeak(10 ** (db / 20));
  expect(waveformPeak(0)).toBe(0);
  // Noise below the floor reads as silence.
  expect(height(-60)).toBe(0);
  // Speech peaking near -3.5 dB fills most of the body.
  expect(height(-3.5)).toBeGreaterThan(0.7);
  // A loud music bed moving between -12 and -3 dB keeps visible dynamics, not a solid band.
  expect(height(-3) - height(-12)).toBeGreaterThan(0.25);
  // Quiet room tone stays small.
  expect(height(-40)).toBeLessThan(0.1);
  expect(waveformPeak(-(10 ** (-3.5 / 20)))).toBe(-height(-3.5));
  expect(waveformPeak(1)).toBe(0.9);
  expect(waveformPeak(2)).toBe(0.9);
});
