import type { Clip, Command, Fps, InsertClip, Timeline, Track } from "./schema";

export type TimelineErrorCode =
  | "not_found"
  | "locked"
  | "overlap"
  | "out_of_bounds"
  | "nothing_to_split"
  | "duplicate_id"
  | "track_kind"
  | "unsupported";

export class TimelineError extends Error {
  constructor(
    readonly code: TimelineErrorCode,
    message: string,
    /** Index of the failing command within its batch. */
    readonly command?: number,
  ) {
    super(message);
    this.name = "TimelineError";
  }
}

/**
 * Where a clip created by a batch gets its markup: a copy of a clip from the timeline the batch
 * started with, or new media.
 */
export type ClipOrigin = { copyOf: string } | { insert: InsertClip };
type OnCreate = (id: string, origin: ClipOrigin) => void;
/** Ids are never reused within a batch, so every created clip has one unambiguous origin. */
interface Batch {
  reserved: Set<string>;
  onCreate: OnCreate;
  /** Measured source lengths in seconds, by `src`, for inserted media. */
  mediaLengths: ReadonlyMap<string, number>;
  /** Every inserted `src` known to hold no audio stream. */
  silentMedia: ReadonlySet<string>;
}
/**
 * Options for applying commands; `mediaLengths` holds measured source lengths by `src`, and
 * `silentMedia` every `src` known to hold no audio stream.
 */
interface ApplyOptions {
  onCreate?: OnCreate;
  mediaLengths?: ReadonlyMap<string, number>;
  silentMedia?: ReadonlySet<string>;
}

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
        (audioOnly.get(clip.track) ?? true) && clip.kind === "audio",
      );
  for (const [index, audio] of audioOnly)
    tracks.set(index, {
      index,
      kind: audio ? "audio" : "video",
      name: null,
      locked: false,
      autoSelect: true,
    });
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

