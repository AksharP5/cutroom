import { basename } from "node:path";
import {
  VOLUME_TARGET,
  gainedVolume,
  parseAutomation,
  sampleAutomationLane,
} from "@hyperframes/core/audio-automation";
import { clampFadesToDuration, fadeGain } from "@hyperframes/core/audio-fade";
import { cubicBezier, valueAt } from "../../shared/timeline/keyframes";
import type { KeyframeValues } from "../../shared/timeline/keyframes";
import { REGION_EASE_CURVES } from "../../shared/timeline/region";
import type { Region } from "../../shared/timeline/region";
import { elementSpan } from "../../shared/timeline/regionStyle";
import { isAudioKind } from "../../shared/timeline/schema";
import type {
  Clip,
  Fps,
  KeyframeEase,
  KeyframeProperty,
  Marker,
  Timeline,
} from "../../shared/timeline/schema";
import { formatTimecode } from "../../shared/timeline/timecode";
import { trackMix } from "../../shared/timeline/tracks";
import { framesBefore } from "../../shared/timeline/transition";
import {
  add,
  element,
  fcpxmlDocument,
  fileUrl,
  framesAt,
  rational,
  times,
} from "./fcpxml";
import type { Element, Rational } from "./fcpxml";
import type { MediaFacts } from "./probe";

/**
 * A clip's media as the planner reads it: a probed video or audio file, or a still image. `sound`
 * stands in for a file's sound where Resolve can't decode it.
 */
export type ClipMedia =
  | { kind: "file"; facts: MediaFacts; sound?: MediaFacts }
  | { kind: "still"; path: string };
type FileMedia = Extract<ClipMedia, { kind: "file" }>;

/** The file a clip's sound is read from. */
const soundOf = (media: FileMedia): FileMedia => ({
  kind: "file",
  facts: media.sound ?? media.facts,
});

export interface PlanInput {
  name: string;
  timeline: Timeline;
  size: { width: number; height: number };
  /** Local media for each clip that has it, by clip id. */
  media: ReadonlyMap<string, ClipMedia>;
  /** Clips rendered into a layer, whose zooms are already drawn. */
  baked?: ReadonlySet<string>;
}

export interface Plan {
  fcpxml: string;
  /** Resolve's marker EDL, or null when the timeline has no markers. */
  markers: string | null;
  /** Plain sentences naming what Resolve will not show as Cutroom does. */
  notes: string[];
}

/** Resolve reads FCPXML's position and crop in hundredths of the frame's height. */
const heightPercent = (pixels: number, height: number) =>
  (pixels / height) * 100;

/** The CSS perspective Cutroom zooms under; see regionStyle. */
const PERSPECTIVE = 1000;

/** Resolve's floor for clip volume. */
const SILENCE_DB = -96;
const decibels = (gain: number) =>
  gain > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(gain)) : SILENCE_DB;

/** Resolve's names for Cutroom's transitions; FCPXML names Final Cut's effect by its uid. */
const TRANSITIONS = {
  dissolve: {
    name: "Cross Dissolve",
    uid: "FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265",
  },
  dip: {
    name: "Fade To Color",
    uid: "FxPlug:1F8A3B6C-3C1C-4F8C-A73F-35F4C1D1D7C1",
  },
} as const;

const MARKER_COLOURS: Record<Marker["color"], string> = {
  blue: "Blue",
  cyan: "Cyan",
  green: "Green",
  yellow: "Yellow",
  red: "Red",
  pink: "Pink",
  purple: "Purple",
};

interface Zoom {
  /** Clip-local frames, end exclusive. */
  start: number;
  end: number;
  region: Region;
}

/** How far a zoom has eased in at a frame of its span, as Cutroom's stylesheet animates it. */
function zoomProgress({ start, end, region }: Zoom, frame: number) {
  const length = end - start;
  const at = frame - start;
  if (at < 0 || at >= length) return 0;
  const ease = (progress: number) =>
    cubicBezier(REGION_EASE_CURVES[region.ease], progress);
  const rampOut = Math.min(region.out, length);
  const rampIn = Math.min(region.in, length - rampOut - (rampOut ? 0 : 1));
  if (rampIn > 0 && at < rampIn) return ease(at / rampIn);
  if (rampOut > 0 && at > length - rampOut)
    return 1 - ease((at - (length - rampOut)) / rampOut);
  return 1;
}

/**
 * The zoom at a clip-local frame as a scale about the frame's centre and a translation applied
 * before it, the same perspective `translate` Cutroom draws. A later zoom takes over an earlier one.
 */
