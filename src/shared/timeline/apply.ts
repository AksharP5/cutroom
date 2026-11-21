import { frameTime } from "./time";
import {
  framesAfterOut,
  framesBeforeIn,
  readClipSource,
  resolveClip,
  retimeClipSource,
  sourceAtEdge,
  writeClipSource,
} from "./clipTiming";
import {
  attrMicros,
  decode,
  encode,
  firstFrame,
  frames,
  micros,
  positionAtSource,
  retimedFrames,
  secondsOf,
  sourceAt,
} from "./piece";
import {
  activeVersion,
  fitsVersion,
  mediaVersions,
  updateVersionFits,
  versionFit,
  versionMedia,
  versionOffset,
  versionOwner,
  versionPartners,
  versionShortReason,
  versionStart,
  versionsAtEdge,
} from "./versions";
import { firstTextLine, isAudioKind, MAX_VERSIONS } from "./schema";
import type {
  Clip,
  Command,
  Fps,
  InsertClip,
  InsertTitle,
  InsertAdjustment,
  InsertComposition,
  KeyframeProperty,
  Timeline,
  Track,
  Transition,
  Version,
} from "./schema";
import { cutTitle, defaultTitle, editTitle, isTitle } from "./title";
import { cutRegion, defaultRegion, editRegion } from "./region";
import type { Region, RegionEdit } from "./region";
import { TimelineError } from "./errors";
import {
  clearAudioAutomation,
  clipFades,
  CUTROOM_AUDIO_GROUP_PREFIX,
  trackGainWarning,
  windowMix,
  withVolumePoints,
} from "./mix";
import { MAX_FX_NODES, asHfChain } from "./fx";
import type { FxInput, FxNode } from "./fx";
import {
  mintAudioFxNodeId,
  normalizeAudioFxParams,
} from "@hyperframes/core/audio-fx";
import {
  audioFxPresetNodes,
  getAudioFxPreset,
} from "@hyperframes/core/audio-fx-presets";
import {
  framesAfter,
  framesBefore,
  sameTransition,
  takesTransition,
} from "./transition";
import { newTrack, nextTrackIndex } from "./tracks";
import { editTransform, hasTransformEdit } from "./transform";
import { editStyle, takesStyleField } from "./elementStyle";
import { FREEZE_DIR, localMediaPath, sourceUrl } from "../media";
import { parseRateLane } from "@hyperframes/core/speed-ramp";
import { canHaveGrade, editGrade } from "./grade";
import {
  moveKeyframe,
  holdKeyframes,
  parseKeyframeValue,
  removeKeyframe,
  replaceKeyframes,
  setKeyframe,
  shiftKeyframes,
  tracksOf,
  valueAt,
} from "./keyframes";
import type { KeyframeValues } from "./keyframes";

export { TimelineError } from "./errors";
export type { TimelineErrorCode } from "./errors";

/**
 * Where a clip created by a batch gets its markup: a copy of a clip from the timeline the batch
 * started with, or new media.
 */
export type ClipOrigin =
  | { copyOf: string }
  | {
      freeze: {
        clipId: string;
        src: string;
        media: string;
        path: string;
        time: number;
      };
    }
  | {
      insert: InsertClip | InsertTitle | InsertComposition | InsertAdjustment;
    }
  | { clipboardId: string; clipId: string };
type OnCreate = (id: string, origin: ClipOrigin) => void;
/**
 * Names a clip a command creates when the command does not: `base` is the id of the clip a piece
 * is cut from (`from`), or a slug of new media (`from` null). It must return an id not in `taken`.
 */
export type NewId = (
  base: string,
  from: string | null,
  taken: ReadonlySet<string>,
) => string;
/** Ids are never reused within a batch, so every created clip has one unambiguous origin. */
interface Batch {
  composition: string;
  clipboards: ReadonlyMap<string, readonly Clip[]>;
  /** Ids in the timeline and ids the project used before; a new clip takes none of them. */
  reserved: Set<string>;
  retired: ReadonlySet<string>;
  onCreate: OnCreate;
  /** Measured source lengths in seconds, by `src`, for inserted media. */
  mediaLengths: ReadonlyMap<string, number>;
  /** Every inserted `src` known to hold no audio stream. */
  silentMedia: ReadonlySet<string>;
  mediaRates: ReadonlyMap<string, number>;
  mediaFiles?: ReadonlySet<string>;
  newId: NewId;
  onSkip: (clip: Clip, reason: string) => void;
}
/**
 * Options for applying commands; `mediaLengths` holds measured source lengths by `src`, and
 * `silentMedia` every `src` known to hold no audio stream.
 */
interface ApplyOptions {
  composition?: string;
  clipboards?: Batch["clipboards"];
  /** Observe each admitted command before the batch is written. */
  onApply?: (before: Timeline, after: Timeline, command: Command) => void;
  /** Source-restricted auto-select razor targets left whole by this batch. */
  onSkip?: Batch["onSkip"];
  onCreate?: OnCreate;
  mediaLengths?: ReadonlyMap<string, number>;
  silentMedia?: ReadonlySet<string>;
  mediaRates?: Batch["mediaRates"];
  mediaFiles?: Batch["mediaFiles"];
  /** Names new clips the commands leave unnamed; `randomClipId` unless a caller needs others. */
  newId?: NewId;
  /** Ids the project used before, maybe undone since. New clips never take them. */
  retired?: ReadonlySet<string>;
}
/** What a command that creates clips needs: the ids in use, how to name a piece, and its origin. */
interface Minting {
  taken: Set<string>;
  onCreate: OnCreate;
  name(base: string, from: string | null): string;
}

const SUFFIX = "abcdefghijklmnopqrstuvwxyz0123456789";
/**
 * A readable id no clip has had: the base without an earlier random suffix, then six random
 * letters or digits (`shot-3-k7q2xa`). Ids that leave the timeline are never handed out again.
 */
export const randomClipId: NewId = (base, from, taken) => {
  const stem = from === null ? base : base.replace(/-[a-z0-9]{6}$/, "");
  for (;;) {
    const letters = [...crypto.getRandomValues(new Uint8Array(6))].map(
      (byte) => SUFFIX[byte % SUFFIX.length],
    );
    const id = `${stem}-${letters.join("")}`;
    if (!taken.has(id)) return id;
  }
};

/**
 * The chain a command asks for, from the one there is. An effect named by an existing id keeps
 * the values it leaves out, so `{ id, type, enabled: false }` bypasses it and nothing else.
 */
function buildFxChain(
  previous: readonly FxNode[],
  inputs: readonly FxInput[],
): FxNode[] {
  const nodes: FxNode[] = [];
  for (const input of inputs) {
    if ("preset" in input) {
      const preset = getAudioFxPreset(input.preset)!;
      nodes.push(
        ...audioFxPresetNodes(preset, asHfChain(nodes)).map((node) => ({
          id: node.id!,
          type: node.type,
          enabled: true,
          label: node.label ?? null,
          preset: preset.id,
          params: node.params ?? {},
        })),
      );
      continue;
    }
    const id = input.id ?? mintAudioFxNodeId(asHfChain(nodes));
    if (nodes.some((node) => node.id === id))
      throw new TimelineError(
        "unsupported",
        `Two effects have the id ${id}. Give each its own.`,
      );
    const kept = previous.find(
      (node) => node.id === id && node.type === input.type,
    );
    nodes.push({
      id,
      type: input.type,
      enabled: input.enabled ?? kept?.enabled ?? true,
      label: input.label !== undefined ? input.label : (kept?.label ?? null),
      preset: kept?.preset ?? null,
      params: normalizeAudioFxParams(input.type, {
        ...kept?.params,
        ...input.params,
      }),
    });
  }
  if (nodes.length > MAX_FX_NODES)
    throw new TimelineError(
      "unsupported",
      `A chain holds up to ${MAX_FX_NODES} effects.`,
    );
  return nodes;
}

/**
 * Source and timeline seconds are canonical at whole microseconds, as HTML and `cutroom.json` store
 * them. Commands compute source times exactly from frame counts and round only when writing.
 */
export const canonicalSeconds = (value: number) =>
  Math.round(value * 1e6) / 1e6;
const round6 = canonicalSeconds;
export { frameTime } from "./time";
/** Frame time rounded to six decimals, as written to HTML and `cutroom.json`. */
export const toSeconds = (frames: number, fps: Fps) =>
  round6(frameTime(frames, fps));
/**
 * The first frame at or after a time, as the runtime shows clips: a boundary within a thousandth
 * of a frame counts as on that frame (core `exportClipWindow`).
 */
export const toFrames = (seconds: number, fps: Fps) =>
  // Adding zero turns the -0 that ceil returns just below zero into 0.
  Math.ceil((seconds * fps.num) / fps.den - 1e-3) + 0;
export const clipEnd = (clip: Clip) => clip.start + clip.duration;

// Plain clips have no persisted source in-point. Track their window only while observing a batch.
const animationSource = Symbol("animation source offset");
type ObservedClip = Clip & { [animationSource]?: number };
export const animationOrigin = (clip: ObservedClip, fps: Fps) =>
  canonicalSeconds(
    clip.mediaStart === null
      ? frameTime(clip.start, fps) -
          (clip[animationSource] ?? 0) / clip.playbackRate
      : secondsOf(positionAtSource(resolveClip(clip, fps), micros(0))),
  );

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Canonical order, so parsed and applied timelines compare equal. Track kinds are stored; a clip
 * landing on a track index that has none yet creates it, audio when every clip there is audio.
 */
export function normalizeTimeline(timeline: Timeline): Timeline {
  const tracks = new Map(timeline.tracks.map((track) => [track.index, track]));
  const audioOnly = new Map<number, boolean>();
  for (const clip of timeline.clips)
    if (!tracks.has(clip.track))
      audioOnly.set(
        clip.track,
        (audioOnly.get(clip.track) ?? true) && isAudioKind(clip.kind),
      );
  for (const [index, audio] of audioOnly)
    tracks.set(index, newTrack(index, audio ? "audio" : "video"));
  return {
    ...timeline,
    tracks: [...tracks.values()].sort((a, b) => a.index - b.index),
    clips: timeline.clips.toSorted(
      (a, b) =>
        a.track - b.track || a.start - b.start || compareText(a.id, b.id),
    ),
    markers: timeline.markers.toSorted(
      (a, b) => a.frame - b.frame || compareText(a.id, b.id),
    ),
  };
}

const usedNames = (timeline: Timeline, retired: ReadonlySet<string>) =>
  new Set([
    ...retired,
    ...(timeline.authoredAudioGroups ?? []).map(({ id }) => id),
    ...timeline.clips.flatMap((clip) =>
      clip.link ? [clip.id, clip.link] : [clip.id],
    ),
  ]);

function applyIn(timeline: Timeline, command: Command, batch: Batch) {
  const next = run(timeline, command, batch);
  return next === timeline ? timeline : settle(timeline, next);
}

/** Applies one command. Auto-select razor skips source-restricted clips; other failures throw a TimelineError. */
export function apply(
  timeline: Timeline,
  command: Command,
  {
    composition = "index.html",
    clipboards = new Map(),
    onSkip = () => {},
    onCreate = () => {},
    mediaLengths = new Map(),
    silentMedia = new Set(),
    mediaRates = new Map(),
    mediaFiles,
    newId = randomClipId,
    retired = new Set(),
  }: ApplyOptions = {},
): Timeline {
  const next = applyIn(timeline, command, {
    composition,
    clipboards,
    reserved: usedNames(timeline, retired),
    retired,
    onSkip,
    onCreate,
    mediaLengths,
    silentMedia,
    mediaRates,
    mediaFiles,
    newId,
  });
  return next === timeline ? timeline : updateVersionFits(fitTransitions(next));
}

/** Applies a batch atomically: the first failure throws with its command index. */
export function applyAll(
  timeline: Timeline,
  commands: readonly Command[],
  {
    composition = "index.html",
    clipboards = new Map(),
    onApply,
    onSkip = () => {},
    onCreate = () => {},
    mediaLengths = new Map(),
    silentMedia = new Set(),
    mediaRates = new Map(),
    mediaFiles,
    newId = randomClipId,
    retired = new Set(),
  }: ApplyOptions = {},
): Timeline {
  const origins = new Map<string, ClipOrigin>();
  const batch: Batch = {
    composition,
    clipboards,
    reserved: usedNames(timeline, retired),
    retired,
    onSkip,
    mediaLengths,
    silentMedia,
    mediaRates,
    mediaFiles,
    newId,
    onCreate: (id, origin) => {
      // A copy of a clip made earlier in the batch copies that clip's own origin.
      const resolved =
        ("copyOf" in origin && origins.get(origin.copyOf)) || origin;
      origins.set(id, resolved);
      onCreate(id, resolved);
    },
  };
  const observed = onApply
    ? {
        ...timeline,
        clips: timeline.clips.map((clip) => ({
          ...clip,
          [animationSource]: 0,
        })),
      }
    : timeline;
  const result = commands.reduce((current, command, index) => {
    try {
      const next = applyIn(current, command, batch);
      onApply?.(current, next, command);
      return next;
    } catch (error) {
      if (!(error instanceof TimelineError)) throw error;
      throw new TimelineError(
        error.code,
        `Command ${index + 1} (${command.type}): ${error.message}`,
        index,
      );
    }
  }, observed);
  if (result === observed) return timeline;
  // A roll trims both sides of a cut in turn, so transitions are settled once the batch is done.
  const fitted = updateVersionFits(fitTransitions(result));
  if (!onApply) return fitted;
  return {
    ...fitted,
    clips: fitted.clips.map((clip: ObservedClip) => {
      const { [animationSource]: _offset, ...written } = clip;
      return written;
    }),
  };
}

/** Audio clips belong on audio tracks and everything else on video tracks. */
function assertTrackKind(
  kind: Clip["kind"],
  track: Pick<Track, "index" | "kind"> | undefined,
  name: string,
) {
  if (!track || (track.kind === "audio") === isAudioKind(kind)) return;
  throw new TimelineError(
    "track_kind",
    `Clip ${name} is ${isAudioKind(kind) ? "audio" : "picture"} and track ${track.index} is ${track.kind === "audio" ? "an" : "a"} ${track.kind} track.`,
  );
}

