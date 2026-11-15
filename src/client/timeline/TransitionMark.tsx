import { useRef } from "react";
import type { PointerEvent } from "react";
import { clipEnd, cutRoom } from "../../shared/timeline/apply";
import type {
  Clip,
  CommandInput,
  Timeline,
  Transition,
} from "../../shared/timeline/schema";
import { formatTimecode } from "../../shared/timeline/timecode";
import {
  TRANSITION_NAMES,
  framesBefore,
} from "../../shared/timeline/transition";

/** How close to either end of a transition a press takes its length instead of selecting it. */
const EDGE_PX = 6;

/** The length a dragged end gives, from how far that end now sits from the cut. */
export function draggedLength(
  transition: Transition,
  edge: "start" | "end",
  reach: number,
) {
  if (transition.alignment === "center") return 2 * reach;
  return (transition.alignment === "start") === (edge === "end") ? reach : 0;
}

/**
 * A transition drawn over the cut it sits on, from where the outgoing clip's media starts playing
 * under the incoming one to where it stops. A press selects it; a press on either end drags its
 * length about its alignment, up to the longest that fits, as one undo step on release.
 */
export function TransitionMark({
  timeline,
  clip,
  transition,
  selected,
  frameAt,
  onSelect,
  onEdit,
  onGesture,
}: {
  timeline: Timeline;
  /** The incoming clip, which carries the transition in. */
  clip: Clip;
  transition: Transition;
  selected: boolean;
  frameAt(clientX: number): number;
  onSelect(): void;
  onEdit(command: CommandInput): void;
  onGesture(active: boolean): void;
}) {
  const start = clip.start - framesBefore(transition);
  const from = timeline.clips.find(
    (item) =>
      item.track === clip.track &&
      clipEnd(item) === clip.start &&
      item.transitionOut,
  );
  const mark = useRef<HTMLElement>(null);
  const drag = useRef<{
    edge: "start" | "end";
    duration: number;
    room: number;
    cancel(): void;
  } | null>(null);
  const draw = (duration: number) => {
    const element = mark.current;
    if (!element) return;
    const before = framesBefore({ ...transition, duration });
    element.style.setProperty("--s", String(clip.start - before));
    element.style.setProperty("--d", String(duration));
  };
  const end = (commit: boolean) => {
    const held = drag.current;
    if (!held) return;
    drag.current = null;
    held.cancel();
    onGesture(false);
    if (commit && from && held.duration !== transition.duration)
      onEdit({
        type: "setTransition",
        from: from.id,
        to: clip.id,
        transition: { ...transition, duration: held.duration },
      });
    else draw(transition.duration);
  };

  function onPointerDown(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    // The lanes would start a marquee or select the clip underneath.
    event.stopPropagation();
    onSelect();
    const box = event.currentTarget.getBoundingClientRect();
    const edge =
      event.clientX - box.left <= EDGE_PX
        ? "start"
        : box.right - event.clientX <= EDGE_PX
          ? "end"
          : null;
    if (!edge || !from) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const key = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      end(false);
    };
    document.addEventListener("keydown", key, true);
    drag.current = {
      edge,
      duration: transition.duration,
      room: cutRoom(timeline, from, clip, transition.alignment).frames,
      cancel: () => document.removeEventListener("keydown", key, true),
    };
    onGesture(true);
  }

  function onPointerMove(event: PointerEvent<HTMLElement>) {
    const held = drag.current;
    if (!held) return;
    const frame = frameAt(event.clientX);
    const reach = held.edge === "end" ? frame - clip.start : clip.start - frame;
    const length = draggedLength(transition, held.edge, reach);
    if (!length) return;
    held.duration = Math.max(1, Math.min(held.room, length));
    draw(held.duration);
  }

  return (
    <i
      ref={mark}
      className={`tl-transition${selected ? " selected" : ""}`}
      data-transition={clip.id}
      data-kind={transition.kind}
      title={`${TRANSITION_NAMES[transition.kind]}, ${formatTimecode(transition.duration, timeline.fps)}`}
      style={{ "--s": start, "--d": transition.duration }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
      onLostPointerCapture={() => end(false)}
    />
  );
}
