import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEditFrame,
  followEditPicture,
  previewEditFrame,
} from "../src/client/edit/editFrame";
import type { EditPicture } from "../src/client/edit/editFrame";
import { matchFrame } from "../src/client/edit/keys";
import {
  picturePiece,
  picturesAt,
} from "../src/server/hyperframes/pictureSelection";
import { sourcePictures } from "../src/server/media/pictureIndex";
import { planResolveTimeline } from "../src/server/resolve/plan";
import type { ClipMedia } from "../src/server/resolve/plan";
import { probeMedia } from "../src/server/resolve/probe";
import { duckPlan, soundWindow } from "../src/server/timeline/audio";
import {
  prepareFrozenFrames,
  saveFrozenFrames,
} from "../src/server/timeline/freeze";
import { applyAll } from "../src/shared/timeline/apply";
import type { ClipOrigin } from "../src/shared/timeline/apply";
import {
  ClipSchema,
  CommandSchema,
  TimelineSchema,
} from "../src/shared/timeline/schema";
import type {
  Clip,
  CommandInput,
  Fps,
  Timeline,
} from "../src/shared/timeline/schema";
import { syncOffsets } from "../src/shared/timeline/sync";
import { newTrack } from "../src/shared/timeline/tracks";

const ready = Bun.which("ffmpeg") && Bun.which("ffprobe");
const thirty = { num: 30, den: 1 };
const ntsc = { num: 30000, den: 1001 };
const film = { num: 24000, den: 1001 };
const sixty = { num: 60, den: 1 };
/** P6's ramp: 0.5x to 2x over 4 s on HyperFrames' default curve. */
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

async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [out, error, exit] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(error);
  return Buffer.from(out);
}
const ffmpeg = (...args: string[]) =>
  command(["ffmpeg", "-v", "error", "-nostdin", ...args]);

/** Pictures numbered in eight black and white cells, as tests/export-picture.test.ts reads them. */
const NUMBERED = (rate: string) =>
  `nullsrc=s=96x54:r=${rate},geq=lum='if(mod(floor(N/pow(2,floor(X/12))),2),235,16)':cb=128:cr=128`;

async function numbered(
  path: string,
  rate: string,
  count: number,
  extra: string[] = [],
) {
  await ffmpeg(
    ...["-f", "lavfi", "-i", NUMBERED(rate), "-frames:v", String(count)],
    ...["-c:v", "libx264", "-crf", "15", "-threads", "1", ...extra, path],
  );
}

async function label(path: string) {
  const cells = await ffmpeg(
    ...["-i", path, "-vf", "crop=96:2:0:26,scale=8:1:flags=area,format=gray"],
    ...["-f", "rawvideo", "pipe:1"],
  );
  return [...cells.subarray(0, 8)].reduce(
    (value, cell, bit) => value + (cell > 128 ? 1 << bit : 0),
    0,
  );
}

const SPEECH = [
  [1, 2],
  [2.45, 3.6],
  [5, 7],
] as const;
const BURSTS = `if(${SPEECH.map(([a, b]) => `between(t,${a},${b})`).join("+")},0.5*sin(2*PI*440*t),0)`;

