import { basename } from "node:path";
import {
  VOLUME_TARGET,
  gainedVolume,
  parseAutomation,
  sampleAutomationLane,
} from "@hyperframes/core/audio-automation";
import { clampFadesToDuration } from "@hyperframes/core/audio-fade";
import { getAudioFxDef } from "@hyperframes/core/audio-fx";
import { parseRateLane } from "@hyperframes/core/speed-ramp";
import { mainChain } from "../../shared/timeline/fx";
import type { FxNode } from "../../shared/timeline/fx";
import { cubicBezier, valueAt } from "../../shared/timeline/keyframes";
import type { KeyframeValues } from "../../shared/timeline/keyframes";
import type { Grade } from "../../shared/timeline/grade";
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
  Transition,
} from "../../shared/timeline/schema";
import { formatTimecode } from "../../shared/timeline/timecode";
import { mixSilences, trackMix } from "../../shared/timeline/tracks";
import { framesBefore, sameTransition } from "../../shared/timeline/transition";
import {
  add,
  element,
  fcpxmlDocument,
  fileUrl,
  framesAt,
  rational,
} from "./fcpxml";
import type { Element, Rational } from "./fcpxml";
import type { MediaFacts } from "./probe";
import { oneLine } from "./text";

/**
 * A clip's media as the planner reads it: a probed video or audio file, or a still image. `sound`
 * stands in for a file's sound when Resolve needs a WAV copy.
 */
export type ClipMedia =
  | { kind: "file"; facts: MediaFacts; sound?: MediaFacts }
  | { kind: "still"; path: string };
type FileMedia = Extract<ClipMedia, { kind: "file" }>;

const mediaPath = (media: ClipMedia) =>
  media.kind === "file" ? media.facts.path : media.path;

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

interface GradeTarget extends ClipTarget {
  grade: Grade;
}

interface TransitionTarget extends ClipTarget {
  transition: Transition;
  /** Cutroom uses linear fades when one of these sounds has authored automation. */
  linear?: boolean;
}

interface ClipTarget {
  kind: "video" | "audio";
  track: number;
  start: number;
  end: number;
  label: string;
  source: string;
}

interface RetimeTarget extends ClipTarget {
  percent: number;
}

interface FadeTarget extends ClipTarget {
  fadeIn: number;
  fadeOut: number;
}

interface TrackTarget {
  kind: ClipTarget["kind"];
  index: number;
  empty: boolean;
  name: string | null;
  locked: boolean;
}

