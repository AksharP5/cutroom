import { useEffect, useLayoutEffect, useRef } from "react";
import type { PictureBox, PictureHit } from "../../shared/preview";
import { isAudioKind } from "../../shared/timeline/schema";
import type { Clip, Timeline } from "../../shared/timeline/schema";
import { SNAP_PX } from "../timeline/gesture";
import { clickSelection, emptySelection } from "../timeline/selection";
import { useWorkspace } from "../workspace";
import { inspectorSubject } from "./inspector/fields";
import { contains, dragOffset, pickHit } from "./pictureDrag";
import {
  cancelPositionPreview,
  commitPositionPreview,
  hitPicture,
  pictureBox,
  previewPosition,
  usePictureMove,
  usePositionWarning,
} from "./preview";
import { editTimeline, useTimeline } from "./timeline";

/** Travel before a press becomes a drag, as on the timeline. */
const DRAG_PX = 3;
const ARROWS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

interface Offset {
  x: number;
  y: number;
}

/** One Position change in flight: where the clip was and where the gesture has put it. */
interface Move {
  timeline: Timeline;
  clip: Clip;
  from: Offset;
  to: Offset;
}

interface Press {
  timeline: Timeline;
  /** Where it landed, in screen and composition pixels. */
  client: Offset;
  at: Offset;
  cycle: boolean;
  toggle: boolean;
  /** Null until the preview answers what lies under the press. */
  hits: PictureHit[] | null;
  latest: { client: Offset; axis: boolean; bypass: boolean };
  released: boolean;
  drag: (Move & { box: PictureBox | null }) | null;
  /** A drag that began over nothing, or on a locked track, moves nothing. */
  idle: boolean;
}

/**
 * Selection on the picture. The selected clip's box is outlined wherever playback takes it; a
 * click selects what is drawn under it, a drag moves the clip's Position, and arrow keys nudge
 * it while the picture has focus. Moves are drafts in the preview until they commit one edit,
 * the same path as the inspector's Position fields.
 */