function run(timeline: Timeline, command: Command, batch: Batch): Timeline {
  const { clips, fps } = timeline;
  const { reserved: taken } = batch;
  // Sync checks compare each surviving piece with its source in this command's input.
  const copies = new Map<string, string>();
  const onCreate: OnCreate = (id, origin) => {
    if ("copyOf" in origin)
      copies.set(id, copies.get(origin.copyOf) ?? origin.copyOf);
    batch.onCreate(id, origin);
  };
  const trackAt = (index: number) =>
    timeline.tracks.find((track) => track.index === index);
  const byId = new Map(clips.map((clip) => [clip.id, clip]));
  const find = (id: string) => {
    const clip = byId.get(id);
    if (!clip) throw new TimelineError("not_found", `No clip has id ${id}.`);
    return clip;
  };
  // Ids the command names for the pieces it cuts, by the clip each is cut from, in cutting order.
  const supplied = new Map(
    Object.entries(
      command.type === "paste" ||
        command.type === "freeze" ||
        command.type === "split" ||
        command.type === "insert" ||
        command.type === "trim" ||
        command.type === "trimPlayhead" ||
        command.type === "remove" ||
        command.type === "move"
        ? (command.ids ?? {})
        : {},
    ).map(([from, ids]) => [from, [...ids]]),
  );
  const claim = (id: string) => {
    if (batch.retired.has(id) && !byId.has(id))
      throw new TimelineError(
        "duplicate_id",
        `Id ${id} was used earlier in this project. Name the clip with an id never used before.`,
      );
    if (taken.has(id))
      throw new TimelineError("duplicate_id", `A clip already has id ${id}.`);
    taken.add(id);
    return id;
  };
  const mint: Minting = {
    taken,
    onCreate,
    name: (base, from) =>
      claim(
        (from === null ? undefined : supplied.get(from)?.shift()) ??
          batch.newId(base, from, taken),
      ),
  };
  switch (command.type) {
    case "setFormat":
      throw new TimelineError(
        "unsupported",
        "Format changes need the composition source.",
      );
    case "move": {
      const named = new Set(command.clipIds.map(find));
      const lifted = command.trackClipIds
        ? new Set(command.trackClipIds.map(find))
        : named;
      for (const clip of lifted)
        if (!named.has(clip))
          throw new TimelineError(
            "unsupported",
            `Clip ${clip.id} must be named in clipIds to change tracks.`,
          );
      if (command.by === 0 && command.trackBy === 0) return timeline;
      const moving = command.linked
        ? new Set(withPartners(clips, [...named]))
        : named;
      if (command.trackBy !== 0)
        for (const clip of lifted) {
          const index = clip.track + command.trackBy;
          const track = trackAt(index);
          // A move never invents a track; the editor and agents create one first.
          if (!track)
            throw new TimelineError(
              "not_found",
              `Track ${index} does not exist, so ${clip.id} cannot move onto it. To create it, add {"type":"setTrack","index":${index},"kind":"${isAudioKind(clip.kind) ? "audio" : "video"}"} before the move in the same batch.`,
            );
          assertTrackKind(clip.kind, track, clip.id);
        }
      let next = clips.map((clip) =>
        moving.has(clip)
          ? {
              ...clip,
              start: clip.start + command.by,
              track: clip.track + (lifted.has(clip) ? command.trackBy : 0),
            }
          : clip,
      );
      if (command.mode === "overwrite") {
        const fixed = new Set([...moving].map((clip) => clip.id));
        const ranges = new Map<number, [number, number][]>();
        for (const clip of next) {
          if (!fixed.has(clip.id)) continue;
          const old = byId.get(clip.id)!;
          if (clip.start === old.start && clip.track === old.track) continue;
          const track = ranges.get(clip.track) ?? [];
          track.push([clip.start, clipEnd(clip)]);
          ranges.set(clip.track, track);
        }
        for (const [track, spans] of ranges)
          for (const [from, to] of mergeRanges(spans).toReversed())
            next = clearRange(next, track, from, to, fps, mint, fixed);
      }
      return { ...timeline, clips: next };
    }
    case "trim": {
      const target = find(command.clipId);
      const edge = (clip: Clip) =>
        command.edge === "start" ? clip.start : clipEnd(clip);
      const at = edge(target);
      const delta = command.to - at;
      if (delta === 0) return timeline;
      // A linked group is one unit: every partner's same edge moves by the same delta.
      const members = command.linked ? withPartners(clips, [target]) : [target];
      const ids = new Set(members.map((clip) => clip.id));
      const trimmed = clips.map((clip) => {
        if (!ids.has(clip.id)) return clip;
        if (command.edge === "end")
          return windowClip(
            clip,
            clip.start,
            clipEnd(clip) + delta,
            fps,
            "trim",
          );
        return {
          ...windowClip(clip, clip.start + delta, clipEnd(clip), fps, "trim"),
          start: command.ripple ? clip.start : clip.start + delta,
        };
      });
      if (!command.ripple) return { ...timeline, clips: trimmed };
      const change = command.edge === "start" ? -delta : delta;
      const edits = new Map(
        members.map((clip) => [clip.track, { at: edge(clip), change }]),
      );
      return {
        ...timeline,
        clips: rippleTrim(timeline, trimmed, {
          edge: command.edge,
          at,
          edits,
          fixed: ids,
          mint,
          copies,
        }),
      };
    }
    case "trimPlayhead": {
      const named = command.clipIds.map(find);
      const { at, edge, ripple, linked } = command;
      const deltas = new Map<string, number>();
      const linkedStarts = new Map<string, number>();
      for (const clip of named) {
        if (
          at < clip.start ||
          at >= clipEnd(clip) ||
          (edge === "end" && at === clip.start)
        )
          throw new TimelineError(
            "out_of_bounds",
            `The playhead must be inside ${clipName(clip)} to trim its ${edge}.`,
          );
        const delta = at - (edge === "start" ? clip.start : clipEnd(clip));
        if (linked && clip.link !== null) {
          if (ripple && edge === "start") {
            const previous = linkedStarts.get(clip.link);
            if (previous !== undefined && previous !== delta)
              throw new TimelineError(
                "unsupported",
                "Ripple trimming these starts would move linked content by different amounts.",
              );
            linkedStarts.set(clip.link, delta);
          }
          for (const partner of clips)
            if (partner.link === clip.link && !deltas.has(partner.id))
              deltas.set(partner.id, delta);
        }
        deltas.set(clip.id, delta);
      }
      const edits = new Map<number, RippleTrimEdit>();
      const trimmed = new Map<string, Clip>();
      for (const [id, delta] of deltas) {
        const clip = find(id);
        const start = edge === "start" ? clip.start + delta : clip.start;
        const end = edge === "end" ? clipEnd(clip) + delta : clipEnd(clip);
        if (delta) {
          const next = windowClip(clip, start, end, fps, "trim");
          trimmed.set(id, ripple ? { ...next, start: clip.start } : next);
        }
        if (!ripple) continue;
        if (edits.has(clip.track))
          throw new TimelineError(
            "unsupported",
            "Ripple trim needs one edit per affected track.",
          );
        edits.set(clip.track, {
          at: edge === "start" ? clip.start : clipEnd(clip),
          change: edge === "start" ? -delta : delta,
        });
      }
      if (!trimmed.size) return timeline;
      const next = clips.map((clip) => trimmed.get(clip.id) ?? clip);
      const first = named[0]!;
      const primaryAt = edge === "start" ? first.start : clipEnd(first);
      return {
        ...timeline,
        clips: ripple
          ? rippleTrim(timeline, next, {
              edge,
              at: primaryAt,
              edits,
              fixed: new Set(deltas.keys()),
              mint,
              copies,
            })
          : next,
      };
    }
    case "roll":
    case "swap": {
      const from = find(command.from);
      const to = find(command.to);
      if (from.track !== to.track || clipEnd(from) !== to.start)
        throw new TimelineError(
          "unsupported",
          "The two clips must meet on the same track.",
        );
      const outgoing = new Set(
        command.linked ? withPartners(clips, [from]) : [from],
      );
      const incoming = new Set(
        command.linked ? withPartners(clips, [to]) : [to],
      );
      if ([...outgoing].some((clip) => incoming.has(clip)))
        throw new TimelineError(
          "unsupported",
          "The two clips belong to the same linked group.",
        );
      if (command.type === "swap") {
        if (
          [...outgoing, ...incoming].some(
            (clip) => clip.transitionIn || clip.transitionOut,
          )
        )
          throw new TimelineError(
            "unsupported",
            "Remove the transitions touching the clips before swapping them.",
          );
        return {
          ...timeline,
          clips: clips.map((clip) =>
            outgoing.has(clip)
              ? { ...clip, start: clip.start + to.duration }
              : incoming.has(clip)
                ? { ...clip, start: clip.start - from.duration }
                : clip,
          ),
        };
      }
      const { by } = command;
      if (!by) return timeline;
      return {
        ...timeline,
        clips: clips.map((clip) =>
          outgoing.has(clip)
            ? windowClip(clip, clip.start, clipEnd(clip) + by, fps, "trim")
            : incoming.has(clip)
              ? windowClip(clip, clip.start + by, clipEnd(clip), fps, "trim")
              : clip,
        ),
      };
    }
    case "split": {
      const { at } = command;
      const spans = (clip: Clip) => clip.start < at && at < clipEnd(clip);
      let selected: Clip[];
      if (command.clipIds) {
        selected = command.clipIds.map(find);
        const outside = selected.find((clip) => !spans(clip));
        if (outside)
          throw new TimelineError(
            "out_of_bounds",
            `Clip ${outside.id} does not span frame ${at}.`,
          );
      } else {
        const tracks = rippleTracks(timeline, []);
        selected = clips.filter(
          (clip) => tracks.has(clip.track) && spans(clip),
        );
      }
      const targets = withPartners(clips, selected).filter(spans);
      if (!targets.length)
        throw new TimelineError(
          "nothing_to_split",
          `No clip on an unlocked auto-select track spans frame ${at}.`,
        );
      const skipped = skipAutoClips(
        clips,
        new Map(
          targets.flatMap((clip) =>
            clip.sourceRestrictions?.copy
              ? [[clip, clip.sourceRestrictions.copy] as const]
              : [],
          ),
        ),
        command.clipIds && !command.autoSelect
          ? new Set(targets.map((clip) => clip.id))
          : new Set(),
        batch.onSkip,
      );
      return {
        ...timeline,
        clips: splitClips(
          clips,
          targets.filter((clip) => !skipped.has(clip.id)),
          at,
          fps,
          mint,
        ),
      };
    }
    case "freeze": {
      const { at } = command;
      const video = find(command.clipId);
      const { src, mediaStart } = video;
      const media = src && localMediaPath(batch.composition, src);
      if (video.kind !== "video" || !src || !media || mediaStart === null)
        throw new TimelineError(
          "unsupported",
          "Select a clip with a local video source.",
        );
      const replace = command.mode === "replace";
      if (
        at < video.start ||
        (!replace && at === video.start) ||
        at >= clipEnd(video)
      )
        throw new TimelineError(
          "out_of_bounds",
          "Move the playhead inside the video clip to freeze a frame.",
        );
      const linked = withPartners(clips, [video]);
      const targets = linked.filter(
        (clip) => clip.start < at && at < clipEnd(clip),
      );
      if (replace && video.sourceRestrictions?.remove)
        throw new TimelineError("unsupported", video.sourceRestrictions.remove);
      if (!replace && targets.some((clip) => parseRateLane(clip.automation)))
        throw new TimelineError(
          "unsupported",
          "Freeze frame needs a constant playback speed on every clip it cuts.",
        );
      const tracks = new Set(linked.map((clip) => clip.track));
      const duration = replace
        ? video.duration
        : Math.max(1, Math.round((2 * fps.num) / fps.den));
      const id = command.id ? claim(command.id) : mint.name("freeze", null);
      const path = `${FREEZE_DIR}/${id}.png`;
      const sourceTime = sourceAt(resolveClip(video, fps), frames(at, fps));
      onCreate(id, {
        freeze: {
          clipId: video.id,
          src,
          media,
          path,
          time:
            typeof sourceTime === "number" ? sourceTime : secondsOf(sourceTime),
        },
      });
      const transform = replace
        ? video
        : holdKeyframes(video, at - video.start);
      const image: Clip = {
        id,
        track: video.track,
        kind: "image",
        start: replace ? video.start : at,
        duration,
        mediaStart: null,
        playbackRate: 1,
        src: sourceUrl(batch.composition, path),
        sourceDuration: null,
        hasAudio: false,
        link: replace ? video.link : null,
        label: "Freeze",
        volume: null,
        opacity: transform.opacity,
        x: transform.x,
        y: transform.y,
        scaleX: transform.scaleX,
        scaleY: transform.scaleY,
        rotation: transform.rotation,
        crop: transform.crop,
        keyframes: replace ? video.keyframes : null,
        text: null,
        title: null,
        region:
          replace || !video.region
            ? video.region
            : { ...video.region, in: 0, out: 0 },
        adjustment: false,
        style: video.style,
        ...(video.variableBindings && {
          variableBindings: video.variableBindings,
        }),
        fadeIn: replace ? video.fadeIn : 0,
        fadeOut: replace ? video.fadeOut : 0,
        transitionIn: replace ? video.transitionIn : null,
        transitionOut: replace ? video.transitionOut : null,
        automation: null,
        fx: [],
        // The still is the source's frame, so the same grade draws it as the clip showed it.
        grade: video.grade,
        enabled: video.enabled,
        startRef: replace ? video.startRef : null,
      };
      if (replace)
        return {
          ...timeline,
          clips: clips.map((clip) => (clip === video ? image : clip)),
        };
      const cut = splitClips(clips, targets, at, fps, mint);
      return {
        ...timeline,
        clips: [...shiftAfter(cut, tracks, () => at, duration), image],
      };
    }
    case "remove": {
      const removing = withPartners(clips, command.clipIds.map(find));
      for (const clip of removing)
        if (clip.sourceRestrictions?.remove)
          throw new TimelineError(
            "unsupported",
            clip.sourceRestrictions.remove,
          );
      const ids = new Set(removing.map((clip) => clip.id));
      const remaining = clips.filter((clip) => !ids.has(clip.id));
      if (!command.ripple) return { ...timeline, clips: remaining };
      const tracks = rippleTracks(
        timeline,
        removing.map((clip) => clip.track),
      );
      // Close the selected intervals once on every participating track. Working right to left
      // keeps earlier ranges in the original timeline's coordinates.
      let next = remaining;
      for (const [from, to] of mergeRanges(
        removing.map((clip) => [clip.start, clipEnd(clip)] as const),
      ).toReversed())
        next = removeTime(next, tracks, () => from, to - from, timeline, mint);
      assertRippleSync(timeline, next, tracks, copies);
      return { ...timeline, clips: next };
    }
    case "closeGap": {
      const track = trackAt(command.track);
      if (!track)
        throw new TimelineError(
          "not_found",
          `Track ${command.track} does not exist.`,
        );
      const name = trackLabel(timeline, track.index);
      if (track.locked)
        throw new TimelineError("locked", `Track ${name} is locked.`);
      const gap = gapAt(timeline, track.index, command.at);
      if (!gap) {
        const inside = clips.find(
          (clip) =>
            clip.track === track.index &&
            clip.start <= command.at &&
            command.at < clipEnd(clip),
        );
        throw new TimelineError(
          "out_of_bounds",
          inside
            ? `Frame ${command.at} on ${name} is inside ${clipName(inside)}, not a gap.`
            : `Nothing follows frame ${command.at} on ${name}, so there is no gap to close.`,
        );
      }
      const tracks = rippleTracks(timeline, [track.index]);
      // Resolve closes a gap only when the time is empty on every track it ripples.
      const blocking = clips.find(
        (clip) =>
          tracks.has(clip.track) &&
          clip.start < gap.to &&
          clipEnd(clip) > gap.from,
      );
      if (blocking) {
        const other = trackLabel(timeline, blocking.track);
        throw new TimelineError(
          "unsupported",
          `${clipName(blocking)} on ${other} is in the gap. Turn off auto-select on ${other} to close the gap without it.`,
        );
      }
      const next = removeTime(
        clips,
        tracks,
        () => gap.from,
        gap.to - gap.from,
        timeline,
        mint,
      );
      // Nothing is cut, so every clip keeps its id; linked clips must move by the same amount.
      const shift = (clip: Clip) => clip.start - byId.get(clip.id)!.start;
      for (const clip of next) {
        const stranded =
          clip.link !== null &&
          next.find(
            (other) => other.link === clip.link && shift(other) !== shift(clip),
          );
        if (!stranded) continue;
        const other = trackLabel(
          timeline,
          shift(clip) ? stranded.track : clip.track,
        );
        throw new TimelineError(
          "unsupported",
          `Linked clips of ${clipName(clip)} on ${other} do not ripple, so closing the gap would put them out of sync. Turn on auto-select on ${other}, or unlink them.`,
        );
      }
      return { ...timeline, clips: next };
    }
    case "slip": {
      const target = find(command.clipId);
      const edit = slipEdit(timeline, target, command.linked);
      if (!edit)
        throw new TimelineError(
          "unsupported",
          `${clipName(target)} has no source to slip.`,
        );
      if (command.by === 0) return timeline;
      return within(timeline, edit, command.by, (frames, later) =>
        frames
          ? `${clipName(target)} can slip at most ${frameCount(frames)} ${later ? "later" : "earlier"} in its source`
          : `${clipName(target)} cannot slip ${later ? "later" : "earlier"}`,
      );
    }
    case "slide": {
      const named = command.clipIds.map(find);
      const edit = slideEdit(timeline, named);
      if (command.by === 0) return timeline;
      const name = clipName(named[0]!);
      return within(timeline, edit, command.by, (frames, later) =>
        frames
          ? `${name} can slide at most ${frameCount(frames)} ${later ? "later" : "earlier"}`
          : `${name} cannot slide ${later ? "later" : "earlier"}`,
      );
    }
    case "link": {
      const named = [...new Set(command.clipIds)].map(find);
      if (named.length < 2)
        throw new TimelineError(
          "unsupported",
          "Linking takes two or more different clips.",
        );
      const members = withPartners(clips, named);
      const [first] = members;
      if (
        first?.link &&
        members.every((clip) => clip.link === first.link) &&
        members.length ===
          clips.filter((clip) => clip.link === first.link).length
      )
        return timeline;
      const link = uniqueName(taken, "lk", 1);
      const ids = new Set(members.map((clip) => clip.id));
      return {
        ...timeline,
        clips: clips.map((clip) =>
          ids.has(clip.id) ? { ...clip, link } : clip,
        ),
      };
    }
    case "unlink": {
      const named = new Set(command.clipIds.map(find));
      const links = new Set([...named].flatMap((clip) => clip.link ?? []));
      if (!links.size) return timeline;
      // A partner left on its own is unlinked too.
      const left = new Map<string, number>();
      for (const clip of clips)
        if (clip.link && links.has(clip.link) && !named.has(clip))
          left.set(clip.link, (left.get(clip.link) ?? 0) + 1);
      return {
        ...timeline,
        clips: clips.map((clip) =>
          clip.link &&
          links.has(clip.link) &&
          (named.has(clip) || (left.get(clip.link) ?? 0) < 2)
            ? { ...clip, link: null }
            : clip,
        ),
      };
    }
    case "insert": {
      const { clip: input, track, at, mode } = command;
      if (command.linkedAudio && input.kind !== "video")
        throw new TimelineError(
          "track_kind",
          "Only video can have linked audio.",
        );
      const generated = input.kind === "title" || input.kind === "adjustment";
      const sourceName = generated
        ? null
        : (localMediaPath("index.html", input.src) ?? input.src);
      // A file name is quoted so it reads as written, never as a clip id.
      assertTrackKind(
        generated ? "element" : input.kind,
        trackAt(track),
        input.id ?? (sourceName === null ? input.kind : `"${sourceName}"`),
      );
      const id =
        input.id === undefined
          ? mint.name(
              generated ? input.kind : slug(input.src, input.kind),
              null,
            )
          : claim(input.id);
      const end = at + input.duration;
      const separate =
        input.kind === "video" &&
        !input.muted &&
        !batch.silentMedia.has(input.src);
      // A named sound track is edited as the picture's is; left out, the sound is routed to room.
      const soundTrack = separate ? command.linkedAudio?.track : undefined;
      if (soundTrack !== undefined && input.kind === "video")
        assertTrackKind("audio", trackAt(soundTrack), `"${sourceName}" sound`);
      let next = clips;
      if (mode === "overwrite")
        next = clearRange(next, track, at, end, fps, mint);
      if (mode === "insert") {
        const tracks = rippleTracks(timeline, [
          track,
          ...(soundTrack === undefined ? [] : [soundTrack]),
        ]);
        const spans = (clip: Clip) => clip.start < at && at < clipEnd(clip);
        const targets = withPartners(
          next,
          next.filter((clip) => tracks.has(clip.track) && spans(clip)),
        ).filter(spans);
        for (const clip of targets)
          if (clip.sourceRestrictions?.copy) refuseRippleCut(clip, timeline);
        next = splitClips(next, targets, at, fps, mint);
        next = shiftAfter(next, tracks, () => at, input.duration);
      }
      /** The new clip with nothing set beyond what the input says. */
      const placed = (fields: Pick<Clip, "kind"> & Partial<Clip>): Clip => ({
        id,
        track,
        start: at,
        duration: input.duration,
        mediaStart: null,
        playbackRate: 1,
        src: null,
        sourceDuration: null,
        hasAudio: false,
        link: null,
        label: input.label ?? null,
        volume: null,
        opacity: null,
        x: null,
        y: null,
        scaleX: null,
        scaleY: null,
        rotation: null,
        crop: null,
        keyframes: null,
        text: null,
        title: null,
        region: null,
        adjustment: false,
        style: {},
        fadeIn: 0,
        fadeOut: 0,
        transitionIn: null,
        transitionOut: null,
        automation: null,
        fx: [],
        grade: null,
        enabled: true,
        startRef: null,
        ...fields,
      });
      if (input.kind === "title") {
        onCreate(id, { insert: input });
        return {
          ...timeline,
          clips: [
            ...next,
            placed({
              kind: "element",
              textPreview: firstTextLine(input.text),
              text: input.text,
              title: editTitle(defaultTitle(fps), input.title),
            }),
          ],
        };
      }
      if (input.kind === "adjustment") {
        const region = input.region;
        onCreate(id, { insert: input });
        return {
          ...timeline,
          clips: [
            ...next,
            placed({
              kind: "element",
              adjustment: true,
              region: region
                ? editRegion(defaultRegion(region.effect, fps), region)
                : null,
            }),
          ],
        };
      }
      // A scene plays its composition from the start, as a fresh host does.
      if (input.kind === "composition") {
        onCreate(id, { insert: input });
        return {
          ...timeline,
          clips: [
            ...next,
            placed({ kind: "composition", mediaStart: 0, src: input.src }),
          ],
        };
      }
      const video = separate ? { ...input, muted: true } : input;
      onCreate(id, { insert: video });
      const added = placed({
        kind: input.kind,
        mediaStart: input.kind === "image" ? null : input.mediaStart,
        src: input.src,
        sourceDuration:
          input.kind === "image"
            ? null
            : (batch.mediaLengths.get(input.src) ?? null),
        hasAudio:
          isAudioKind(input.kind) ||
          (input.kind === "video" &&
            !video.muted &&
            !batch.silentMedia.has(input.src)),
        link: separate ? id : null,
        volume: input.volume ?? null,
        // New pictures are placed to fit the frame, as the writer places them.
        style:
          input.kind === "video" || input.kind === "image"
            ? { objectFit: "contain" }
            : {},
      });
      let tracks = timeline.tracks;
      let audio: Clip[] = [];
      if (separate) {
        const audioId =
          command.linkedAudio?.id === undefined
            ? mint.name(`${slug(input.src, "audio")}-audio`, null)
            : claim(command.linkedAudio.id);
        const routed =
          soundTrack === undefined
            ? routePictureSound(
                timeline,
                { clips: next, tracks },
                [added],
                added,
                mode === "overwrite",
              )
            : { tracks, track: soundTrack, replace: mode === "overwrite" };
        tracks = routed.tracks;
        if (routed.replace)
          next = clearRange(next, routed.track, at, end, fps, mint);
        onCreate(audioId, { insert: { ...input, kind: "audio", id: audioId } });
        audio = [
          {
            ...added,
            id: audioId,
            kind: "audio",
            track: routed.track,
            hasAudio: true,
            style: {},
          },
        ];
      }
      return {
        ...timeline,
        tracks,
        clips: [...next, added, ...audio],
      };
    }
    case "paste": {
      const source = batch.clipboards.get(command.clipboardId);
      if (!source?.length)
        throw new TimelineError(
          "not_found",
          "The clip clipboard is unavailable. Copy the clips again.",
        );
      for (const clip of source) {
        if (clip.sourceRestrictions?.copy)
          throw new TimelineError(
            "unsupported",
            `${clip.label ?? clip.id} can't be copied. ${clip.sourceRestrictions.copy}`,
          );
        assertTrackKind(clip.kind, trackAt(clip.track), clip.id);
      }
      // Reserve clipboard names too, even when a cut removed their source clips.
      for (const clip of source) {
        taken.add(clip.id);
        if (clip.link) taken.add(clip.link);
      }
      const start = Math.min(...source.map((clip) => clip.start));
      const duration = Math.max(...source.map(clipEnd)) - start;
      const links = new Map<string, string>();
      const added = source.map((clip): Clip => {
        const id = mint.name(clip.id, clip.id);
        if (clip.link && !links.has(clip.link))
          links.set(clip.link, uniqueName(taken, "lk", 1));
        onCreate(id, { clipboardId: command.clipboardId, clipId: clip.id });
        const { authoredAudioGroupId, trackGainWarning, ...copy } = clip;
        const dropGroup =
          authoredAudioGroupId?.startsWith(CUTROOM_AUDIO_GROUP_PREFIX) &&
          !timeline.authoredAudioGroups?.some(
            (group) => group.id === authoredAudioGroupId,
          );
        return {
          ...(dropGroup ? copy : clip),
          id,
          start: command.at + clip.start - start,
          link: clip.link ? links.get(clip.link)! : null,
          startRef: null,
        };
      });
      let next = clips;
      if (command.mode === "overwrite") {
        const pictures = added.filter((clip) => !isAudioKind(clip.kind));
        const sound = added.filter((clip) => isAudioKind(clip.kind));
        const standalone = sound.filter(
          (clip) =>
            !pictures.some(
              (picture) => clip.link !== null && picture.link === clip.link,
            ),
        );
        // Place picture first. Sound routing reads its overwritten links from the input timeline.
        for (const clip of pictures)
          next = clearRange(
            next,
            clip.track,
            clip.start,
            clipEnd(clip),
            fps,
            mint,
          );
        // Keep the pasted group outside the cutter so it can never erase its own copies.
        const placed = [...pictures, ...standalone];
        for (const clip of standalone) {
          next = clearRange(
            next,
            clip.track,
            clip.start,
            clipEnd(clip),
            fps,
            mint,
          );
        }
        // A different composition may not have the copied picture or standalone audio tracks yet.
        let tracks = normalizeTimeline({
          ...timeline,
          clips: [...next, ...placed],
        }).tracks;
        for (const clip of sound) {
          const partners = clip.link
            ? pictures.filter((picture) => picture.link === clip.link)
            : [];
          if (!partners.length) continue;
          const routed = routePictureSound(
            timeline,
            { clips: [...next, ...placed], tracks },
            partners,
            clip,
            true,
          );
          tracks = routed.tracks;
          if (routed.replace)
            next = clearRange(
              next,
              routed.track,
              clip.start,
              clipEnd(clip),
              fps,
              mint,
            );
          placed.push({ ...clip, track: routed.track });
        }
        return { ...timeline, tracks, clips: [...next, ...placed] };
      }
      const tracks = rippleTracks(
        timeline,
        source.map((clip) => clip.track),
      );
      const spans = (clip: Clip) =>
        clip.start < command.at && command.at < clipEnd(clip);
      const targets = withPartners(
        next,
        next.filter((clip) => tracks.has(clip.track) && spans(clip)),
      ).filter(spans);
      for (const clip of targets)
        if (clip.sourceRestrictions?.copy) refuseRippleCut(clip, timeline);
      next = splitClips(next, targets, command.at, fps, mint);
      next = shiftAfter(next, tracks, () => command.at, duration);
      assertRippleSync(timeline, next, tracks, copies);
      return { ...timeline, clips: [...next, ...added] };
    }
    case "setTransition":
    case "setTransitions": {
      const cuts = command.type === "setTransition" ? [command] : command.cuts;
      const changed = new Map<string, Clip>();
      for (const { from: fromId, to: toId, transition } of cuts) {
        const from = changed.get(fromId) ?? find(fromId);
        const to = changed.get(toId) ?? find(toId);
        if (from.track !== to.track || clipEnd(from) !== to.start)
          throw new TimelineError(
            "unsupported",
            `${clipName(from)} does not end where ${clipName(to)} starts on the same track.`,
          );
        for (const clip of [from, to])
          if (!takesTransition(clip))
            throw new TimelineError(
              "unsupported",
              `Transitions join video, image and audio clips, and ${clipName(clip)} is not one.`,
            );
        const pairs =
          command.type === "setTransition" && command.linked
            ? linkedCuts(clips, from, to)
            : [[from, to] as const];
        for (const [outgoing, incoming] of pairs) {
          if (transition) {
            const room = transitionRoom(
              fps,
              outgoing,
              incoming,
              transition.alignment,
            );
            if (transition.duration > room.frames)
              throw new TimelineError(
                "out_of_bounds",
                room.frames
                  ? `Only ${room.frames} ${room.frames === 1 ? "frame fits" : "frames fit"} at this cut: ${room.reason}.`
                  : `No transition fits at this cut: ${room.reason}.`,
              );
          }
          changed.set(outgoing.id, {
            ...outgoing,
            transitionOut: transition,
            ...(transition && { fadeOut: 0 }),
          });
          changed.set(incoming.id, {
            ...incoming,
            transitionIn: transition,
            ...(transition && { fadeIn: 0 }),
          });
        }
      }
      return {
        ...timeline,
        clips: clips.map((clip) => changed.get(clip.id) ?? clip),
      };
    }
    case "setTiming": {
      const target = find(command.clipId);
      const targets = withPartners(clips, [target]);
      for (const clip of targets) {
        if (clip.mediaStart === null)
          throw new TimelineError(
            "unsupported",
            `Clip ${clip.id} has no source timing.`,
          );
        if (command.playbackRate !== undefined && readClipSource(clip).lane)
          throw new TimelineError(
            "unsupported",
            `Clip ${clip.id} has a speed ramp. Change its rate lane in the composition source.`,
          );
      }
      const ids = new Set(targets.map(({ id }) => id));
      const groupStart = Math.min(...targets.map(({ start }) => start));
      const rate = command.playbackRate ?? target.playbackRate;
      const startFor = (clip: Clip) =>
        targets.length === 1 ||
        command.playbackRate === undefined ||
        command.playbackRate === clip.playbackRate
          ? clip.start
          : groupStart +
            Math.max(
              0,
              retimedFrames(
                clip.start - groupStart,
                clip.playbackRate,
                command.playbackRate,
                clip.speedSpan?.phase ?? 0,
              ),
            );
      const selected = readClipSource(target);
      const selectedStart = frames(target.start, fps);
      const previousMap = selected.lane
        ? null
        : decode(selected.stored, target.playbackRate, selectedStart, fps);
      const anchor = frames(
        command.playbackRate !== undefined && command.mediaStart === undefined
          ? groupStart
          : startFor(target),
        fps,
      );
      const editedMap =
        previousMap &&
        decode(
          command.mediaStart === undefined
            ? encode(previousMap, target.playbackRate, anchor, fps)
            : { mediaStart: Number(attrMicros(command.mediaStart)) },
          rate,
          anchor,
          fps,
        );
      const sourceShift =
        command.mediaStart === undefined
          ? 0
          : command.mediaStart - target.mediaStart!;
      const changed = new Map(
        targets.map((clip) => {
          const playbackRate = command.playbackRate ?? clip.playbackRate;
          const speedChanged = playbackRate !== clip.playbackRate;
          const head = clip.start - groupStart;
          const span = clip.speedSpan ?? {
            frames: clip.duration,
            rate: clip.playbackRate,
            phase: 0,
          };
          const phase = targets.length === 1 ? 0 : span.phase;
          const source = readClipSource(clip);
          const current =
            previousMap &&
            !source.lane &&
            clip.playbackRate === target.playbackRate
              ? clip === target
                ? previousMap
                : decode(
                    source.stored,
                    clip.playbackRate,
                    frames(clip.start, fps),
                    fps,
                  )
              : null;
          const sharesMap =
            current &&
            previousMap &&
            current.c === previousMap.c &&
            current.zero === previousMap.zero;
          // Independently aligned partners keep their phase when their head rounds to a frame.
          const oldOffset = frameTime(head, fps) * clip.playbackRate;
          const mediaStart = clip.mediaStart! + sourceShift;
          let start = startFor(clip);
          let rounding =
            frameTime(start - groupStart, fps) * playbackRate - oldOffset;
          if (
            speedChanged &&
            !sharesMap &&
            mediaStart >= 0 &&
            round6(mediaStart + rounding) < 0
          ) {
            // Use the first feasible frame when rounding down would need media before source zero.
            start += Math.ceil(
              -(mediaStart + rounding) / frameTime(1, fps) / playbackRate,
            );
            rounding =
              frameTime(start - groupStart, fps) * playbackRate - oldOffset;
          }
          const duration = speedChanged
            ? Math.max(
                1,
                groupStart +
                  retimedFrames(
                    head,
                    clip.playbackRate,
                    playbackRate,
                    phase,
                    span,
                  ) -
                  start,
              )
            : clip.duration;
          const timing =
            sharesMap && editedMap
              ? writeClipSource(
                  source,
                  encode(editedMap, rate, frames(start, fps), fps),
                )
              : retimeClipSource(
                  {
                    ...clip,
                    mediaStart: mediaStart + rounding,
                    playbackRate,
                  },
                  start,
                  fps,
                );
          const resized = {
            ...clip,
            start,
            duration,
            playbackRate,
            ...timing,
            ...(clip.versions && {
              versions: shownVersionAt(clip, timing.mediaStart, fps),
            }),
            ...(speedChanged && {
              speedSpan: {
                ...span,
                phase: round6(
                  phase +
                    head * clip.playbackRate -
                    (start - groupStart) * playbackRate,
                ),
              },
            }),
          };
          // A rounded duration can overrun the source by one frame.
          if (
            speedChanged &&
            duration > 1 &&
            framesAfterOut(resized, fps) === -1
          )
            resized.duration -= 1;
          return [clip.id, resized] as const;
        }),
      );
      const retimed = clips.map((clip) => changed.get(clip.id) ?? clip);
      // Move following clips together by enough to clear every retimed partner's tail.
      const change = Math.max(
        ...targets.map(
          (clip) => clipEnd(changed.get(clip.id)!) - clipEnd(clip),
        ),
      );
      if (!change) return { ...timeline, clips: retimed };

      const edges = new Map(targets.map((clip) => [clip.track, clipEnd(clip)]));
      const editPoint = (track: number) => edges.get(track) ?? clipEnd(target);
      const tracks = rippleTracks(timeline, [...edges.keys()]);
      const next =
        change < 0
          ? removeTime(
              retimed,
              tracks,
              (track) => editPoint(track) + change,
              -change,
              timeline,
              mint,
              ids,
            )
          : insertTime(retimed, tracks, editPoint, change, timeline, mint, ids);
      assertRippleSync(timeline, next, tracks, copies);
      return { ...timeline, clips: next };
    }
    case "setClip": {
      const target = find(command.clipId);
      const transform = hasTransformEdit(command);
      const animatedTransform =
        command.keyframes &&
        (command.keyframes.position ||
          command.keyframes.scale ||
          command.keyframes.rotation ||
          command.keyframes.crop);
      if (
        isAudioKind(target.kind) &&
        (command.x !== undefined ||
          command.y !== undefined ||
          transform ||
          command.keyframes)
      )
        throw new TimelineError(
          "unsupported",
          `Audio clips have no ${transform ? "transform" : "position"}.`,
        );
      if (
        (transform || animatedTransform) &&
        target.sourceRestrictions?.transform
      )
        throw new TimelineError(
          "unsupported",
          target.sourceRestrictions.transform,
        );
      const tracks = tracksOf(target);
      // Scale and rotation keyframes keep the position in keyframes too (see `settle`).
      const keyed = (
        [
          ["position", command.x !== undefined || command.y !== undefined],
          [
            "scale",
            command.scale !== undefined ||
              command.scaleX !== undefined ||
              command.scaleY !== undefined,
          ],
          ["rotation", command.rotation !== undefined],
          ["crop", command.crop !== undefined],
          ["opacity", command.opacity !== undefined],
        ] as const
      ).find(
        ([property, edited]) =>
          edited &&
          (tracks[property] ||
            (property === "position" && (tracks.scale || tracks.rotation))),
      );
      if (keyed && command.keyframes === undefined)
        throw new TimelineError(
          "unsupported",
          `${clipName(target)} animates its ${keyed[0]} with keyframes. Change it with setKeyframe, or remove its keyframes first.`,
        );
      if (command.text !== undefined) {
        if (target.text === null)
          throw new TimelineError(
            "unsupported",
            `${target.label ?? target.id} has no text to edit.`,
          );
        if (target.sourceRestrictions?.text)
          throw new TimelineError(
            "unsupported",
            target.sourceRestrictions.text,
          );
      }
      if (command.title !== undefined && target.title === null)
        throw new TimelineError(
          "unsupported",
          target.sourceRestrictions?.title ??
            `${target.label ?? target.id} is not a Cutroom title.`,
        );
      if (command.style !== undefined) {
        const refused = Object.keys(command.style).find(
          (field) => !takesStyleField(target.kind, field),
        );
        const refusal = isAudioKind(target.kind)
          ? "Audio clips have no style."
          : isTitle(target)
            ? `${clipName(target)} is a Cutroom title. Change its look with setClip.title.`
            : refused === "objectFit"
              ? `${clipName(target)} is not a video or image, so it has no fit.`
              : refused
                ? `${clipName(target)} has no words to style; text style needs a text element.`
                : null;
        if (refusal) throw new TimelineError("unsupported", refusal);
      }
      if (target.adjustment) {
        const refused = (
          [
            ["position", command.x !== undefined || command.y !== undefined],
            ["transform", transform || command.keyframes],
            ["opacity", command.opacity !== undefined],
            ["style", command.style !== undefined],
          ] as const
        ).find(([, edited]) => edited);
        if (refused)
          throw new TimelineError(
            "unsupported",
            `${clipName(target)} is an adjustment layer, which has no ${refused[0]}. Change its effect with setClip.region.`,
          );
      }
      const region =
        command.region === undefined
          ? target.region
          : regionFor(target, command.region, fps);
      if (command.grade !== undefined) {
        if (!canHaveGrade(target.kind, target.adjustment))
          throw new TimelineError(
            "unsupported",
            `${clipName(target)} has no colour grade.`,
          );
        if (target.sourceRestrictions?.grade)
          throw new TimelineError(
            "unsupported",
            target.sourceRestrictions.grade,
          );
      }
      const graded = command.grade && editGrade(target.grade, command.grade);
      if (graded && "refusal" in graded)
        throw new TimelineError("unsupported", graded.refusal);
      if (command.fx !== undefined && !target.hasAudio)
        throw new TimelineError(
          "unsupported",
          `${clipName(target)} has no sound to process.`,
        );
      if (command.fx !== undefined && target.sourceRestrictions?.fx)
        throw new TimelineError("unsupported", target.sourceRestrictions.fx);
      if (command.automation?.volume.length && !target.hasAudio)
        throw new TimelineError(
          "unsupported",
          `${clipName(target)} has no sound to automate.`,
        );
      for (const [fade, transition] of [
        [command.fadeIn, target.transitionIn],
        [command.fadeOut, target.transitionOut],
      ] as const)
        if (fade && transition)
          throw new TimelineError(
            "unsupported",
            `${clipName(target)} has a transition on that edge, which sets its fade. Change the transition instead.`,
          );
      const fadeIn = command.fadeIn ?? target.fadeIn;
      const fadeOut = command.fadeOut ?? target.fadeOut;
      return {
        ...timeline,
        clips: clips.map((clip) => {
          if (clip !== target) return clip;
          const edited = {
            ...clip,
            fadeIn,
            fadeOut,
            ...(command.label !== undefined && { label: command.label }),
            ...(command.volume !== undefined && { volume: command.volume }),
            ...(command.fx !== undefined && {
              fx: buildFxChain(clip.fx, command.fx),
            }),
            ...(command.automation !== undefined && {
              automation: command.automation
                ? withVolumePoints(
                    clip.automation,
                    command.automation.volume,
                    timeline.fps,
                  )
                : clearAudioAutomation(clip.automation),
            }),
            ...(command.x !== undefined && { x: command.x }),
            ...(command.y !== undefined && { y: command.y }),
            ...(transform && editTransform(clip, command)),
            ...(command.text !== undefined && {
              text: command.text,
              textPreview: firstTextLine(command.text),
            }),
            ...(command.opacity !== undefined && {
              opacity: command.opacity,
            }),
            ...(command.title !== undefined &&
              clip.title && {
                title: editTitle(clip.title, command.title),
              }),
            ...(command.style !== undefined && {
              style: editStyle(clip.style, command.style),
            }),
            ...(command.grade !== undefined && {
              grade: graded ? graded.grade : null,
            }),
            ...(command.enabled !== undefined && {
              enabled: command.enabled,
            }),
            region,
          };
          return command.keyframes === undefined
            ? edited
            : replaceKeyframes(edited, command.keyframes);
        }),
      };
    }
    case "setKeyframe":
    case "removeKeyframe":
    case "moveKeyframe": {
      const target = find(command.clipId);
      const { property } = command;
      if (isAudioKind(target.kind) || target.adjustment)
        throw new TimelineError(
          "unsupported",
          `${target.adjustment ? `${clipName(target)} is an adjustment layer, which has` : "Audio clips have"} no ${property} to keyframe.`,
        );
      if (property !== "opacity" && target.sourceRestrictions?.transform)
        throw new TimelineError(
          "unsupported",
          target.sourceRestrictions.transform,
        );
      const keyframes = tracksOf(target)[property] ?? [];
      const at = (frame: number) =>
        keyframes.some((keyframe) => keyframe.frame === frame);
      const inside = (frame: number) => {
        if (frame < 0 || frame >= target.duration)
          throw new TimelineError(
            "out_of_bounds",
            `Frame ${frame} is outside ${clipName(target)}, which runs from frame 0 to ${target.duration - 1}.`,
          );
      };
      const edited = (() => {
        if (command.type === "setKeyframe") {
          if (!at(command.frame)) inside(command.frame);
          return setKeyframe(
            target,
            property,
            command.frame,
            keyframeValue(target, property, command.frame, command.value),
            command.ease,
          );
        }
        if (!at(command.frame))
          throw new TimelineError(
            "not_found",
            `${clipName(target)} has no ${property} keyframe at frame ${command.frame}.`,
          );
        if (command.type === "removeKeyframe")
          return removeKeyframe(target, property, command.frame);
        if (command.to === command.frame) return target;
        inside(command.to);
        if (at(command.to))
          throw new TimelineError(
            "overlap",
            `${clipName(target)} already has a ${property} keyframe at frame ${command.to}.`,
          );
        return moveKeyframe(target, property, command.frame, command.to);
      })();
      if (edited === target) return timeline;
      return {
        ...timeline,
        clips: clips.map((clip) => (clip === target ? edited : clip)),
      };
    }
    case "setTrack": {
      if (command.kind !== undefined)
        for (const clip of clips)
          if (clip.track === command.index)
            assertTrackKind(
              clip.kind,
              { index: command.index, kind: command.kind },
              clip.id,
            );
      const current =
        timeline.tracks.find((track) => track.index === command.index) ??
        newTrack(command.index, command.kind ?? "video");
      const kind = command.kind ?? current.kind;
      if (kind !== "audio" && command.solo)
        throw new TimelineError("track_kind", "Solo requires an audio track.");
      return {
        ...timeline,
        tracks: [
          ...timeline.tracks.filter((track) => track !== current),
          {
            ...current,
            ...(command.kind !== undefined && { kind: command.kind }),
            ...(command.name !== undefined && { name: command.name }),
            ...(command.locked !== undefined && { locked: command.locked }),
            ...(command.autoSelect !== undefined && {
              autoSelect: command.autoSelect,
            }),
            ...(command.enabled !== undefined && { enabled: command.enabled }),
            ...(command.muted !== undefined && { muted: command.muted }),
            ...(command.solo !== undefined && { solo: command.solo }),
            ...(command.volume !== undefined && { volume: command.volume }),
            ...(command.fx !== undefined && {
              fx: buildFxChain(current.fx, command.fx),
            }),
          },
        ],
      };
    }
    case "routeAudioGroup": {
      const selected = new Set(command.clipIds.map(find));
      for (const clip of selected) {
        if (trackAt(clip.track)?.locked)
          throw new TimelineError("locked", `Track ${clip.track} is locked.`);
        if (!clip.hasAudio)
          throw new TimelineError(
            "unsupported",
            `${clipName(clip)} has no sound.`,
          );
      }
      let groups = timeline.authoredAudioGroups ?? [];
      const target = command.group;
      let id = typeof target === "string" ? target : null;
      if (target && typeof target !== "string") {
        // The renderer falls back to matching bare IDs across scenes. Keep bus
        // IDs independent of labels and use UUIDs even across unrelated projects.
        do {
          id = CUTROOM_AUDIO_GROUP_PREFIX + crypto.randomUUID();
        } while (taken.has(id));
        taken.add(id);
        groups = [
          ...groups,
          {
            id,
            label: target.label,
            volume: target.volume ?? 1,
            muted: false,
            solo: false,
            fx: [],
            automated: false,
          },
        ];
      } else if (target) {
        const group = groups.find(({ id }) => id === target);
        if (!group)
          throw new TimelineError(
            "not_found",
            `No audio group has ID ${target}.`,
          );
        if (group.sourceRestriction)
          throw new TimelineError("unsupported", group.sourceRestriction);
      }
      return {
        ...timeline,
        ...(groups.length && { authoredAudioGroups: groups }),
        clips: clips.map((clip) => {
          if (
            !selected.has(clip) ||
            clip.authoredAudioGroupId === (id ?? undefined)
          )
            return clip;
          const {
            authoredAudioGroupId: _group,
            trackGainWarning: _warning,
            ...rest
          } = clip;
          return id
            ? {
                ...rest,
                authoredAudioGroupId: id,
                trackGainWarning: trackGainWarning(id),
              }
            : rest;
        }),
      };
    }
    case "setAudioGroup":
    case "removeAudioGroup": {
      const groups = timeline.authoredAudioGroups ?? [];
      let groupId = command.group;
      if (command.type === "setAudioGroup" && command.clipId !== undefined) {
        const target = find(command.clipId);
        if (
          command.expectedGroupId !== undefined &&
          target.authoredAudioGroupId !== command.expectedGroupId
        )
          throw new TimelineError(
            "unsupported",
            `${clipName(target)} changed audio groups. Check its group before editing it.`,
          );
        groupId = target.authoredAudioGroupId;
        if (!groups.some(({ id }) => id === groupId))
          throw new TimelineError(
            "unsupported",
            `${clipName(target)} has no editable authored audio group.`,
          );
      }
      const group = groups.find(({ id }) => id === groupId);
      if (!group)
        throw new TimelineError(
          "not_found",
          `No audio group has ID ${groupId}.`,
        );
      if (group.sourceRestriction)
        throw new TimelineError("unsupported", group.sourceRestriction);
      const lockedTracks = new Set(
        timeline.tracks
          .filter(({ locked }) => locked)
          .map(({ index }) => index),
      );
      const locked = clips.find(
        (clip) =>
          clip.authoredAudioGroupId === group.id &&
          lockedTracks.has(clip.track),
      );
      if (locked)
        throw new TimelineError("locked", `Track ${locked.track} is locked.`);
      if (command.type === "removeAudioGroup") {
        const rest = groups.filter((entry) => entry !== group);
        const { authoredAudioGroups: _, ...others } = timeline;
        return {
          ...others,
          ...(rest.length && { authoredAudioGroups: rest }),
          clips: clips.map((clip) => {
            if (clip.authoredAudioGroupId !== group.id) return clip;
            const {
              authoredAudioGroupId: _group,
              trackGainWarning: _warning,
              ...track
            } = clip;
            return track;
          }),
        };
      }
      const next = {
        ...group,
        ...(command.label !== undefined && { label: command.label }),
        ...(command.volume !== undefined && { volume: command.volume }),
        ...(command.muted !== undefined && { muted: command.muted }),
        ...(command.solo !== undefined && { solo: command.solo }),
        ...(command.fx !== undefined && {
          fx: buildFxChain(group.fx, command.fx),
        }),
        ...(command.automation === null && { automated: false }),
      };
      if (JSON.stringify(next) === JSON.stringify(group)) return timeline;
      return {
        ...timeline,
        authoredAudioGroups: groups.map((entry) =>
          entry === group ? next : entry,
        ),
      };
    }
    case "setMaster": {
      if (command.volume === undefined && command.fx === undefined)
        return timeline;
      if (command.fx === undefined && timeline.main?.sourceRestriction)
        throw new TimelineError("unsupported", timeline.main.sourceRestriction);
      const current = timeline.main ?? { volume: 1, fx: [] };
      const main = {
        volume: command.volume ?? current.volume,
        fx:
          command.fx === undefined
            ? current.fx
            : buildFxChain(current.fx, command.fx),
      };
      const { main: _, ...rest } = timeline;
      return main.volume === 1 && !main.fx.length ? rest : { ...rest, main };
    }
    case "removeTrack": {
      const track = timeline.tracks.find(
        (track) => track.index === command.index,
      );
      if (!track)
        throw new TimelineError(
          "not_found",
          `Track ${command.index} not found.`,
        );
      if (track.locked)
        throw new TimelineError("locked", `Track ${track.index} is locked.`);
      if (clips.some((clip) => clip.track === track.index))
        throw new TimelineError(
          "unsupported",
          `Track ${track.index} is not empty. Remove its clips first.`,
        );
      return {
        ...timeline,
        tracks: timeline.tracks.filter((item) => item !== track),
      };
    }
    case "setMarker": {
      const id =
        command.id ??
        uniqueName(
          new Set(timeline.markers.map((marker) => marker.id)),
          "marker",
          1,
        );
      // Only the given fields change, so an edit never reverts someone else's newer ones.
      const current = timeline.markers.find((marker) => marker.id === id) ?? {
        id,
        frame: command.frame,
        duration: 0,
        name: "",
        note: "",
        color: "blue" as const,
      };
      const frame = command.frame ?? current.frame;
      if (frame === undefined)
        throw new TimelineError("unsupported", "A new marker needs a frame.");
      return {
        ...timeline,
        markers: [
          ...timeline.markers.filter((marker) => marker.id !== id),
          {
            id,
            frame,
            duration: command.duration ?? current.duration,
            name: command.name ?? current.name,
            note: command.note ?? current.note,
            color: command.color ?? current.color,
          },
        ],
      };
    }
    case "removeMarker": {
      if (!timeline.markers.some((marker) => marker.id === command.id))
        throw new TimelineError("not_found", `No marker has id ${command.id}.`);
      return {
        ...timeline,
        markers: timeline.markers.filter((marker) => marker.id !== command.id),
      };
    }
    case "setVersions":
    case "addVersion":
    case "renameVersion":
    case "setVersion":
    case "keepVersion":
      return editVersions(timeline, find(command.clipId), command, batch);
    case "setRange": {
      const range = {
        in: command.in === undefined ? timeline.range.in : command.in,
        out: command.out === undefined ? timeline.range.out : command.out,
      };
      if (range.in !== null && range.out !== null && range.out <= range.in)
        throw new TimelineError(
          "out_of_bounds",
          "The out point must follow the in point.",
        );
      return { ...timeline, range };
    }
  }
}