export interface Plan {
  placements: (ClipTarget & { audioChannels?: number })[];
  grades: GradeTarget[];
  transitions: TransitionTarget[];
  retimes: RetimeTarget[];
  fades: FadeTarget[];
  links: ClipTarget[][];
  tracks: TrackTarget[];
  timelineMarkers: Marker[];
  /** Absolute file paths used by the FCPXML's media resources. */
  mediaPaths: string[];
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

export const resolveMarkerColor: Record<Marker["color"], string> = {
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
  mediaPaths: Set<string>;
  formats: Element[];
  assetIds: Map<string, string>;
  formatIds: Map<string, string>;
  /** Resolve's audio lanes, A1 first, by key. */
  audioLanes: Map<string, number>;
  /** Clip-local zooms on each clip, from its own region and adjustment layers above it. */
  zooms: Map<string, Zoom[]>;
  hidden: ReadonlySet<number>;
  muted: ReadonlySet<number>;
  /** Whether Cutroom's mix silences a clip: its track, a solo, or its bus's mute. */
  silent(clip: Clip): boolean;
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
  const path = mediaPath(media);
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
  context.mediaPaths.add(path);
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

/** Resolve keeps keys at their full-source offsets when the script changes speed. */
function keyOrigin(clip: Clip, media: ClipMedia): Rational {
  const start = sourceStart(clip, media);
  if (clip.playbackRate === 1) return start;
  const origin = sourceOrigin(media);
  const elapsed = add(start, rational(-origin.num, origin.den));
  const seconds = Number(elapsed.num) / Number(elapsed.den) / clip.playbackRate;
  return add(origin, rational(Math.round(seconds * 1e6), 1e6));
}

/** What Resolve and the summary call a clip. */
export const label = (clip: Clip) =>
  clip.label ?? clip.textPreview ?? (clip.src ? basename(clip.src) : clip.id);

const where = (context: Context, clip: Clip) =>
  `"${oneLine(label(clip))}" at ${formatTimecode(clip.start, context.fps)} on ${context.trackNames.get(clip.track) ?? "its track"}`;

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
  add(
    origin,
    rational(
      (BigInt(frame) * 100n + 1n) * BigInt(fps.den),
      BigInt(fps.num) * 100n,
    ),
  );

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
  if (fit === "fill" || fit === "none" || fit === "scale-down")
    context.notes.push(
      `${where(context, clip)} uses the CSS fit mode "${fit}". Match its framing in Resolve's Transform and Scaling controls using the Cutroom picture as a reference.`,
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
      ["fill", "background fill"],
      ["borderRadius", "corner radius"],
      ["shadow", "drop shadow"],
      ["blur", "blur"],
      ["width", "box width"],
      ["height", "box height"],
    ] as const
  )
    .filter(([field]) => clip.style[field] !== undefined)
    .map(([field, name]) => `${name} ${JSON.stringify(clip.style[field])}`);
  if (unsupported.length)
    context.notes.push(
      `Rebuild the inline styling on ${where(context, clip)} in Fusion. ${unsupported.join(", ")}.`,
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
  const group = context.input.timeline.authoredAudioGroups?.find(
    (entry) => entry.id === clip.authoredAudioGroupId,
  );
  const groupGain = group?.volume ?? 1;
  const lanes = clip.automation ? parseAutomation(clip.automation).lanes : [];
  const lane = lanes.find((entry) => entry.target === VOLUME_TARGET);
  const effects = [
    ...gainEffects(clip.fx).map((effect) => ({
      effect,
      lane: lanes.find((entry) => entry.target === `fx.${effect.id}.gain`),
    })),
    ...gainEffects(clip.trackGainWarning ? [] : (track?.fx ?? [])).map(
      (effect) => ({ effect, lane: undefined }),
    ),
    ...gainEffects(group?.fx ?? []).map((effect) => ({
      effect,
      lane: undefined,
    })),
    ...gainEffects(mainChain(context.input.timeline.main)).map((effect) => ({
      effect,
      lane: undefined,
    })),
  ];
  const seconds = (frames: number) => (frames * fps.den) / fps.num;
  return (frame: number) => {
    const time = seconds(frame);
    const level = lane
      ? gainedVolume(sampleAutomationLane(lane, time), clip.volume ?? 1)
      : (clip.volume ?? 1);
    const fxDb = effects.reduce((sum, entry) => {
      const gain = entry.lane
        ? sampleAutomationLane(entry.lane, time)
        : Number(entry.effect.params.gain ?? 0);
      return sum + gain;
    }, 0);
    return level * trackGain * groupGain * 10 ** (fxDb / 20);
  };
}

/** A chain of gain stages can be folded into editable clip volume without changing its sound. */
function gainEffects(chain: readonly FxNode[]) {
  const enabled = chain.filter((effect) => effect.enabled);
  return enabled.every((effect) => effect.type === "gain") ? enabled : [];
}

function effectNotes(chain: readonly FxNode[]) {
  const enabled = chain.filter((effect) => effect.enabled);
  if (enabled.every((effect) => effect.type === "gain")) return "";
  return enabled
    .map((effect) => {
      const definition = getAudioFxDef(effect.type);
      const params = definition?.params.map(
        (param) =>
          `${param.label} ${effect.params[param.key] ?? param.default}${param.kind === "number" && param.unit ? ` ${param.unit}` : ""}`,
      );
      return `${definition?.label ?? effect.type}${params?.length ? ` (${params.join(", ")})` : ""}`;
    })
    .join(", ");
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

/** The native Resolve speed command sets one constant rate per clip. */
export function sourceClipWithSpeedAutomation(
  clips: readonly Clip[],
  media: ReadonlyMap<string, ClipMedia>,
) {
  return clips.find((clip) => {
    const source = media.get(clip.id);
    return (
      source?.kind === "file" &&
      (isPicture(clip, source) || isSound(clip, source)) &&
      parseRateLane(clip.automation) !== null
    );
  });
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
  const mix = trackMix(timeline);
  const mutedGroups = new Set(
    (timeline.authoredAudioGroups ?? []).flatMap(({ id, muted }) =>
      muted ? [id] : [],
    ),
  );
  const context: Context = {
    input,
    fps,
    notes: [],
    assets: [],
    mediaPaths: new Set(),
    formats: [],
    assetIds: new Map(),
    formatIds: new Map(),
    audioLanes: new Map(),
    zooms: new Map(),
    hidden: mix.hidden,
    muted: mix.muted,
    silent: (clip) =>
      mixSilences(mix, clip) ||
      (clip.authoredAudioGroupId !== undefined &&
        mutedGroups.has(clip.authoredAudioGroupId)),
    trackNames,
  };
  const media = (clip: Clip) => input.media.get(clip.id);
  const pictures = timeline.clips.filter((clip) =>
    isPicture(clip, media(clip)),
  );
  const timelineMarkers: Marker[] = [];
  const markedFrames = new Set<number>();
  for (const marker of timeline.markers) {
    if (markedFrames.has(marker.frame)) {
      context.notes.push(
        `Resolve allows one marker per frame. Move the marker "${oneLine(marker.name) || "Marker"}" at ${formatTimecode(marker.frame, fps)} to a free frame in Cutroom and export again.`,
      );
      continue;
    }
    markedFrames.add(marker.frame);
    timelineMarkers.push(marker);
  }
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
    ...[...new Set(embedded.map((clip) => clip.track))]
      .sort((a, b) => a - b)
      .map((index) => `video ${index}`),
  ];
  soundTracks.forEach((key, order) =>
    context.audioLanes.set(key, -(soundTracks.length - order)),
  );
  const laneOfSound = (clip: Clip) =>
    context.audioLanes.get(`${kindOf(clip.track, clip)} ${clip.track}`)!;
  const target = (
    clip: Clip,
    kind: ClipTarget["kind"],
    track: number,
    source: ClipMedia,
  ): ClipTarget => ({
    kind,
    track,
    start: clip.start,
    end: clip.start + clip.duration,
    label: oneLine(label(clip)),
    source: fileUrl(mediaPath(source)),
  });
  const pictureTarget = (clip: Clip) =>
    target(clip, "video", videoTracks.indexOf(clip.track) + 1, media(clip)!);
  const soundTarget = (clip: Clip) =>
    target(
      clip,
      "audio",
      soundTracks.length + laneOfSound(clip) + 1,
      soundOf(media(clip) as FileMedia),
    );
  const targetTracks: TrackTarget[] = [];
  const trackTarget = (
    kind: TrackTarget["kind"],
    index: number,
    track: number,
    empty: boolean,
  ) => {
    const source = tracks.find((entry) => entry.index === track);
    if (empty || source?.name || source?.locked)
      targetTracks.push({
        kind,
        index,
        empty,
        name: source?.name ?? null,
        locked: source?.locked ?? false,
      });
  };
  for (const [order, track] of videoTracks.entries()) {
    // Resolve creates V1 for the primary storyline even when it contains only gaps.
    trackTarget(
      "video",
      order + 1,
      track,
      order > 0 && !pictures.some((clip) => clip.track === track),
    );
  }
  for (const [order, track] of audioTracks.entries()) {
    // With no sound at all, Resolve starts with an empty A1.
    const defaultTrack = order === 0 && !sounds.length && !embedded.length;
    trackTarget(
      "audio",
      order + 1,
      track,
      !defaultTrack && !sounds.some((clip) => clip.track === track),
    );
  }

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
  for (const clip of [...embedded, ...sounds]) {
    const effects = effectNotes(clip.fx);
    if (effects)
      context.notes.push(
        `Rebuild these effects for ${where(context, clip)} in Fairlight, in this order. ${effects}.`,
      );
  }
  for (const track of tracks) {
    const effects = effectNotes(track.fx);
    if (effects)
      context.notes.push(
        `Rebuild these track effects for ${trackNames.get(track.index)} in Fairlight, in this order. ${effects}.`,
      );
  }
  const masterEffects = effectNotes(mainChain(timeline.main));
  if (masterEffects)
    context.notes.push(
      `Rebuild these effects on the main Fairlight bus, in this order. ${masterEffects}.`,
    );
  for (const group of timeline.authoredAudioGroups ?? []) {
    const members = [...embedded, ...sounds].filter(
      (clip) => clip.authoredAudioGroupId === group.id,
    );
    if (!members.length) continue;
    const name = `"${oneLine(group.label ?? group.id)}" bus`;
    if (group.muted) {
      context.notes.push(
        `The ${name} is muted in Cutroom, so its clips are disabled.`,
      );
      continue;
    }
    const effects = effectNotes(group.fx);
    if (effects)
      context.notes.push(
        `Rebuild these effects on the ${name} in Fairlight, in this order, and route its clips through it. ${effects}.`,
      );
    if (group.volume !== 1 || gainEffects(group.fx).length)
      context.notes.push(
        `The ${name} gain is in its member clips’ volume. Route those clips through a Fairlight bus at 0 dB to adjust them together.`,
      );
    if (group.automated)
      context.notes.push(
        `The ${name} automation is not carried. Its clips play at the bus's static gain; draw the automation on a Fairlight bus.`,
      );
  }
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
      timeline.clips.some(
        (clip) => clip.track === index && context.silent(clip),
      )
    )
      context.notes.push(
        `${trackNames.get(index)} is muted in Cutroom, so its clips are disabled.`,
      );

