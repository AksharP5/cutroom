import { frameTime } from "../../shared/timeline/apply";
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

/** The engine's accepted preview owns source offsets, including ripple head trims. */
export function previewEditFrame(timeline: Timeline, intent: Intent) {
  if (intent.kind !== "trim" && intent.kind !== "roll") return;
  const edges =
    intent.kind === "roll"
      ? [
          { id: intent.left, end: true },
          { id: intent.right, end: false },
        ]
      : [{ id: intent.clipId, end: intent.edge === "end" }];
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
  const frames = clips.flatMap(({ clip, end }) =>
    clip.kind === "video" || clip.kind === "image"
      ? [
          {
            clipId: clip.id,
            time:
              (clip.mediaStart ?? 0) +
              frameTime(end ? clip.duration - 1 : 0, timeline.fps) *
                clip.playbackRate,
          },
        ]
      : [],
  );
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
              `${index ? "In" : "Out"} ${formatTimecode(Math.floor((frame.time * timeline.fps.num) / timeline.fps.den + 1e-6), timeline.fps)}`,
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