/** Validates the result of a command and settles derived state: references, duration, and order. */
function settle(before: Timeline, after: Timeline): Timeline {
  const previous = new Map(before.clips.map((clip) => [clip.id, clip]));
  const current = new Map(after.clips.map((clip) => [clip.id, clip]));
  const locked = new Set(
    [...before.tracks, ...after.tracks]
      .filter((track) => track.locked)
      .map((track) => track.index),
  );
  const moved = new Set<string>();
  for (const clip of after.clips) {
    if (clip.duration < 1)
      throw new TimelineError(
        "out_of_bounds",
        `Clip ${clip.id} would be shorter than one frame.`,
      );
    if (clip.start < 0)
      throw new TimelineError(
        "out_of_bounds",
        `Clip ${clip.id} would start before the timeline.`,
      );
    if (clip.track < 0)
      throw new TimelineError(
        "out_of_bounds",
        `Clip ${clip.id} would move above the first track.`,
      );
    if (clip.mediaStart !== null && round6(clip.mediaStart) < 0)
      throw new TimelineError(
        "out_of_bounds",
        `Clip ${clip.id} would start before its source media.`,
      );
    const old = previous.get(clip.id);
    if (old === clip || (old && JSON.stringify(old) === JSON.stringify(clip)))
      continue;
    if (
      clip.sourceDuration !== null &&
      clip.mediaStart !== null &&
      !clip.versionSilent &&
      // The frames the runtime shows before the source runs out.
      framesAfterOut(clip, after.fps) < 0
    )
      throw new TimelineError(
        "out_of_bounds",
        `Clip ${clip.id} would run past the end of its source media.`,
      );
    if (locked.has(clip.track) || (old && locked.has(old.track)))
      throw new TimelineError(
        "locked",
        `Track ${locked.has(clip.track) ? clip.track : old?.track} is locked.`,
      );
    if (
      !old ||
      old.start !== clip.start ||
      old.duration !== clip.duration ||
      old.track !== clip.track
    )
      moved.add(clip.id);
  }
  for (const clip of before.clips)
    if (!current.has(clip.id) && locked.has(clip.track))
      throw new TimelineError("locked", `Track ${clip.track} is locked.`);
  const overlap = findOverlap(after.clips, moved);
  if (overlap)
    throw new TimelineError(
      "overlap",
      `Clip ${overlap.clip.id} would overlap ${overlap.other.id} on track ${overlap.clip.track}.`,
    );
  const contentEnd = (clips: Clip[]) =>
    clips.reduce((end, clip) => Math.max(end, clipEnd(clip)), 0);
  const beforeEnd = contentEnd(before.clips);
  const afterEnd = contentEnd(after.clips);
  const tail = before.duration - beforeEnd;
  return normalizeTimeline({
    ...after,
    // The authored tail after the last clip is kept, as script cuts do. A root kept shorter than
    // its content never grows on its own, and an empty root is space to fill, not a tail.
    duration:
      afterEnd === beforeEnd
        ? after.duration
        : before.clips.length === 0
          ? Math.max(before.duration, afterEnd)
          : tail >= 0
            ? afterEnd + tail
            : Math.min(before.duration, afterEnd),
    clips: after.clips.map((clip) => {
      if (!clip.startRef) return clip;
      const target = current.get(clip.startRef.clipId);
      return target && clip.start === clipEnd(target) + clip.startRef.offset
        ? clip
        : { ...clip, startRef: null };
    }),
  });
}

