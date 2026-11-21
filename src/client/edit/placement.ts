import { clipEnd } from "../../shared/timeline/apply";
import type { Timeline, Track } from "../../shared/timeline/schema";
import {
  newTrack,
  nextTrackIndex,
  shownTracks,
} from "../../shared/timeline/tracks";

/** Find an enabled track above the destination with the entire new range free. */
export function higherPlacementTrack(
  timeline: Timeline,
  destination: Track,
  at: number,
  duration: number,
) {
  const tracks = shownTracks(timeline.tracks);
  const free = tracks.find(
    (track) =>
      track.kind === destination.kind &&
      track.index > destination.index &&
      track.enabled &&
      !track.locked &&
      !timeline.clips.some(
        (clip) =>
          clip.track === track.index &&
          clip.start < at + duration &&
          clipEnd(clip) > at,
      ),
  );
  if (free) return { track: free, create: [] };
  const existing = timeline.tracks.some(
    ({ index }) => index === destination.index,
  )
    ? []
    : [destination];
  const track = newTrack(
    nextTrackIndex([...timeline.tracks, destination]),
    destination.kind,
  );
  return { track, create: [...existing, track] };
}
