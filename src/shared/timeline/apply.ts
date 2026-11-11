import { isAudioKind } from "./schema";
import type { Clip, Command, Fps, InsertClip, Timeline, Track } from "./schema";
import { TimelineError } from "./errors";
import { windowMix } from "./mix";
import { newTrack, nextTrackIndex } from "./tracks";

export { TimelineError } from "./errors";
export type { TimelineErrorCode } from "./errors";

/**
 * Where a clip created by a batch gets its markup: a copy of a clip from the timeline the batch
 * started with, or new media.
 */
export type ClipOrigin = { copyOf: string } | { insert: InsertClip };
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
  /** Ids in the timeline and ids the project used before; a new clip takes none of them. */
  reserved: Set<string>;
  retired: ReadonlySet<string>;
  onCreate: OnCreate;
  /** Measured source lengths in seconds, by `src`, for inserted media. */
  mediaLengths: ReadonlyMap<string, number>;
  /** Every inserted `src` known to hold no audio stream. */
  silentMedia: ReadonlySet<string>;
  newId: NewId;
}
/**
 * Options for applying commands; `mediaLengths` holds measured source lengths by `src`, and
 * `silentMedia` every `src` known to hold no audio stream.
 */
interface ApplyOptions {
  onCreate?: OnCreate;
  mediaLengths?: ReadonlyMap<string, number>;
  silentMedia?: ReadonlySet<string>;
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
 * Source and timeline seconds are canonical at whole microseconds, as HTML and `cutroom.json` store
 * them. Commands compute source times exactly from frame counts and round only when writing.
 */
export const canonicalSeconds = (value: number) =>
  Math.round(value * 1e6) / 1e6;
const round6 = canonicalSeconds;
/** Exact time of a frame, for seeking. */
export const frameTime = (frames: number, fps: Fps) =>
  (frames * fps.den) / fps.num;
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
    ...timeline.clips.flatMap((clip) =>
      clip.link ? [clip.id, clip.link] : [clip.id],
    ),
  ]);

function applyIn(timeline: Timeline, command: Command, batch: Batch) {
  const next = run(timeline, command, batch);
  return next === timeline ? timeline : settle(timeline, next);
}

/** Applies one command. Commands that cannot apply exactly throw a TimelineError; nothing is clamped. */
export function apply(
  timeline: Timeline,
  command: Command,
  {
    onCreate = () => {},
    mediaLengths = new Map(),
    silentMedia = new Set(),
    newId = randomClipId,
    retired = new Set(),
  }: ApplyOptions = {},
): Timeline {
  return applyIn(timeline, command, {
    reserved: usedNames(timeline, retired),
    retired,
    onCreate,
    mediaLengths,
    silentMedia,
    newId,
  });
}