function editVersions(
  timeline: Timeline,
  target: Clip,
  command: Extract<
    Command,
    {
      type:
        | "setVersions"
        | "addVersion"
        | "renameVersion"
        | "setVersion"
        | "keepVersion";
    }
  >,
  batch: Batch,
): Timeline {
  const { clips, fps } = timeline;
  const media = mediaVersions(target.kind);
  if (target.kind === "element" || (!media && command.type === "addVersion"))
    throw new TimelineError(
      "unsupported",
      "This clip does not hold media versions.",
    );
  const owner = versionOwner(clips, target);
  if (target !== owner)
    throw new TimelineError(
      "unsupported",
      `Edit versions on the linked picture, ${clipName(owner)}.`,
    );
  const partners = versionPartners(clips, target);
  const active = activeVersion(target);
  let versions = target.versions;
  let index = active;
  const take = (version: Version) => {
    if (
      !fitsVersion(target.kind, version.src) ||
      (!media && version.sourceIn !== undefined)
    )
      throw new TimelineError(
        "unsupported",
        `"${version.src}" is not a source for a ${target.kind} version.`,
      );
    if (!media) return version;
    return versionMedia(
      {
        ...version,
        sourceIn: version.sourceIn ?? 0,
        ...(batch.mediaRates.has(version.src) && {
          sourceFps: batch.mediaRates.get(version.src),
        }),
      },
      batch.mediaLengths,
      batch.silentMedia,
      batch.mediaFiles,
    );
  };

  switch (command.type) {
    case "setVersions":
      versions = command.versions.map(take);
      if (
        !media &&
        new Set(versions.map(({ src }) => src)).size !== versions.length
      )
        throw new TimelineError(
          "unsupported",
          "Each scene or image version needs its own file.",
        );
      index = command.active;
      if (media && versions[index]) {
        const requested = versionFit(target, partners, versions[index], fps);
        if (!requested.fits || requested.offline) {
          const available = versions.findIndex((version) => {
            const status = versionFit(target, partners, version, fps);
            return status.fits && !status.offline;
          });
          if (available >= 0) index = available;
        }
      }
      break;
    case "addVersion": {
      if (!target.src)
        throw new TimelineError(
          "unsupported",
          "This clip has no source to copy.",
        );
      if (versions && versions.length >= MAX_VERSIONS)
        throw new TimelineError(
          "unsupported",
          `A clip holds at most ${MAX_VERSIONS} versions.`,
        );
      const first = take({ name: "Take 1", src: target.src });
      first.sourceIn = versionOffset(first, target.mediaStart ?? 0, fps);
      first.sourceDuration ??= target.sourceDuration ?? undefined;
      const list = versions ?? [first];
      const shown = list[active >= 0 ? active : 0]!;
      const base = command.version?.name ?? "Take";
      let name = command.version ? base : `Take ${list.length + 1}`;
      for (
        let suffix = list.length + 1;
        list.some((version) => version.name === name);
        suffix++
      )
        name = `${base.slice(0, 55)} ${suffix + 1}`;
      const added = command.version
        ? take({ ...command.version, name })
        : { ...shown, name };
      if (command.version && command.sourceSeconds !== undefined)
        added.sourceIn = versionOffset(added, command.sourceSeconds, fps);
      versions = [...list, added];
      const status = versionFit(target, partners, added, fps);
      index =
        status.fits && !status.offline ? list.length : Math.max(0, active);
      break;
    }
    case "renameVersion":
      if (!versions?.[command.version])
        throw new TimelineError(
          "not_found",
          "There is no version at that index.",
        );
      if (
        versions.some(
          ({ name }, i) => i !== command.version && name === command.name,
        )
      )
        throw new TimelineError(
          "unsupported",
          "Each version needs its own name.",
        );
      return {
        ...timeline,
        clips: clips.map((clip) =>
          clip === target
            ? {
                ...clip,
                versions: versions!.map((version, i) =>
                  i === command.version
                    ? { ...version, name: command.name }
                    : version,
                ),
              }
            : clip,
        ),
      };
    case "setVersion":
    case "keepVersion":
      index = command.version ?? active;
  }

  const version = versions?.[index];
  if (!version)
    throw new TimelineError(
      "not_found",
      `Clip ${target.id} has ${versions?.length ?? 0} versions. There is no version at that index.`,
    );
  if (
    media &&
    (index !== active || command.type === "setVersions") &&
    command.type !== "addVersion"
  ) {
    const status = versionFit(target, partners, version, fps);
    if (status.offline)
      throw new TimelineError("not_found", `${status.name} is offline.`);
    if (!status.fits)
      throw new TimelineError("out_of_bounds", versionShortReason(status, fps));
  }
  const start = versionStart(version, fps);
  const unchanged = command.type !== "setVersions" && index === active;
  const switchSource = (clip: Clip, partner: boolean): Clip => {
    if (unchanged || (command.type === "addVersion" && index === 0))
      return clip;
    const { versionSilent: _silent, ...rest } = clip;
    const silent = Boolean(partner && version.silent);
    return {
      ...rest,
      src: version.src,
      ...(media && {
        label: clip.label ?? clipName(clip),
        mediaStart: partner
          ? start + (clip.mediaStart ?? 0) - (target.mediaStart ?? 0)
          : start,
        sourceDuration:
          version.sourceDuration ??
          (version.src === clip.src ? clip.sourceDuration : null),
        ...(partner && { hasAudio: !silent }),
        ...(silent && { versionSilent: true }),
      }),
    };
  };
  return {
    ...timeline,
    clips: clips.map((clip) => {
      if (clip !== target)
        return partners.includes(clip) ? switchSource(clip, true) : clip;
      const {
        versions: _dropped,
        versionIndex: _index,
        ...next
      } = switchSource(clip, false);
      return command.type === "keepVersion"
        ? next
        : {
            ...next,
            versions,
            ...(media && {
              versionIndex: index,
              label: next.label ?? clipName(target),
            }),
          };
    }),
  };
}

