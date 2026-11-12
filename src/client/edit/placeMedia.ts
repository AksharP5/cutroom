import { isAudioKind } from "../../shared/timeline/schema";
import { newTrack, nextTrackIndex } from "../../shared/timeline/tracks";
import { dropPreview, placedMedia } from "../timeline/gesture";
import type { MediaDrag } from "../timeline/mediaDrag";
import { editTimeline } from "./timeline";
import { transport, useTransport } from "./transport";

/**
 * Places media at the playhead with the edit a drop makes, on the first unlocked track of its
 * kind, which is V1 or A1 unless that is locked. With none unlocked it gets a new track. The
 * playhead then moves to the end of the new clip, so the next placement follows it.
 */
export function placeAtPlayhead(
  projectId: string,
  media: MediaDrag,
  mode: "insert" | "overwrite",
  /** Runs with the accepted preview, before the server replies. */
  onPlace?: () => void,
) {
  const { frame, duration } = useTransport.getState();
  // The playhead stops on the last frame, so from there the clip goes after it, at the end.
  const at = duration > 0 && frame === duration - 1 ? duration : frame;
  let end = at;
  return editTimeline(
    projectId,
    "Add media",
    (timeline) => {
      const audio = isAudioKind(media.kind);
      const track =
        timeline.tracks.find(
          (track) => (track.kind === "audio") === audio && !track.locked,
        ) ??
        newTrack(nextTrackIndex(timeline.tracks), audio ? "audio" : "video");
      const placed = placedMedia(media, timeline.fps);
      end = at + placed.frames;
      return dropPreview(timeline, placed, track, at, at, 0, [], mode).commands;
    },
    undefined,
    () => {
      transport.seek(end);
      onPlace?.();
    },
  );
}