function zoomAt(
  zooms: readonly Zoom[],
  frame: number,
  size: PlanInput["size"],
) {
  const zoom = zooms.findLast(
    (candidate) => candidate.start <= frame && frame < candidate.end,
  );
  if (!zoom) return { scale: 1, x: 0, y: 0 };
  const progress = zoomProgress(zoom, frame);
  const { x, y, width } = zoom.region.box;
  const share = 1 - width;
  const depth = PERSPECTIVE * share * progress;
  return {
    scale: PERSPECTIVE / (PERSPECTIVE - depth),
    x: ((size.width / 2) * share - x * size.width) * progress,
    y: ((size.height / 2) * share - y * size.height) * progress,
  };
}

/**
 * Values at every frame, keeping only the frames where the motion bends: every frame dropped
 * lies on the straight line between the keys around it, so linear keys redraw each frame exactly.
 */
export function simplify<V>(
  values: readonly V[],
  numbers: (value: V) => number[],
  tolerance = 1e-4,
): { frame: number; value: V }[] {
  const points = values.map(numbers);
  const kept = [0];
  const straight = (from: number, to: number) => {
    for (let frame = from + 1; frame < to; frame++) {
      const share = (frame - from) / (to - from);
      const ok = points[frame]!.every(
        (value, index) =>
          Math.abs(
            points[from]![index]! +
              (points[to]![index]! - points[from]![index]!) * share -
              value,
          ) <= tolerance,
      );
      if (!ok) return false;
    }
    return true;
  };
  for (let to = 2; to < values.length; to++)
    if (!straight(kept.at(-1)!, to)) kept.push(to - 1);
  if (values.length > 1) kept.push(values.length - 1);
  return kept.map((frame) => ({ frame, value: values[frame]! }));
}

interface Context {
  input: PlanInput;
  fps: Fps;
  notes: string[];
  assets: Element[];
  formats: Element[];
  assetIds: Map<string, string>;
  formatIds: Map<string, string>;
  /** Resolve's audio lanes, A1 first, by key. */
  audioLanes: Map<string, number>;
  /** Clip-local zooms on each clip, from its own region and adjustment layers above it. */
  zooms: Map<string, Zoom[]>;
  hidden: ReadonlySet<number>;
  muted: ReadonlySet<number>;
  trackNames: Map<number, string>;
}

const nextId = (context: Context) =>
  `r${context.assets.length + context.formats.length + 2}`;

function formatFor(context: Context, video: MediaFacts["video"]) {
  const key = video
    ? `${video.rate.num}/${video.rate.den} ${video.width}x${video.height}`
    : "still";
  let id = context.formatIds.get(key);
  if (id) return id;
  id = nextId(context);
  context.formatIds.set(key, id);
  context.formats.push(
    element("format", {
      id,
      frameDuration: video
        ? rational(video.rate.den, video.rate.num)
        : undefined,
      width: video?.width ?? context.input.size.width,
      height: video?.height ?? context.input.size.height,
    }),
  );
  return id;
}

/** The asset for a file: with its picture and sound, or its picture or sound alone. */
function assetFor(
  context: Context,
  media: ClipMedia,
  role: "all" | "picture" | "sound",
) {
  const path = media.kind === "file" ? media.facts.path : media.path;
  const key = `${role} ${path}`;
  let id = context.assetIds.get(key);
  if (id) return id;
  const facts = media.kind === "file" ? media.facts : null;
  const video = role === "sound" ? null : (facts?.video ?? null);
  const audio = role === "picture" ? null : (facts?.audio ?? null);
  const format =
    media.kind === "still" || video ? formatFor(context, video) : undefined;
  id = nextId(context);
  context.assetIds.set(key, id);
  context.assets.push(
    element(
      "asset",
      {
        id,
        name: basename(path),
        start: sourceOrigin(media),
        duration:
          media.kind === "still"
            ? rational(0)
            : rational(Math.round(media.facts.duration * 1e6), 1e6),
        hasVideo: media.kind === "still" || video ? 1 : 0,
        hasAudio: audio ? 1 : 0,
        format,
        audioSources: audio ? 1 : undefined,
        audioChannels: audio?.channels,
        audioRate: audio?.sampleRate,
      },
      [element("media-rep", { kind: "original-media", src: fileUrl(path) })],
    ),
  );
  return id;
}

/** Where Resolve numbers a file's frames from: its timecode, or zero. */
const sourceOrigin = (media: ClipMedia): Rational =>
  media.kind === "file" && media.facts.video
    ? framesAt(media.facts.video.timecode, media.facts.video.rate)
    : rational(0);

