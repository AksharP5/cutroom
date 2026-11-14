import { clipEnd, toFrames } from "../../shared/timeline/apply";
import type {
  CommandInput,
  Timeline,
  Track,
} from "../../shared/timeline/schema";
import { nextTrackIndex, shownTracks } from "../../shared/timeline/tracks";

const TITLE_SECONDS = 5;
/** The placeholder a new title opens with, selected so typing replaces it. */
const TITLE_WORDS = "Title";

/**
 * A new title at `at`, drawn over the picture: on the first unlocked, enabled video track above the
 * video destination with those five seconds free, or on a new track at the top when there is none.
 * It never lands on a clip, so adding a title cuts nothing. It has no entrance, so the words being
 * typed are visible at the playhead; the exit keeps its default.
 */
export function addTitleCommands(
  timeline: Timeline,
  destination: Track,
  at: number,
): CommandInput[] {
  const duration = toFrames(TITLE_SECONDS, timeline.fps);
  const tracks = shownTracks(timeline.tracks);
  const video = tracks.filter((track) => track.kind === "video");
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
  // An empty timeline only shows its V1: the title's track must not become that V1 itself.
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
      clip: {
        kind: "title",
        text: TITLE_WORDS,
        duration,
        title: { in: { preset: "none" } },
      },
    },
  ];
}