export function PictureSelect({
  projectId,
  box,
  frame,
  scale,
  active,
}: {
  projectId: string;
  /** The picture's place on the stage, in screen pixels. */
  box: { left: number; top: number; width: number; height: number };
  /** The composition's size in its own pixels. */
  frame: { width: number; height: number };
  /** Screen pixels per composition pixel. */
  scale: Offset;
  /** Only the Select tool takes presses and keys; the outline shows with every tool. */
  active: boolean;
}) {
  const view = useTimeline((state) => state.view);
  const selection = useTimeline((state) => state.selection);
  const subject = view
    ? (inspectorSubject(view.timeline, selection)?.clip ?? null)
    : null;
  const clip = subject && !isAudioKind(subject.kind) ? subject : null;
  const locked = Boolean(
    clip &&
    view?.timeline.tracks.find((track) => track.index === clip.track)?.locked,
  );
  const latest = useRef({ projectId, frame, scale, clip, locked, active });
  latest.current = { projectId, frame, scale, clip, locked, active };

  const surface = useRef<HTMLDivElement>(null);
  const outline = useRef<HTMLDivElement>(null);
  const guides = useRef<HTMLDivElement>(null);
  const press = useRef<Press | null>(null);
  const nudge = useRef<(Move & { keys: Set<string> }) | null>(null);

  const draw = () => {
    const element = outline.current;
    if (!element) return;
    const shown = pictureBox.current();
    const { scale } = latest.current;
    // A picture hit publishes before React renders the new selection. Read the same store now
    // so the outline can join that paint rather than waiting for the inspector to render.
    const { view, selection } = useTimeline.getState();
    const clip = view ? inspectorSubject(view.timeline, selection)?.clip : null;
    const box = shown?.clipId === clip?.id ? shown?.box : null;
    element.hidden = !box;
    if (!box || !shown) return;
    element.dataset.outlined = shown.clipId;
    const left = Math.round(box.x * scale.x);
    const top = Math.round(box.y * scale.y);
    const width = Math.max(1, Math.round((box.x + box.width) * scale.x) - left);
    const height = Math.max(
      1,
      Math.round((box.y + box.height) * scale.y) - top,
    );
    // One-pixel edges stretched by transform: no layout as the box follows playback. They sit
    // just outside the box, so the outline never covers the clip's own pixels.
    const marks = [...element.children] as HTMLElement[];
    const place = (at: number, l: number, t: number, w: number, h: number) => {
      marks[at]!.style.transform = `translate(${l}px, ${t}px) scaleX(${w})`;
      marks[at + 1]!.style.transform =
        `translate(${l}px, ${t + h - 1}px) scaleX(${w})`;
      marks[at + 2]!.style.transform = `translate(${l}px, ${t}px) scaleY(${h})`;
      marks[at + 3]!.style.transform =
        `translate(${l + w - 1}px, ${t}px) scaleY(${h})`;
    };
    place(0, left - 2, top - 2, width + 4, height + 4);
    place(4, left - 1, top - 1, width + 2, height + 2);
    // Corner handles, centred on the line; shown only while the picture has the arrow keys.
    for (const [at, x, y] of [
      [8, left - 1, top - 1],
      [9, left + width, top - 1],
      [10, left - 1, top + height],
      [11, left + width, top + height],
    ] as const)
      marks[at]!.style.transform = `translate(${x - 2}px, ${y - 2}px)`;
  };
  useLayoutEffect(() => {
    draw();
    return pictureBox.subscribe(draw);
  }, [clip?.id, scale.x, scale.y]);

  const showGuides = (lines: { x: number | null; y: number | null } | null) => {
    const [vertical, horizontal] = [
      ...(guides.current?.children ?? []),
    ] as HTMLElement[];
    if (!vertical || !horizontal) return;
    const { frame, scale } = latest.current;
    const x = lines?.x ?? null;
    const y = lines?.y ?? null;
    vertical.hidden = x === null;
    horizontal.hidden = y === null;
    // A line on the far edge still draws inside the picture.
    if (x !== null)
      vertical.style.transform = `translateX(${Math.min(Math.round(x * scale.x), Math.round(frame.width * scale.x) - 1)}px)`;
    if (y !== null)
      horizontal.style.transform = `translateY(${Math.min(Math.round(y * scale.y), Math.round(frame.height * scale.y) - 1)}px)`;
  };

  /** A grab hands the arrow keys to the picture. The handles say so; no focus ring is needed. */
  const grab = () => {
    const element = surface.current;
    if (!element) return;
    element.dataset.grabbed = "";
    element.focus({ preventScroll: true });
  };
  /** The picture follows through the preview's draft path; the inspector shows the numbers. */
  const show = ({ clip, to }: Move) => {
    previewPosition(clip.id, to.x, to.y);
    usePictureMove.setState({ move: { clipId: clip.id, ...to } });
  };
  const restore = ({ clip, from }: Move) => {
    cancelPositionPreview(clip.id, from.x, from.y);
    usePictureMove.setState({ move: null });
  };
  /** Release and key-up both end here: one command, so one undo step. */
  const commit = (move: Move) => {
    const { clip, from, to } = move;
    if (to.x === from.x && to.y === from.y) {
      restore(move);
      return;
    }
    const { projectId } = latest.current;
    void commitPositionPreview(() =>
      editTimeline(
        projectId,
        "Edit position",
        () => [{ type: "setClip", clipId: clip.id, x: to.x, y: to.y }],
        move.timeline,
      ),
    );
    // The timeline already shows the edit, so the fields go straight to the new value.
    usePictureMove.setState({ move: null });
  };

  const select = (hit: PictureHit | null, toggle: boolean) => {
    const { view, selection } = useTimeline.getState();
    // Ctrl on nothing keeps what is selected, as on the timeline.
    if (!view || (!hit && toggle)) return;
    const next = hit
      ? clickSelection(view.timeline, [], selection, hit.clipId, {
          toggle,
          range: false,
          alone: false,
        })
      : emptySelection;
    useTimeline.setState({ selection: next });
    // The promoted preview just measured this box. Draw it with selection rather than waiting
    // for a second bridge round trip; ordinary observation keeps following it afterward.
    if (hit && inspectorSubject(view.timeline, next)?.clip?.id === hit.clipId)
      pictureBox.publish({ clipId: hit.clipId, box: hit.box });
  };

  /** Runs on every pointer event and when the preview answers, whichever comes last. */
  const act = (current: Press) => {
    if (!latest.current.active || !current.hits || current.idle) return;
    const { view } = useTimeline.getState();
    if (!view) return;
    const { frame, scale, clip } = latest.current;
    if (!current.drag) {
      // The preview only knows elements; the timeline says which are clips that can be picked.
      const pickable = current.hits.filter((hit) => {
        const found = view.timeline.clips.find(
          (item) => item.id === hit.clipId,
        );
        return (
          found &&
          !isAudioKind(found.kind) &&
          !view.timeline.tracks.find((track) => track.index === found.track)
            ?.locked
        );
      });
      const hit = pickHit(pickable, clip?.id ?? null, current.cycle);
      if (current.released) {
        // A click that picks something else, or nothing, leaves the arrows with the playhead.
        // The picture takes them once the selected clip itself is grabbed.
        if (hit && hit.clipId === clip?.id && !current.toggle) grab();
        else surface.current?.blur();
        select(hit, current.toggle);
        return;
      }
      const { client } = current.latest;
      if (
        Math.hypot(client.x - current.client.x, client.y - current.client.y) <
        DRAG_PX
      )
        return;
      const target = current.timeline.clips.find(
        (item) => item.id === hit?.clipId,
      );
      if (!hit || !target) {
        current.idle = true;
        surface.current?.blur();
        return;
      }
      if (target.id !== clip?.id) select(hit, false);
      const from = { x: target.x ?? 0, y: target.y ?? 0 };
      current.drag = {
        timeline: current.timeline,
        clip: target,
        from,
        to: from,
        box: hit.box,
      };
      grab();
      // Like a timeline drag, this one owns Esc while it lasts.
      useWorkspace.setState({ gesture: true });
    }
    const { drag, latest: pointer } = current;
    const snapping =
      useTimeline.getState().snapping &&
      !pointer.bypass &&
      // An overridden Position moves the picture by some other amount than the offset.
      !usePositionWarning.getState().warning;
    const { dx, dy, guides } = dragOffset(
      {
        x: (pointer.client.x - current.client.x) / scale.x,
        y: (pointer.client.y - current.client.y) / scale.y,
      },
      {
        axis: pointer.axis,
        box: drag.box,
        frame,
        reach: snapping ? SNAP_PX / scale.x : 0,
      },
    );
    drag.to = {
      x: Number((drag.from.x + dx).toFixed(6)),
      y: Number((drag.from.y + dy).toFixed(6)),
    };
    show(drag);
    showGuides(guides);
  };

  const end = (cancel: boolean) => {
    const current = press.current;
    press.current = null;
    if (!current) return;
    showGuides(null);
    if (!current.drag) {
      if (cancel) current.idle = true;
      else {
        current.released = true;
        act(current);
      }
      return;
    }
    useWorkspace.setState({ gesture: false });
    if (cancel) restore(current.drag);
    else commit(current.drag);
  };

  const endNudge = (cancel: boolean) => {
    const current = nudge.current;
    nudge.current = null;
    if (!current) return;
    if (cancel) restore(current);
    else commit(current);
  };

  // Esc cancels a drag before any other shortcut hears it. Modifiers redraw a stationary drag.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const current = press.current;
      if (!current?.drag) return;
      if (event.key === "Escape" && event.type === "keydown") {
        event.preventDefault();
        event.stopPropagation();
        end(true);
        return;
      }
      current.latest.axis = event.shiftKey;
      current.latest.bypass = event.ctrlKey || event.metaKey;
      act(current);
    };
    const blur = () => {
      end(true);
      endNudge(false);
    };
    // Timeline presses keep focus where it was. The arrows go back to the playhead anyway.
    const leave = (event: PointerEvent) => {
      const element = surface.current;
      if (
        element &&
        element === document.activeElement &&
        !(event.target instanceof Node && element.contains(event.target))
      )
        element.blur();
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("keyup", key, true);
    document.addEventListener("pointerdown", leave, true);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("keyup", key, true);
      document.removeEventListener("pointerdown", leave, true);
      window.removeEventListener("blur", blur);
      end(true);
      endNudge(true);
    };
  }, []);
  // Another tool, or another clip, ends what the last one started.
  useEffect(() => {
    if (active) return;
    end(true);
    endNudge(false);
    surface.current?.blur();
    if (surface.current) delete surface.current.dataset.grabbed;
  }, [active]);
  useEffect(() => () => endNudge(false), [clip?.id]);

  return (
    <div
      ref={surface}
      className="edit-select"
      style={box}
      role="application"
      aria-label="Picture"
      aria-describedby="edit-select-help"
      title={
        active && clip
          ? "Drag to move. Click the selected clip again to nudge with arrow keys."
          : undefined
      }
      data-active={active || undefined}
      tabIndex={active ? 0 : -1}
      // Focus is given by hand: only a grab of the selected clip hands the arrows to the picture.
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        const timeline = useTimeline.getState().view?.timeline;
        if (!active || !timeline || event.button !== 0 || press.current) return;
        // A press still ends typing elsewhere, as a click on any other part of the editor does.
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && focused !== event.currentTarget)
          focused.blur();
        const bounds = event.currentTarget.getBoundingClientRect();
        const client = { x: event.clientX, y: event.clientY };
        const at = {
          x: (client.x - bounds.left) / scale.x,
          y: (client.y - bounds.top) / scale.y,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        const current: Press = {
          timeline,
          client,
          at,
          cycle: event.altKey,
          toggle: event.ctrlKey || event.metaKey,
          hits: null,
          latest: {
            client,
            axis: event.shiftKey,
            bypass: event.ctrlKey || event.metaKey,
          },
          released: false,
          drag: null,
          idle: false,
        };
        press.current = current;
        void hitPicture(at.x, at.y).then(
          (hits) => {
            current.hits = hits;
            act(current);
          },
          // A preview replaced mid-press cannot say what was under it; leave the selection alone.
          () => {
            current.idle = true;
            surface.current?.blur();
          },
        );
      }}
      onPointerMove={(event) => {
        const current = press.current;
        if (!current) {
          const shown = pictureBox.current();
          const bounds = event.currentTarget.getBoundingClientRect();
          const over =
            active &&
            !locked &&
            shown?.box &&
            shown.clipId === clip?.id &&
            contains(shown.box, {
              x: (event.clientX - bounds.left) / scale.x,
              y: (event.clientY - bounds.top) / scale.y,
            });
          event.currentTarget.style.cursor = over ? "move" : "";
          return;
        }
        current.latest = {
          client: { x: event.clientX, y: event.clientY },
          axis: event.shiftKey,
          bypass: event.ctrlKey || event.metaKey,
        };
        act(current);
      }}
      onPointerUp={() => end(false)}
      onPointerCancel={() => end(true)}
      onLostPointerCapture={() => end(true)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && nudge.current) {
          event.preventDefault();
          event.stopPropagation();
          endNudge(true);
          return;
        }
        const step = ARROWS[event.key];
        if (
          !step ||
          !active ||
          !clip ||
          !view ||
          !event.currentTarget.hasAttribute("data-grabbed") ||
          locked ||
          press.current ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey
        )
          return;
        // The picture has focus, so the arrows move the clip instead of the playhead.
        event.preventDefault();
        const from = { x: clip.x ?? 0, y: clip.y ?? 0 };
        const current = (nudge.current ??= {
          timeline: view.timeline,
          clip,
          from,
          to: from,
          keys: new Set(),
        });
        current.keys.add(event.key);
        const size = event.shiftKey ? 10 : 1;
        current.to = {
          x: Number((current.to.x + step[0] * size).toFixed(6)),
          y: Number((current.to.y + step[1] * size).toFixed(6)),
        };
        show(current);
      }}
      onKeyUp={(event) => {
        const current = nudge.current;
        if (!current || !ARROWS[event.key]) return;
        current.keys.delete(event.key);
        // Holding a key, or rolling from one arrow to the next, is one move.
        if (!current.keys.size) endNudge(false);
      }}
      onBlur={(event) => {
        delete event.currentTarget.dataset.grabbed;
        endNudge(false);
      }}
    >
      <span id="edit-select-help" hidden>
        Click a clip to select it. Drag it, or click it again and use the arrow
        keys, to move it.
      </span>
      <div ref={guides} className="edit-select-guides" aria-hidden="true">
        <i data-axis="x" hidden />
        <i data-axis="y" hidden />
      </div>
      <div
        ref={outline}
        className="edit-select-outline"
        aria-hidden="true"
        hidden
      >
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
        <b />
        <b />
        <b />
        <b />
      </div>
    </div>
  );
}