const usedNames = (timeline: Timeline) =>
  new Set(
    timeline.clips.flatMap((clip) =>
      clip.link ? [clip.id, clip.link] : [clip.id],
    ),
  );

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
  }: ApplyOptions = {},
): Timeline {
  return applyIn(timeline, command, {
    reserved: usedNames(timeline),
    onCreate,
    mediaLengths,
    silentMedia,
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
  }: ApplyOptions = {},
): Timeline {
  const origins = new Map<string, ClipOrigin>();
  const batch: Batch = {
    reserved: usedNames(timeline),
    mediaLengths,
    silentMedia,
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
  if (!track || (track.kind === "audio") === (kind === "audio")) return;
  throw new TimelineError(
    "track_kind",
    `Clip ${name} is ${kind === "audio" ? "audio" : "picture"} and track ${track.index} is a ${track.kind} track.`,
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
  const rippleBatch = { ...batch, onCreate };
  const trackAt = (index: number) =>
    timeline.tracks.find((track) => track.index === index);
  const byId = new Map(clips.map((clip) => [clip.id, clip]));
  const find = (id: string) => {
    const clip = byId.get(id);
    if (!clip) throw new TimelineError("not_found", `No clip has id ${id}.`);
    return clip;
  };
  switch (command.type) {
    case "move": {
      const named = new Set(command.clipIds.map(find));
      const moving = new Set(withPartners(clips, [...named]));
      if (command.trackBy !== 0)
        for (const clip of named)
          assertTrackKind(
            clip.kind,
            trackAt(clip.track + command.trackBy),
            clip.id,
          );
      return {
        ...timeline,
        clips: clips.map((clip) =>
          moving.has(clip)
            ? {
                ...clip,
                start: clip.start + command.by,
                track: clip.track + (named.has(clip) ? command.trackBy : 0),
              }
            : clip,
        ),
      };
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
          return { ...clip, duration: clip.duration + delta };
        return {
          ...clip,
          start: command.ripple ? clip.start : clip.start + delta,
          duration: clip.duration - delta,
          mediaStart: advance(clip, delta, fps),
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
              rippleBatch,
              ids,
            )
          : insertTime(
              trimmed,
              tracks,
              editPoint,
              change,
              fps,
              rippleBatch,
              ids,
            );
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
        clips: splitClips(clips, targets, at, fps, taken, onCreate),
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
        next = removeTime(
          next,
          tracks,
          () => from,
          to - from,
          fps,
          rippleBatch,
        );
      assertRippleSync(timeline, next, tracks, copies);
      return { ...timeline, clips: next };
    }
    case "insert": {
      const { clip: input, track, at, mode } = command;
      assertTrackKind(input.kind, trackAt(track), input.id ?? input.src);
      if (input.id !== undefined && taken.has(input.id))
        throw new TimelineError(
          "duplicate_id",
          `A clip already has id ${input.id}.`,
        );
      const id =
        input.id ?? uniqueName(taken, slug(input.src, input.kind), 2, true);
      taken.add(id);
      const end = at + input.duration;
      let next = clips;
      if (mode === "overwrite")
        next = clearRange(next, track, at, end, fps, taken, onCreate);
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
          taken,
          onCreate,
        );
        next = shiftAfter(next, tracks, () => at, input.duration);
      }
      onCreate(id, { insert: input });
      return {
        ...timeline,
        clips: [
          ...next,
          {
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
              input.kind === "audio" ||
              (input.kind === "video" &&
                !input.muted &&
                !batch.silentMedia.has(input.src)),
            link: null,
            label: input.label ?? null,
            volume: input.volume ?? null,
            startRef: null,
          },
        ],
      };
    }
    case "setClip": {
      const target = find(command.clipId);
      return {
        ...timeline,
        clips: clips.map((clip) =>
          clip === target
            ? {
                ...clip,
                ...(command.label !== undefined && { label: command.label }),
                ...(command.volume !== undefined && { volume: command.volume }),
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
      const current = timeline.tracks.find(
        (track) => track.index === command.index,
      ) ?? {
        index: command.index,
        kind: command.kind ?? "video",
        name: null,
        locked: false,
        autoSelect: true,
      };
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
      return {
        ...timeline,
        markers: [
          ...timeline.markers.filter((marker) => marker.id !== id),
          {
            id,
            frame: command.frame,
            duration: command.duration,
            name: command.name,
            note: command.note,
            color: command.color,
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
        `Clip ${clip.id} is on a locked track.`,
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
      throw new TimelineError(
        "locked",
        `Clip ${clip.id} is on a locked track.`,
      );
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
  batch: Batch,
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
      batch.reserved,
      batch.onCreate,
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
  batch: Batch,
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
      batch.reserved,
      batch.onCreate,
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
  taken: Set<string>,
  onCreate: OnCreate,
): Clip[] {
  if (!targets.length) return clips;
  const rights = targets.map((clip): Clip => {
    const id = uniqueName(taken, clip.id.replace(/-\d+$/, ""), 2);
    onCreate(id, { copyOf: clip.id });
    return {
      ...clip,
      id,
      start: at,
      duration: clipEnd(clip) - at,
      mediaStart: advance(clip, at - clip.start, fps),
      startRef: null,
    };
  });
  const ids = new Set(targets.map((clip) => clip.id));
  const cut = [
    ...clips.map((clip) =>
      ids.has(clip.id) ? { ...clip, duration: at - clip.start } : clip,
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
  taken: Set<string>,
  onCreate: OnCreate,
): Clip[] {
  const overlaps = (clip: Clip) => clip.start < to && clipEnd(clip) > from;
  const hits = (list: Clip[]) =>
    list.filter((clip) => clip.track === track && overlaps(clip));
  const targets = hits(clips);
  // Only a clip with surviving material on both sides needs a copy.
  const next = splitClips(
    clips,
    targets.filter((clip) => clip.start < from && clipEnd(clip) > to),
    to,
    fps,
    taken,
    onCreate,
  );
  const cut = next.flatMap((clip) => {
    if (clip.track !== track || !overlaps(clip)) return [clip];
    if (clip.start < from) return [{ ...clip, duration: from - clip.start }];
    if (clipEnd(clip) <= to) return [];
    return [
      {
        ...clip,
        start: to,
        duration: clipEnd(clip) - to,
        mediaStart: advance(clip, to - clip.start, fps),
      },
    ];
  });
  return regroupLinks(
    cut,
    new Set(targets.flatMap((clip) => clip.link ?? [])),
    taken,
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

function uniqueName(
  taken: Set<string>,
  base: string,
  first: number,
  bare = false,
): string {
  let n = first;
  let name = bare ? base : `${base}-${n++}`;
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
