import {
  add,
  attrMicros,
  frames,
  micros,
  secondsOf,
  subtract,
} from "../../shared/timeline/piece";
import type { ExactTime } from "../../shared/timeline/piece";
import { clipEnd } from "../../shared/timeline/apply";
import { TimelineError } from "../../shared/timeline/errors";
import { isAudioKind } from "../../shared/timeline/schema";
import type { CommandInput, Track } from "../../shared/timeline/schema";
import { destinationTracks } from "../../shared/timeline/tracks";
import { dropPreview, placedMedia } from "../timeline/gesture";
import type { MediaDrag } from "../timeline/mediaDrag";
import { useViewSettings } from "../timeline/viewSettings";
import { higherPlacementTrack } from "./placement";
import { editTimeline, useTimeline } from "./timeline";
import { transport, useTransport } from "./transport";
import { showToast } from "../workspace";

export type SourcePlacement = "insert" | "overwrite" | "replace" | "top";

/**
 * Places media at the playhead on the destination tracks the headers show: picture on the video
 * destination, sound on the audio one, a video's own sound included. A locked destination
 * refuses the edit. The playhead then moves to the end of the new clip, so the next placement
 * follows it.
 */
export function placeAtPlayhead(
  projectId: string,
  media: MediaDrag,
  mode: SourcePlacement,
  /** Runs with the accepted preview, before the server replies. */
  onPlace?: () => void,
  sourceTime?: ExactTime,
) {
  const { frame, duration } = useTransport.getState();
  // The playhead stops on the last frame, so from there the clip goes after it, at the end.
  const at = duration > 0 && frame === duration - 1 ? duration : frame;
  let end = at;
  let saved = () => {};
  return editTimeline(
    projectId,
    mode === "replace"
      ? "Replace from source"
      : mode === "top"
        ? "Place source on top"
        : "Add media",
    (timeline) => {
      const { video, audio, videoEnabled, audioEnabled } = destinationTracks(
        timeline.tracks,
        useViewSettings.getState().destinations,
      );
      const placed = placedMedia(
        media,
        timeline.fps,
        useTimeline.getState().composition,
      );
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
      const destination = picture ? video : audio;
      if (mode === "replace") {
        const target = timeline.clips.find(
          (clip) =>
            clip.track === destination.index &&
            clip.start <= frame &&
            frame < clipEnd(clip),
        );
        if (!target)
          throw new TimelineError(
            "not_found",
            "Move the playhead over a clip on the destination track.",
          );
        const partners = target.link
          ? timeline.clips.filter(
              (clip) => clip.id !== target.id && clip.link === target.link,
            )
          : [];
        const partner = partners[0];
        if (
          (picture && sound && partners.length > 1) ||
          (picture &&
            sound &&
            partner &&
            (!isAudioKind(partner.kind) ||
              partner.start !== target.start ||
              partner.duration !== target.duration))
        )
          throw new TimelineError(
            "unsupported",
            "Replace needs the picture and its linked sound to have matching edges.",
          );
        const start =
          placed.kind === "image" || !sourceTime
            ? frames(0, timeline.fps)
            : subtract(sourceTime, frames(frame - target.start, timeline.fps));
        const endInSource = add(start, frames(target.duration, timeline.fps));
        if (
          placed.kind !== "image" &&
          (start.n < 0n ||
            subtract(endInSource, micros(attrMicros(media.seconds))).n > 0n)
        )
          throw new TimelineError(
            "out_of_bounds",
            "The source playhead needs enough media on both sides to fill this clip.",
          );
        if (placed.kind === "composition" && start.n !== 0n)
          throw new TimelineError(
            "unsupported",
            "Replace a composition from its first frame.",
          );
        end = frame;
        const replacement = dropPreview(
          timeline,
          {
            ...placed,
            kind: picture ? placed.kind : "audio",
            frames: target.duration,
            mediaStart: (media.start ?? 0) + secondsOf(start),
            hasAudio: sound,
          },
          destination,
          target.start,
          target.start,
          0,
        );
        return replacement.commands.map((command): CommandInput =>
          picture && sound && partner && command.type === "insert"
            ? { ...command, linkedAudio: { track: partner.track } }
            : command,
        );
      }
      if (mode === "top") {
        const { track, create } = higherPlacementTrack(
          timeline,
          destination,
          at,
          placed.frames,
        );
        return dropPreview(
          timeline,
          {
            ...placed,
            kind: picture ? placed.kind : "audio",
            hasAudio: sound,
          },
          track,
          at,
          at,
          0,
          create,
        ).commands;
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
      saved = transport.follow(end);
      onPlace?.();
    },
  ).finally(() => saved());
}