/** Each fixture of the picture rows, made once. */
const fixtures = (async () => {
  if (!ready) return null;
  const dir = await mkdtemp(join(tmpdir(), "timing-tools-"));
  const media = join(dir, "media");
  await mkdir(media);
  const path = (name: string) => join(media, name);
  await Promise.all([
    // P1: 1 s open GOPs with two B-frames.
    numbered(path("gop.mp4"), "30", 90, [
      ...["-g", "30", "-bf", "2", "-x264-params", "open-gop=1:scenecut=0"],
    ]),
    numbered(path("pal.mp4"), "25", 20),
    numbered(path("film.mp4"), "24000/1001", 20),
    numbered(path("ntsc.mp4"), "30000/1001", 20),
    numbered(path("double.mp4"), "60000/1001", 40),
    // P11: pictures at 0, 40, 50, 100, 120 and 200 ms.
    // A trailing picture at 233 ms keeps 200 ms off the end, which some FFmpeg builds' edit
    // lists leave out when the last picture has no duration.
    numbered(path("vfr.mp4"), "30", 7, [
      "-vf",
      "settb=1/1000,setpts='if(eq(N,0),0,if(eq(N,1),40,if(eq(N,2),50,if(eq(N,3),100,if(eq(N,4),120,if(eq(N,5),200,233))))))'",
      ...["-fps_mode", "passthrough", "-enc_time_base", "1/1000", "-bf", "0"],
      ...["-video_track_timescale", "1000"],
    ]),
    // P12: Matroska keeps whole milliseconds, so a 60 fps picture starts up to half one late.
    numbered(path("ms.mkv"), "60", 20),
    numbered(path("ramp.mp4"), "30", 160),
    // Tone where a voice speaks: source seconds 1 to 2, 2.45 to 3.6 and 5 to 7 of 12.
    ffmpeg(
      ...["-f", "lavfi", "-i", `aevalsrc='${BURSTS}':s=48000:d=12`],
      ...["-c:a", "pcm_s16le", path("bursts.wav")],
    ),
  ]);
  return { dir, path };
})();

afterAll(async () => {
  const made = await fixtures;
  if (made) await rm(made.dir, { recursive: true, force: true });
});

const empty = (fps: Fps): Timeline =>
  TimelineSchema.parse({
    fps,
    duration: 600,
    tracks: [newTrack(0, "video"), newTrack(1, "audio")],
    clips: [],
    markers: [],
    range: { in: null, out: null },
  });

const video = (fields: Partial<Clip> & Pick<Clip, "id" | "src">): Clip =>
  ClipSchema.parse({
    track: 0,
    kind: "video",
    start: 0,
    duration: 10,
    mediaStart: 0,
    playbackRate: 1,
    sourceDuration: 20,
    hasAudio: false,
    link: null,
    label: null,
    volume: null,
    opacity: null,
    enabled: true,
    startRef: null,
    ...fields,
  });

const run = (timeline: Timeline, commands: CommandInput[]) =>
  applyAll(
    timeline,
    commands.map((command) => CommandSchema.parse(command)),
  );

/** Split a clip at every frame, so each piece starts on one frame of the uncut clip. */
function everyFrame(fps: Fps, clip: Clip) {
  return run({ ...empty(fps), clips: [clip] }, [
    ...Array.from({ length: clip.duration - 1 }, (_, index) => ({
      type: "split" as const,
      at: clip.start + index + 1,
      clipIds: [index === 0 ? clip.id : `${clip.id}-${index}`],
      ids: {
        [index === 0 ? clip.id : `${clip.id}-${index}`]: [
          `${clip.id}-${index + 1}`,
        ],
      },
    })),
  ]);
}

/** Each FCPXML picture clip's timeline frame and source-in frame, at the source's own rate. */
function sourceIns(fcpxml: string, timelineFps: Fps, sourceFps: Fps) {
  const seconds = (value: string) => {
    const [num, den = "1"] = value.replace(/s$/, "").split("/");
    return Number(num) / Number(den);
  };
  return [...fcpxml.matchAll(/<(?:video|asset-clip) ([^>]*)>/g)].map(
    ([, attributes]) => {
      const attr = (name: string) =>
        new RegExp(`\\b${name}="([^"]+)"`).exec(attributes!)?.[1] ?? "0s";
      return {
        at: Math.round(
          (seconds(attr("offset")) * timelineFps.num) / timelineFps.den,
        ),
        frame: Math.round(
          (seconds(attr("start")) * sourceFps.num) / sourceFps.den,
        ),
      };
    },
  );
}