/** The shown take's in-point follows the clip's own; Timing and slip change only that take. */
function shownVersionAt(clip: Clip, mediaStart: number | null, fps: Fps) {
  const active = activeVersion(clip);
  if (mediaStart === null || !clip.versions || !mediaVersions(clip.kind))
    return clip.versions;
  return clip.versions.map((version, i) =>
    i === active
      ? { ...version, sourceIn: versionOffset(version, mediaStart, fps) }
      : version,
  );
}

/** Drops and clipboard pastes replace only the overwritten picture's sound, otherwise use room. */
function routePictureSound(
  before: Timeline,
  current: Pick<Timeline, "clips" | "tracks">,
  pictures: readonly Clip[],
  sound: Clip,
  overwrite: boolean,
) {
  const { clips } = before;
  let { tracks } = current;
  const at = sound.start;
  const end = clipEnd(sound);
  // Read links before clearing picture: a full overwrite can remove the partner's link.
  const overwrittenLinks = new Set(
    overwrite
      ? clips
          .filter(
            (clip) =>
              clip.kind === "video" &&
              pictures.some(
                (picture) =>
                  clip.track === picture.track &&
                  clip.start < clipEnd(picture) &&
                  clipEnd(clip) > picture.start,
              ),
          )
          .flatMap((clip) => clip.link ?? [])
      : [],
  );
  const partnerTracks = new Set(
    clips
      .filter(
        (clip) =>
          isAudioKind(clip.kind) &&
          clip.link !== null &&
          overwrittenLinks.has(clip.link),
      )
      .map((clip) => clip.track),
  );
  if (partnerTracks.size > 1)
    throw new TimelineError(
      "unsupported",
      "The overwritten pictures have sound on different tracks. Overwrite one linked pair at a time.",
    );
  // Classify from the input: an overwrite can remove the original picture entirely.
  const existing = [...clips, ...current.clips];
  const pictureLinks = new Set(
    existing
      .filter((clip) => clip.kind === "video" && clip.link !== null)
      .map((clip) => clip.link),
  );
  const partner = tracks.find((candidate) =>
    partnerTracks.has(candidate.index),
  );
  let destination =
    partner ??
    tracks.find(
      (candidate) =>
        candidate.kind === "audio" &&
        !candidate.locked &&
        existing.every(
          (clip) =>
            clip.track !== candidate.index ||
            (clip.link !== null && pictureLinks.has(clip.link)),
        ) &&
        !current.clips.some(
          (clip) =>
            clip.track === candidate.index &&
            clip.start < end &&
            clipEnd(clip) > at,
        ),
    );
  if (!destination) {
    destination = newTrack(
      Math.max(
        ...pictures.map((picture) => picture.track + 1),
        nextTrackIndex(tracks),
      ),
      "audio",
    );
    tracks = [...tracks, destination];
  }
  return {
    tracks,
    track: destination.index,
    replace: partner !== undefined,
  };
}

