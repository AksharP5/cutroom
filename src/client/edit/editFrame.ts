import { sourceTimeAt } from "@hyperframes/core/speed-ramp";
import { clipRate } from "../../shared/timeline/time";
import { clipEnd, frameTime } from "../../shared/timeline/apply";
import { formatTimecode } from "../../shared/timeline/timecode";
import type { Timeline } from "../../shared/timeline/schema";
import type { Intent } from "../timeline/gesture";
import type { EditFrame } from "../../shared/preview";
import { transport, useTransport } from "./transport";

export type EditPicture = {
  time: number;
  frames: EditFrame[];
  labels: string[];
};
let picture: EditPicture | null = null;
const targets = new Set<(picture: EditPicture | null) => void>();

export const editPicture = () => picture;
export function followEditPicture(
  target: (picture: EditPicture | null) => void,
) {
  targets.add(target);
  return () => {
    targets.delete(target);
  };
}

/**
 * The source frames an edit changes, as Resolve's trim view shows them: a trimmed edge, both
 * sides of a rolled cut, a slipped clip's new in and out, or the out and in of the neighbours a
 * slide trims. A side of a slide without a neighbour shows the clip's own edge there.
 */
function editEdges(timeline: Timeline, intent: Intent) {
  switch (intent.kind) {
    case "trim":
      return [{ id: intent.clipId, end: intent.edge === "end" }];
    case "roll":
      return [
        { id: intent.left, end: true },
        { id: intent.right, end: false },
      ];
    case "slip":
      return [
        { id: intent.clipId, end: false },
        { id: intent.clipId, end: true },
      ];
    case "slide": {
      const clip = timeline.clips.find((item) => item.id === intent.clipId);
      if (!clip) return [];
      const end = clipEnd(clip);
      const left = timeline.clips.find(
        (other) => other.track === clip.track && clipEnd(other) === clip.start,
      );
      const right = timeline.clips.find(
        (other) => other.track === clip.track && other.start === end,
      );
      return [
        { id: (left ?? clip).id, end: left !== undefined },
        { id: (right ?? clip).id, end: right === undefined },
      ];
    }
    default:
      return [];
  }
}

/** The engine's accepted preview owns source offsets, including ripple head trims. */
export function previewEditFrame(timeline: Timeline, intent: Intent) {
  const edges = editEdges(timeline, intent);
  if (!edges.length) return;
  const clips = edges.flatMap((edge) => {
    const edited = timeline.clips.find((clip) => clip.id === edge.id);
    const clip =
      edited?.kind === "audio" || edited?.kind === "voiceover"
        ? timeline.clips.find(
            (clip) =>
              edited.link !== null &&
              clip.link === edited.link &&
              clip.kind === "video",
          )
        : edited;
    return clip &&
      clip.enabled &&
      clip.kind !== "audio" &&
      clip.kind !== "voiceover"
      ? [{ clip, end: edge.end }]
      : [];
  });
  if (!clips.length) return;
  if (!picture && useTransport.getState().state.kind !== "stopped")
    transport.dispatch({ type: "stop" });
  const shown = clips.filter(
    ({ clip }) => clip.kind === "video" || clip.kind === "image",
  );
  const frames = shown.map(({ clip, end }) => ({
    clipId: clip.id,
    time:
      (clip.mediaStart ?? 0) +
      sourceTimeAt(
        clipRate(clip),
        frameTime(end ? clip.duration - 1 : 0, timeline.fps),
      ),
  }));
  const edge = clips.at(-1)!;
  picture = {
    time: frameTime(
      edge.clip.start + (edge.end ? edge.clip.duration - 1 : 0),
      timeline.fps,
    ),
    frames,
    labels:
      frames.length === 2
        ? frames.map(
            (frame, index) =>
              `${shown[index]!.end ? "Out" : "In"} ${formatTimecode(Math.floor((frame.time * timeline.fps.num) / timeline.fps.den + 1e-6), timeline.fps)}`,
          )
        : [],
  };
  for (const target of targets) target(picture);
}

export function clearEditFrame() {
  if (!picture) return;
  picture = null;
  for (const target of targets) target(null);
}