async function resolveColumn(
  name: string,
  fps: Fps,
  sourceFps: Fps,
  count: number,
  clip: Partial<Clip> = {},
) {
  const { path } = (await fixtures)!;
  const facts = await probeMedia(path(name));
  if (!facts) throw new Error(`${name} could not be probed`);
  const timeline = everyFrame(
    fps,
    video({ id: "shot", src: path(name), duration: count, ...clip }),
  );
  const plan = planResolveTimeline({
    name: "Cut",
    timeline,
    size: { width: 96, height: 54 },
    media: new Map<string, ClipMedia>(
      timeline.clips.map((piece) => [piece.id, { kind: "file", facts }]),
    ),
  });
  return sourceIns(plan.fcpxml, fps, sourceFps)
    .sort((a, b) => a.at - b.at)
    .map(({ frame }): number | null => frame);
}

/** The pictures export's capture selects for an uncut clip at each frame. */
async function exported(
  name: string,
  fps: Fps,
  count: number,
  timing: { mediaStart?: number; automation?: string } = {},
) {
  const { path } = (await fixtures)!;
  const source = (await sourcePictures(path(name)))!;
  const piece = picturePiece(
    {
      id: "shot",
      src: name,
      start: 0,
      end: (count * fps.den) / fps.num,
      mediaStart: timing.mediaStart ?? 0,
      playbackRate: timing.automation
        ? JSON.parse(timing.automation).lanes[0]
        : 1,
    },
    fps,
    source,
  );
  return picturesAt(piece, source, fps, 0, count);
}

test.skipIf(!ready)(
  "Resolve's source-in is the picture export shows at each piece's first frame",
  async () => {
    // P4: the piece split at 59 of an open-GOP file starts on 59.
    const gop = await resolveColumn("gop.mp4", thirty, thirty, 90);
    expect(gop).toEqual(Array.from({ length: 90 }, (_, n) => n));
    // P8, P9, P10 on 29.97.
    expect(
      await resolveColumn("pal.mp4", ntsc, { num: 25, den: 1 }, 10),
    ).toEqual([0, 0, 1, 2, 3, 4, 5, 5, 6, 7]);
    expect(await resolveColumn("film.mp4", ntsc, film, 11)).toEqual([
      0, 0, 1, 2, 3, 4, 4, 5, 6, 7, 8,
    ]);
    // A piece's stored in-point at 59.94 rounds 0.3 µs short of picture 2n; export's lead finds 2n.
    expect(
      await resolveColumn("double.mp4", ntsc, { num: 60000, den: 1001 }, 20),
    ).toEqual(Array.from({ length: 20 }, (_, n) => 2 * n));
    // 23.976 and 29.97 timelines over their own rate.
    expect(await resolveColumn("film.mp4", film, film, 20)).toEqual(
      Array.from({ length: 20 }, (_, n) => n),
    );
    expect(await resolveColumn("ntsc.mp4", ntsc, ntsc, 20)).toEqual(
      Array.from({ length: 20 }, (_, n) => n),
    );
    // P11: a variable-rate file, counted in pictures on the grid ffprobe reports, here 1000 fps.
    const vfr = { num: 1000, den: 1 };
    expect(await resolveColumn("vfr.mp4", thirty, vfr, 7)).toEqual([
      0, 0, 2, 3, 4, 4, 5,
    ]);
    // P12: Matroska's millisecond clock.
    expect(await resolveColumn("ms.mkv", sixty, sixty, 20)).toEqual(
      Array.from({ length: 20 }, (_, n) => n),
    );
    // And each is the picture export's capture writes at that frame of the uncut clip.
    expect(
      await resolveColumn("double.mp4", ntsc, { num: 60000, den: 1001 }, 20),
    ).toEqual(await exported("double.mp4", ntsc, 20));
    expect(await resolveColumn("vfr.mp4", thirty, vfr, 7)).toEqual(
      await exported("vfr.mp4", thirty, 7),
    );
  },
  60_000,
);