/** The source time a clip starts at, on the frame export shows first. */
function sourceStart(clip: Clip, media: ClipMedia): Rational {
  if (media.kind === "still") return rational(0);
  const seconds = clip.mediaStart ?? 0;
  const { video, audio } = media.facts;
  if (video) {
    const frame = Math.max(
      0,
      Math.floor(
        (seconds - video.start) * (video.rate.num / video.rate.den) + 1e-6,
      ),
    );
    return add(sourceOrigin(media), framesAt(frame, video.rate));
  }
  const rate = audio?.sampleRate ?? 48_000;
  return rational(Math.round(seconds * rate), rate);
}

/** What Resolve and the summary call a clip. */
export const label = (clip: Clip) =>
  clip.label ?? clip.textPreview ?? (clip.src ? basename(clip.src) : clip.id);

const where = (context: Context, clip: Clip) =>
  `"${label(clip)}" at ${formatTimecode(clip.start, context.fps)} on ${context.trackNames.get(clip.track) ?? "its track"}`;

/** Keyframe values in FCPXML's units, as numbers for comparison and as attribute text. */
const PROPERTY_TEXT = {
  position: (value: KeyframeValues["position"], height: number) =>
    `${num(heightPercent(value.x, height))} ${num(-heightPercent(value.y, height))}`,
  scale: (value: KeyframeValues["scale"]) => `${num(value.x)} ${num(value.y)}`,
  rotation: (value: number) => num(-value),
  opacity: (value: number) => num(value),
} as const;
const num = (value: number) => String(Number(value.toFixed(6)) + 0);

type Picture = Omit<KeyframeValues, "crop"> & { crop: KeyframeValues["crop"] };

/** What a clip draws at a clip-local frame, its zooms included. */
function pictureAt(context: Context, clip: Clip, frame: number): Picture {
  const zoom = zoomAt(
    context.zooms.get(clip.id) ?? [],
    frame,
    context.input.size,
  );
  const position = valueAt(clip, "position", frame);
  const scale = valueAt(clip, "scale", frame);
  return {
    position: {
      x: zoom.scale * (position.x + zoom.x),
      y: zoom.scale * (position.y + zoom.y),
    },
    scale: { x: zoom.scale * scale.x, y: zoom.scale * scale.y },
    rotation: valueAt(clip, "rotation", frame),
    crop: valueAt(clip, "crop", frame),
    opacity: valueAt(clip, "opacity", frame),
  };
}

const NUMBERS: {
  [P in KeyframeProperty]: (value: KeyframeValues[P]) => number[];
} = {
  position: (value) => [value.x, value.y],
  scale: (value) => [value.x, value.y],
  rotation: (value) => [value],
  crop: (value) => [value.top, value.right, value.bottom, value.left],
  opacity: (value) => [value],
};

type Key<V> = { frame: number; value: V };

/**
 * A key's time, a hundredth of a frame late: Resolve rounds key times down in floating point, so
 * a key exactly on an NTSC frame (226 frames is 7.540866... s) can land on the frame before.
 */
const keyTime = (origin: Rational, frame: number, fps: Fps) =>
  add(origin, rational(frame * 100 * fps.den + fps.den, 100 * fps.num));

/**
 * One property's linear keys: the clip's own keyframes when its motion is linear or held, which
 * Resolve draws the same way, otherwise every frame the motion bends on. CSS's cubic-bezier eases
 * and Cutroom's zooms have no exact Resolve ease, so they are drawn frame by frame.
 */
function keysOf<P extends KeyframeProperty>(
  context: Context,
  clip: Clip,
  property: P,
): Key<KeyframeValues[P]>[] | null {
  const own = clip.keyframes?.[property] as
    | { frame: number; value: KeyframeValues[P]; ease: KeyframeEase }[]
    | undefined;
  const zoomed =
    (property === "position" || property === "scale") &&
    (context.zooms.get(clip.id)?.length ?? 0) > 0;
  if (!own && !zoomed) return null;
  const native =
    own &&
    !zoomed &&
    own.every(
      (key, index) =>
        key.frame >= 0 &&
        (key.ease === "linear" ||
          key.ease === "hold" ||
          index === own.length - 1),
    );
  if (native)
    return own.flatMap(({ frame, value, ease }, index) => {
      const next = own[index + 1];
      return ease === "hold" && next && next.frame - 1 > frame
        ? [
            { frame, value },
            { frame: next.frame - 1, value },
          ]
        : [{ frame, value }];
    });
  const values = Array.from(
    { length: clip.duration },
    (_, frame) =>
      pictureAt(context, clip, frame)[property] as KeyframeValues[P],
  );
  return simplify(values, NUMBERS[property]);
}

