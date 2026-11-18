import { clipEnd, toFrames } from "../../shared/timeline/apply";
import { defaultRegion } from "../../shared/timeline/region";
import type {
  Region,
  RegionBox,
  RegionEffect,
} from "../../shared/timeline/region";
import { isAudioKind } from "../../shared/timeline/schema";
import type {
  Clip,
  CommandInput,
  Timeline,
  Track,
} from "../../shared/timeline/schema";
import { nextTrackIndex, shownTracks } from "../../shared/timeline/tracks";

/** A new layer's length without In and Out marks around the playhead. */
const LAYER_SECONDS = 3;

/** A box of the frame's shape at `scale`, centred on a point and kept inside the frame. */
export function zoomBoxAt(x: number, y: number, side: number): RegionBox {
  const clamp = (value: number) => Math.min(1 - side, Math.max(0, value));
  return {
    x: clamp(x - side / 2),
    y: clamp(y - side / 2),
    width: side,
    height: side,
  };
}

const pictures = (timeline: Timeline, frame: number) =>
  timeline.clips.filter(
    (clip) =>
      !isAudioKind(clip.kind) &&
      clip.enabled &&
      !clip.adjustment &&
      clip.start <= frame &&
      frame < clipEnd(clip),
  );

/**
 * The clip a zoom on a clip goes on: the selected picture, or the top one under the playhead.
 * Adjustment layers are never it; their zoom is the layer's own.
 */
export function zoomTarget(
  timeline: Timeline,
  selected: string | null,
  frame: number,
): Clip | null {
  const chosen = timeline.clips.find((clip) => clip.id === selected);
  if (chosen && !isAudioKind(chosen.kind) && !chosen.adjustment) return chosen;
  return (
    pictures(timeline, frame).toSorted((a, b) => b.track - a.track)[0] ?? null
  );
}

/**
 * A new adjustment layer over In to Out, or three seconds from the playhead: on the first unlocked,
 * enabled video track above the video destination that is free there, or on a new track at the
 * top. It never lands on a clip, so adding one cuts nothing.
 */
export function addLayerCommands(
  timeline: Timeline,
  destination: Track,
  frame: number,
  effect: RegionEffect,
  box: RegionBox,
): CommandInput[] {
  const { range } = timeline;
  const marked =
    range.in !== null && range.out !== null && range.out > range.in;
  const at = marked ? range.in! : frame;
  const duration = marked
    ? range.out! - range.in!
    : toFrames(LAYER_SECONDS, timeline.fps);
  const video = shownTracks(timeline.tracks).filter(
    (track) => track.kind === "video",
  );
  const free = video
    .slice(video.findIndex((track) => track.index === destination.index) + 1)
    .find(
      (track) =>
        !track.locked &&
        track.enabled &&
        !timeline.clips.some(
          (clip) =>
            clip.track === track.index &&
            clip.start < at + duration &&
            clipEnd(clip) > at,
        ),
    );
  const kept = timeline.tracks.some(({ index }) => index === destination.index)
    ? timeline.tracks
    : [...timeline.tracks, destination];
  const track = free?.index ?? nextTrackIndex(kept);
  const newTracks: CommandInput[] = free
    ? []
    : [...kept.slice(timeline.tracks.length), { index: track }].map(
        ({ index }) => ({ type: "setTrack", index, kind: "video" }),
      );
  return [
    ...newTracks,
    {
      type: "insert",
      track,
      at,
      clip: { kind: "adjustment", duration, region: { effect, box } },
    },
  ];
}

/** The effect's settings with a new box, as a new region on a clip without one would have them. */
export const regionWith = (
  region: Region | null,
  effect: RegionEffect,
  box: RegionBox,
  fps: Timeline["fps"],
): Region => ({ ...(region ?? defaultRegion(effect, fps)), box });