test("Resolve's sound-only source-in is the source sample the mixer reads first", () => {
  // 1x at 29.97, in-point 10 µs past a frame: the line is 0.48 of a sample off. Frame 3 is output
  // sample 4805, and the mixer reads 4805 plus the line's whole-sample offset, 0.
  const timeline = everyFrame(
    ntsc,
    video({
      id: "voice",
      kind: "audio",
      track: 1,
      src: "voice.wav",
      mediaStart: 0.00001,
      duration: 6,
      hasAudio: true,
    }),
  );
  const plan = planResolveTimeline({
    name: "Cut",
    timeline,
    size: { width: 96, height: 54 },
    media: new Map<string, ClipMedia>(
      timeline.clips.map((clip) => [
        clip.id,
        {
          kind: "file",
          facts: {
            path: "/media/voice.wav",
            video: null,
            audio: { channels: 1, sampleRate: 48000, codec: "pcm_s16le" },
            duration: 20,
          },
        },
      ]),
    ),
  });
  const starts = [...plan.fcpxml.matchAll(/<asset-clip [^>]*start="([^"]+)"/g)]
    .map(([, start]) => {
      const [num, den = "1"] = start!.replace(/s$/, "").split("/");
      return (Number(num) * 48000) / Number(den);
    })
    .sort((a, b) => a - b);
  expect(starts).toEqual([0, 1602, 3203, 4805, 6406, 8008]);
});

test("a duck or loudness reading starts on the source sample the mixer plays first", () => {
  // S1b's line: 29.97, 1x, the in-point 10 µs late. Pieces split at frames 1 to 5 read output
  // samples 1602, 3203, 4805, 6406 and 8008 plus one offset for the line, here 0.
  const timeline = everyFrame(
    ntsc,
    video({
      id: "voice",
      kind: "audio",
      track: 1,
      src: "voice.wav",
      mediaStart: 0.00001,
      duration: 6,
      hasAudio: true,
    }),
  );
  const windows = timeline.clips
    .toSorted((a, b) => a.start - b.start)
    .map((clip) => soundWindow(clip, ntsc));
  expect(windows.map(({ from }) => Math.round(from * 48000))).toEqual([
    0, 1602, 3203, 4805, 6406, 8008,
  ]);
  // Each reads to where the next begins, so the pieces cover the source once.
  windows.slice(1).forEach(({ from }, index) => {
    const before = windows[index]!;
    expect(Math.round((before.from + before.seconds) * 48000)).toBe(
      Math.round(from * 48000),
    );
  });
  // A ramp's reading runs from the source at its first sample to the source at its end: P6 over
  // 5 s is 6.16 s of source by the closed form 2 / ln 4 * (4^(t/4) - 1) + 2 * (t - 4).
  const ramp = soundWindow(
    video({
      id: "ramp",
      kind: "audio",
      track: 1,
      src: "voice.wav",
      duration: 150,
      automation: RAMP,
      hasAudio: true,
    }),
    thirty,
  );
  expect(ramp.from).toBe(0);
  expect(ramp.seconds).toBeCloseTo((2 / Math.log(4)) * 3 + 2, 3);
});

test("match frame and the trim view's edge land on export's picture through a ramp", () => {
  // P6: frame 60 shows picture 43 (1.4427 s) and frame 120 shows 129 (4.3281 s).
  const clip = video({
    id: "ramp",
    src: "ramp.mp4",
    duration: 150,
    sourceDuration: 10,
    automation: RAMP,
  });
  const timeline = { ...empty(thirty), clips: [clip] };
  const at = (frame: number) =>
    matchFrame(timeline, { selection: new Set(), frame })?.frame;
  expect(at(60)).toBe(43);
  expect(at(120)).toBe(129);
  // A 1x clip at 29.97, cut at 59: the tail's first frame is source frame 59.
  const cut = run(
    {
      ...empty(ntsc),
      clips: [video({ id: "shot", src: "shot.mp4", duration: 120 })],
    },
    [{ type: "split", at: 59, clipIds: ["shot"], ids: { shot: ["tail"] } }],
  );
  expect(
    matchFrame(cut, { selection: new Set(["tail"]), frame: 59 })?.frame,
  ).toBe(59);

  // Trimming the ramp's tail shows the source export shows at its last frame, 149: 6.2614 s by
  // the closed form 2 / ln 4 * 3 + 2 * (149 / 30 - 4), which is source frame 187.
  const seen: EditPicture[] = [];
  const stop = followEditPicture((picture) => {
    if (picture) seen.push(picture);
  });
  try {
    previewEditFrame(timeline, {
      kind: "trim",
      clipId: "ramp",
      edge: "end",
      ripple: false,
    });
  } finally {
    stop();
    clearEditFrame();
  }
  expect(seen[0]!.frames[0]!.time).toBeCloseTo(
    (2 / Math.log(4)) * 3 + 2 * (149 / 30 - 4),
    3,
  );
  expect(seen[0]!.labels).toEqual([]);
});