/** Only clips a command moved are checked, so overlaps already in the HTML stay editable. */
function findOverlap(
  clips: Clip[],
  moved: ReadonlySet<string>,
): { clip: Clip; other: Clip } | null {
  if (!moved.size) return null;
  const tracks = new Set(
    clips.filter((clip) => moved.has(clip.id)).map((clip) => clip.track),
  );
  for (const track of tracks) {
    let last: Clip | undefined;
    let lastMoved: Clip | undefined;
    const list = clips.filter((clip) => clip.track === track);
    for (const clip of list.sort((a, b) => a.start - b.start)) {
      const other = moved.has(clip.id) ? last : lastMoved;
      if (other && clip.start < clipEnd(other)) return { clip, other };
      if (!last || clipEnd(clip) > clipEnd(last)) last = clip;
      if (
        moved.has(clip.id) &&
        (!lastMoved || clipEnd(clip) > clipEnd(lastMoved))
      )
        lastMoved = clip;
    }
  }
  return null;
}

/** Linked clips (`data-link`) are edited as one. */
function withPartners(clips: Clip[], selected: Clip[]): Clip[] {
  const ids = new Set(selected.map((clip) => clip.id));
  const links = new Set(
    selected.flatMap((clip) => (clip.link ? [clip.link] : [])),
  );
  return clips.filter(
    (clip) => ids.has(clip.id) || (clip.link !== null && links.has(clip.link)),
  );
}

/** Auto-select razor may leave a source-restricted clip whole, including its linked group. */
function skipAutoClips(
  clips: Clip[],
  reasons: ReadonlyMap<Clip, string>,
  explicit: ReadonlySet<string>,
  onSkip: Batch["onSkip"],
): Set<string> {
  const skipped = new Set<string>();
  for (const [clip, reason] of reasons) {
    const group = withPartners(clips, [clip]);
    if (group.some((member) => explicit.has(member.id)))
      throw new TimelineError("unsupported", reason);
    for (const member of group) {
      if (skipped.has(member.id)) continue;
      skipped.add(member.id);
      onSkip(member, reason);
    }
  }
  return skipped;
}

/** Ripple edits reach the edited tracks and every auto-select track, never a locked one. */
function rippleTracks(timeline: Timeline, own: number[]): Set<number> {
  const locked = new Set(
    timeline.tracks.filter((track) => track.locked).map((track) => track.index),
  );
  return new Set(
    [
      ...own,
      ...timeline.tracks
        .filter((track) => track.autoSelect)
        .map((track) => track.index),
    ].filter((index) => !locked.has(index)),
  );
}

/**
 * Insert ripple: clips at or after the edit point move by `delta`, and a
 * linked group moves whole when any member does. A partner it pulls must land in free space.
 */
function shiftAfter(
  clips: Clip[],
  tracks: ReadonlySet<number>,
  editPoint: (track: number) => number,
  delta: number,
  fixed: ReadonlySet<string> = new Set(),
): Clip[] {
  const qualifies = (clip: Clip) =>
    !fixed.has(clip.id) &&
    tracks.has(clip.track) &&
    clip.start >= editPoint(clip.track);
  const links = new Set(
    clips.filter(qualifies).flatMap((clip) => (clip.link ? [clip.link] : [])),
  );
  const pulled = new Set<string>();
  const next = clips.map((clip) => {
    if (fixed.has(clip.id)) return clip;
    if (!qualifies(clip)) {
      if (clip.link === null || !links.has(clip.link)) return clip;
      pulled.add(clip.id);
    }
    return { ...clip, start: clip.start + delta };
  });
  const overlap = findOverlap(next, pulled);
  const blocked =
    next.find((clip) => pulled.has(clip.id) && clip.start < 0) ??
    (overlap && (pulled.has(overlap.clip.id) ? overlap.clip : overlap.other));
  if (blocked)
    throw new TimelineError(
      "unsupported",
      `Linked clips ${next
        .filter((clip) => clip.link === blocked.link)
        .map((clip) => clip.id)
        .join(
          ", ",
        )} cannot move together here without leaving the timeline or overlapping another clip.`,
    );
  return next;
}

/** A track as its header names it: V1 for the first video track, A2 for the second audio one. */
function trackLabel(timeline: Timeline, index: number) {
  const kind = timeline.tracks.find((track) => track.index === index)!.kind;
  const number = timeline.tracks.filter(
    (track) => track.kind === kind && track.index <= index,
  ).length;
  return `${kind === "audio" ? "A" : "V"}${number}`;
}

const frameCount = (frames: number) =>
  `${frames} ${frames === 1 ? "frame" : "frames"}`;

/**
 * The empty time around `frame` on a track: from the end of the clip before it, or the timeline's
 * start, to the start of the clip after it. Null inside a clip and after a track's last clip,
 * which Resolve does not count as a gap.
 */
export function gapAt(
  timeline: Pick<Timeline, "clips">,
  track: number,
  frame: number,
): { from: number; to: number } | null {
  let from = 0;
  let to = Infinity;
  for (const clip of timeline.clips) {
    if (clip.track !== track) continue;
    const end = clipEnd(clip);
    if (clip.start <= frame && frame < end) return null;
    if (end <= frame) from = Math.max(from, end);
    else to = Math.min(to, clip.start);
  }
  return to === Infinity ? null : { from, to };
}

/**
 * A slip as a function of its frames: the clip, and with `linked` its partners that play a source,
 * show other source in the same place. Both edges of each window move together, so keyframes and
 * volume points follow their content as a trim's do. Null when the clip has no source to slip.
 */
function slipEdit(timeline: Timeline, clip: Clip, linked: boolean) {
  if (clip.mediaStart === null) return null;
  const members = new Set(
    (linked ? withPartners(timeline.clips, [clip]) : [clip]).filter(
      (member) => member.mediaStart !== null,
    ),
  );
  return (by: number): Timeline => ({
    ...timeline,
    clips: timeline.clips.map((member) =>
      members.has(member)
        ? {
            ...windowClip(
              member,
              member.start + by,
              clipEnd(member) + by,
              timeline.fps,
              "trim",
              true,
            ),
            start: member.start,
          }
        : member,
    ),
  });
}

/**
 * A slide as a function of its frames. The named clips and their partners move as one block,
 * keeping their source. On each of their tracks the clip ending where the block starts and the
 * clip starting where it ends trim to follow, and so do those neighbours' linked partners, as a
 * trim moves a partner's edge with its own. A gap beside the block shrinks or grows instead. A clip
 * that would trim on both sides lies inside the block, which is refused.
 */
function slideEdit(timeline: Timeline, named: Clip[]) {
  const { clips, fps } = timeline;
  const members = new Set(withPartners(clips, named).map((clip) => clip.id));
  const starts = new Set<string>();
  const ends = new Set<string>();
  for (const member of clips) {
    if (!members.has(member.id)) continue;
    const others = clips.filter(
      (other) => other.track === member.track && !members.has(other.id),
    );
    const left = others.find((other) => clipEnd(other) === member.start);
    const right = others.find((other) => other.start === clipEnd(member));
    if (left) for (const clip of withPartners(clips, [left])) ends.add(clip.id);
    if (right)
      for (const clip of withPartners(clips, [right])) starts.add(clip.id);
  }
  const inside = clips.find((clip) => starts.has(clip.id) && ends.has(clip.id));
  if (inside)
    throw new TimelineError(
      "unsupported",
      `${clipName(inside)} is between clips that slide, so they cannot slide as one block. Select it too, or slide them apart.`,
    );
  return (by: number): Timeline => ({
    ...timeline,
    clips: clips.map((clip) =>
      members.has(clip.id)
        ? { ...clip, start: clip.start + by }
        : starts.has(clip.id) || ends.has(clip.id)
          ? windowClip(
              clip,
              clip.start + (starts.has(clip.id) ? by : 0),
              clipEnd(clip) + (ends.has(clip.id) ? by : 0),
              fps,
              "trim",
            )
          : clip,
    ),
  });
}

/**
 * Refuses an edit that would shorten a transition on a cut it changed, as Resolve stops a slip or
 * slide at a transition's handles. A transition that did not fit before is left to fit as it can.
 */
function assertTransitionsFit(before: Timeline, after: Timeline) {
  const previous = new Map(before.clips.map((clip) => [clip.id, clip]));
  for (const incoming of after.clips) {
    const transition = incoming.transitionIn;
    if (!transition) continue;
    const outgoing = after.clips.find(
      (clip) =>
        clip.id !== incoming.id &&
        clip.track === incoming.track &&
        clipEnd(clip) === incoming.start &&
        sameTransition(clip.transitionOut, transition),
    );
    if (!outgoing) continue;
    const was = [previous.get(outgoing.id), previous.get(incoming.id)];
    if (was[0] === outgoing && was[1] === incoming) continue;
    const room = transitionRoom(
      after.fps,
      outgoing,
      incoming,
      transition.alignment,
    );
    if (room.frames >= transition.duration) continue;
    if (
      was[0] &&
      was[1] &&
      transitionRoom(before.fps, was[0], was[1], transition.alignment).frames <
        transition.duration
    )
      continue;
    throw new TimelineError(
      "out_of_bounds",
      `The ${transition.duration}-frame transition between ${clipName(outgoing)} and ${clipName(incoming)} would not fit, since ${room.reason}.`,
    );
  }
}