/** Applies a batch atomically: the first failure throws with its command index. */
export function applyAll(
  timeline: Timeline,
  commands: readonly Command[],
  {
    onCreate = () => {},
    mediaLengths = new Map(),
    silentMedia = new Set(),
    newId = randomClipId,
    retired = new Set(),
  }: ApplyOptions = {},
): Timeline {
  const origins = new Map<string, ClipOrigin>();
  const batch: Batch = {
    reserved: usedNames(timeline, retired),
    retired,
    mediaLengths,
    silentMedia,
    newId,
    onCreate: (id, origin) => {
      // A copy of a clip made earlier in the batch copies that clip's own origin.
      const resolved =
        ("copyOf" in origin && origins.get(origin.copyOf)) || origin;
      origins.set(id, resolved);
      onCreate(id, resolved);
    },
  };
  return commands.reduce((current, command, index) => {
    try {
      return applyIn(current, command, batch);
    } catch (error) {
      if (!(error instanceof TimelineError)) throw error;
      throw new TimelineError(
        error.code,
        `Command ${index + 1} (${command.type}): ${error.message}`,
        index,
      );
    }
  }, timeline);
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
      command.type === "split" ||
        command.type === "insert" ||
        command.type === "trim" ||
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
        for (const clip of lifted)
          assertTrackKind(
            clip.kind,
            trackAt(clip.track + command.trackBy),
            clip.id,
          );
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
      const members = withPartners(clips, [target]);
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
      const edges = new Map(members.map((clip) => [clip.track, edge(clip)]));
      const editPoint = (track: number) => edges.get(track) ?? at;
      const change = command.edge === "start" ? -delta : delta;
      const tracks = rippleTracks(
        timeline,
        members.map((clip) => clip.track),
      );
      const next =
        change < 0
          ? removeTime(
              trimmed,
              tracks,
              (track) =>
                editPoint(track) + (command.edge === "end" ? change : 0),
              -change,
              fps,
              mint,
              ids,
            )
          : insertTime(trimmed, tracks, editPoint, change, fps, mint, ids);
      assertRippleSync(timeline, next, tracks, copies);
      return { ...timeline, clips: next };
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
      return {
        ...timeline,
        clips: splitClips(clips, targets, at, fps, mint),
      };
    }
    case "remove": {
      const removing = withPartners(clips, command.clipIds.map(find));
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
        next = removeTime(next, tracks, () => from, to - from, fps, mint);
      assertRippleSync(timeline, next, tracks, copies);
      return { ...timeline, clips: next };
    }
    case "insert": {
      const { clip: input, track, at, mode } = command;
      if (command.linkedAudio && input.kind !== "video")
        throw new TimelineError(
          "track_kind",
          "Only video can have linked audio.",
        );
      // A file name is quoted so it reads as written, never as a clip id.
      assertTrackKind(input.kind, trackAt(track), input.id ?? `"${input.src}"`);
      const id =
        input.id === undefined
          ? mint.name(slug(input.src, input.kind), null)
          : claim(input.id);
      const end = at + input.duration;
      let next = clips;
      if (mode === "overwrite")
        next = clearRange(next, track, at, end, fps, mint);
      if (mode === "insert") {
        const tracks = rippleTracks(timeline, [track]);
        const spans = (clip: Clip) => clip.start < at && at < clipEnd(clip);
        next = splitClips(
          next,
          withPartners(
            next,
            next.filter((clip) => tracks.has(clip.track) && spans(clip)),
          ).filter(spans),
          at,
          fps,
          mint,
        );
        next = shiftAfter(next, tracks, () => at, input.duration);
      }
      const separate =
        input.kind === "video" &&
        !input.muted &&
        !batch.silentMedia.has(input.src);
      const video = separate ? { ...input, muted: true } : input;
      onCreate(id, { insert: video });
      const added: Clip = {
        id,
        track,
        kind: input.kind,
        start: at,
        duration: input.duration,
        mediaStart: input.kind === "image" ? null : input.mediaStart,
        playbackRate: 1,
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
        label: input.label ?? null,
        volume: input.volume ?? null,
        opacity: null,
        fadeIn: 0,
        fadeOut: 0,
        automation: null,
        enabled: true,
        startRef: null,
      };
      let tracks = timeline.tracks;
      let audio: Clip[] = [];
      if (separate) {
        // Overwrite may have removed a linked video entirely; classify sound from the input.
        const pictureLinks = new Set(
          clips
            .filter((clip) => clip.kind === "video" && clip.link !== null)
            .map((clip) => clip.link),
        );
        const audioId =
          command.linkedAudio?.id === undefined
            ? mint.name(`${slug(input.src, "audio")}-audio`, null)
            : claim(command.linkedAudio.id);
        // Read links before clearing picture: a full overwrite can remove the partner's link.
        const overwrittenLinks = new Set(
          mode === "overwrite"
            ? clips
                .filter(
                  (clip) =>
                    clip.track === track &&
                    clip.kind === "video" &&
                    clip.start < end &&
                    clipEnd(clip) > at,
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
        // Only the overwritten picture's own sound is replaced. Any other destination must be free
        // over the drop, so a fallback never cuts another clip's audio.
        const partner = tracks.find((candidate) =>
          partnerTracks.has(candidate.index),
        );
        let destination =
          partner ??
          tracks.find(
            (candidate) =>
              candidate.kind === "audio" &&
              !candidate.locked &&
              clips.every(
                (clip) =>
                  clip.track !== candidate.index ||
                  (clip.link !== null && pictureLinks.has(clip.link)),
              ) &&
              !next.some(
                (clip) =>
                  clip.track === candidate.index &&
                  clip.start < end &&
                  clipEnd(clip) > at,
              ),
          );
        if (!destination) {
          destination = newTrack(
            Math.max(track + 1, nextTrackIndex(tracks)),
            "audio",
          );
          tracks = [...tracks, destination];
        }
        if (partner) next = clearRange(next, partner.index, at, end, fps, mint);
        onCreate(audioId, { insert: { ...input, kind: "audio", id: audioId } });
        audio = [
          {
            ...added,
            id: audioId,
            kind: "audio",
            track: destination.index,
            hasAudio: true,
          },
        ];
      }
      return {
        ...timeline,
        tracks,
        clips: [...next, added, ...audio],
      };
    }
    case "setTiming": {
      const target = find(command.clipId);
      const targets = withPartners(clips, [target]);
      for (const clip of targets)
        if (clip.mediaStart === null)
          throw new TimelineError(
            "unsupported",
            `Clip ${clip.id} has no source timing.`,
          );
      return {
        ...timeline,
        clips: clips.map((clip) =>
          targets.includes(clip)
            ? {
                ...clip,
                ...(command.playbackRate !== undefined && {
                  playbackRate: command.playbackRate,
                }),
                // Keep each partner's source at the selected clip's start in sync, including L-cuts.
                mediaStart:
                  clip.mediaStart! +
                  (command.mediaStart === undefined
                    ? 0
                    : command.mediaStart - target.mediaStart!) +
                  frameTime(clip.start - target.start, fps) *
                    ((command.playbackRate ?? clip.playbackRate) -
                      clip.playbackRate),
              }
            : clip,
        ),
      };
    }
    case "setClip": {
      const target = find(command.clipId);
      const fadeIn = command.fadeIn ?? target.fadeIn;
      const fadeOut = command.fadeOut ?? target.fadeOut;
      return {
        ...timeline,
        clips: clips.map((clip) =>
          clip === target
            ? {
                ...clip,
                fadeIn,
                fadeOut,
                ...(command.label !== undefined && { label: command.label }),
                ...(command.volume !== undefined && { volume: command.volume }),
                ...(command.automation !== undefined && {
                  automation: command.automation,
                }),
                ...(command.opacity !== undefined && {
                  opacity: command.opacity,
                }),
                ...(command.enabled !== undefined && {
                  enabled: command.enabled,
                }),
              }
            : clip,
        ),
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
          },
        ],
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
    if (old && JSON.stringify(old) === JSON.stringify(clip)) continue;
    if (
      clip.sourceDuration !== null &&
      clip.mediaStart !== null &&
      // The frames the runtime shows before the source runs out.
      clip.duration >
        toFrames(
          (clip.sourceDuration - clip.mediaStart) / clip.playbackRate,
          after.fps,
        )
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

/** Remove an exact interval on each participating track, then close it. */
function removeTime(
  clips: Clip[],
  tracks: ReadonlySet<number>,
  from: (track: number) => number,
  duration: number,
  fps: Fps,
  mint: Minting,
  fixed: ReadonlySet<string> = new Set(),
): Clip[] {
  const fixedClips = clips.filter((clip) => fixed.has(clip.id));
  let next = clips.filter((clip) => !fixed.has(clip.id));
  for (const track of tracks)
    next = clearRange(
      next,
      track,
      from(track),
      from(track) + duration,
      fps,
      mint,
    );
  return [
    ...fixedClips,
    ...next.map((clip) =>
      tracks.has(clip.track) && clip.start >= from(clip.track) + duration
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
  fps: Fps,
  mint: Minting,
  fixed: ReadonlySet<string>,
): Clip[] {
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
      fps,
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
    const sourceAtStart =
      (old.mediaStart ?? 0) +
      frameTime(clip.start - old.start, before.fps) * old.playbackRate;
    if (round6(clip.mediaStart ?? 0) === round6(sourceAtStart)) continue;
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
            partner.start < clipEnd(clip) && clipEnd(partner) > clip.start,
        );
    if (!changed && !outOfSync) continue;
    throw new TimelineError(
      track.locked && !clip.link ? "locked" : "unsupported",
      `Clip ${clip.id} is on ${track.locked ? "a locked" : "an auto-select-off"} track, so the ripple cannot preserve sync.`,
    );
  }
}

function advance(clip: Clip, frames: number, fps: Fps): number | null {
  return clip.mediaStart === null
    ? null
    : clip.mediaStart + ((frames * fps.den) / fps.num) * clip.playbackRate;
}

/** Source geometry is shared; edge trims and internal cuts have different fade semantics. */
function windowClip(
  clip: Clip,
  start: number,
  end: number,
  fps: Fps,
  mode: "trim" | "cut" = "cut",
): Clip {
  const duration = end - start;
  if (duration <= 0) return { ...clip, start, duration };
  return {
    ...clip,
    ...windowMix(clip, start - clip.start, duration, fps, mode),
    start,
    duration,
    mediaStart: advance(clip, start - clip.start, fps),
  };
}

/** The timeline as it reads back once written: source offsets at their canonical microsecond. */
export function canonicalTimeline(timeline: Timeline): Timeline {
  return {
    ...timeline,
    clips: timeline.clips.map((clip) =>
      clip.mediaStart === null
        ? clip
        : { ...clip, mediaStart: round6(clip.mediaStart) + 0 },
    ),
  };
}

/**
 * Cuts each target at `at`; right halves are new clips. Afterwards each linked group is regrouped
 * by time: pieces that overlap stay linked, the earliest such group keeps the link, later ones get
 * a new link, and a piece that overlaps no partner is unlinked.
 */
function splitClips(
  clips: Clip[],
  targets: Clip[],
  at: number,
  fps: Fps,
  { taken, onCreate, name }: Minting,
): Clip[] {
  if (!targets.length) return clips;
  const rights = targets.map((clip): Clip => {
    const id = name(clip.id, clip.id);
    onCreate(id, { copyOf: clip.id });
    return {
      ...windowClip(clip, at, clipEnd(clip), fps),
      id,
      startRef: null,
    };
  });
  const ids = new Set(targets.map((clip) => clip.id));
  const cut = [
    ...clips.map((clip) =>
      ids.has(clip.id) ? windowClip(clip, clip.start, at, fps) : clip,
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