test("the sync badge reads a ramped pair from their source maps", () => {
  // S7: linked picture and sound on one ramp, split both, then trim only the sound by 3 frames.
  const linked = (id: string, kind: "video" | "audio", track: number) =>
    video({
      id,
      kind,
      track,
      src: "shot.mp4",
      duration: 150,
      automation: RAMP,
      link: "pair",
      hasAudio: kind === "audio",
    });
  const start = {
    ...empty(thirty),
    clips: [linked("pic", "video", 0), linked("snd", "audio", 1)],
  };
  const split = run(start, [
    {
      type: "split",
      at: 60,
      clipIds: ["pic", "snd"],
      ids: { pic: ["pic-2"], snd: ["snd-2"] },
    },
  ]);
  expect(syncOffsets(split).size).toBe(0);
  const trimmed = run(split, [
    { type: "trim", clipId: "snd-2", edge: "start", to: 63, linked: false },
  ]);
  expect(syncOffsets(trimmed).size).toBe(0);
  // S8: moved alone 2 frames later, the sound plays its source 2 frames late.
  const moved = run(trimmed, [
    { type: "move", clipIds: ["snd-2"], by: 2, linked: false },
  ]);
  const offsets = syncOffsets(moved);
  expect(offsets.get("snd-2")).toBe(2);
  expect(offsets.get("pic-2")).toBe(-2);

  // S8 by a slip: the sound alone shows 3 frames later along the ramp, so it plays each source
  // 3 frames early. A slip keeps the map's zero and moves its curve zero.
  const slipped = syncOffsets(
    run(trimmed, [{ type: "slip", clipId: "snd-2", by: 3, linked: false }]),
  );
  expect(slipped.get("snd-2")).toBe(-3);
  expect(slipped.get("pic-2")).toBe(3);

  // A pair on one ramp whose in-points differ by hand has different zeros, so neither is the
  // other shifted: each is compared where it starts. The sound starts 0.1 s into the source,
  // which the picture reaches at t with 2 / ln 4 * (4^(t/4) - 1) = 0.1, t = 0.1934 s, frame 6.
  const offset = syncOffsets({
    fps: thirty,
    clips: [
      linked("pic", "video", 0),
      { ...linked("snd", "audio", 1), mediaStart: 0.1 },
    ],
  });
  expect(offset.get("snd")).toBe(-6);
  expect(offset.get("pic")).toBe(6);
});