/** An edit's result as the engine takes it, or the refusal. */
function attempt(before: Timeline, after: Timeline) {
  try {
    assertTransitionsFit(before, after);
    settle(before, after);
    return null;
  } catch (error) {
    if (error instanceof TimelineError) return error;
    throw error;
  }
}

/** Refusals that say there is no more room; any other, such as a locked track, is not a limit. */
const outOfRoom = (error: TimelineError) =>
  error.code === "out_of_bounds" || error.code === "overlap";

/**
 * How many frames a one-parameter edit can go each way before the engine refuses it, found by
 * trying it, with the refusal just past each limit. Every rule the engine applies counts: source
 * ends, neighbours and their partners, the next clip, transitions and locks.
 */
function reach(before: Timeline, edit: (by: number) => Timeline) {
  const side = (sign: 1 | -1) => {
    let fits = 0;
    let fails = 0;
    let error: TimelineError | null = null;
    for (let frames = 1; frames <= 1 << 24; frames *= 2) {
      error = attempt(before, edit(sign * frames));
      if (error) {
        fails = frames;
        break;
      }
      fits = frames;
    }
    if (!error) return { frames: Infinity, error: null };
    while (fails - fits > 1) {
      const middle = (fits + fails) >> 1;
      const refusal = attempt(before, edit(sign * middle));
      if (refusal) {
        fails = middle;
        error = refusal;
      } else fits = middle;
    }
    return { frames: fits, error };
  };
  return { earlier: side(-1), later: side(1) };
}

/** Applies a slip or slide, or refuses it with how far it can go and what stops it there. */
function within(
  before: Timeline,
  edit: (by: number) => Timeline,
  by: number,
  describe: (frames: number, later: boolean) => string,
) {
  const after = edit(by);
  const refusal = attempt(before, after);
  if (!refusal) return after;
  if (!outOfRoom(refusal)) throw refusal;
  const side = reach(before, edit)[by > 0 ? "later" : "earlier"];
  if (side.error && !outOfRoom(side.error)) throw side.error;
  const reason = (side.error ?? refusal).message.replace(/\.$/, "");
  const limit = reason.charAt(0).toLowerCase() + reason.slice(1);
  throw new TimelineError(
    "out_of_bounds",
    side.frames
      ? `${describe(side.frames, by > 0)}: then ${limit}.`
      : `${describe(0, by > 0)}: ${limit}.`,
  );
}

const range = (before: Timeline, edit: (by: number) => Timeline) => {
  const { earlier, later } = reach(before, edit);
  return { min: 0 - earlier.frames, max: later.frames };
};

/**
 * How far a clip can slip, in frames: negative shows earlier source. With `linked`, partners that
 * play a source slip too and limit it. Null when the clip has no source to slip.
 */
export function slipRange(timeline: Timeline, clip: Clip, linked = true) {
  const edit = slipEdit(timeline, clip, linked);
  return edit && range(timeline, edit);
}

/** How far clips can slide as one block, in frames; none when they cannot form one. */
export function slideRange(timeline: Timeline, clips: Clip[]) {
  try {
    return range(timeline, slideEdit(timeline, clips));
  } catch (error) {
    if (error instanceof TimelineError) return { min: 0, max: 0 };
    throw error;
  }
}

function refuseRippleCut(clip: Clip, timeline: Timeline): never {
  const track = trackLabel(timeline, clip.track);
  const name = clip.label ?? clip.src?.split("/").at(-1) ?? clip.id;
  throw new TimelineError(
    "unsupported",
    `${name} on ${track} can't be cut here. Turn off auto-select on ${track} to ripple without it.`,
  );
}

interface RippleTrimEdit {
  at: number;
  change: number;
}

/** Ripple the time opened or removed by one or more trimmed edges. */
function rippleTrim(
  timeline: Timeline,
  clips: Clip[],
  {
    edge,
    at,
    edits,
    fixed,
    mint,
    copies,
  }: {
    edge: "start" | "end";
    at: number;
    edits: ReadonlyMap<number, RippleTrimEdit>;
    fixed: ReadonlySet<string>;
    mint: Minting;
    copies: ReadonlyMap<string, string>;
  },
): Clip[] {
  const tracks = rippleTracks(timeline, [...edits.keys()]);
  const groups = new Map<number, Set<number>>();
  for (const [track, { change }] of edits) {
    const group = groups.get(change) ?? new Set<number>();
    if (tracks.has(track)) group.add(track);
    groups.set(change, group);
  }
  const mixed = groups.size > 1;
  const cutStart = ({ at, change }: RippleTrimEdit) =>
    edge === "end" ? at + change : at;
  if (mixed) {
    const earliest = Math.min(
      ...[...edits.values()].filter(({ change }) => change).map(cutStart),
    );
    if (
      timeline.clips.some(
        (clip) =>
          tracks.has(clip.track) &&
          !edits.has(clip.track) &&
          clipEnd(clip) > earliest,
      )
    )
      throw new TimelineError(
        "unsupported",
        "These trims remove different lengths. Turn off auto-select on the other tracks to ripple them independently.",
      );
  }
  let next = clips;
  for (const [change, group] of groups) {
    if (change === 0) continue;
    const participating = mixed ? group : tracks;
    const editPoint = (track: number) => edits.get(track) ?? { at, change };
    const before = next;
    next =
      change < 0
        ? removeTime(
            next,
            participating,
            (track) => cutStart(editPoint(track)),
            -change,
            timeline,
            mint,
            fixed,
          )
        : insertTime(
            next,
            participating,
            (track) => editPoint(track).at,
            change,
            timeline,
            mint,
            fixed,
          );
    if (mixed)
      assertRippleSync(
        { ...timeline, clips: before },
        next,
        participating,
        copies,
        "independent trims",
      );
  }
  assertRippleSync(timeline, next, tracks, copies);
  return next;
}

/** Remove an interval on participating tracks, refusing cuts the source cannot represent. */
function removeTime(
  clips: Clip[],
  tracks: ReadonlySet<number>,
  from: (track: number) => number,
  duration: number,
  timeline: Timeline,
  mint: Minting,
  fixed: ReadonlySet<string> = new Set(),
): Clip[] {
  const shortened = new Set<string>();
  for (const clip of clips) {
    const start = from(clip.track),
      end = start + duration;
    if (
      fixed.has(clip.id) ||
      !tracks.has(clip.track) ||
      clip.start >= end ||
      clipEnd(clip) <= start
    )
      continue;
    const spans = clip.start < start && clipEnd(clip) > end;
    // Graphics have no video or audio source frames to preserve after the gap.
    if (
      spans &&
      (clip.kind === "image" ||
        clip.kind === "composition" ||
        (clip.kind === "element" && (clip.text !== null || clip.textPreview)))
    ) {
      shortened.add(clip.id);
      continue;
    }
    const reason = spans
      ? clip.sourceRestrictions?.copy
      : clip.start >= start && clipEnd(clip) <= end
        ? clip.sourceRestrictions?.remove
        : undefined;
    if (reason) refuseRippleCut(clip, timeline);
  }
  const fixedClips = clips.filter((clip) => fixed.has(clip.id));
  let next = clips.filter((clip) => !fixed.has(clip.id));
  // Keep the original span through link regrouping so it joins both surviving media pieces.
  for (const track of tracks)
    next = clearRange(
      next,
      track,
      from(track),
      from(track) + duration,
      timeline.fps,
      mint,
      shortened,
    );
  return [
    ...fixedClips,
    ...next.map((clip) =>
      shortened.has(clip.id)
        ? windowClip(
            clip,
            clip.start,
            clipEnd(clip) - duration,
            timeline.fps,
            "trim",
          )
        : tracks.has(clip.track) && clip.start >= from(clip.track) + duration
          ? { ...clip, start: clip.start - duration }
          : clip,
    ),
  ];
}

/** Extending a ripple trim opens time at the old edge, cutting overlapping clips there. */
function insertTime(
  clips: Clip[],
  tracks: ReadonlySet<number>,
  at: (track: number) => number,
  duration: number,
  timeline: Timeline,
  mint: Minting,
  fixed: ReadonlySet<string>,
): Clip[] {
  for (const clip of clips)
    if (
      !fixed.has(clip.id) &&
      tracks.has(clip.track) &&
      clip.start < at(clip.track) &&
      at(clip.track) < clipEnd(clip) &&
      clip.sourceRestrictions?.copy
    )
      refuseRippleCut(clip, timeline);
  let next = clips;
  for (const track of tracks)
    next = splitClips(
      next,
      next.filter(
        (clip) =>
          !fixed.has(clip.id) &&
          clip.track === track &&
          clip.start < at(track) &&
          at(track) < clipEnd(clip),
      ),
      at(track),
      timeline.fps,
      mint,
    );
  return next.map((clip) =>
    !fixed.has(clip.id) &&
    tracks.has(clip.track) &&
    clip.start >= at(clip.track)
      ? { ...clip, start: clip.start + duration }
      : clip,
  );
}

/** Protected clips stay unchanged; a link cannot pull one into a ripple. */
function assertRippleSync(
  before: Timeline,
  clips: Clip[],
  tracks: ReadonlySet<number>,
  copies: ReadonlyMap<string, string>,
  mode?: "independent trims",
) {
  const protectedTracks = new Map(
    before.tracks
      .filter((track) => !tracks.has(track.index))
      .map((track) => [track.index, track]),
  );
  if (!protectedTracks.size) return;
  const previous = new Map(before.clips.map((clip) => [clip.id, clip]));
  const current = new Map(clips.map((clip) => [clip.id, clip]));
  const shifted = new Map<string, Clip[]>();
  for (const clip of clips) {
    const old = previous.get(copies.get(clip.id) ?? clip.id);
    if (!old?.link) continue;
    const { fps } = before;
    if (old.mediaStart === null && clip.mediaStart === null) continue;
    const line = resolveClip(old, fps);
    const current = resolveClip(clip, fps);
    if (
      line.c === current.c &&
      line.tau === current.tau &&
      line.zero === current.zero &&
      JSON.stringify(line.curve) === JSON.stringify(current.curve)
    )
      continue;
    const partners = shifted.get(old.link) ?? [];
    partners.push(clip);
    shifted.set(old.link, partners);
  }
  for (const clip of before.clips) {
    const track = protectedTracks.get(clip.track);
    if (!track) continue;
    const changed =
      JSON.stringify(clip) !== JSON.stringify(current.get(clip.id));
    const outOfSync =
      clip.link &&
      shifted
        .get(clip.link)
        ?.some(
          (partner) =>
            mode === "independent trims" ||
            (partner.start < clipEnd(clip) && clipEnd(partner) > clip.start),
        );
    if (!changed && !outOfSync) continue;
    if (mode === "independent trims" && track.autoSelect && !track.locked)
      throw new TimelineError(
        "unsupported",
        `Rippling these trims would move linked clips of ${clipName(clip)} by different amounts.`,
      );
    throw new TimelineError(
      track.locked && !clip.link ? "locked" : "unsupported",
      `Clip ${clip.id} is on ${track.locked ? "a locked" : "an auto-select-off"} track, so the ripple cannot preserve sync.`,
    );
  }
}

/** A keyframe's value from a command: its fields over what the clip shows at that frame. */
function keyframeValue<P extends KeyframeProperty>(
  clip: Clip,
  property: P,
  frame: number,
  value: Extract<Command, { type: "setKeyframe" }>["value"],
): KeyframeValues[P] {
  const current = valueAt(clip, property, frame);
  const parsed = parseKeyframeValue(
    property,
    value === undefined
      ? current
      : typeof value === "object" && typeof current === "object"
        ? { ...current, ...value }
        : value,
  );
  if (!parsed.success)
    throw new TimelineError(
      "unsupported",
      `That is not a ${property} value: ${parsed.error.issues[0]?.message ?? "invalid"}. position and scale take {x, y}, crop takes {top, right, bottom, left}, rotation and opacity take a number.`,
    );
  return parsed.data;
}

/** Source geometry is shared; edge trims and internal cuts have different fade semantics. */
function windowClip(
  clip: ObservedClip,
  start: number,
  end: number,
  fps: Fps,
  mode: "trim" | "cut" = "cut",
  slip = false,
): Clip {
  const duration = end - start;
  if (duration <= 0) return { ...clip, start, duration };
  const mix = windowMix(clip, start - clip.start, duration, fps, mode);
  const { speedSpan, ...original } = clip;
  const edge = sourceAtEdge(
    { ...clip, ...mix },
    frames(clip.start, fps),
    frames(start, fps),
    fps,
  );
  return {
    ...original,
    ...(duration === clip.duration && speedSpan && { speedSpan }),
    ...mix,
    start,
    duration,
    ...edge,
    ...(clip.versions && {
      versions: slip
        ? shownVersionAt(clip, edge.mediaStart, fps)
        : versionsAtEdge(
            { ...clip, ...mix },
            edge.mediaStart,
            frames(clip.start, fps),
            frames(start, fps),
            fps,
          ),
    }),
    // Keyframes stay on the frames of content they animate.
    keyframes: shiftKeyframes(clip.keyframes, start - clip.start),
    // A piece cut from a clip keeps a transition only on an edge it still has.
    ...(mode === "cut" && start !== clip.start && { transitionIn: null }),
    ...(mode === "cut" && end !== clipEnd(clip) && { transitionOut: null }),
    ...(clip[animationSource] !== undefined && {
      [animationSource]:
        clip[animationSource] +
        frameTime(start - clip.start, fps) * clip.playbackRate,
    }),
  };
}

const clipName = (clip: Clip) =>
  clip.label ?? clip.src?.split("/").at(-1) ?? clip.id;

/** The cut itself, then each pair of linked partners meeting at the same frame on one track. */
function linkedCuts(clips: Clip[], from: Clip, to: Clip): [Clip, Clip][] {
  const cut = clipEnd(from);
  const partners = (clip: Clip) =>
    clip.link === null
      ? []
      : clips.filter(
          (item) =>
            item.link === clip.link &&
            item.id !== from.id &&
            item.id !== to.id &&
            takesTransition(item),
        );
  const incoming = partners(to);
  return [
    [from, to],
    ...partners(from).flatMap((outgoing): [Clip, Clip][] => {
      const partner = incoming.find(
        (clip) =>
          clip.track === outgoing.track &&
          clip.start === cut &&
          clipEnd(outgoing) === cut,
      );
      return partner ? [[outgoing, partner]] : [];
    }),
  ];
}

/**
 * The longest transition with this alignment that fits a cut, and what limits it: media past the
 * outgoing clip's out point and before the incoming clip's in point, each clip's length beside its
 * other transition or sound fade, and the start of the timeline.
 */