/** A `<param>` animating one property, with times in the clip's own (source) time. */
function animation<V>(
  name: string,
  keys: Key<V>[],
  text: (value: V) => string,
  origin: Rational,
  fps: Fps,
) {
  return element("param", { name, value: text(keys[0]!.value) }, [
    element(
      "keyframeAnimation",
      {},
      keys.map((key) =>
        element("keyframe", {
          time: keyTime(origin, key.frame, fps),
          value: text(key.value),
        }),
      ),
    ),
  ]);
}

/** The crop, conform, transform and opacity adjustments that place a picture as Cutroom does. */
function pictureAdjustments(
  context: Context,
  clip: Clip,
  origin: Rational,
): Element[] {
  const { fps } = context;
  const { height } = context.input.size;
  const first = pictureAt(context, clip, 0);
  const adjustments: Element[] = [];

  const crop = keysOf(context, clip, "crop");
  const edges = ["left", "right", "top", "bottom"] as const;
  if (crop || edges.some((edge) => first.crop[edge])) {
    adjustments.push(
      element("adjust-crop", { mode: "trim" }, [
        element(
          "trim-rect",
          Object.fromEntries(
            edges.map((edge) => [
              edge,
              num(heightPercent(first.crop[edge], height)),
            ]),
          ),
          crop
            ? edges.map((edge) =>
                animation(
                  edge,
                  crop,
                  (value) => num(heightPercent(value[edge], height)),
                  origin,
                  fps,
                ),
              )
            : [],
        ),
      ]),
    );
  }

  const fit = clip.style.objectFit;
  if (fit === "fill")
    context.notes.push(
      `${where(context, clip)} stretches to fill its box; Resolve scales it to fill instead.`,
    );
  adjustments.push(
    element("adjust-conform", {
      type: fit === "cover" || fit === "fill" ? "fill" : "fit",
    }),
  );

  const position = keysOf(context, clip, "position");
  const scale = keysOf(context, clip, "scale");
  const rotation = keysOf(context, clip, "rotation");
  const transformed =
    position ||
    scale ||
    rotation ||
    first.position.x ||
    first.position.y ||
    first.scale.x !== 1 ||
    first.scale.y !== 1 ||
    first.rotation;
  const toPosition = (value: KeyframeValues["position"]) =>
    PROPERTY_TEXT.position(value, height);
  if (transformed)
    adjustments.push(
      element(
        "adjust-transform",
        {
          position: toPosition(first.position),
          scale: PROPERTY_TEXT.scale(first.scale),
          rotation: first.rotation
            ? PROPERTY_TEXT.rotation(first.rotation)
            : undefined,
        },
        [
          ...(position
            ? [animation("position", position, toPosition, origin, fps)]
            : []),
          ...(scale
            ? [animation("scale", scale, PROPERTY_TEXT.scale, origin, fps)]
            : []),
          ...(rotation
            ? [
                animation(
                  "rotation",
                  rotation,
                  PROPERTY_TEXT.rotation,
                  origin,
                  fps,
                ),
              ]
            : []),
        ],
      ),
    );

  const opacity = keysOf(context, clip, "opacity");
  if (opacity || first.opacity !== 1)
    adjustments.push(
      element(
        "adjust-blend",
        { amount: num(first.opacity) },
        opacity
          ? [animation("amount", opacity, PROPERTY_TEXT.opacity, origin, fps)]
          : [],
      ),
    );

  const unsupported = (
    [
      ["fill", "a background fill"],
      ["borderRadius", "rounded corners"],
      ["shadow", "a shadow"],
      ["blur", "a blur"],
      ["width", "its own size"],
      ["height", "its own size"],
    ] as const
  )
    .filter(([field]) => clip.style[field] !== undefined)
    .map(([, name]) => name);
  if (unsupported.length)
    context.notes.push(
      `${where(context, clip)} has ${[...new Set(unsupported)].join(" and ")}, which Resolve's timeline does not carry.`,
    );
  return adjustments;
}

/** The sound level a clip plays at a clip-local frame, in linear gain. */
function gainCurve(context: Context, clip: Clip) {
  const { fps } = context;
  const track = context.input.timeline.tracks.find(
    (entry) => entry.index === clip.track,
  );
  const trackGain = clip.trackGainWarning ? 1 : (track?.volume ?? 1);
  const lane = clip.automation
    ? parseAutomation(clip.automation).lanes.find(
        (entry) => entry.target === VOLUME_TARGET,
      )
    : undefined;
  const seconds = (frames: number) => (frames * fps.den) / fps.num;
  const duration = seconds(clip.duration);
  const fades = clampFadesToDuration(
    { fadeIn: seconds(clip.fadeIn), fadeOut: seconds(clip.fadeOut) },
    duration,
  );
  return (frame: number) => {
    const time = seconds(frame);
    const level = lane
      ? gainedVolume(sampleAutomationLane(lane, time), clip.volume ?? 1)
      : (clip.volume ?? 1);
    return level * fadeGain(time, duration, fades) * trackGain;
  };
}

