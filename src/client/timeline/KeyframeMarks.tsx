import { useRef } from "react";
import type { PointerEvent } from "react";
import type {
  Clip,
  CommandInput,
  KeyframeEase,
  KeyframeProperty,
  Timeline,
} from "../../shared/timeline/schema";
import { KEYFRAME_PROPERTIES } from "../../shared/timeline/schema";
import { openContextMenu } from "../components/ContextMenu";
import { tracksOf } from "../../shared/timeline/keyframes";
import { formatTimecode } from "../../shared/timeline/timecode";

const EASES = [
  ["linear", "Linear"],
  ["ease-in", "Ease in"],
  ["ease-out", "Ease out"],
  ["ease-in-out", "Ease in and out"],
  ["hold", "Hold"],
] as const satisfies readonly (readonly [KeyframeEase, string])[];

/** Pixels a press travels before it drags a keyframe instead of seeking to it. */
const DRAG_PX = 3;

/** Each frame with keyframes inside the clip, with the properties keyed there. */
export function keyframeStops(clip: Clip) {
  const stops = new Map<number, KeyframeProperty[]>();
  const tracks = tracksOf(clip);
  for (const property of KEYFRAME_PROPERTIES)
    for (const { frame } of tracks[property] ?? [])
      if (frame >= 0 && frame < clip.duration)
        stops.set(frame, [...(stops.get(frame) ?? []), property]);
  return [...stops].sort(([a], [b]) => a - b);
}

/**
 * A clip's keyframes as diamonds along the foot of its body, one per frame whatever it keys. A press
 * seeks to it; a drag retimes every keyframe on that frame, within the clip and short of the
 * frames already keyed for those properties, as one undo step on release. Esc puts it back. A
 * right-click sets their ease or deletes them. A held keyframe is drawn square.
 */
export function KeyframeMarks({
  timeline,
  clip,
  selected,
  frameAt,
  onSeek,
  onEdit,
  onGesture,
}: {
  timeline: Timeline;
  clip: Clip;
  selected: boolean;
  frameAt(clientX: number): number;
  onSeek(frame: number): void;
  onEdit(label: string, commands: CommandInput[]): void;
  onGesture(active: boolean): void;
}) {
  const drag = useRef<{
    frame: number;
    properties: KeyframeProperty[];
    x: number;
    offset: number;
    to: number;
    moved: boolean;
    element: HTMLElement;
    cancel(): void;
  } | null>(null);
  const stops = keyframeStops(clip);
  if (!stops.length) return null;
  const tracks = tracksOf(clip);
  /** The nearest frame the dragged keyframes can take, inside the clip and off other keyframes. */
  const allowed = (
    properties: KeyframeProperty[],
    from: number,
    to: number,
  ) => {
    const taken = new Set(
      properties.flatMap(
        (property) =>
          tracks[property]
            ?.map((keyframe) => keyframe.frame)
            .filter((frame) => frame !== from) ?? [],
      ),
    );
    const step = to > from ? -1 : 1;
    let frame = Math.max(0, Math.min(clip.duration - 1, to));
    while (taken.has(frame) && frame !== from) frame += step;
    return frame;
  };
  const end = (commit: boolean) => {
    const held = drag.current;
    if (!held) return;
    drag.current = null;
    held.cancel();
    held.element.style.setProperty("--f", String(clip.start + held.frame));
    if (held.moved) onGesture(false);
    if (!held.moved) {
      if (commit) onSeek(clip.start + held.frame);
      return;
    }
    if (!commit || held.to === held.frame) return;
    onEdit(
      "Move keyframe",
      held.properties.map((property) => ({
        type: "moveKeyframe",
        clipId: clip.id,
        property,
        frame: held.frame,
        to: held.to,
      })),
    );
  };
  const easeAt = (frame: number, properties: KeyframeProperty[]) => {
    const eases = new Set(
      properties.map(
        (property) =>
          tracks[property]?.find((keyframe) => keyframe.frame === frame)?.ease,
      ),
    );
    return eases.size === 1 ? [...eases][0] : undefined;
  };
  return (
    <>
      {stops.map(([frame, properties]) => (
        <i
          key={frame}
          className={`tl-keyframe${selected ? " selected" : ""}`}
          data-keyframe={`${clip.id}:${frame}`}
          data-ease={easeAt(frame, properties)}
          onContextMenu={(event) => {
            event.stopPropagation();
            const ease = easeAt(frame, properties);
            const commands = (
              type: "setKeyframe" | "removeKeyframe",
              next?: KeyframeEase,
            ): CommandInput[] =>
              properties.map((property) =>
                type === "setKeyframe"
                  ? { type, clipId: clip.id, property, frame, ease: next }
                  : { type, clipId: clip.id, property, frame },
              );
            openContextMenu(
              event,
              "Keyframe",
              [
                ...EASES.map(([value, label]) => ({
                  label,
                  checked: ease === value,
                  radio: true,
                  run: () =>
                    onEdit(
                      `Set keyframe to ${label.toLowerCase()}`,
                      commands("setKeyframe", value),
                    ),
                })),
                "separator" as const,
                {
                  label: "Delete keyframe",
                  run: () =>
                    onEdit("Delete keyframe", commands("removeKeyframe")),
                },
              ],
              event.currentTarget,
            );
          }}
          data-unscaled
          title={`${properties.join(", ")} at ${formatTimecode(clip.start + frame, timeline.fps)}`}
          style={{ "--f": clip.start + frame }}
          onPointerDown={(event: PointerEvent<HTMLElement>) => {
            if (event.button !== 0) return;
            // The lanes would start a marquee or move the clip underneath.
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            const key = (keyEvent: KeyboardEvent) => {
              if (keyEvent.key !== "Escape") return;
              keyEvent.preventDefault();
              keyEvent.stopPropagation();
              end(false);
            };
            document.addEventListener("keydown", key, true);
            drag.current = {
              frame,
              properties,
              x: event.clientX,
              offset: frameAt(event.clientX) - (clip.start + frame),
              to: frame,
              moved: false,
              element: event.currentTarget,
              cancel: () => document.removeEventListener("keydown", key, true),
            };
          }}
          onPointerMove={(event) => {
            const held = drag.current;
            if (!held) return;
            if (!held.moved && Math.abs(event.clientX - held.x) < DRAG_PX)
              return;
            if (!held.moved) onGesture(true);
            held.moved = true;
            held.to = allowed(
              held.properties,
              held.frame,
              frameAt(event.clientX) - held.offset - clip.start,
            );
            held.element.style.setProperty("--f", String(clip.start + held.to));
          }}
          onPointerUp={() => end(true)}
          onPointerCancel={() => end(false)}
          onLostPointerCapture={() => end(false)}
        />
      ))}
    </>
  );
}