export function transitionRoom(
  fps: Fps,
  from: Clip,
  to: Clip,
  alignment: Transition["alignment"],
): { frames: number; reason: string } {
  const count = (frames: number) =>
    `${frames} ${frames === 1 ? "frame" : "frames"}`;
  const limit = (limits: [number, () => string][]) => {
    const [frames, reason] = limits.reduce((least, next) =>
      next[0] < least[0] ? next : least,
    );
    return { frames: Math.max(0, frames), reason };
  };
  const inSide = from.transitionIn
    ? framesAfter(from.transitionIn)
    : from.hasAudio
      ? clipFades(from).fadeIn
      : 0;
  const outSide = to.transitionOut
    ? framesBefore(to.transitionOut)
    : to.hasAudio
      ? clipFades(to).fadeOut
      : 0;
  const before = limit([
    [
      framesBeforeIn(to, fps),
      () =>
        `${clipName(to)} has ${count(framesBeforeIn(to, fps))} of media before its in point`,
    ],
    [
      from.duration - inSide,
      () =>
        inSide
          ? `${clipName(from)} has ${count(from.duration - inSide)} beside its ${from.transitionIn ? "other transition" : "fade in"}`
          : `${clipName(from)} is ${count(from.duration)} long`,
    ],
    [to.start, () => `the cut is ${count(to.start)} from the timeline start`],
  ]);
  const after = limit([
    [
      framesAfterOut(from, fps),
      () =>
        `${clipName(from)} has ${count(framesAfterOut(from, fps))} of media after its out point`,
    ],
    [
      to.duration - outSide,
      () =>
        outSide
          ? `${clipName(to)} has ${count(to.duration - outSide)} beside its ${to.transitionOut ? "other transition" : "fade out"}`
          : `${clipName(to)} is ${count(to.duration)} long`,
    ],
  ]);
  const side =
    alignment === "start"
      ? { frames: after.frames, limit: after }
      : alignment === "end"
        ? { frames: before.frames, limit: before }
        : 2 * before.frames + 1 <= 2 * after.frames
          ? { frames: 2 * before.frames + 1, limit: before }
          : { frames: 2 * after.frames, limit: after };
  return { frames: side.frames, reason: side.limit.reason() };
}

/** The longest transition that fits a cut and, when linked, every linked cut beside it. */
export function cutRoom(
  timeline: Timeline,
  from: Clip,
  to: Clip,
  alignment: Transition["alignment"],
  linked = true,
) {
  return (linked ? linkedCuts(timeline.clips, from, to) : [[from, to]])
    .map(([outgoing, incoming]) =>
      transitionRoom(timeline.fps, outgoing, incoming, alignment),
    )
    .reduce((least, next) => (next.frames < least.frames ? next : least));
}

type TransitionCut = Extract<
  Command,
  { type: "setTransitions" }
>["cuts"][number];
export type TransitionScope = Track["kind"] | "both";

/** Default centred transitions at the cuts whose two clips were selected, in timeline order. */
export function planBatchTransitions(
  { tracks, clips, fps }: Timeline,
  selected: ReadonlySet<string>,
  scope: TransitionScope,
) {
  const enabled = new Set(
    tracks
      .filter(
        (track) => !track.locked && (scope === "both" || track.kind === scope),
      )
      .map((track) => track.index),
  );
  const selectedIds =
    scope === "both"
      ? new Set(
          withPartners(
            clips,
            clips.filter(
              (clip) => enabled.has(clip.track) && selected.has(clip.id),
            ),
          ).map(({ id }) => id),
        )
      : selected;
  const requested = toFrames(1, fps);
  const ends = new Map<string, Clip>();
  const cuts: TransitionCut[] = [];
  let skipped = 0;
  let shortened = 0;
  let kept = 0;
  for (const to of clips) {
    if (
      !enabled.has(to.track) ||
      !selectedIds.has(to.id) ||
      !takesTransition(to)
    )
      continue;
    const from = ends.get(`${to.track}:${to.start}`);
    const end = `${to.track}:${clipEnd(to)}`;
    if (!from || from.transitionOut || to.transitionIn) {
      if (from) kept++;
      ends.set(end, to);
      continue;
    }
    const room = transitionRoom(fps, from, to, "center");
    const duration = Math.min(requested, room.frames);
    if (duration <= 0) {
      skipped++;
      ends.set(end, to);
      continue;
    }
    if (duration < requested) shortened++;
    const transition = {
      kind: "dissolve",
      duration,
      alignment: "center",
    } as const;
    cuts.push({ from: from.id, to: to.id, transition });
    // The following cut has to fit alongside this one on the shared clip.
    ends.set(end, {
      ...to,
      transitionIn: transition,
      fadeIn: 0,
    });
  }
  return { cuts, kept, skipped, shortened };
}

/**
 * A transition stays on a cut while both of its edges still meet there; a clip moved away or
 * deleted takes it with it. One that no longer fits shortens to the longest that does, earliest
 * cut first, and goes when nothing fits.
 */
function fitTransitions(timeline: Timeline): Timeline {
  if (!timeline.clips.some((clip) => clip.transitionIn || clip.transitionOut))
    return timeline;
  const byId = new Map(timeline.clips.map((clip) => [clip.id, clip]));
  const ends = new Map<string, Clip[]>();
  for (const clip of timeline.clips) {
    if (!clip.transitionOut || !takesTransition(clip)) continue;
    const key = `${clip.track}:${clipEnd(clip)}`;
    const items = ends.get(key) ?? [];
    items.push(clip);
    ends.set(key, items);
  }
  const cuts: [string, string][] = [];
  const outgoingIds = new Set<string>();
  const incomingIds = new Set<string>();
  for (const incoming of timeline.clips) {
    if (!incoming.transitionIn || !takesTransition(incoming)) continue;
    const outgoing = ends
      .get(`${incoming.track}:${incoming.start}`)
      ?.find(
        (clip) =>
          clip.id !== incoming.id &&
          sameTransition(clip.transitionOut, incoming.transitionIn),
      );
    if (!outgoing) continue;
    cuts.push([outgoing.id, incoming.id]);
    outgoingIds.add(outgoing.id);
    incomingIds.add(incoming.id);
  }
  const set = (id: string, edges: Partial<Clip>) =>
    byId.set(id, { ...byId.get(id)!, ...edges });
  for (const clip of timeline.clips) {
    const unpaired = {
      ...(clip.transitionIn &&
        !incomingIds.has(clip.id) && {
          transitionIn: null,
        }),
      ...(clip.transitionOut &&
        !outgoingIds.has(clip.id) && {
          transitionOut: null,
        }),
    };
    if (Object.keys(unpaired).length) set(clip.id, unpaired);
  }
  for (const [outgoingId, incomingId] of cuts.toSorted(
    ([a], [b]) =>
      byId.get(a)!.track - byId.get(b)!.track ||
      byId.get(a)!.start - byId.get(b)!.start,
  )) {
    const outgoing = byId.get(outgoingId)!;
    const incoming = byId.get(incomingId)!;
    const transition = incoming.transitionIn!;
    const { frames } = transitionRoom(
      timeline.fps,
      outgoing,
      incoming,
      transition.alignment,
    );
    const fitted =
      transition.duration <= frames
        ? transition
        : frames > 0
          ? { ...transition, duration: frames }
          : null;
    if (fitted !== transition) {
      set(outgoingId, { transitionOut: fitted });
      set(incomingId, { transitionIn: fitted });
    }
  }
  // A start written as a reference to another clip cannot also begin before the cut.
  for (const clip of byId.values())
    if (clip.startRef && clip.transitionIn && framesBefore(clip.transitionIn))
      set(clip.id, { startRef: null });
  const clips = timeline.clips.map((clip) => byId.get(clip.id)!);
  return clips.every((clip, index) => clip === timeline.clips[index])
    ? timeline
    : { ...timeline, clips };
}

/** The timeline as it reads back once written: source offsets at their canonical microsecond. */
export function canonicalTimeline(timeline: Timeline): Timeline {
  return {
    ...timeline,
    clips: timeline.clips.map((clip) =>
      clip.mediaStart === null
        ? clip
        : { ...clip, ...retimeClipSource(clip, clip.start, timeline.fps) },
    ),
  };
}

/**
 * Cuts each target at `at`; right halves are new clips. Afterwards each linked group is regrouped
 * by time: pieces that overlap stay linked, the earliest such group keeps the link, later ones get
 * a new link, and a piece that overlaps no partner is unlinked.
 */
/**
 * A clip's region after a `setClip.region` edit: a zoom fits any visual clip, while blur and
 * highlight draw over the picture below, which only an adjustment layer has.
 */
function regionFor(
  clip: Clip,
  edit: RegionEdit | null,
  fps: Fps,
): Region | null {
  if (edit === null) return null;
  if (isAudioKind(clip.kind))
    throw new TimelineError("unsupported", "Audio clips have no picture.");
  const effect = edit.effect ?? clip.region?.effect;
  if (!effect)
    throw new TimelineError(
      "unsupported",
      `${clipName(clip)} has no region yet. Name its effect: zoom, blur or highlight.`,
    );
  if (effect !== "zoom" && !clip.adjustment)
    throw new TimelineError(
      "unsupported",
      `A ${effect} draws over the picture below it, so it needs an adjustment layer: insert a clip of kind "adjustment" above ${clipName(clip)}.`,
    );
  const base =
    clip.region && clip.region.effect === effect
      ? clip.region
      : {
          ...defaultRegion(effect, fps),
          ...(clip.region && { box: clip.region.box }),
        };
  return editRegion(base, edit);
}

function splitClips(
  clips: Clip[],
  targets: Clip[],
  at: number,
  fps: Fps,
  { taken, onCreate, name }: Minting,
): Clip[] {
  if (!targets.length) return clips;
  for (const clip of targets)
    if (clip.sourceRestrictions?.copy)
      throw new TimelineError("unsupported", clip.sourceRestrictions.copy);
  const rights = targets.map((clip): Clip => {
    const id = name(clip.id, clip.id);
    onCreate(id, { copyOf: clip.id });
    return {
      ...windowClip(clip, at, clipEnd(clip), fps),
      id,
      startRef: null,
      ...(clip.title && { title: cutTitle(clip.title).right }),
      ...(clip.region && { region: cutRegion(clip.region).right }),
    };
  });
  const ids = new Set(targets.map((clip) => clip.id));
  const cut = [
    ...clips.map((clip) =>
      ids.has(clip.id)
        ? {
            ...windowClip(clip, clip.start, at, fps),
            ...(clip.title && { title: cutTitle(clip.title).left }),
            ...(clip.region && { region: cutRegion(clip.region).left }),
          }
        : clip,
    ),
    ...rights,
  ];
  return regroupLinks(
    cut,
    new Set(targets.flatMap((clip) => clip.link ?? [])),
    taken,
  );
}

/** Keep affected pieces linked only within their surviving overlap groups. */
function regroupLinks(
  clips: Clip[],
  links: ReadonlySet<string>,
  taken: Set<string>,
): Clip[] {
  if (!links.size) return clips;
  const relinked = new Map<string, string | null>();
  for (const link of links) {
    const components = overlapping(clips.filter((clip) => clip.link === link));
    let kept = false;
    for (const component of components) {
      const next =
        component.length < 2 ? null : kept ? uniqueName(taken, "lk", 1) : link;
      if (next === link) kept = true;
      for (const clip of component) relinked.set(clip.id, next);
    }
  }
  return clips.map((clip) =>
    relinked.has(clip.id) && relinked.get(clip.id) !== clip.link
      ? { ...clip, link: relinked.get(clip.id)! }
      : clip,
  );
}

/** Clips grouped by overlapping time, earliest group first. */
function overlapping(clips: Clip[]): Clip[][] {
  const components: Clip[][] = [];
  let end = -Infinity;
  for (const clip of clips.toSorted((a, b) => a.start - b.start)) {
    if (clip.start < end) components.at(-1)!.push(clip);
    else components.push([clip]);
    end = clip.start < end ? Math.max(end, clipEnd(clip)) : clipEnd(clip);
  }
  return components;
}

/** Removes `[from, to)` from one track, cutting clips at the boundaries. Linked partners elsewhere stay whole, as in Resolve. */
function clearRange(
  clips: Clip[],
  track: number,
  from: number,
  to: number,
  fps: Fps,
  mint: Minting,
  fixed: ReadonlySet<string> = new Set(),
): Clip[] {
  const overlaps = (clip: Clip) =>
    !fixed.has(clip.id) && clip.start < to && clipEnd(clip) > from;
  const hits = (list: Clip[]) =>
    list.filter((clip) => clip.track === track && overlaps(clip));
  const targets = hits(clips);
  for (const clip of targets)
    if (
      clip.start >= from &&
      clipEnd(clip) <= to &&
      clip.sourceRestrictions?.remove
    )
      throw new TimelineError("unsupported", clip.sourceRestrictions.remove);
  // Only a clip with surviving material on both sides needs a copy.
  const next = splitClips(
    clips,
    targets.filter((clip) => clip.start < from && clipEnd(clip) > to),
    to,
    fps,
    mint,
  );
  const cut = next.flatMap((clip) => {
    if (clip.track !== track || !overlaps(clip)) return [clip];
    if (clip.start < from) return [windowClip(clip, clip.start, from, fps)];
    if (clipEnd(clip) <= to) return [];
    return [windowClip(clip, to, clipEnd(clip), fps)];
  });
  return regroupLinks(
    cut,
    new Set(targets.flatMap((clip) => clip.link ?? [])),
    mint.taken,
  );
}

function mergeRanges(
  ranges: (readonly [number, number])[],
): [number, number][] {
  const merged: [number, number][] = [];
  for (const [start, end] of ranges.toSorted((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function uniqueName(taken: Set<string>, base: string, first: number): string {
  let n = first;
  let name = `${base}-${n++}`;
  while (taken.has(name)) name = `${base}-${n++}`;
  taken.add(name);
  return name;
}

function slug(src: string, fallback: string): string {
  const name = src.split(/[?#]/, 1)[0]!.split("/").at(-1) ?? "";
  return (
    name
      .replace(/\.[^.]*$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || fallback
  );
}

/** Snapshot a selection with its linked partners; copies must own their source bytes. */
export function copyClips(timeline: Timeline, ids: readonly string[]): Clip[] {
  const named = ids.map((id) => {
    const clip = timeline.clips.find((clip) => clip.id === id);
    if (!clip) throw new TimelineError("not_found", `No clip has id ${id}.`);
    return clip;
  });
  const clips = withPartners(timeline.clips, named);
  for (const clip of clips)
    if (clip.sourceRestrictions?.copy)
      throw new TimelineError(
        "unsupported",
        `${clip.label ?? clip.id} can't be copied. ${clip.sourceRestrictions.copy}`,
      );
  return clips;
}