/** Clip volume, with keys where it changes, so Resolve plays the same level at every frame. */
function volumeAdjustment(context: Context, clip: Clip, origin: Rational) {
  const gain = gainCurve(context, clip);
  const levels = Array.from({ length: clip.duration + 1 }, (_, frame) =>
    decibels(gain(frame)),
  );
  if (levels.every((level) => Math.abs(level - levels[0]!) < 0.01))
    return Math.abs(levels[0]!) < 0.01
      ? []
      : [element("adjust-volume", { amount: `${num(levels[0]!)}dB` })];
  // Keys where the level bends by more than a hundredth of a decibel.
  const kept = simplify(levels, (level) => [level], 0.01);
  return [
    element("adjust-volume", { amount: `${num(levels[0]!)}dB` }, [
      element("param", { name: "amount", value: `${num(levels[0]!)}dB` }, [
        element(
          "keyframeAnimation",
          {},
          kept.map((key) =>
            element("keyframe", {
              time: keyTime(origin, key.frame, context.fps),
              value: `${num(key.value)}dB`,
            }),
          ),
        ),
      ]),
    ]),
  ];
}

/** A clip's media speed as a time map, so it plays at its rate over the same length. */
function timeMap(clip: Clip, fps: Fps): Element[] {
  if (clip.playbackRate === 1) return [];
  const length = framesAt(clip.duration, fps);
  const rate = rational(Math.round(clip.playbackRate * 1e6), 1e6);
  return [
    element("timeMap", {}, [
      element("timept", {
        time: rational(0),
        value: rational(0),
        interp: "linear",
      }),
      element("timept", {
        time: length,
        value: rational(length.num * rate.num, length.den * rate.den),
        interp: "linear",
      }),
    ]),
  ];
}

/** Every clip that draws a native picture: video and still images Resolve opens. */
function isPicture(
  clip: Clip,
  media: ClipMedia | undefined,
): media is ClipMedia {
  if (!media) return false;
  if (clip.kind === "image") return media.kind === "still";
  return (
    clip.kind === "video" && media.kind === "file" && media.facts.video !== null
  );
}

function isSound(clip: Clip, media: ClipMedia | undefined): media is FileMedia {
  return (
    isAudioKind(clip.kind) &&
    media?.kind === "file" &&
    media.facts.audio !== null
  );
}

