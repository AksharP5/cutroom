import { toFrames } from "../../shared/timeline/apply";
import type {
  CommandInput,
  Timeline,
  Track,
} from "../../shared/timeline/schema";
import { higherPlacementTrack } from "./placeMedia";

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
  const { track, create } = higherPlacementTrack(
    timeline,
    destination,
    at,
    duration,
  );
  return [
    ...create.map(({ index, kind }): CommandInput => ({
      type: "setTrack",
      index,
      kind,
    })),
    {
      type: "insert",
      track: track.index,
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
