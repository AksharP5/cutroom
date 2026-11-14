import { isAudioKind } from "../../shared/timeline/schema";
import type { CommandInput } from "../../shared/timeline/schema";
import { destinationTracks } from "../../shared/timeline/tracks";
import { dropPreview, placedMedia } from "../timeline/gesture";
import type { MediaDrag } from "../timeline/mediaDrag";
import { useViewSettings } from "../timeline/viewSettings";
import { editTimeline } from "./timeline";
import { transport, useTransport } from "./transport";
import { showToast } from "../workspace";

/**
 * Places media at the playhead on the destination tracks the headers show: picture on the video
 * destination, sound on the audio one, a video's own sound included. A locked destination
 * refuses the edit. The playhead then moves to the end of the new clip, so the next placement
 * follows it.
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
      const { video, audio, videoEnabled, audioEnabled } = destinationTracks(
        timeline.tracks,
        useViewSettings.getState().destinations,
      );
      const placed = placedMedia(media, timeline.fps);
      end = at + placed.frames;
      const picture = !isAudioKind(media.kind) && videoEnabled;
      const sound =
        audioEnabled &&
        (isAudioKind(media.kind) ||
          (placed.kind === "video" && placed.hasAudio === true));
      if (!picture && !sound) {
        showToast("Enable a destination to place this source", null, {
          tone: "info",
          transient: true,
        });
        return [];
      }
      if (!picture)
        return dropPreview(
          timeline,
          { ...placed, kind: "audio" },
          audio,
          at,
          at,
          0,
          [],
          mode,
        ).commands;
      const missing =
        sound && !timeline.tracks.some((track) => track.index === audio.index);
      return dropPreview(
        timeline,
        { ...placed, hasAudio: sound },
        video,
        at,
        at,
        0,
        missing ? [audio] : [],
        mode,
      ).commands.map((command): CommandInput =>
        sound && command.type === "insert"
          ? { ...command, linkedAudio: { track: audio.index } }
          : command,
      );
    },
    undefined,
    () => {
      transport.seek(end);
      onPlace?.();
    },
  );
}