  // Retimed picture and sound get their own edits so the importer can set their speed.
  const retimed = (clip: Clip) => clip.playbackRate !== 1;
  const hasTransition = (clip: Clip) => clip.transitionIn || clip.transitionOut;
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
    (embedded.includes(clip) && (hasTransition(clip) || varies(clip)));
  const linkedTo = new Map<Clip, Clip[]>();
  for (const sound of sounds) {
    if (!sound.link || retimed(sound) || hasTransition(sound) || varies(sound))
      continue;
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
    const audible = clip.enabled && !context.silent(clip);
    const { start: at, end } = soundTarget(clip);
    return element(
      "audio",
      {
        ref: assetFor(context, mediaOf, "all"),
        lane: laneOfSound(clip),
        offset: framesAt(at, fps),
        start,
        duration: framesAt(end - at, fps),
        enabled: audible ? undefined : 0,
        role: "dialogue",
      },
      volumeAdjustment(context, clip, start),
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
    const { start: at, end } = pictureTarget(clip);
    const children = pictureAdjustments(context, clip, keyOrigin(clip, own));
    if (separate(clip))
      return element(
        "asset-clip",
        {
          ref: assetFor(context, own, "picture"),
          lane: attach.lane,
          name: label(clip),
          offset: attach.offset,
          start,
          duration: framesAt(end - at, fps),
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
        duration: framesAt(end - at, fps),
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
    });
    spine.push(node);
    cursor = clip.start + clip.duration;
    const next = spineClips[index + 1];
    const transition = clip.transitionOut;
    if (
      transition &&
      next &&
      next.start === cursor &&
      sameTransition(transition, next.transitionIn) &&
      !retimed(clip) &&
      !retimed(next)
    ) {
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

  const transitions = pictures.flatMap((clip): TransitionTarget[] => {
    const transition = clip.transitionOut;
    if (!transition) return [];
    const cut = clip.start + clip.duration;
    const next = pictures.find(
      (other) => other.track === clip.track && other.start === cut,
    );
    if (!next || !sameTransition(transition, next.transitionIn)) {
      context.notes.push(
        `The transition after ${where(context, clip)} needs both source clips. Restore the missing media in Cutroom and export again.`,
      );
      return [];
    }
    if (clip.track === v1 && !retimed(clip) && !retimed(next)) return [];
    return [{ ...pictureTarget(clip), transition }];
  });
  const audible = [...sounds, ...embedded];
  const audioClips = timeline.clips.filter(
    (clip) =>
      clip.hasAudio && (clip.kind === "video" || isAudioKind(clip.kind)),
  );
  const incoming = new Set<Clip>();
  for (const clip of audioClips) {
    const transition = clip.transitionOut;
    if (!transition) continue;
    const cut = clip.start + clip.duration;
    const next = audioClips.find(
      (other) =>
        other.track === clip.track &&
        other.start === cut &&
        sameTransition(transition, other.transitionIn),
    );
    if (next) incoming.add(next);
    const whereSound = audible.includes(clip)
      ? `A${soundTarget(clip).track} at ${formatTimecode(cut, fps)}`
      : `${where(context, clip)} ending at ${formatTimecode(cut, fps)}`;
    const linear = clip.automation !== null;
    if (
      next &&
      audible.includes(clip) &&
      audible.includes(next) &&
      clip.enabled &&
      next.enabled &&
      !context.silent(clip) &&
      linear === (next.automation !== null)
    ) {
      transitions.push({ ...soundTarget(clip), transition, linear });
    } else {
      context.notes.push(
        `Rebuild the ${transition.duration}-frame audio fade at ${whereSound} in Fairlight. Extend the audio into the transition and fade the existing sides. Use a straight fade on a side with clip automation and an equal-power fade on the other sides.`,
      );
    }
  }
  for (const clip of audioClips) {
    if (clip.transitionIn && !incoming.has(clip))
      context.notes.push(
        `Rebuild the ${clip.transitionIn.duration}-frame audio fade before ${where(context, clip)} in Fairlight. Extend the incoming audio into the transition and fade it in.`,
      );
  }
  const equalPowerCuts = transitions
    .filter(({ kind, linear }) => kind === "audio" && !linear)
    .map(({ track, end }) => `A${track} at ${formatTimecode(end, fps)}`);
  if (equalPowerCuts.length)
    context.notes.push(
      `Resolve uses its own equal-power fade curve on ${equalPowerCuts.join(", ")}. For Cutroom’s curve, overlap the clips on separate Fairlight tracks and use clip volume keyframes to match the original fade.`,
    );

  /** Connected clips hang off the spine slot under their first frame. */
  const attach = (clip: Clip, node: (offset: Rational) => Element) => {
    const slot =
      slots.find(
        (entry) => entry.start <= clip.start && clip.start < entry.end,
      ) ??
      slots.findLast((entry) => entry.start <= clip.start) ??
      slots[0]!;
    slot.node.children.push(node(add(slot.origin, framesAt(clip.start, fps))));
  };

  for (const clip of pictures) {
    if (clip.track === v1) continue;
    attach(clip, (offset) =>
      pictureElement(clip, { lane: pictureTarget(clip).track - 1, offset }),
    );
  }
  const loose = [
    ...sounds.filter((clip) => !linked.has(clip)),
    ...embedded.filter(separate),
  ];
  for (const clip of loose) {
    const own = soundOf(media(clip) as FileMedia);
    const start = sourceStart(clip, own);
    const audible = clip.enabled && !context.silent(clip);
    const { start: at, end } = soundTarget(clip);
    attach(clip, (offset) =>
      element(
        "asset-clip",
        {
          ref: assetFor(context, own, "sound"),
          lane: laneOfSound(clip),
          name: label(clip),
          offset,
          start,
          duration: framesAt(end - at, fps),
          enabled: audible ? undefined : 0,
          audioRole: "dialogue",
        },
        volumeAdjustment(context, clip, keyOrigin(clip, own)),
      ),
    );
  }
  const retimes = [
    ...pictures
      .filter(retimed)
      .map((clip) => [clip, pictureTarget(clip)] as const),
    ...loose.filter(retimed).map((clip) => [clip, soundTarget(clip)] as const),
  ].map(([clip, placement]) => ({
    ...placement,
    percent: Number(num(clip.playbackRate * 100)),
  }));
  const separateLinks = new Set(
    loose.flatMap((clip) => (clip.link ? [clip.link] : [])),
  );
  const links = [...separateLinks].flatMap((link) => {
    const video = pictures.filter((clip) => clip.link === link);
    if (!video.length) return [];
    const audio = [...sounds, ...embedded.filter(separate)].filter(
      (clip) => clip.link === link,
    );
    return [[...video.map(pictureTarget), ...audio.map(soundTarget)]];
  });
  links.push(
    ...embedded
      .filter((clip) => !clip.link && separate(clip))
      .map((clip) => [pictureTarget(clip), soundTarget(clip)]),
  );
  const mediaEnd = Math.max(
    0,
    ...[...pictures, ...sounds].map((clip) => clip.start + clip.duration),
  );
  if (mediaEnd < end)
    context.notes.push(
      `Resolve may trim the empty tail after ${formatTimecode(mediaEnd, fps)}. Extend a black generator to ${formatTimecode(end, fps)} to restore that time.`,
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
    markers: markerList(input.name, timelineMarkers, fps),
    timelineMarkers,
    mediaPaths: [...context.mediaPaths],
    placements: [
      ...pictures.map(pictureTarget),
      ...audible.map((clip) => ({
        ...soundTarget(clip),
        audioChannels: soundOf(media(clip) as FileMedia).facts.audio?.channels,
      })),
    ],
    transitions,
    retimes,
    fades: audible.flatMap((clip) =>
      clip.fadeIn || clip.fadeOut
        ? [
            {
              ...soundTarget(clip),
              ...clampFadesToDuration(clip, clip.duration),
            },
          ]
        : [],
    ),
    links,
    tracks: targetTracks,
    notes: context.notes,
    grades: pictures.flatMap((clip) =>
      clip.grade && !input.baked?.has(clip.id)
        ? [
            {
              ...pictureTarget(clip),
              grade: clip.grade,
            },
          ]
        : [],
    ),
  };
}

/**
 * Markers as the EDL Resolve reads with Timeline > Import > Timeline Markers from EDL. FCPXML
 * markers do not survive Resolve's import, so they travel beside the timeline.
 */
export function markerList(name: string, markers: readonly Marker[], fps: Fps) {
  if (!markers.length) return null;
  const line = (text: string) => oneLine(text.replaceAll("|", " "));
  const events = markers
    .toSorted((a, b) => a.frame - b.frame)
    .map((marker, index) => {
      const at = formatTimecode(marker.frame, fps);
      const out = formatTimecode(marker.frame + 1, fps);
      const number = String(index + 1).padStart(3, "0");
      return [
        `${number}  001      V     C        ${at} ${out} ${at} ${out}  `,
        ` |C:ResolveColor${resolveMarkerColor[marker.color]} |M:${line(marker.name) || " "} |D:${Math.max(1, marker.duration)}`,
        "",
      ].join("\n");
    });
  return `TITLE: ${line(name)}\nFCM: NON-DROP FRAME\n\n${events.join("\n")}`;
}