/** Resolve a timeline as Cutroom shows it: an FCPXML document and its markers. */
export function planResolveTimeline(input: PlanInput): Plan {
  const { timeline, size } = input;
  const { fps } = timeline;
  const tracks = timeline.tracks.toSorted((a, b) => a.index - b.index);
  const kindOf = (index: number, clip: Clip) =>
    tracks.find((track) => track.index === index)?.kind ??
    (isAudioKind(clip.kind) ? "audio" : "video");
  const videoTracks = [
    ...new Set([
      ...tracks
        .filter((track) => track.kind === "video")
        .map((track) => track.index),
      ...timeline.clips
        .filter((clip) => kindOf(clip.track, clip) === "video")
        .map((clip) => clip.track),
    ]),
  ].sort((a, b) => a - b);
  const audioTracks = [
    ...new Set([
      ...tracks
        .filter((track) => track.kind === "audio")
        .map((track) => track.index),
      ...timeline.clips
        .filter((clip) => kindOf(clip.track, clip) === "audio")
        .map((clip) => clip.track),
    ]),
  ].sort((a, b) => a - b);
  const trackNames = new Map([
    ...videoTracks.map((index, order) => [index, `V${order + 1}`] as const),
    ...audioTracks.map((index, order) => [index, `A${order + 1}`] as const),
  ]);
  const mix = trackMix(timeline.tracks);
  const context: Context = {
    input,
    fps,
    notes: [],
    assets: [],
    formats: [],
    assetIds: new Map(),
    formatIds: new Map(),
    audioLanes: new Map(),
    zooms: new Map(),
    hidden: mix.hidden,
    muted: mix.muted,
    trackNames,
  };
  const media = (clip: Clip) => input.media.get(clip.id);
  const pictures = timeline.clips.filter((clip) =>
    isPicture(clip, media(clip)),
  );
  const sounds = timeline.clips.filter((clip) => isSound(clip, media(clip)));
  const embedded = pictures.filter(
    (clip) =>
      clip.kind === "video" &&
      clip.hasAudio &&
      media(clip)?.kind === "file" &&
      (media(clip) as { facts: MediaFacts }).facts.audio !== null,
  );

  // Resolve sorts audio lanes from the lowest up, so A1 is the deepest lane.
  const soundTracks = [
    ...audioTracks.map((index) => `audio ${index}`),
    ...[...new Set(embedded.map((clip) => clip.track))].map(
      (index) => `video ${index}`,
    ),
  ];
  soundTracks.forEach((key, order) =>
    context.audioLanes.set(key, -(soundTracks.length - order)),
  );
  const laneOfSound = (clip: Clip) =>
    context.audioLanes.get(`${kindOf(clip.track, clip)} ${clip.track}`)!;

  for (const source of timeline.clips) {
    if (source.region?.effect !== "zoom" || source.region.box.width >= 1)
      continue;
    if (!source.enabled || context.hidden.has(source.track)) continue;
    const range = { start: source.start, end: source.start + source.duration };
    const targets = source.adjustment
      ? timeline.clips.filter((clip) => {
          const span = elementSpan(clip);
          return (
            !isAudioKind(clip.kind) &&
            !input.baked?.has(clip.id) &&
            clip.track !== source.track &&
            videoTracks.indexOf(clip.track) <
              videoTracks.indexOf(source.track) &&
            span.start < range.end &&
            range.start < span.end
          );
        })
      : [source];
    for (const target of targets)
      context.zooms.set(target.id, [
        ...(context.zooms.get(target.id) ?? []),
        {
          start: range.start - target.start,
          end: range.end - target.start,
          region: source.region,
        },
      ]);
  }

  const notCarried = timeline.clips.filter(
    (clip) =>
      !pictures.includes(clip) &&
      !sounds.includes(clip) &&
      // A sound clip of a file without sound plays silence in Cutroom too.
      !(isAudioKind(clip.kind) && media(clip)) &&
      !(clip.adjustment && clip.region?.effect === "zoom"),
  );
  for (const clip of notCarried)
    context.notes.push(
      clip.adjustment
        ? `The ${clip.region?.effect ?? "adjustment"} layer ${where(context, clip)} is not carried.`
        : `${where(context, clip)} is not carried: Resolve can't open it as media.`,
    );
  for (const clip of [...pictures, ...sounds])
    if (clip.fx.length)
      context.notes.push(
        `${where(context, clip)} has sound effects Resolve's timeline does not carry.`,
      );
  for (const track of tracks)
    if (track.fx.length)
      context.notes.push(
        `${trackNames.get(track.index) ?? "A track"} has sound effects Resolve's timeline does not carry.`,
      );
  if (timeline.markers.some((marker) => marker.note.trim()))
    context.notes.push(
      "Marker notes stay in Cutroom; the marker list carries names, colours and lengths.",
    );
  if (timeline.masterFx?.length)
    context.notes.push("The master bus effects are not carried.");
  for (const group of timeline.authoredAudioGroups ?? [])
    if (group.volume !== 1)
      context.notes.push(
        `The audio group "${group.label ?? group.id}" plays at ${num(decibels(group.volume))} dB in Cutroom; Resolve plays its clips at their own level.`,
      );
  for (const index of videoTracks)
    if (
      context.hidden.has(index) &&
      timeline.clips.some((clip) => clip.track === index)
    )
      context.notes.push(
        `${trackNames.get(index)} is hidden in Cutroom, so its clips are disabled.`,
      );
  for (const index of audioTracks)
    if (
      context.muted.has(index) &&
      timeline.clips.some((clip) => clip.track === index)
    )
      context.notes.push(
        `${trackNames.get(index)} is muted in Cutroom, so its clips are disabled.`,
      );

  // Linked sound travels inside its picture, so Resolve links the two. Resolve opens a retimed
  // clip as a compound clip, so one keeps its sound beside it.
  const retimed = (clip: Clip) => clip.playbackRate !== 1;
  // Resolve drops keyframes written inside a <video>, the one element whose sound it links, so an
  // animated picture is an <asset-clip> and its sound a clip of its own.
  const animated = (clip: Clip) =>
    Object.keys(clip.keyframes ?? {}).length > 0 ||
    (context.zooms.get(clip.id)?.length ?? 0) > 0;
  const varies = (clip: Clip) =>
    volumeAdjustment(context, clip, rational(0)).some(
      (adjustment) => adjustment.children.length > 0,
    );
  const separate = (clip: Clip) =>
    retimed(clip) ||
    animated(clip) ||
    (embedded.includes(clip) && varies(clip));
  const linkedTo = new Map<Clip, Clip[]>();
  for (const sound of sounds) {
    if (!sound.link || retimed(sound) || varies(sound)) continue;
    const picture = pictures.find(
      (clip) => clip.link === sound.link && !separate(clip),
    );
    if (picture)
      linkedTo.set(picture, [...(linkedTo.get(picture) ?? []), sound]);
  }
  const linked = new Set([...linkedTo.values()].flat());

  /** A sound clip as a child of its picture. Resolve places these at sequence time. */
  const soundChild = (clip: Clip, file: FileMedia) => {
    const mediaOf = soundOf(file);
    const start = sourceStart(clip, mediaOf);
    const audible = clip.enabled && !context.muted.has(clip.track);
    return element(
      "audio",
      {
        ref: assetFor(context, mediaOf, "all"),
        lane: laneOfSound(clip),
        offset: framesAt(clip.start, fps),
        start,
        duration: framesAt(clip.duration, fps),
        enabled: audible ? undefined : 0,
        role: "dialogue",
      },
      [...timeMap(clip, fps), ...volumeAdjustment(context, clip, start)],
    );
  };

  /** A picture clip with its linked and embedded sound. */
  const pictureElement = (
    clip: Clip,
    attach: { lane?: number; offset: Rational },
  ) => {
    const own = media(clip)!;
    const start = sourceStart(clip, own);
    const visible = clip.enabled && !context.hidden.has(clip.track);
    const children: Element[] = [
      ...timeMap(clip, fps),
      ...pictureAdjustments(context, clip, start),
    ];
    if (separate(clip))
      return element(
        "asset-clip",
        {
          ref: assetFor(context, own, "picture"),
          lane: attach.lane,
          name: label(clip),
          offset: attach.offset,
          start,
          duration: framesAt(clip.duration, fps),
          enabled: visible ? undefined : 0,
        },
        children,
      );
    if (embedded.includes(clip) && own.kind === "file")
      children.push(soundChild(clip, own));
    for (const sound of linkedTo.get(clip) ?? [])
      children.push(soundChild(sound, media(sound) as FileMedia));
    return element(
      "video",
      {
        ref: assetFor(context, own, "all"),
        lane: attach.lane,
        name: label(clip),
        offset: attach.offset,
        start,
        duration: framesAt(clip.duration, fps),
        enabled: visible ? undefined : 0,
      },
      children,
    );
  };

  const effects: Element[] = [];
  const effectFor = (effect: { name: string; uid: string }) => {
    const found = effects.find((entry) => entry.attributes.uid === effect.uid);
    if (found) return String(found.attributes.id);
    const id = `e${effects.length + 1}`;
    effects.push(element("effect", { id, name: effect.name, uid: effect.uid }));
    return id;
  };

  // The primary storyline is V1, with gaps where it is empty, so transitions on it carry.
  const v1 = videoTracks[0];
  const spineClips = pictures
    .filter((clip) => clip.track === v1)
    .sort((a, b) => a.start - b.start);
  const end = Math.max(
    timeline.duration,
    ...timeline.clips.map((clip) => clip.start + clip.duration),
  );
  interface Slot {
    start: number;
    end: number;
    node: Element;
    /** The time the slot's children count from. */
    origin: Rational;
    retimed: boolean;
  }
  const slots: Slot[] = [];
  const spine: Element[] = [];
  const gap = (from: number, to: number) => {
    const node = element("gap", {
      name: "Gap",
      offset: framesAt(from, fps),
      start: rational(0),
      duration: framesAt(to - from, fps),
    });
    slots.push({
      start: from,
      end: to,
      node,
      origin: framesAt(-from, fps),
      retimed: false,
    });
    spine.push(node);
  };
  let cursor = 0;
  spineClips.forEach((clip, index) => {
    if (clip.start > cursor) gap(cursor, clip.start);
    const node = pictureElement(clip, { offset: framesAt(clip.start, fps) });
    const start = sourceStart(clip, media(clip)!);
    slots.push({
      start: clip.start,
      end: clip.start + clip.duration,
      node,
      origin: add(start, framesAt(-clip.start, fps)),
      retimed: clip.playbackRate !== 1,
    });
    spine.push(node);
    cursor = clip.start + clip.duration;
    const next = spineClips[index + 1];
    const transition = clip.transitionOut;
    if (transition && next && next.start === cursor && next.transitionIn) {
      const effect = TRANSITIONS[transition.kind];
      spine.push(
        element(
          "transition",
          {
            name: effect.name,
            offset: framesAt(cursor - framesBefore(transition), fps),
            duration: framesAt(transition.duration, fps),
          },
          [
            element("filter-video", {
              ref: effectFor(effect),
              name: effect.name,
            }),
          ],
        ),
      );
    }
  });
  if (end > cursor) gap(cursor, end);

  for (const clip of pictures)
    if (clip.track !== v1 && (clip.transitionIn || clip.transitionOut))
      context.notes.push(
        `The transition on ${where(context, clip)} is a cut in Resolve, which keeps transitions on V1 only.`,
      );

  /** Connected clips hang off the spine slot under their first frame, never a retimed one. */
  const attach = (clip: Clip, node: (offset: Rational) => Element) => {
    const covering = slots.filter((slot) => !slot.retimed);
    const slot =
      covering.find(
        (entry) => entry.start <= clip.start && clip.start < entry.end,
      ) ??
      covering.findLast((entry) => entry.start <= clip.start) ??
      covering[0] ??
      slots[0]!;
    slot.node.children.push(node(add(slot.origin, framesAt(clip.start, fps))));
  };

  for (const clip of pictures) {
    if (clip.track === v1) continue;
    attach(clip, (offset) =>
      pictureElement(clip, { lane: videoTracks.indexOf(clip.track), offset }),
    );
  }
  const loose = [
    ...sounds.filter((clip) => !linked.has(clip)),
    ...embedded.filter(separate),
  ];
  for (const clip of loose) {
    const own = soundOf(media(clip) as FileMedia);
    const start = sourceStart(clip, own);
    const audible = clip.enabled && !context.muted.has(clip.track);
    attach(clip, (offset) =>
      element(
        "asset-clip",
        {
          ref: assetFor(context, own, "sound"),
          lane: laneOfSound(clip),
          name: label(clip),
          offset,
          start,
          duration: framesAt(clip.duration, fps),
          enabled: audible ? undefined : 0,
          audioRole: "dialogue",
        },
        [...timeMap(clip, fps), ...volumeAdjustment(context, clip, start)],
      ),
    );
  }
  for (const clip of pictures)
    if (
      !retimed(clip) &&
      animated(clip) &&
      (embedded.includes(clip) ||
        sounds.some((sound) => sound.link && sound.link === clip.link))
    )
      context.notes.push(
        `${where(context, clip)} is animated, so its sound is a separate clip: Resolve drops keyframes on linked clips it imports. Select both and use Link Clips to join them.`,
      );
  for (const clip of [...pictures, ...sounds])
    if (retimed(clip))
      context.notes.push(
        `${where(context, clip)} plays at ${num(clip.playbackRate * 100)}%; Resolve opens a retimed clip as a compound clip, with its sound beside it, unlinked.`,
      );

  const sequenceFormat = element("format", {
    id: "r1",
    frameDuration: rational(fps.den, fps.num),
    width: size.width,
    height: size.height,
  });
  const root = element("fcpxml", { version: "1.11" }, [
    element("resources", {}, [
      sequenceFormat,
      ...context.formats,
      ...context.assets,
      ...effects,
    ]),
    element("library", {}, [
      element("event", { name: input.name }, [
        element("project", { name: input.name }, [
          element(
            "sequence",
            {
              format: "r1",
              duration: framesAt(end, fps),
              tcStart: rational(0),
              tcFormat: "NDF",
              audioLayout: "stereo",
              audioRate: "48k",
            },
            [element("spine", {}, spine)],
          ),
        ]),
      ]),
    ]),
  ]);
  return {
    fcpxml: fcpxmlDocument(root),
    markers: markerList(input.name, timeline.markers, fps),
    notes: context.notes,
  };
}

/**
 * Markers as the EDL Resolve reads with Timeline > Import > Timeline Markers from EDL. FCPXML
 * markers do not survive Resolve's import, so they travel beside the timeline.
 */
export function markerList(name: string, markers: readonly Marker[], fps: Fps) {
  if (!markers.length) return null;
  const line = (text: string) => text.replace(/[\s|]+/g, " ").trim();
  const events = markers
    .toSorted((a, b) => a.frame - b.frame)
    .map((marker, index) => {
      const at = formatTimecode(marker.frame, fps);
      const out = formatTimecode(marker.frame + 1, fps);
      const number = String(index + 1).padStart(3, "0");
      return [
        `${number}  001      V     C        ${at} ${out} ${at} ${out}  `,
        ` |C:ResolveColor${MARKER_COLOURS[marker.color]} |M:${line(marker.name) || " "} |D:${Math.max(1, marker.duration)}`,
        "",
      ].join("\n");
    });
  return `TITLE: ${line(name)}\nFCM: NON-DROP FRAME\n\n${events.join("\n")}`;
}