test.skipIf(!ready)(
  "a freeze frame captures the picture export shows",
  async () => {
    const { dir, path } = (await fixtures)!;
    const project = { path: dir };
    const freeze = async (
      name: string,
      fps: Fps,
      at: number,
      fields: Partial<Clip> = {},
    ) => {
      const clip = video({
        id: "shot",
        src: `media/${name}`,
        duration: 150,
        ...fields,
      });
      const origins = new Map<string, ClipOrigin>();
      applyAll(
        { ...empty(fps), clips: [clip] },
        [
          CommandSchema.parse({
            type: "freeze",
            clipId: "shot",
            at,
            mode: "replace",
          }),
        ],
        { onCreate: (id, origin) => origins.set(id, origin) },
      );
      const frames = [...origins.values()].flatMap((origin) =>
        "freeze" in origin ? [origin.freeze] : [],
      );
      const prepared = await prepareFrozenFrames(
        project,
        frames,
        new Map([[clip.src!, 10]]),
      );
      const stills: Buffer[] = [];
      const png = join(dir, "still.png");
      await saveFrozenFrames(
        project,
        prepared,
        async () => {},
        (_path, content) => stills.push(Buffer.from(content)),
      );
      await rm(join(dir, ".cutroom"), { recursive: true, force: true });
      await Bun.write(png, stills[0]!);
      return label(png);
    };
    void path;
    // P1: the pictures either side of an open GOP's second keyframe.
    expect(await freeze("gop.mp4", thirty, 59)).toBe(59);
    expect(await freeze("gop.mp4", thirty, 58)).toBe(58);
    expect(await freeze("gop.mp4", thirty, 60)).toBe(60);
    // P8 frame 6 and P9 frame 6 on 29.97.
    expect(await freeze("pal.mp4", ntsc, 6)).toBe(5);
    expect(await freeze("film.mp4", ntsc, 6)).toBe(4);
    // P11 frame 2.
    expect(await freeze("vfr.mp4", thirty, 2)).toBe(2);
    // P6 frame 120 through the ramp.
    expect(await freeze("ramp.mp4", thirty, 120, { automation: RAMP })).toBe(
      129,
    );
  },
  60_000,
);

test.skipIf(!ready)(
  "a duck lands where each voice plays its speech, at 2x, at 0.5x and through a ramp",
  async () => {
    const { dir } = (await fixtures)!;
    const bed = video({
      id: "bed",
      kind: "audio",
      track: 0,
      src: "media/bed.wav",
      duration: 900,
      hasAudio: true,
    });
    // Source seconds to the voice's own seconds, by closed form. P6's ramp is
    // 2 / ln 4 * (4^(t/4) - 1) to 4 s, where it has covered 6 / ln 4 s, then 2x.
    const covered = 6 / Math.log(4);
    const voices = {
      double: { fields: { playbackRate: 2 }, at: (s: number) => s / 2 },
      half: { fields: { playbackRate: 0.5 }, at: (s: number) => s * 2 },
      ramp: {
        fields: { automation: RAMP },
        at: (s: number) =>
          s <= covered
            ? (4 * Math.log(1 + (s * Math.log(4)) / 2)) / Math.log(4)
            : 4 + (s - covered) / 2,
      },
    };
    for (const [id, { fields, at }] of Object.entries(voices)) {
      // The voice starts one second into the bed.
      const voice = video({
        id,
        kind: "audio",
        track: 1,
        src: "media/bursts.wav",
        start: 30,
        duration: Math.ceil(at(9) * 30),
        hasAudio: true,
        ...fields,
      });
      const plan = await duckPlan(
        { path: dir },
        "index.html",
        {
          ...empty(thirty),
          tracks: [newTrack(0, "audio"), newTrack(1, "audio")],
          clips: [bed, voice],
        },
        { bed: "bed", voices: [id], depth: -12, attack: 0.1, release: 0.1 },
      );
      // A pause counts when it lasts 0.3 s on the timeline: 2x plays the 0.45 s gap in 0.225 s.
      const spans: [number, number][] = [];
      for (const [a, b] of SPEECH) {
        const last = spans.at(-1);
        if (last && 1 + at(a) - last[1] < 0.3) last[1] = 1 + at(b);
        else spans.push([1 + at(a), 1 + at(b)]);
      }
      expect(spans.length).toBe(id === "double" ? 2 : 3);
      expect(plan.speech).toBe(spans.length);
      const { volume } = plan.commands[0]!.automation;
      const floor = Math.min(...volume.map(({ gain }) => gain));
      const ducked = volume
        .filter(({ gain }) => gain === floor)
        .map(({ frame }) => frame);
      const expected = spans.flat().map((seconds) => seconds * 30);
      // Speech is found to a few milliseconds of source, a frame or two of timeline at 0.5x.
      expect(ducked).toHaveLength(expected.length);
      ducked.forEach((frame, index) =>
        expect(Math.abs(frame - expected[index]!)).toBeLessThan(1.5),
      );
    }
  },
  60_000,
);
